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
import { join } from "node:path";
import type { TuiPlugin } from "@opencode-ai/plugin/tui";
import { CandelaClient } from "./candela-client.js";
import { discoverCandelaUrl } from "./discover.js";
import {
  resolveSettings,
  toggleQuietMode,
  updateDailyCostGoal,
  updateSessionCostCap,
  updateSessionTag,
} from "./settings.js";

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
  /** Session input tokens — for context window gauge */
  let sessionInputTokens = 0;
  let prevInputTokens: number | null = null;
  /** 24h input token count from last refresh — avoids extra API call */
  let lastInputTokens24h = 0;

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
      lastInputTokens24h = data.usage.inputTokens ?? 0;

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

        // Session tag
        const tagLine: string[] = [];
        const currentTag = resolveSettings().sessionTag;
        if (currentTag) {
          tagLine.push(`🏷️ ${currentTag}`);
        }

        // Cost forecast — extrapolate session cost over estimated remaining time
        const forecastLine: string[] = [];
        if (sessionCalls >= 3 && sessionCostUsd > 0) {
          // Estimate cost/call, project for 10 more calls (reasonable session)
          const costPerCall = sessionCostUsd / sessionCalls;
          const projected = sessionCostUsd + costPerCall * 10;
          forecastLine.push(
            `📈 Forecast: ~${formatCost(projected)} if 10 more calls`,
          );
        }

        // Budget pacing — estimate when budget will run out
        const pacingLine: string[] = [];
        if (
          budgetFraction !== null &&
          budgetRemaining !== null &&
          budgetFraction > 0 &&
          budgetFraction < 1
        ) {
          const hoursElapsed = Math.max(1, new Date().getUTCHours() || 1);
          const fractionPerHour = budgetFraction / hoursElapsed;
          const hoursLeft =
            fractionPerHour > 0 ? (1 - budgetFraction) / fractionPerHour : 999;
          if (hoursLeft <= 8) {
            const exhaustTime = new Date(Date.now() + hoursLeft * 3600000);
            const timeStr = exhaustTime.toLocaleTimeString("en-US", {
              hour: "numeric",
              minute: "2-digit",
            });
            pacingLine.push(
              `⏱️ At current rate, budget exhausted by ${timeStr}`,
            );
          }
        }

        // Context window gauge
        const contextLine: string[] = [];
        if (sessionInputTokens > 0) {
          const kTok = (sessionInputTokens / 1000).toFixed(0);
          // Estimate capacity based on common context windows
          const capacity = 128_000; // reasonable default
          const pct = Math.round((sessionInputTokens / capacity) * 100);
          const bar = pct >= 80 ? "🟥" : pct >= 60 ? "🟨" : "🟩";
          contextLine.push(`📏 Context: ${kTok}k tokens ${bar} ~${pct}%`);
          if (pct >= 80) {
            contextLine.push("  ⚠️ Compaction likely soon");
          }
        }

        // Daily cost goal progress
        const goalLine: string[] = [];
        const settings = resolveSettings();
        if (settings.dailyCostGoal !== null && settings.dailyCostGoal > 0) {
          const goalPct = Math.round(
            (totalCost24h / settings.dailyCostGoal) * 100,
          );
          const goalEmoji = goalPct >= 100 ? "🟥" : goalPct >= 75 ? "🟨" : "🟩";
          goalLine.push(
            `🎯 Goal: ${formatCost(totalCost24h)}/${formatCost(settings.dailyCostGoal)} ${goalEmoji} ${goalPct}%`,
          );
        }

        return [
          budgetLine,
          costLine,
          ...cacheLine,
          ...tagLine,
          ...activityLine,
          ...forecastLine,
          ...contextLine,
          ...goalLine,
          ...pacingLine,
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
        if (lastResponseCost !== null && lastResponseCost > 0) {
          parts.push(`↳${formatCost(lastResponseCost)}`);
        }
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

      // Track input token deltas for context gauge
      if (prevInputTokens !== null) {
        sessionInputTokens += Math.max(0, lastInputTokens24h - prevInputTokens);
      }
      prevInputTokens = lastInputTokens24h;

      // Dynamic threshold: max($0.10, 1% of daily budget)
      // Use raw budgetFraction to avoid rounding error from budgetPct
      const dynamicThreshold =
        budgetRemaining !== null &&
        budgetFraction !== null &&
        budgetFraction < 1
          ? Math.max(0.1, (budgetRemaining / (1 - budgetFraction)) * 0.01)
          : 0.1;

      if (lastResponseCost >= dynamicThreshold) {
        const settings = resolveSettings();
        // In quiet mode, only show as warning (skip info-level cost toasts)
        if (!settings.quietMode || lastResponseCost >= dynamicThreshold * 3) {
          api.ui.toast({
            title: "💸 Expensive Response",
            message: `That response: ${formatCost(lastResponseCost)} · Session total: ${formatCost(sessionCostUsd)}`,
            variant:
              lastResponseCost >= dynamicThreshold * 3 ? "warning" : "info",
          });
        }
      }

      // Session cost cap warning
      const capSettings = resolveSettings();
      if (
        capSettings.sessionCostCap !== null &&
        sessionCostUsd >= capSettings.sessionCostCap
      ) {
        api.ui.toast({
          title: "🛑 Session Cost Cap Reached",
          message: `Session cost (${formatCost(sessionCostUsd)}) has reached your cap of ${formatCost(capSettings.sessionCostCap)}.\nConsider wrapping up or adjusting with CANDELA_SESSION_CAP.`,
          variant: "error",
        });
      } else if (
        capSettings.sessionCostCap !== null &&
        sessionCostUsd >= capSettings.sessionCostCap * 0.8
      ) {
        api.ui.toast({
          title: "⚠️ Approaching Session Cap",
          message: `Session cost: ${formatCost(sessionCostUsd)} / ${formatCost(capSettings.sessionCostCap)} cap`,
          variant: "warning",
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
      // Budget warnings always show (even in quiet mode)
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
        description: "Export current session cost data as JSON and CSV",
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
          const exportDir = join(homedir(), ".config", "opencode");
          mkdirSync(exportDir, { recursive: true });

          // JSON export
          const jsonPath = join(exportDir, "candela-export.json");
          writeFileSync(jsonPath, JSON.stringify(exportData, null, 2), "utf-8");

          // CSV export — models breakdown
          const csvLines = [
            "model,cost_usd,calls,cost_per_call",
            ...topModels.map(
              (m) =>
                `${m.model},${m.cost.toFixed(4)},${m.calls},${m.calls > 0 ? (m.cost / m.calls).toFixed(4) : "0"}`,
            ),
            "",
            "metric,value",
            `total_cost_24h,${totalCost24h.toFixed(4)}`,
            `session_cost,${sessionCostUsd.toFixed(4)}`,
            `session_calls,${sessionCalls}`,
            `budget_pct,${budgetPct ?? "N/A"}`,
            `budget_remaining,${budgetRemaining?.toFixed(2) ?? "N/A"}`,
            `cache_hit_rate,${cacheHitRate?.toFixed(1) ?? "N/A"}`,
            `exported_at,${exportData.exportedAt}`,
          ];
          const csvPath = join(exportDir, "candela-export.csv");
          writeFileSync(csvPath, csvLines.join("\n"), "utf-8");

          api.ui.toast({
            title: "📦 Exported",
            message: `JSON: ${jsonPath}\nCSV: ${csvPath}`,
            variant: "info",
          });
        },
      },
      {
        title: "Candela: Set Daily Cost Goal",
        value: "candela.goal",
        description: "Set a daily cost goal (e.g. /goal 20 = $20/day)",
        category: "Candela",
        slash: {
          name: "goal",
        },
        onSelect: async () => {
          const currentGoal = resolveSettings().dailyCostGoal;
          if (currentGoal !== null) {
            api.ui.toast({
              title: "🎯 Daily Goal",
              message: `Current goal: ${formatCost(currentGoal)}/day\nSpent today: ${formatCost(totalCost24h)}\n\nTo change: set CANDELA_DAILY_GOAL=<amount>\nTo clear: set CANDELA_DAILY_GOAL=0`,
              variant: "info",
            });
          } else {
            // Set a default goal based on current usage
            const suggestedGoal = Math.max(5, Math.ceil(totalCost24h * 1.5));
            updateDailyCostGoal(suggestedGoal);
            api.ui.toast({
              title: "🎯 Goal Set",
              message: `Daily goal set to ${formatCost(suggestedGoal)}\nBased on current usage: ${formatCost(totalCost24h)}\n\nChange with CANDELA_DAILY_GOAL env var`,
              variant: "info",
            });
          }
        },
      },
      {
        title: "Candela: Toggle Quiet Mode",
        value: "candela.quiet",
        description: "Suppress info toasts — only show warnings and errors",
        category: "Candela",
        slash: {
          name: "quiet",
          aliases: ["shh"],
        },
        onSelect: () => {
          const updated = toggleQuietMode();
          api.ui.toast({
            title: updated.quietMode ? "🔇 Quiet Mode On" : "🔔 Quiet Mode Off",
            message: updated.quietMode
              ? "Only warnings and errors will show as toasts."
              : "All notifications restored.",
            variant: "info",
          });
        },
      },
      {
        title: "Candela: Tag Session",
        value: "candela.tag",
        description:
          "Tag this session for cost attribution (e.g. 'refactoring')",
        category: "Candela",
        slash: {
          name: "tag",
          aliases: ["label"],
        },
        onSelect: () => {
          const current = resolveSettings().sessionTag;
          if (current) {
            // Clear existing tag
            updateSessionTag(null);
            api.ui.toast({
              title: "🏷️ Tag Cleared",
              message: `Removed tag "${current}"`,
              variant: "info",
            });
          } else {
            // Can't prompt in TUI — set a default tag based on git branch
            let branchTag = "untagged";
            try {
              branchTag =
                execFileSync("git", ["branch", "--show-current"], {
                  encoding: "utf-8",
                  timeout: 2000,
                }).trim() || "untagged";
            } catch {
              // git not available
            }
            updateSessionTag(branchTag);
            api.ui.toast({
              title: "🏷️ Tagged",
              message: `Session tagged: "${branchTag}"\nChange with CANDELA_SESSION_TAG env var\nRun /tag again to clear`,
              variant: "info",
            });
          }
        },
      },
      {
        title: "Candela: Set Session Cost Cap",
        value: "candela.cap",
        description:
          "Set a per-session cost limit (warns at 80%, alerts at 100%)",
        category: "Candela",
        slash: {
          name: "cap",
        },
        onSelect: () => {
          const current = resolveSettings().sessionCostCap;
          if (current !== null) {
            api.ui.toast({
              title: "🛑 Session Cap",
              message: `Current cap: ${formatCost(current)}\nSession cost: ${formatCost(sessionCostUsd)}\n\nChange with CANDELA_SESSION_CAP=<amount>\nSet to 0 to clear`,
              variant: "info",
            });
          } else {
            // Auto-set based on current session cost
            const suggestedCap = Math.max(
              10,
              Math.ceil(sessionCostUsd * 3) || 10,
            );
            updateSessionCostCap(suggestedCap);
            api.ui.toast({
              title: "🛑 Cap Set",
              message: `Session cost cap set to ${formatCost(suggestedCap)}\nWarns at 80%, alerts at 100%\n\nChange with CANDELA_SESSION_CAP env var`,
              variant: "info",
            });
          }
        },
      },
    ]);
  }
};
