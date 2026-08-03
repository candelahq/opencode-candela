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

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Plugin } from "@opencode-ai/plugin";
import {
  getCumulativeCost,
  getSessionCount,
  readSpendTrends,
} from "./analytics-reader.js";
import type { GrantInfo } from "./candela-client.js";
import { CandelaClient } from "./candela-client.js";
import { createConfigTools } from "./config-tools.js";
import { createContextHook } from "./context.js";
import { discoverCandelaUrl } from "./discover.js";
import { incrementCrossPromo, resolveSettings } from "./settings.js";
import { createCandelaTools } from "./tools.js";

/** Redact credentials/tokens from a URL, keeping only the origin. */
function sanitizeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    return u.origin;
  } catch {
    return "<invalid-url>";
  }
}

import { formatCost, formatTokens } from "./utils.js";

// ── Analytics ────────────────────────────────────────────────────────────────

const ANALYTICS_PATH = join(
  homedir(),
  ".config",
  "opencode",
  "candela-analytics.jsonl",
);

interface SessionAnalyticsEntry {
  ts: string;
  sessionId: string;
  duration: number;
  toolCalls: number;
  totalCost: number;
  pluginVersion: string;
  models: string[];
}

/** Append a session analytics entry to the local JSONL file. */
function logSessionAnalytics(entry: SessionAnalyticsEntry): void {
  try {
    const dir = dirname(ANALYTICS_PATH);
    mkdirSync(dir, { recursive: true });
    appendFileSync(ANALYTICS_PATH, `${JSON.stringify(entry)}\n`, "utf-8");
  } catch {
    // Non-fatal — analytics is best-effort
  }
}

/** Check if this is the very first session (no analytics file yet). */
function isFirstEverSession(): boolean {
  return !existsSync(ANALYTICS_PATH);
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

export const CandelaPlugin: Plugin = async ({ client, $ }) => {
  const candelaUrl = discoverCandelaUrl();
  const candela = new CandelaClient(candelaUrl);

  // Check if Candela is alive on init
  const alive = await candela.isAlive();
  if (alive) {
    // Single call to get usage + budget + grants
    const data = await candela.getDashboardData(24);

    const connectMsg = `Connected to Candela at ${sanitizeUrl(candelaUrl)}`;
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
    // ── First-use onboarding: Candela not running ───────────────────────
    await client.app.log({
      body: {
        service: "opencode-candela",
        level: "info",
        message:
          "🕯️ Candela can track your AI spend in real-time.\n" +
          `   Run \`candela start\` or set CANDELA_URL to connect.\n` +
          `   Tried: ${sanitizeUrl(candelaUrl)}`,
      },
    });
  }

  // Track per-session state
  let sessionStartTime: Date | null = null;
  let sessionToolCalls = 0;
  let sessionId: string | null = null;
  let sessionBaseline: { cost: number; tokens: number; calls: number } | null =
    null;

  let activeTaskId: string | null = null;
  let activeSubtaskParent: string | null = null;
  let activeSubtaskTitle: string | null = null;

  /** Accessor for session state — tools read this lazily. */
  const getSession = () => ({
    startTime: sessionStartTime,
    toolCalls: sessionToolCalls,
    id: sessionId,
  });

  // ── Custom tools ──────────────────────────────────────────────────────────
  // Register tools that the AI agent can call conversationally.
  // Phase 1: Cost queries — "how much have I spent today?"
  // Phase 2: Config management — "add claude sonnet 4 through candela"
  const costTools = alive
    ? createCandelaTools(candela, candelaUrl, getSession)
    : undefined;
  const configTools = createConfigTools(candela, candelaUrl, client);
  // Phase 3: Context injection — cost awareness in system prompt
  // Smart routing is opt-in: enable via CANDELA_SMART_ROUTING=true
  const context = alive
    ? createContextHook(
        candela,
        process.cwd(),
        () => resolveSettings().smartRouting,
      )
    : undefined;
  const tools = { ...configTools, ...costTools };

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

    "chat.headers": async (_input, output) => {
      if (!alive || !sessionId) return;
      output.headers["X-Session-Id"] = sessionId;
      if (activeTaskId) {
        output.headers["X-Task-Id"] = activeTaskId;
      }
      if (activeSubtaskParent) {
        output.headers["X-Subtask-Parent"] = activeSubtaskParent;
      }
      if (activeSubtaskTitle) {
        // base64 encode or safe-encode the title if needed, but assuming headers can take it
        output.headers["X-Subtask-Title"] = activeSubtaskTitle;
      }
    },

    /**
     * Listen for events to track session lifecycle and show cost toasts.
     */
    event: async ({ event }) => {
      // Detect external config changes (#13) — runs regardless of Candela health
      if (event.type === "file.watcher.updated") {
        const filePath = event.properties?.file;
        if (
          filePath &&
          (filePath.endsWith(".opencode.json") ||
            filePath.endsWith("opencode/config.json"))
        ) {
          candela.invalidateCache();
          await client.app.log({
            body: {
              service: "opencode-candela",
              level: "info",
              message: "🔄 Config file changed — Candela state refreshed",
            },
          });
        }
      }

      if (event.type === "todo.updated") {
        const payload = event.properties as Record<string, unknown>;
        if (payload?.active) {
          activeTaskId = (payload.id as string) ?? null;
          activeSubtaskParent = (payload.parentId as string) ?? null;
          activeSubtaskTitle = (payload.title as string) ?? null;
        } else if (payload?.id && payload.id === activeTaskId) {
          activeTaskId = null;
          activeSubtaskParent = null;
          activeSubtaskTitle = null;
        }
      }

      if (!alive) return;

      // Track session start — use OpenCode's real session ID
      if (event.type === "session.created") {
        sessionStartTime = new Date();
        sessionToolCalls = 0;
        // Use OpenCode's session ID if available, fall back to UUID
        const info = (event as { properties?: { info?: { id?: string } } })
          .properties?.info;
        sessionId = info?.id ?? crypto.randomUUID();
        sessionBaseline = null;
        candela.resetHealth();
        candela.invalidateCache();
        context?.resetSession();

        // Capture baseline metrics at session start for accurate delta.
        // Awaited to prevent race where session.idle fires before baseline is set.
        let baselineData: Awaited<ReturnType<typeof candela.getDashboardData>> =
          null;
        try {
          baselineData = await candela.getDashboardData(24);
          if (baselineData) {
            sessionBaseline = {
              cost: baselineData.usage.totalCostUsd,
              tokens: baselineData.usage.totalTokens,
              calls: baselineData.usage.requestCount,
            };
          }
        } catch {
          // Non-fatal — sessionBaseline stays null, idle handler uses raw totals
        }

        await client.app.log({
          body: {
            service: "opencode-candela",
            level: "debug",
            message: `📍 Session ${sessionId.slice(0, 8)} started`,
          },
        });

        // ── First-use onboarding: Candela is running ────────────────────
        if (isFirstEverSession()) {
          await client.app.log({
            body: {
              service: "opencode-candela",
              level: "info",
              message:
                "🕯️ Candela is tracking costs for this session.\n" +
                '   Try: "how much have I spent?" or /cost\n' +
                "   Smart routing: set CANDELA_SMART_ROUTING=true",
            },
          });
        }

        // ── Startup trend summary ──────────────────────────────────────
        const trends = readSpendTrends();
        if (trends) {
          const budgetLine = baselineData?.budget
            ? ` · Budget: ${formatCost(baselineData.budget.remainingUsd)} remaining`
            : "";
          await client.app.log({
            body: {
              service: "opencode-candela",
              level: "info",
              message:
                `📈 Yesterday: ${formatCost(trends.yesterdayCost)} · ` +
                `This week: ${formatCost(trends.weekCost)} · ` +
                `Avg: ${formatCost(trends.avgDailyCost)}/day${budgetLine}`,
            },
          });
        }

        // ── Cross-promote ecosystem (milestone triggers, max 3) ────────
        const MAX_PROMO_IMPRESSIONS = 3;
        const settings = resolveSettings();
        if (settings.crossPromoShown < MAX_PROMO_IMPRESSIONS) {
          const totalSessions = getSessionCount();
          const totalSpend = getCumulativeCost();
          const hitBudgetWarning = baselineData?.budget?.usedFraction
            ? baselineData.budget.usedFraction >= 0.8
            : false;

          // Milestone triggers: 5th session, $50 cumulative, or first budget warning
          const shouldPromote =
            totalSessions >= 5 || totalSpend >= 50 || hitBudgetWarning;

          if (shouldPromote) {
            // Check if Desktop is reachable
            let desktopAlive = false;
            try {
              const resp = await fetch(
                "http://localhost:8181/_local/api/health",
                { signal: AbortSignal.timeout(1000) },
              );
              desktopAlive = resp.ok;
            } catch {
              // Desktop not running
            }

            const promoMsg = desktopAlive
              ? "📊 Candela Dashboard available: http://localhost:8181/_local/\n" +
                "   Charts, model breakdown, budget waterfalls, and more."
              : "💡 Get the Candela Desktop app for charts and budget waterfalls:\n" +
                "   brew install --cask candelahq/tap/candela-desktop";

            await client.app.log({
              body: {
                service: "opencode-candela",
                level: "info",
                message: promoMsg,
              },
            });
            incrementCrossPromo();
          }
        }
      }

      // Show cost + budget summary when session goes idle
      if (event.type === "session.idle" && sessionStartTime) {
        // Always use 24h window to match baseline capture (fixes time-window mismatch)
        const data = await candela.getDashboardData(24);
        if (data && data.usage.requestCount > 0) {
          // Calculate session-specific metrics (subtract baseline)
          const sessionCost = sessionBaseline
            ? Math.max(data.usage.totalCostUsd - sessionBaseline.cost, 0)
            : data.usage.totalCostUsd;
          const sessionTokens = sessionBaseline
            ? Math.max(data.usage.totalTokens - sessionBaseline.tokens, 0)
            : data.usage.totalTokens;
          const sessionCalls = sessionBaseline
            ? Math.max(data.usage.requestCount - sessionBaseline.calls, 0)
            : data.usage.requestCount;
          const duration = Math.round(
            (Date.now() - sessionStartTime.getTime()) / 1000,
          );
          const minutes = Math.floor(duration / 60);
          const seconds = duration % 60;

          // Build summary with budget context
          const parts = [
            `${formatTokens(sessionTokens)} tokens`,
            formatCost(sessionCost),
            `${sessionCalls} calls`,
            `${minutes}m${seconds}s`,
          ];

          // Cache hit rate
          const totalCacheRead = data.models.reduce(
            (s, m) => s + m.cacheReadTokens,
            0,
          );
          if (totalCacheRead > 0 && data.usage.inputTokens > 0) {
            const hitRate = Math.min(
              100,
              (totalCacheRead / data.usage.inputTokens) * 100,
            ).toFixed(0);
            parts.push(`🗄️${hitRate}%`);
          }

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

        // Per-call cost anomaly detection — rolling 24h window
        // Alert if any model's average cost/call exceeds $1 over the last 24h
        if (data && data.usage.totalCostUsd > 0.5) {
          for (const m of data.models) {
            const perCall =
              m.requestCount > 0 ? m.totalCostUsd / m.requestCount : 0;
            if (perCall > 1.0) {
              await client.app.log({
                body: {
                  service: "opencode-candela",
                  level: "warn",
                  message: `💸 Cost spike (24h): ${m.model} averaging ${formatCost(perCall)}/call (${m.requestCount} calls)`,
                },
              });
            }
          }
        }

        // ── Session analytics logging ──────────────────────────────────
        // NOTE: cost/models are from the 24h dashboard aggregate, not
        // session-scoped. This is a periodic snapshot for local trend
        // analysis. Session baseline subtraction gives a rough estimate.
        if (sessionId && sessionStartTime) {
          const sessionCost = sessionBaseline
            ? Math.max(
                (data?.usage.totalCostUsd ?? 0) - sessionBaseline.cost,
                0,
              )
            : (data?.usage.totalCostUsd ?? 0);
          const sessionDuration = Math.round(
            (Date.now() - sessionStartTime.getTime()) / 1000,
          );
          const modelsUsed =
            data?.models
              .filter((m) => m.requestCount > 0)
              .map((m) => m.model) ?? [];

          logSessionAnalytics({
            ts: new Date().toISOString(),
            sessionId,
            duration: sessionDuration,
            toolCalls: sessionToolCalls,
            totalCost: sessionCost,
            pluginVersion: "0.6.0",
            models: modelsUsed,
          });
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
