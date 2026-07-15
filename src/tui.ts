/**
 * Candela TUI plugin for OpenCode.
 *
 * Renders cost/budget information in the OpenCode terminal UI:
 * - Sidebar content: Live cost dashboard with budget, top models, session cost
 * - Sidebar footer: Quick budget status line
 * - Session prompt right: Inline cost indicator next to the prompt
 */

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
  let budgetPct = 0;
  let budgetRemaining = 0;
  let budgetEmoji = "🟢";
  let totalCost24h = 0;
  let topModels: Array<{ model: string; cost: number; calls: number }> = [];
  let lastRefresh = 0;

  async function refresh() {
    const now = Date.now();
    if (now - lastRefresh < 15_000) return; // Debounce 15s
    lastRefresh = now;

    try {
      const data = await candela.getDashboardData(24);
      if (!data) return;

      if (data.budget) {
        budgetPct = Math.round(data.budget.usedFraction * 100);
        budgetRemaining = data.budget.remainingUsd;
        budgetEmoji =
          data.budget.usedFraction >= 0.9
            ? "🔴"
            : data.budget.usedFraction >= 0.6
              ? "🟡"
              : "🟢";
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
      }
    } catch {
      // Non-fatal — stale data is better than no data
    }
  }

  // Initial load
  await refresh();

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

        const budgetLine = `${budgetEmoji} Budget: ${budgetPct}% used · ${formatCost(budgetRemaining)} left`;
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

        return [budgetLine, costLine, ...modelLines].join(
          "\n",
        ) as unknown as null;
      },

      // Sidebar footer — compact budget status
      sidebar_footer: () => {
        return `${budgetEmoji} ${formatCost(budgetRemaining)} remaining` as unknown as null;
      },
    },
  });

  // ── Toast on budget thresholds ────────────────────────────────────────────

  let lastToastThreshold = 0;

  api.event.on("session.idle", async () => {
    await refresh();

    const threshold =
      budgetPct >= 100 ? 100 : budgetPct >= 90 ? 90 : budgetPct >= 80 ? 80 : 0;

    if (threshold > 0 && threshold > lastToastThreshold) {
      lastToastThreshold = threshold;
      const variant: "info" | "warning" | "error" =
        threshold >= 100 ? "error" : threshold >= 90 ? "warning" : "info";
      api.ui.toast({
        title: `${budgetEmoji} Budget ${threshold}%`,
        message:
          threshold >= 100
            ? `Budget exhausted! ${formatCost(budgetRemaining)} remaining.`
            : `You've used ${budgetPct}% of your budget. ${formatCost(budgetRemaining)} remaining.`,
        variant,
      });
    }
  });
};
