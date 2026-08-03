/**
 * Candela TUI plugin for OpenCode.
 *
 * Renders cost/budget information in the OpenCode terminal UI:
 * - Sidebar content: Live cost dashboard with budget, top models, session cost
 * - Sidebar footer: Quick budget status line
 * - Session prompt right: Inline cost indicator next to the prompt
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { TuiPlugin } from "@opencode-ai/plugin/tui";
import { CandelaClient } from "./candela-client.js";
import { discoverCandelaUrl } from "./discover.js";

import { formatCost } from "./utils.js";

export const tui: TuiPlugin = async (api) => {
  const candelaUrl = discoverCandelaUrl();
  const candela = new CandelaClient(candelaUrl);

  // Check connectivity
  const alive = await candela.isAlive();
  if (!alive) return;

  // ── State ─────────────────────────────────────────────────────────────────
  // Poll Candela every 30s for dashboard data
  let budgetPct: number | null = null;
  let budgetRemaining: number | null = null;
  let budgetEmoji = "🟢";
  let totalCost24h = 0;
  let topModels: Array<{ model: string; cost: number; calls: number }> = [];
  let lastRefresh = 0;
  let sessionCalls = 0;
  let sessionCostUsd = 0;
  let cacheHitRate: number | null = null;
  /** Raw 0.0–1.0 fraction for accurate threshold math (avoids rounding error). */
  let budgetFraction: number | null = null;

  // Per-response cost/call delta tracking — accumulated on each session.idle
  let prevTotalCost: number | null = null;
  let lastResponseCost: number | null = null;

  async function refresh(force = false) {
    const now = Date.now();
    if (!force && now - lastRefresh < 15_000) return; // Debounce 15s
    lastRefresh = now;

    try {
      const data = await candela.getDashboardData(24);
      if (!data) return;

      if (data.budget) {
        budgetPct = Math.round(data.budget.usedFraction * 100);
        budgetRemaining = data.budget.remainingUsd;
        budgetFraction = data.budget.usedFraction;
        budgetEmoji =
          data.budget.usedFraction >= 0.9
            ? "🔴"
            : data.budget.usedFraction >= 0.6
              ? "🟡"
              : "🟢";
      } else {
        budgetPct = null;
        budgetRemaining = null;
        budgetFraction = null;
        budgetEmoji = "🟢";
      }

      totalCost24h = data.usage.totalCostUsd ?? 0;

      if (data.models) {
        topModels = data.models
          .sort((a, b) => b.totalCostUsd - a.totalCostUsd)
          .slice(0, 5)
          .map((m) => ({
            model: m.model,
            cost: m.totalCostUsd,
            calls: m.requestCount,
          }));

        // Cache hit rate across all models
        const totalCacheRead = data.models.reduce(
          (s, m) => s + m.cacheReadTokens,
          0,
        );
        if (totalCacheRead > 0 && data.usage.inputTokens > 0) {
          cacheHitRate = Math.min(
            100,
            (totalCacheRead / data.usage.inputTokens) * 100,
          );
        } else {
          cacheHitRate = null;
        }
      }
    } catch {
      // Non-fatal — stale data is better than no data
    }
  }

  // Initial load
  await refresh();
  // Seed delta tracking baseline so first response has a delta
  prevTotalCost = totalCost24h;

  // Background polling
  const interval = setInterval(refresh, 30_000);
  api.lifecycle.onDispose(() => clearInterval(interval));

  // ── Slots ─────────────────────────────────────────────────────────────────

  api.slots.register({
    slots: {
      // Sidebar content — main cost dashboard
      sidebar_content: () => {
        // Refresh on render
        refresh();

        const budgetLine =
          budgetPct === null || budgetRemaining === null
            ? "Budget: unavailable"
            : `${budgetEmoji} Budget: ${budgetPct}% used · ${formatCost(budgetRemaining)} left`;
        const costLine = `💰 24h spend: ${formatCost(totalCost24h)}`;

        const modelLines = topModels.length
          ? [
              "",
              "📊 Top models (24h):",
              ...topModels.map(
                (m) => `  ${m.model}: ${formatCost(m.cost)} (${m.calls} calls)`,
              ),
            ]
          : [];

        // Cache effectiveness
        const cacheLine =
          cacheHitRate !== null
            ? [`🗄️ Cache hit rate: ${cacheHitRate.toFixed(0)}%`]
            : [];

        // Session activity
        const activityLine =
          sessionCalls > 0
            ? [
                `⚡ Session: ${formatCost(sessionCostUsd)} · ${sessionCalls} calls`,
              ]
            : [];

        return [
          budgetLine,
          costLine,
          ...cacheLine,
          ...activityLine,
          ...modelLines,
        ].join("\n") as unknown as null;
      },

      // Sidebar footer — compact budget status
      sidebar_footer: () => {
        return (budgetRemaining === null
          ? "Budget: unavailable"
          : `${budgetEmoji} ${formatCost(budgetRemaining)} remaining`) as unknown as null;
      },

      // Session prompt right — inline cost indicator next to the input
      session_prompt_right: () => {
        refresh();
        if (sessionCalls === 0 && budgetPct === null) return null;

        const parts: string[] = [];
        // Show last response cost if available
        if (lastResponseCost !== null && lastResponseCost > 0) {
          parts.push(`↳${formatCost(lastResponseCost)}`);
        }
        if (sessionCostUsd > 0) {
          parts.push(formatCost(sessionCostUsd));
        }
        if (sessionCalls > 0) {
          parts.push(`${sessionCalls} calls`);
        }
        if (budgetPct !== null) {
          parts.push(`${budgetEmoji}${budgetPct}%`);
        }

        if (parts.length === 0) return null;
        return parts.join(" · ") as unknown as null;
      },

      // Status bar — persistent cost ticker at the bottom
      status_bar: () => {
        refresh();
        const parts: string[] = [];
        parts.push(`🕯️ ${formatCost(totalCost24h)} 24h`);
        if (budgetPct !== null) {
          parts.push(`${budgetEmoji}${budgetPct}%`);
        }
        parts.push(`${sessionCalls} calls`);
        if (cacheHitRate !== null) {
          parts.push(`🗄️${cacheHitRate.toFixed(0)}%`);
        }
        return parts.join(" · ") as unknown as null;
      },
    },
  });

  // ── Toast on budget thresholds ────────────────────────────────────────────

  let lastToastThreshold = 0;

  api.event.on("session.idle", async () => {
    // Force refresh to get fresh data for per-response delta
    await refresh(true);

    // Accumulate per-response deltas instead of subtracting a baseline.
    // This avoids undercounting when older entries age out of the 24h window.
    if (prevTotalCost !== null) {
      lastResponseCost = Math.max(0, totalCost24h - prevTotalCost);
      sessionCostUsd += lastResponseCost;
      sessionCalls++;

      // Dynamic threshold: max($0.10, 1% of daily budget)
      // Use raw budgetFraction to avoid rounding error from budgetPct
      const dynamicThreshold =
        budgetRemaining !== null &&
        budgetFraction !== null &&
        budgetFraction < 1
          ? Math.max(0.1, (budgetRemaining / (1 - budgetFraction)) * 0.01)
          : 0.1;

      if (lastResponseCost >= dynamicThreshold) {
        api.ui.toast({
          title: "💸 Expensive Response",
          message: `That response: ${formatCost(lastResponseCost)} · Session total: ${formatCost(sessionCostUsd)}`,
          variant:
            lastResponseCost >= dynamicThreshold * 3 ? "warning" : "info",
        });
      }
    }
    prevTotalCost = totalCost24h;

    const threshold =
      budgetPct != null && budgetPct >= 100
        ? 100
        : budgetPct != null && budgetPct >= 90
          ? 90
          : budgetPct != null && budgetPct >= 80
            ? 80
            : 0;

    if (threshold === 0) {
      lastToastThreshold = 0;
    }

    if (threshold > 0 && threshold > lastToastThreshold) {
      lastToastThreshold = threshold;
      const variant: "info" | "warning" | "error" =
        threshold >= 100 ? "error" : threshold >= 90 ? "warning" : "info";
      api.ui.toast({
        title: `${budgetEmoji} Budget ${threshold}%`,
        message:
          threshold >= 100
            ? `Budget exhausted! ${formatCost(budgetRemaining ?? 0)} remaining.`
            : `You've used ${budgetPct}% of your budget. ${formatCost(budgetRemaining ?? 0)} remaining.`,
        variant,
      });
    }
  });

  // ── Slash Commands ──────────────────────────────────────────────────────────

  if (api.command) {
    api.command.register(() => [
      {
        title: "Candela: Cost Summary",
        value: "candela.cost",
        description: "Show current session and daily cost breakdown",
        category: "Candela",
        slash: {
          name: "cost",
          aliases: ["spend"],
        },
        onSelect: async () => {
          await refresh();
          // Inject a user message that triggers the cost summary tool
          api.ui.toast({
            title: "💰 Cost Summary",
            message: `Today: ${formatCost(totalCost24h)} · Session: ${formatCost(sessionCostUsd)} (${sessionCalls} calls)`,
            variant: "info",
          });
        },
      },
      {
        title: "Candela: Budget Status",
        value: "candela.budget",
        description: "Show budget remaining, grants, and forecast",
        category: "Candela",
        slash: {
          name: "budget",
          aliases: ["remaining"],
        },
        onSelect: async () => {
          await refresh();
          const msg =
            budgetPct !== null && budgetRemaining !== null
              ? `${budgetEmoji} ${budgetPct}% used · ${formatCost(budgetRemaining)} remaining`
              : "Budget data unavailable. Is Candela running?";
          api.ui.toast({
            title: "📊 Budget",
            message: msg,
            variant: budgetPct !== null && budgetPct >= 90 ? "warning" : "info",
          });
        },
      },
      {
        title: "Candela: Top Models by Usage",
        value: "candela.models",
        description: "Show top models by usage over the last 24h",
        category: "Candela",
        slash: {
          name: "models",
        },
        onSelect: async () => {
          await refresh();
          if (topModels.length === 0) {
            api.ui.toast({
              title: "📋 Models",
              message: "No model usage data yet.",
              variant: "info",
            });
            return;
          }
          const lines = topModels
            .map((m) => `${m.model}: ${formatCost(m.cost)} (${m.calls})`)
            .join("\n");
          api.ui.toast({
            title: "📋 Top Models (24h)",
            message: lines,
            variant: "info",
          });
        },
      },
      {
        title: "Candela: Open Dashboard",
        value: "candela.dashboard",
        description: "Open the Candela web dashboard in your browser",
        category: "Candela",
        slash: {
          name: "dashboard",
          aliases: ["dash"],
        },
        onSelect: () => {
          // Derive dashboard URL from discovered Candela URL
          const dashboardUrl = `${candelaUrl.replace(/\/$/, "")}/_local/`;
          try {
            execFileSync("open", [dashboardUrl]);
            api.ui.toast({
              title: "📊 Dashboard",
              message: `Opening ${dashboardUrl} in your browser...`,
              variant: "info",
            });
          } catch {
            api.ui.toast({
              title: "📊 Dashboard",
              message: `Could not open browser. Visit ${dashboardUrl}`,
              variant: "warning",
            });
          }
        },
      },
      {
        title: "Candela: Export Session Data",
        value: "candela.export",
        description: "Export current session cost data as JSON",
        category: "Candela",
        slash: {
          name: "export",
          aliases: ["dump"],
        },
        onSelect: async () => {
          await refresh(true);
          const exportData = {
            exportedAt: new Date().toISOString(),
            period: "24h",
            totalCost: totalCost24h,
            sessionCost: sessionCostUsd,
            sessionCalls,
            budgetPct,
            budgetRemaining,
            cacheHitRate,
            models: topModels,
          };
          // Write to ~/.config/opencode/candela-export.json
          const exportPath = join(
            homedir(),
            ".config",
            "opencode",
            "candela-export.json",
          );
          const dir = dirname(exportPath);
          mkdirSync(dir, { recursive: true });
          writeFileSync(
            exportPath,
            JSON.stringify(exportData, null, 2),
            "utf-8",
          );
          api.ui.toast({
            title: "📦 Exported",
            message: `Session data saved to ${exportPath}`,
            variant: "info",
          });
        },
      },
    ]);
  }
};
