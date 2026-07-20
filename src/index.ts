/**
 * opencode-candela — OpenCode plugin for Candela LLM observability.
 *
 * Server hooks (session lifecycle):
 * - Session-scoped cost tracking with idle toasts
 * - Budget remaining warnings with reset countdown
 * - Active grant display with expiry warnings
 * - Candela proxy URL injection into shells
 * - Rich cost + budget context injection during session compaction
 * - Cost-awareness system prompt injection
 *
 * TUI hooks (terminal UI):
 * - Sidebar cost dashboard with budget, top models
 * - Budget threshold toast notifications
 *
 * Gracefully no-ops if Candela is not running.
 */

// Re-export TUI plugin for OpenCode to discover
export { tui } from "./tui.js";

import type { Plugin } from "@opencode-ai/plugin";
import type { GrantInfo } from "./candela-client.js";
import { CandelaClient } from "./candela-client.js";
import { createConfigTools } from "./config-tools.js";
import { createContextHook } from "./context.js";
import { discoverCandelaUrl } from "./discover.js";
import { createCandelaTools } from "./tools.js";
import { formatCost, formatTokens } from "./utils.js";

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

export const CandelaPlugin: Plugin = async ({ client, $ }) => {
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
  let sessionId: string | null = null;

  /** Accessor for session state — tools read this lazily. */
  const getSession = () => ({
    startTime: sessionStartTime,
    toolCalls: sessionToolCalls,
  });

  // ── Custom tools ──────────────────────────────────────────────────────────
  // Register tools that the AI agent can call conversationally.
  // Phase 1: Cost queries — "how much have I spent today?"
  // Phase 2: Config management — "add claude sonnet 4 through candela"
  const costTools = alive
    ? createCandelaTools(candela, candelaUrl, getSession)
    : undefined;
  const configTools = createConfigTools(candela, candelaUrl);
  const tools = { ...configTools, ...costTools };
  // Phase 3: Context injection — cost awareness in system prompt
  const context = alive ? createContextHook(candela) : undefined;

  return {
    tool: tools,
    "experimental.chat.system.transform": context?.hook,
    /**
     * Inject Candela environment variables into all shell executions.
     * This ensures any subprocess (test runners, scripts, etc.) can
     * discover the Candela proxy.
     */
    "shell.env": async (_input, output) => {
      if (!alive) return;
      output.env.CANDELA_PROXY_URL = candelaUrl;
      output.env.OPENAI_BASE_URL = `${candelaUrl}/proxy/openai/v1`;
      if (sessionId) {
        output.env.CANDELA_SESSION_ID = sessionId;
      }
    },

    /**
     * Listen for events to track session lifecycle and show cost toasts.
     */
    event: async ({ event }) => {
      if (!alive) return;

      // Track session start — clear cache for fresh data
      if (event.type === "session.created") {
        sessionStartTime = new Date();
        sessionToolCalls = 0;
        sessionId = crypto.randomUUID();
        candela.resetHealth();
        candela.invalidateCache();
        context?.resetSession();

        await client.app.log({
          body: {
            service: "opencode-candela",
            level: "debug",
            message: `📍 Session ${sessionId.slice(0, 8)} started`,
          },
        });
      }

      // Show cost + budget summary when session goes idle
      if (event.type === "session.idle" && sessionStartTime) {
        const data = await candela.getDashboardData(1); // last hour
        if (data && data.usage.requestCount > 0) {
          const duration = Math.round(
            (Date.now() - sessionStartTime.getTime()) / 1000,
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
            await $`osascript -e ${`display notification "${summary}" with title "Candela" subtitle "Session Summary"`}`;
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
            await $`osascript -e ${`display notification "${budgetMsg}" with title "Candela" subtitle "⚠️ Budget Warning"`}`;
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
        const models =
          data.models.length > 0
            ? data.models
            : ((await candela.getModelBreakdown(4)) ?? []);
        const modelLines = models
          .slice(0, 5)
          .map(
            (m) =>
              `  - ${m.model} (${m.provider}): ${formatTokens(m.totalTokens)} tokens, ${formatCost(m.totalCostUsd)}`,
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
            `Active grant: ${formatCost(g.remainingUsd)} of ${formatCost(g.amountUsd)} (${g.reason || "Bonus"}${expiryNote})`,
          );
        }

        if (data.totalRemainingUsd !== null) {
          sections.push(
            `Total available: ${formatCost(data.totalRemainingUsd)}`,
          );
        }

        sections.push(
          `Be cost-conscious — ${data.budget?.resetLabel ? `daily budget ${data.budget.resetLabel}.` : "prefer concise responses when possible."}`,
        );

        output.context.push(sections.join("\n"));
      }
    },
  };
};
