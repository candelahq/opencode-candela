/**
 * opencode-candela — OpenCode plugin for Candela LLM observability.
 *
 * Hooks into OpenCode session lifecycle to provide:
 * - Session-scoped cost tracking with idle toasts
 * - Budget remaining warnings with reset countdown
 * - Active grant display with expiry warnings
 * - Candela proxy URL injection into shells
 * - Rich cost + budget context injection during session compaction
 * - Session attribution headers for cost tracking (chat.headers)
 * - Per-task cost attribution via native Todo + Subtask tracking
 * - Cost-aware model parameter adjustment (chat.params)
 * - Deterministic policy gates blocking destructive operations (tool.execute.before)
 *
 * Gracefully no-ops if Candela is not running.
 */

import type { Plugin } from "@opencode-ai/plugin";
import { CandelaClient } from "./candela-client.js";
import type { BudgetInfo, GrantInfo } from "./candela-client.js";
import { discoverCandelaUrl } from "./discover.js";

/** Format USD with appropriate precision */
function formatCost(usd: number): string {
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

/** Format token count with K/M suffixes */
function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}K`;
  return String(count);
}

/** Budget urgency emoji based on usage fraction. */
function budgetEmoji(fraction: number): string {
  if (fraction >= 0.9) return "🔴";
  if (fraction >= 0.6) return "🟡";
  return "🟢";
}

/** Format a grant for display: "🎁 $42.10 remaining (Hackathon — expires May 20)" */
function formatGrant(g: GrantInfo): string {
  const parts = [`🎁 ${formatCost(g.remainingUsd)} remaining`];
  if (g.reason) parts.push(`(${g.reason}`);
  if (g.expiresAt) {
    const expiry = g.expiresAt.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });
    parts.push(g.reason ? ` — expires ${expiry})` : `(expires ${expiry})`);
  } else if (g.reason) {
    parts.push(")");
  }
  return parts.join("");
}

export const CandelaPlugin: Plugin = async ({ client, directory, $ }) => {
  const candelaUrl = discoverCandelaUrl();
  const candela = new CandelaClient(candelaUrl);

  // Check if Candela is alive on init
  const alive = await candela.isAlive();
  if (alive) {
    // Single call to get usage + budget + grants
    const data = await candela.getDashboardData(24);

    const connectMsg = `Connected to Candela at ${candelaUrl}`;
    await client.app.log({
      body: {
        service: "opencode-candela",
        level: "info",
        message: connectMsg,
      },
    });

    // Show budget status on startup
    if (data?.budget) {
      const b = data.budget;
      const emoji = budgetEmoji(b.usedFraction);
      await client.app.log({
        body: {
          service: "opencode-candela",
          level: b.isNearLimit ? "warn" : "info",
          message: `${emoji} Budget: ${b.percentUsed.toFixed(0)}% used — ${formatCost(b.remainingUsd)} remaining${b.resetLabel ? ` (${b.resetLabel})` : ""}`,
        },
      });
    }

    // Show active grants on startup
    for (const g of data?.activeGrants ?? []) {
      if (g.isExhausted) continue;
      await client.app.log({
        body: {
          service: "opencode-candela",
          level: g.isExpiringSoon ? "warn" : "info",
          message: formatGrant(g),
        },
      });
    }
  } else {
    await client.app.log({
      body: {
        service: "opencode-candela",
        level: "debug",
        message: `Candela not detected at ${candelaUrl} — plugin will no-op`,
      },
    });
  }

  // Track per-session state
  let sessionStartTime: Date | null = null;
  let sessionToolCalls = 0;

  // ── Native task tracking for cost attribution ─────────────────────────
  // Track OpenCode's native Todo items and subtask sessions so we can tag
  // LLM spans with per-task/per-subtask cost attribution headers.
  let currentTodoId: string | null = null;
  const subtaskSessions = new Map<string, { parentId: string; title: string }>();

  // ── Policy configuration ─────────────────────────────────────────────────
  // Blocked file patterns (policy gates) — add project-specific patterns
  // via CANDELA_BLOCKED_PATTERNS env var (comma-separated globs).
  const defaultBlockedPatterns = [
    "pricing.yaml",
    "pricing.json",
    ".env",
    ".env.production",
  ];
  const extraPatterns = (process.env.CANDELA_BLOCKED_PATTERNS ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  const blockedPatterns = [...defaultBlockedPatterns, ...extraPatterns];

  const blockedCommands = [
    "rm -rf /",
    "drop table",
    "drop database",
    "truncate table",
    "format c:",
  ];

  return {
    /**
     * Inject Candela environment variables into all shell executions.
     * This ensures any subprocess (test runners, scripts, etc.) can
     * discover the Candela proxy.
     */
    "shell.env": async (_input, output) => {
      if (!alive) return;
      output.env.CANDELA_PROXY_URL = candelaUrl;
      output.env.OPENAI_BASE_URL = `${candelaUrl}/proxy/openai/v1`;
    },

    /**
     * Tag every LLM request with session metadata for cost attribution.
     * Candela uses these headers to break down costs per session/agent.
     */
    "chat.headers": async (input, output) => {
      if (!alive) return;
      output.headers["X-Candela-Session"] = input.sessionID;
      output.headers["X-Candela-Agent"] = input.agent;
      output.headers["X-Candela-Model"] =
        `${input.provider.info.id}/${input.model.id}`;
      output.headers["X-Candela-Source"] = "opencode";

      // Per-task cost attribution: tag with active todo item
      if (currentTodoId) {
        output.headers["X-Candela-Todo-Id"] = currentTodoId;
      }

      // Per-subtask cost attribution: tag child sessions
      const subtask = subtaskSessions.get(input.sessionID);
      if (subtask) {
        output.headers["X-Candela-Subtask-Parent"] = subtask.parentId;
        output.headers["X-Candela-Subtask-Title"] = subtask.title;
      }
    },

    /**
     * Cost-aware model parameter adjustment.
     * When budget is running low, limit output tokens and reduce temperature
     * to control costs. When budget is critical, apply aggressive limits.
     */
    "chat.params": async (_input, output) => {
      if (!alive) return;

      const data = await candela.getDashboardData(1);
      if (!data?.budget) return;

      const { usedFraction } = data.budget;

      // Critical: >95% budget used — hard cap output tokens
      if (usedFraction > 0.95) {
        output.maxOutputTokens = Math.min(
          output.maxOutputTokens ?? 8192,
          2048
        );
        if (output.temperature !== undefined) {
          output.temperature = Math.min(output.temperature, 0.2);
        }
        await client.app.log({
          body: {
            service: "opencode-candela",
            level: "warn",
            message: `🔴 Budget critical (${(usedFraction * 100).toFixed(0)}%) — output capped at 2K tokens`,
          },
        });
      }
      // Warning: >80% budget used — reduce temperature for focus
      else if (usedFraction > 0.8) {
        if (output.temperature !== undefined) {
          output.temperature = Math.min(output.temperature, 0.4);
        }
      }
    },

    /**
     * Deterministic policy gates — block destructive operations before
     * they reach the tool. Similar to Factory Droid's PreToolUse hooks.
     *
     * - Blocks file edits to sensitive paths (pricing configs, .env files)
     * - Blocks destructive shell commands (rm -rf /, DROP TABLE, etc.)
     * - Configurable via CANDELA_BLOCKED_PATTERNS env var
     */
    "tool.execute.before": async (input, output) => {
      // Policy gate: block writes to sensitive files
      if (
        input.tool === "file_edit" ||
        input.tool === "file_write" ||
        input.tool === "write" ||
        input.tool === "edit"
      ) {
        const filePath: string =
          output.args?.path ?? output.args?.file ?? output.args?.filePath ?? "";
        const matchedPattern = blockedPatterns.find((pattern) =>
          filePath.toLowerCase().includes(pattern.toLowerCase())
        );
        if (matchedPattern) {
          await client.app.log({
            body: {
              service: "opencode-candela",
              level: "warn",
              message: `🛡️ Policy blocked: ${input.tool} on "${filePath}" (matches "${matchedPattern}")`,
            },
          });
          throw new Error(
            `🛡️ Blocked by Candela policy: edits to files matching "${matchedPattern}" ` +
              `are not allowed. Edit this file manually and run tests.`
          );
        }
      }

      // Policy gate: block destructive shell commands
      if (input.tool === "shell" || input.tool === "bash" || input.tool === "terminal") {
        const cmd: string = String(
          output.args?.command ?? output.args?.cmd ?? output.args?.input ?? ""
        );
        const matchedCmd = blockedCommands.find((blocked) =>
          cmd.toLowerCase().includes(blocked.toLowerCase())
        );
        if (matchedCmd) {
          await client.app.log({
            body: {
              service: "opencode-candela",
              level: "warn",
              message: `🛡️ Policy blocked: shell command containing "${matchedCmd}"`,
            },
          });
          throw new Error(
            `🛡️ Blocked by Candela policy: commands containing "${matchedCmd}" ` +
              `are not allowed. Run this command manually if intended.`
          );
        }
      }
    },

    /**
     * Listen for events to track session lifecycle and show cost toasts.
     */
    event: async ({ event }) => {
      if (!alive) return;

      // Track todo items for per-task cost attribution
      if (event.type === "todo.updated") {
        const todos = (event as any).properties?.todos as Array<{ id: string; status: string }> | undefined;
        if (todos) {
          const active = todos.find((t) => t.status === "in_progress");
          currentTodoId = active?.id ?? null;
        }
      }

      // Track subtask child sessions for per-subtask cost
      // Also track session start — clear cache for fresh data
      if (event.type === "session.created") {
        const session = (event as any).properties?.info as { id: string; parentID?: string; title: string } | undefined;
        if (session?.parentID) {
          // Bound the map to prevent memory leaks in long-running processes
          if (subtaskSessions.size >= 1000) {
            const firstKey = subtaskSessions.keys().next().value;
            if (firstKey !== undefined) {
              subtaskSessions.delete(firstKey);
            }
          }
          subtaskSessions.set(session.id, {
            parentId: session.parentID,
            title: session.title,
          });
        }
        sessionStartTime = new Date();
        sessionToolCalls = 0;
        candela.resetHealth();
        candela.invalidateCache();
      }

      // Show cost + budget summary when session goes idle
      if (event.type === "session.idle" && sessionStartTime) {
        const data = await candela.getDashboardData(1); // last hour
        if (data && data.usage.requestCount > 0) {
          const duration = Math.round(
            (Date.now() - sessionStartTime.getTime()) / 1000
          );
          const minutes = Math.floor(duration / 60);
          const seconds = duration % 60;

          // Build summary with budget context
          const parts = [
            `${formatTokens(data.usage.totalTokens)} tokens`,
            formatCost(data.usage.totalCostUsd),
            `${data.usage.requestCount} calls`,
            `${minutes}m${seconds}s`,
          ];

          // Add budget indicator if available
          if (data.budget) {
            const emoji = budgetEmoji(data.budget.usedFraction);
            parts.push(`${emoji}${data.budget.percentUsed.toFixed(0)}%`);
          }

          const summary = parts.join(" · ");

          try {
            await $`osascript -e ${"display notification \"" + summary + "\" with title \"Candela\" subtitle \"Session Summary\""}`;
          } catch {
            // Non-macOS or notification permission denied — log instead
            await client.app.log({
              body: {
                service: "opencode-candela",
                level: "info",
                message: `📊 Session: ${summary}`,
              },
            });
          }
        }

        // Budget warning toast (separate notification for visibility)
        if (data?.budget && data.budget.percentUsed > 90) {
          const b = data.budget;
          const budgetMsg = `${formatCost(b.remainingUsd)} remaining (${b.percentUsed.toFixed(0)}% used)${b.resetLabel ? ` — ${b.resetLabel}` : ""}`;
          try {
            await $`osascript -e ${"display notification \"" + budgetMsg + "\" with title \"Candela\" subtitle \"⚠️ Budget Warning\""}`;
          } catch {
            await client.app.log({
              body: {
                service: "opencode-candela",
                level: "warn",
                message: `⚠️ Budget: ${budgetMsg}`,
              },
            });
          }
        }
      }
    },

    /**
     * Track tool executions for session attribution.
     */
    "tool.execute.after": async () => {
      sessionToolCalls++;
    },

    /**
     * Inject cost + budget context into compaction summaries so the LLM
     * retains awareness of spending and budget constraints.
     */
    "experimental.session.compacting": async (_input, output) => {
      if (!alive) return;

      const data = await candela.getDashboardData(4); // last 4 hours
      if (data && data.usage.requestCount > 0) {
        // Model breakdown (from dedicated endpoint for full detail)
        const models = data.models.length > 0 ? data.models : (await candela.getModelBreakdown(4) ?? []);
        const modelLines = models
          .slice(0, 5)
          .map(
            (m) =>
              `  - ${m.model} (${m.provider}): ${formatTokens(m.totalTokens)} tokens, ${formatCost(m.totalCostUsd)}`
          )
          .join("\n");

        const sections: string[] = [
          `## Candela Cost Context`,
          `This session has used ${formatTokens(data.usage.totalTokens)} tokens ` +
            `(${formatCost(data.usage.totalCostUsd)}) across ${data.usage.requestCount} LLM calls.`,
        ];

        if (modelLines) {
          sections.push(`\nModel breakdown:\n${modelLines}`);
        }

        // Budget context — rich data for the LLM to pace itself
        if (data.budget) {
          const b = data.budget;
          sections.push(
            `\n## Candela Budget Context`,
            `Daily budget: ${formatCost(b.remainingUsd)} remaining of ${formatCost(b.limitUsd)} (${b.percentUsed.toFixed(0)}% used${b.resetLabel ? `, ${b.resetLabel}` : ""})`,
          );
        }

        // Grant context
        for (const g of data.activeGrants) {
          if (g.isExhausted) continue;
          const expiryNote = g.expiresAt
            ? ` — expires ${g.expiresAt.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`
            : "";
          sections.push(
            `Active grant: ${formatCost(g.remainingUsd)} of ${formatCost(g.amountUsd)} (${g.reason || "Bonus"}${expiryNote})`
          );
        }

        if (data.totalRemainingUsd !== null) {
          sections.push(`Total available: ${formatCost(data.totalRemainingUsd)}`);
        }

        sections.push(
          `Be cost-conscious — ${data.budget?.resetLabel ? `daily budget ${data.budget.resetLabel}.` : "prefer concise responses when possible."}`
        );

        output.context.push(sections.join("\n"));
      }
    },
  };
};
