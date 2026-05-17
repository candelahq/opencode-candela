/**
 * opencode-candela — OpenCode plugin for Candela LLM observability.
 *
 * Hooks into OpenCode session lifecycle to provide:
 * - Session-scoped cost tracking with idle toasts
 * - Budget remaining warnings
 * - Candela proxy URL injection into shells
 * - Cost context injection during session compaction
 *
 * Gracefully no-ops if Candela is not running.
 */

import type { Plugin } from "@opencode-ai/plugin";
import { CandelaClient } from "./candela-client.js";

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

export const CandelaPlugin: Plugin = async ({ client, $ }) => {
  const candelaUrl =
    process.env.CANDELA_PROXY_URL || "http://localhost:8181";
  const candela = new CandelaClient(candelaUrl);

  // Check if Candela is alive on init
  const alive = await candela.isAlive();
  if (alive) {
    await client.app.log({
      body: {
        service: "opencode-candela",
        level: "info",
        message: `Connected to Candela at ${candelaUrl}`,
      },
    });

    // Check budget on startup — warn if low
    const budget = await candela.getBudgetRemaining();
    if (budget && budget.percentUsed > 80) {
      await client.app.log({
        body: {
          service: "opencode-candela",
          level: "warn",
          message: `⚠️ Budget ${budget.percentUsed.toFixed(0)}% used (${formatCost(budget.remainingUsd)} remaining)`,
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
     * Listen for events to track session lifecycle and show cost toasts.
     */
    event: async ({ event }) => {
      if (!alive) return;

      // Track session start
      if (event.type === "session.created") {
        sessionStartTime = new Date();
        sessionToolCalls = 0;
        // Reset health check in case Candela was started mid-use
        candela.resetHealth();
      }

      // Show cost summary when session goes idle
      if (event.type === "session.idle" && sessionStartTime) {
        const usage = await candela.getUsageSummary(1); // last hour
        if (usage && usage.requestCount > 0) {
          const duration = Math.round(
            (Date.now() - sessionStartTime.getTime()) / 1000
          );
          const minutes = Math.floor(duration / 60);
          const seconds = duration % 60;

          // Send notification via osascript on macOS
          const summary = [
            `${formatTokens(usage.totalTokens)} tokens`,
            formatCost(usage.totalCostUsd),
            `${usage.requestCount} calls`,
            `${minutes}m${seconds}s`,
          ].join(" · ");

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

        // Check budget after session
        const budget = await candela.getBudgetRemaining();
        if (budget && budget.percentUsed > 90) {
          try {
            await $`osascript -e ${"display notification \"" + formatCost(budget.remainingUsd) + " remaining (" + budget.percentUsed.toFixed(0) + "% used)\" with title \"Candela\" subtitle \"⚠️ Budget Warning\""}`;
          } catch {
            await client.app.log({
              body: {
                service: "opencode-candela",
                level: "warn",
                message: `⚠️ Budget: ${formatCost(budget.remainingUsd)} remaining (${budget.percentUsed.toFixed(0)}% used)`,
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
     * Inject cost context into compaction summaries so the LLM
     * retains awareness of how much the session has cost.
     */
    "experimental.session.compacting": async (_input, output) => {
      if (!alive) return;

      const usage = await candela.getUsageSummary(4); // last 4 hours
      if (usage && usage.requestCount > 0) {
        const breakdown = await candela.getModelBreakdown(4);
        const modelLines = (breakdown ?? [])
          .slice(0, 5)
          .map(
            (m) =>
              `  - ${m.model} (${m.provider}): ${formatTokens(m.totalTokens)} tokens, ${formatCost(m.totalCostUsd)}`
          )
          .join("\n");

        output.context.push(
          `## Candela Cost Context\n` +
            `This session has used ${formatTokens(usage.totalTokens)} tokens ` +
            `(${formatCost(usage.totalCostUsd)}) across ${usage.requestCount} LLM calls.\n` +
            `${modelLines ? `\nModel breakdown:\n${modelLines}` : ""}\n` +
            `Be mindful of token usage — prefer concise responses when possible.`
        );
      }

      const budget = await candela.getBudgetRemaining();
      if (budget && budget.remainingUsd > 0) {
        output.context.push(
          `Budget remaining: ${formatCost(budget.remainingUsd)} of ${formatCost(budget.totalBudgetUsd)} ` +
            `(${budget.percentUsed.toFixed(0)}% used).`
        );
      }
    },
  };
};
