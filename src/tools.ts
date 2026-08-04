/**
 * Candela custom tools for OpenCode.
 *
 * These tools are registered with OpenCode's plugin system and become
 * available to the AI agent during coding sessions. Users can ask
 * natural language questions like "how much have I spent today?" and
 * the agent will call these tools to get real-time cost data.
 *
 * Phase 1 tools:
 * - candela_cost_summary: Session/daily cost breakdown with model detail
 * - candela_check_budget: Budget status, grants, and remaining balance
 * - candela_traces: Recent LLM traces with cost and latency
 */

import { tool } from "@opencode-ai/plugin";
import type { CandelaClient } from "./candela-client.js";
import { makeTimeRange, makeTimeRangeFromDate } from "./candela-client.js";
import {
  deleteEntry,
  getEntry,
  listEntries,
  setEntry,
} from "./memory-store.js";
import {
  getSettingsPath,
  resolveSettings,
  updateSmartRouting,
} from "./settings.js";
import {
  budgetBar,
  formatCost,
  formatDuration,
  formatTokens,
} from "./utils.js";

function formatForecastTime(hoursUntilExhaustion: number): string {
  if (hoursUntilExhaustion <= 0) {
    return "Budget already exhausted";
  }
  if (hoursUntilExhaustion > 168) {
    return "Budget runway: > 7 days";
  }
  const now = new Date();
  const exhaustTime = new Date(now.getTime() + hoursUntilExhaustion * 3600000);

  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const isTomorrow =
    exhaustTime.getDate() === tomorrow.getDate() &&
    exhaustTime.getMonth() === tomorrow.getMonth();

  const timeStr = exhaustTime.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });

  if (isTomorrow) {
    return `tomorrow at ${timeStr}`;
  }

  const h = Math.floor(hoursUntilExhaustion);
  const m = Math.round((hoursUntilExhaustion - h) * 60);
  if (h > 0) {
    return `in ~${h}h (by ${timeStr})`;
  }
  return `in ${m}m (by ${timeStr})`;
}

// ── Trace types ───────────────────────────────────────────────────────────────

interface TraceRecord {
  traceId: string;
  model: string;
  provider: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number;
  timestamp: string;
  statusCode: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

// ── Tool Factories ────────────────────────────────────────────────────────────

/**
 * Session state accessor — provided by index.ts so tools can query
 * session-scoped data without owning the lifecycle.
 */
export interface SessionState {
  /** When the current session started, or null if no active session. */
  startTime: Date | null;
  /** Number of tool calls in this session. */
  toolCalls: number;
  /** Per-tool call counts for this session. */
  toolUsage: Record<string, number>;
  /** OpenCode session ID, or null if no active session. */
  id: string | null;
}

/**
 * Create all Candela custom tools bound to a CandelaClient instance.
 *
 * Tools are created as a factory so they share the same client
 * (and its cache/health state) as the rest of the plugin.
 */
export function createCandelaTools(
  candela: CandelaClient,
  candelaUrl: string,
  getSession: () => SessionState,
) {
  // ── candela_cost_summary ──────────────────────────────────────────────────

  const costSummary = tool({
    description:
      "Get a summary of LLM costs for the current session, time period, team, or tool usage. " +
      "Shows total spend, token usage, request count, and per-model breakdown. " +
      "Use 'team' scope for team leaderboard, 'tools' for Candela tool usage stats. " +
      "Use this when the user asks about costs, spending, usage, or tokens.",
    args: {
      scope: tool.schema
        .enum(["session", "1h", "24h", "7d", "team", "tools", "efficiency"])
        .default("24h")
        .describe(
          "Time period to analyze. Use 'session' for current coding session, 'team' for team leaderboard, 'tools' for tool usage telemetry, 'efficiency' for model efficiency.",
        ),
      model_filter: tool.schema
        .string()
        .optional()
        .describe(
          "Optional model name filter (e.g. 'claude-sonnet-4-20250514'). Shows only costs for this model.",
        ),
    },
    async execute(args) {
      if (args.scope === "team") {
        const users = await candela.getTeamLeaderboard(24);
        if (!users || users.length === 0)
          return "No team usage data available.";
        const lines = ["## Team Usage (24h)", ""];
        for (const u of users) {
          lines.push(
            `**${u.displayName || u.email || u.userId}**: ${formatCost(u.costUsd)} | ${u.callCount} calls | ${u.totalTokens.toLocaleString()} tokens | top model: ${u.topModel}`,
          );
        }
        return lines.join("\n");
      }

      if (args.scope === "tools") {
        const session = getSession();
        const usage = session.toolUsage;
        const entries = Object.entries(usage).sort((a, b) => b[1] - a[1]);
        if (entries.length === 0) {
          return "No Candela tool calls this session yet.";
        }
        const maxCount = entries[0][1];
        const lines = [
          `## 🔧 Tool Usage (session: ${session.toolCalls} total calls)`,
          "",
        ];
        for (const [name, count] of entries) {
          const barLen =
            maxCount > 0 ? Math.max(1, Math.round((count / maxCount) * 20)) : 1;
          const bar = "█".repeat(barLen);
          const pct =
            session.toolCalls > 0
              ? ((count / session.toolCalls) * 100).toFixed(0)
              : "0";
          lines.push(`- **${name}**: ${count} calls (${pct}%) ${bar}`);
        }
        return lines.join("\n");
      }

      if (args.scope === "efficiency") {
        const data = await candela.getDashboardData(24);
        if (!data?.models || data.models.length === 0) {
          return "No model usage data available.";
        }
        const models = data.models
          .filter((m) => m.requestCount > 0)
          .sort((a, b) => {
            const aCostPerCall = a.totalCostUsd / a.requestCount;
            const bCostPerCall = b.totalCostUsd / b.requestCount;
            return aCostPerCall - bCostPerCall; // cheapest first
          });
        if (models.length === 0) return "No model usage data available.";

        const lines = ["## 📊 Model Efficiency (24h)", ""];
        for (const m of models) {
          const costPerCall = m.totalCostUsd / m.requestCount;
          const tokensPerCall = Math.round(
            m.totalTokens / m.requestCount,
          );
          const cacheRate =
            m.totalTokens > 0
              ? Math.round((m.cacheReadTokens / m.totalTokens) * 100)
              : 0;
          lines.push(
            `- **${m.model}**: ${formatCost(costPerCall)}/call · ${tokensPerCall.toLocaleString()} tok/call · ${cacheRate}% cache · ${m.requestCount} calls · ${formatCost(m.totalCostUsd)} total`,
          );
        }

        // Add recommendation if there's a big cost gap
        if (models.length >= 2) {
          const cheapest = models[0];
          const priciest = models[models.length - 1];
          const cheapCPC = cheapest.totalCostUsd / cheapest.requestCount;
          const priceCPC = priciest.totalCostUsd / priciest.requestCount;
          if (priceCPC > cheapCPC * 3) {
            const savings = (priceCPC - cheapCPC) * priciest.requestCount;
            lines.push("");
            lines.push(
              `💡 Switching ${priciest.model} calls to ${cheapest.model} could save ~${formatCost(savings)}/day`,
            );
          }
        }
        return lines.join("\n");
      }

      if (args.scope === "session") {
        const session = getSession();
        if (!session.startTime) {
          return {
            title: "No Active Session",
            output:
              "No active session detected. Session tracking starts when you begin a conversation.",
          };
        }

        const traces = await fetchSessionTraces(candelaUrl, session.startTime);
        if (!traces) {
          return {
            title: "Candela Unavailable",
            output:
              "Could not fetch session data. Make sure Candela is running.",
          };
        }

        if (traces.length === 0) {
          const elapsed = formatSessionDuration(session.startTime);
          return {
            title: "No Session Costs",
            output: `Session started ${elapsed} ago but no LLM calls recorded yet.`,
          };
        }

        const totalCost = traces.reduce((sum, t) => sum + t.costUsd, 0);
        const totalInput = traces.reduce((sum, t) => sum + t.inputTokens, 0);
        const totalOutput = traces.reduce((sum, t) => sum + t.outputTokens, 0);
        const totalCacheRead = traces.reduce(
          (sum, t) => sum + t.cacheReadTokens,
          0,
        );
        const avgLatency =
          traces.reduce((sum, t) => sum + t.latencyMs, 0) / traces.length;
        const elapsed = formatSessionDuration(session.startTime);

        const outLines = [
          `## Session Cost (${elapsed})`,
          "",
          session.id ? `**Session**: \`${session.id.slice(0, 8)}...\`` : "",
          "",
          `| Metric | Value |`,
          `|--------|-------|`,
          `| Total Cost | ${formatCost(totalCost)} |`,
          `| LLM Calls | ${traces.length} |`,
          `| Input Tokens | ${formatTokens(totalInput)} |`,
          `| Output Tokens | ${formatTokens(totalOutput)} |`,
          `| Avg Latency | ${formatDuration(avgLatency)} |`,
          `| Cost/Call | ${formatCost(totalCost / traces.length)} |`,
        ];

        if (totalCacheRead > 0 && totalInput > 0) {
          const hitRate = Math.min(
            100,
            (totalCacheRead / totalInput) * 100,
          ).toFixed(0);
          outLines.push(`| Cache Hit Rate | ${hitRate}% |`);
        }

        let filteredTraces = traces;
        if (args.model_filter) {
          const filter = args.model_filter.toLowerCase();
          filteredTraces = traces.filter(
            (t) =>
              (t.model || "").toLowerCase().includes(filter) ||
              (t.provider || "").toLowerCase().includes(filter),
          );
        }

        const byModel = new Map<
          string,
          { cost: number; calls: number; tokens: number }
        >();
        for (const t of filteredTraces) {
          const key = t.model || "unknown";
          const existing = byModel.get(key) ?? { cost: 0, calls: 0, tokens: 0 };
          existing.cost += t.costUsd;
          existing.calls += 1;
          existing.tokens += t.inputTokens + t.outputTokens;
          byModel.set(key, existing);
        }

        if (byModel.size > 0) {
          outLines.push(
            "",
            "### Per-Model Breakdown",
            "",
            "| Model | Cost | Calls | Tokens |",
            "|-------|------|-------|--------|",
          );
          const sorted = [...byModel.entries()].sort(
            (a, b) => b[1].cost - a[1].cost,
          );
          for (const [model, stats] of sorted) {
            outLines.push(
              `| ${model} | ${formatCost(stats.cost)} | ${stats.calls} | ${formatTokens(stats.tokens)} |`,
            );
          }
        }

        const data = await candela.getDashboardData(24);
        if (data?.budget) {
          const b = data.budget;
          outLines.push(
            "",
            `**Budget**: ${formatCost(b.remainingUsd)} remaining of ${formatCost(b.limitUsd)} (${b.percentUsed.toFixed(0)}% used)`,
          );
        }

        return {
          title: `Session: ${formatCost(totalCost)} (${traces.length} calls, ${elapsed})`,
          output: outLines.join("\n"),
        };
      }

      const hours = args.scope === "1h" ? 1 : args.scope === "7d" ? 168 : 24;
      const data = await candela.getDashboardData(hours);
      if (!data) {
        return {
          title: "Candela Unavailable",
          output:
            "Candela server is not reachable. Make sure `candela` is running locally or set CANDELA_PROXY_URL.",
        };
      }

      const { usage, models } = data;

      if (usage.requestCount === 0) {
        return {
          title: "No Usage",
          output: `No LLM calls recorded in the last ${hours} hour(s).`,
        };
      }

      let filteredModels = models;
      if (args.model_filter) {
        const filter = args.model_filter.toLowerCase();
        filteredModels = models.filter(
          (m) =>
            m.model.toLowerCase().includes(filter) ||
            m.provider.toLowerCase().includes(filter),
        );
      }

      const outLines = [
        `## Cost Summary (last ${hours}h)`,
        "",
        `| Metric | Value |`,
        `|--------|-------|`,
        `| Total Cost | ${formatCost(usage.totalCostUsd)} |`,
        `| Total Tokens | ${formatTokens(usage.totalTokens)} (${formatTokens(usage.inputTokens)} in / ${formatTokens(usage.outputTokens)} out) |`,
        `| LLM Calls | ${usage.requestCount} |`,
        `| Avg Cost/Call | ${formatCost(usage.totalCostUsd / usage.requestCount)} |`,
      ];

      if (data.budget) {
        const b = data.budget;
        outLines.push(
          "",
          `**Budget**: ${formatCost(b.remainingUsd)} remaining of ${formatCost(b.limitUsd)} daily (${b.percentUsed.toFixed(0)}% used)`,
        );

        if (b.percentUsed > 50 && hours > 0) {
          const burnRate = usage.totalCostUsd / hours;
          if (burnRate > 0) {
            const hoursUntilExhaustion = b.remainingUsd / burnRate;
            const forecast = formatForecastTime(hoursUntilExhaustion);
            if (
              forecast.startsWith("Budget runway") ||
              forecast.startsWith("Budget already")
            ) {
              outLines.push(`**Forecast**: ${forecast}`);
            } else {
              outLines.push(
                `**Forecast**: At current rate (${formatCost(burnRate)}/hr), budget exhausts ${forecast}`,
              );
            }
          }
        }
      }

      const totalCacheRead = models.reduce((s, m) => s + m.cacheReadTokens, 0);
      if (totalCacheRead > 0 && usage.inputTokens > 0) {
        const hitRate = Math.min(
          100,
          (totalCacheRead / usage.inputTokens) * 100,
        ).toFixed(0);
        outLines.push(
          "",
          `**Cache**: ${hitRate}% hit rate (${formatTokens(totalCacheRead)} cached reads of ${formatTokens(usage.inputTokens)} input)`,
        );
      }

      if (filteredModels.length > 0) {
        outLines.push(
          "",
          `### ${args.model_filter ? "Filtered" : "Per-Model"} Breakdown`,
          "",
          `| Model | Provider | Tokens | Cost | Calls | Cache |`,
          `|-------|----------|--------|------|-------|-------|`,
        );

        const sorted = [...filteredModels].sort(
          (a, b) => b.totalCostUsd - a.totalCostUsd,
        );
        for (const m of sorted.slice(0, 15)) {
          const cacheInfo =
            m.cacheReadTokens > 0
              ? `${formatTokens(m.cacheReadTokens)} read`
              : "—";
          outLines.push(
            `| ${m.model} | ${m.provider} | ${formatTokens(m.totalTokens)} | ${formatCost(m.totalCostUsd)} | ${m.requestCount} | ${cacheInfo} |`,
          );
        }
        if (sorted.length > 15) {
          outLines.push(`| ... | +${sorted.length - 15} more models | | | | |`);
        }

        if (data.budget && data.budget.percentUsed > 50) {
          try {
            const catalog = await candela.getModelCatalog();
            if (catalog && catalog.length > 0) {
              const suggestions: string[] = [];
              for (const m of sorted) {
                const catalogModel = catalog.find((c) => c.modelId === m.model);
                if (catalogModel?.category) {
                  const sameCategory = catalog.filter(
                    (c) =>
                      c.category === catalogModel.category &&
                      c.modelId !== m.model,
                  );
                  if (sameCategory.length > 0) {
                    sameCategory.sort(
                      (a, b) => a.inputPerMillion - b.inputPerMillion,
                    );
                    const cheapest = sameCategory[0];
                    const { smartRouting } = resolveSettings();
                    if (
                      cheapest.inputPerMillion <
                      catalogModel.inputPerMillion *
                        (1 - smartRouting.savingsThreshold)
                    ) {
                      const savingsPercent = Math.round(
                        (1 -
                          cheapest.inputPerMillion /
                            catalogModel.inputPerMillion) *
                          100,
                      );
                      suggestions.push(
                        `- **${m.model}**: Switch to **${cheapest.modelId}** for simple tasks → save ~${savingsPercent}% (${formatCost(catalogModel.inputPerMillion)} → ${formatCost(cheapest.inputPerMillion)})`,
                      );
                    }
                  }
                }
              }
              if (suggestions.length > 0) {
                outLines.push(
                  "",
                  "### 💡 Savings Opportunity",
                  ...suggestions.slice(0, 3),
                );
              }
            }
          } catch (_e) {
            // Ignore catalog fetch errors
          }
        }
      }

      return {
        title: `Cost: ${formatCost(usage.totalCostUsd)} (${hours}h)`,
        output: outLines.join("\n"),
      };
    },
  });

  // ── candela_check_budget ──────────────────────────────────────────────────

  const checkBudget = tool({
    description:
      "Check the current budget status, remaining balance, active grants, and reset time. " +
      "Use this when the user asks about budget, remaining balance, grants, or spending limits.",
    args: {},
    async execute() {
      const data = await candela.getDashboardData(24);
      if (!data) {
        return {
          title: "Candela Unavailable",
          output:
            "Candela server is not reachable. Make sure `candela` is running.",
        };
      }

      const lines: string[] = ["## Budget Status", ""];

      if (!data.budget) {
        lines.push(
          "No budget configured. Running in unlimited mode.",
          "",
          `Today's spend: ${formatCost(data.usage.totalCostUsd)} across ${data.usage.requestCount} calls.`,
        );
      } else {
        const b = data.budget;
        lines.push(
          budgetBar(b.usedFraction),
          "",
          `| Metric | Value |`,
          `|--------|-------|`,
          `| Daily Limit | ${formatCost(b.limitUsd)} |`,
          `| Spent | ${formatCost(b.spentUsd)} |`,
          `| Remaining | ${formatCost(b.remainingUsd)} |`,
          `| Used | ${b.percentUsed.toFixed(1)}% |`,
          `| Status | ${b.isExhausted ? "🔴 EXHAUSTED" : b.isNearLimit ? "🟡 Near Limit" : "🟢 OK"} |`,
        );

        if (b.resetLabel) {
          lines.push(`| Reset | ${b.resetLabel} |`);
        }
        if (b.periodEnd) {
          lines.push(`| Period End | ${b.periodEnd.toISOString()} |`);
        }
      }

      // Active grants
      const activeGrants = data.activeGrants.filter((g) => !g.isExhausted);
      if (activeGrants.length > 0) {
        lines.push(
          "",
          "### Active Grants",
          "",
          `| Grant | Amount | Remaining | Reason | Expires |`,
          `|-------|--------|-----------|--------|---------|`,
        );
        for (const g of activeGrants) {
          const expiry = g.expiresAt
            ? g.expiresAt.toLocaleDateString(undefined, {
                month: "short",
                day: "numeric",
              })
            : "Never";
          const warning = g.isExpiringSoon ? " ⚠️" : "";
          lines.push(
            `| ${g.id.slice(0, 8)}... | ${formatCost(g.amountUsd)} | ${formatCost(g.remainingUsd)} | ${g.reason || "—"} | ${expiry}${warning} |`,
          );
        }
      }

      // Total available
      if (data.totalRemainingUsd !== null) {
        lines.push(
          "",
          `**Total Available** (budget + grants): ${formatCost(data.totalRemainingUsd)}`,
        );
      }

      const title = data.budget
        ? `Budget: ${data.budget.percentUsed.toFixed(0)}% used — ${formatCost(data.budget.remainingUsd)} remaining`
        : `No budget — ${formatCost(data.usage.totalCostUsd)} spent today`;

      return { title, output: lines.join("\n") };
    },
  });

  // ── candela_traces ────────────────────────────────────────────────────────

  const listTraces = tool({
    description:
      "List recent LLM traces or inspect a specific trace by ID. " +
      "Use this when the user asks about recent calls, traces, requests, " +
      "latency, or wants to see what LLM calls were made. Provide a trace_id to see detailed span trees.",
    args: {
      trace_id: tool.schema
        .string()
        .optional()
        .describe(
          "Optional trace ID to inspect. If omitted, lists recent traces.",
        ),
      limit: tool.schema
        .number()
        .min(1)
        .max(50)
        .default(10)
        .describe(
          "Number of recent traces to return when listing. Default 10.",
        ),
      model_filter: tool.schema
        .string()
        .optional()
        .describe(
          "Optional model name filter. Only applies when trace_id is omitted.",
        ),
      min_cost: tool.schema
        .number()
        .optional()
        .describe(
          "Optional minimum cost in USD. Use to find expensive calls (e.g. 0.10 for calls over 10 cents). Only applies when trace_id is omitted.",
        ),
    },
    async execute(args) {
      if (args.trace_id) {
        const traceData = await fetchTrace(candelaUrl, args.trace_id);
        if (!traceData) {
          return {
            title: "Trace Not Found",
            output: `Could not fetch trace \`${args.trace_id}\`. It may not exist or Candela may be unavailable.`,
          };
        }

        const spans = traceData.spans ?? [];
        if (spans.length === 0) {
          return {
            title: "Empty Trace",
            output: `Trace \`${args.trace_id}\` exists but has no spans.`,
          };
        }

        const totalCost = spans.reduce((sum, s) => sum + s.costUsd, 0);
        const totalInput = spans.reduce((sum, s) => sum + s.inputTokens, 0);
        const totalOutput = spans.reduce((sum, s) => sum + s.outputTokens, 0);
        const totalCache = spans.reduce((sum, s) => sum + s.cacheReadTokens, 0);

        const outLines = [
          `## Trace \`${args.trace_id.slice(0, 12)}…\``,
          "",
          `| Metric | Value |`,
          `|--------|-------|`,
          `| Spans | ${spans.length} |`,
          `| Total Cost | ${formatCost(totalCost)} |`,
          `| Input Tokens | ${formatTokens(totalInput)} |`,
          `| Output Tokens | ${formatTokens(totalOutput)} |`,
        ];

        if (totalCache > 0) {
          outLines.push(`| Cache Read | ${formatTokens(totalCache)} |`);
          if (totalInput > 0) {
            const hitRate = Math.min(
              100,
              (totalCache / totalInput) * 100,
            ).toFixed(0);
            outLines.push(`| Cache Hit Rate | ${hitRate}% |`);
          }
        }

        const root =
          spans.find((s) => !s.parentSpanId || s.parentSpanId === "") ??
          spans[0];
        if (root) {
          outLines.push(
            "",
            "### Root Span",
            "",
            `| Field | Value |`,
            `|-------|-------|`,
            `| Model | ${root.model} |`,
            `| Provider | ${root.provider || "—"} |`,
            `| Status | ${root.statusCode === 200 ? "✅ 200" : root.statusCode === 0 ? "❓ unknown" : `❌ ${root.statusCode}`} |`,
            `| Latency | ${formatDuration(root.latencyMs)} |`,
            `| Cost | ${formatCost(root.costUsd)} |`,
          );

          if (root.cacheReadTokens > 0 || root.cacheCreationTokens > 0) {
            outLines.push(
              `| Cache Read | ${formatTokens(root.cacheReadTokens)} |`,
              `| Cache Write | ${formatTokens(root.cacheCreationTokens)} |`,
            );
          }
        }

        if (spans.length > 1) {
          outLines.push(
            "",
            "### Span Waterfall",
            "",
            "| # | Span ID | Model | Latency | Cost | Status |",
            "|---|---------|-------|---------|------|--------|",
          );

          for (let i = 0; i < spans.length; i++) {
            const s = spans[i];
            const depth = s.parentSpanId ? "  └─ " : "";
            const status =
              s.statusCode === 200
                ? "✅"
                : s.statusCode === 0
                  ? "❓"
                  : `❌${s.statusCode}`;
            outLines.push(
              `| ${i + 1} | ${depth}${s.spanId.slice(0, 8)} | ${s.model} | ${formatDuration(s.latencyMs)} | ${formatCost(s.costUsd)} | ${status} |`,
            );
          }
        }

        return {
          title: `Trace: ${formatCost(totalCost)} · ${spans.length} span${spans.length > 1 ? "s" : ""} · ${root?.model ?? "unknown"}`,
          output: outLines.join("\n"),
        };
      } else {
        const traces = await fetchTraces(
          candelaUrl,
          args.limit,
          args.model_filter,
          args.min_cost,
        );
        if (!traces) {
          return {
            title: "Candela Unavailable",
            output: "Could not fetch traces. Make sure Candela is running.",
          };
        }

        if (traces.length === 0) {
          return {
            title: "No Traces",
            output: "No matching traces found.",
          };
        }

        const totalCost = traces.reduce((sum, t) => sum + t.costUsd, 0);
        const avgLatency =
          traces.reduce((sum, t) => sum + t.latencyMs, 0) / traces.length;

        const outLines = [
          `## Recent Traces (${traces.length} shown)`,
          "",
          `**Total Cost**: ${formatCost(totalCost)} | **Avg Latency**: ${formatDuration(avgLatency)}`,
          "",
          `| Time | Model | Tokens | Cost | Latency | Cache |`,
          `|------|-------|--------|------|---------|-------|`,
        ];

        for (const t of traces) {
          const time = new Date(t.timestamp).toLocaleTimeString(undefined, {
            hour: "2-digit",
            minute: "2-digit",
          });
          const tokens = `${formatTokens(t.inputTokens)}→${formatTokens(t.outputTokens)}`;
          const cache =
            t.cacheReadTokens > 0
              ? `${formatTokens(t.cacheReadTokens)} hit`
              : "—";
          const status = t.statusCode === 200 ? "" : ` ❌${t.statusCode}`;
          outLines.push(
            `| ${time} | ${t.model}${status} | ${tokens} | ${formatCost(t.costUsd)} | ${formatDuration(t.latencyMs)} | ${cache} |`,
          );
        }

        return {
          title: `Traces: ${traces.length} calls, ${formatCost(totalCost)}`,
          output: outLines.join("\n"),
        };
      }
    },
  });

  // ── candela_browse_catalog ────────────────────────────────────────────────

  const browseCatalog = tool({
    description:
      "Browse the Candela model catalog. Shows all available models with pricing, " +
      "context window sizes, and categories. Use when the user asks about available models, " +
      "pricing comparisons, cheapest models, or wants to find a model with specific capabilities. " +
      "Optionally filter by provider or category.",
    args: {
      provider: tool.schema
        .string()
        .optional()
        .describe("Filter by provider (e.g. 'anthropic', 'google', 'openai')"),
      category: tool.schema
        .string()
        .optional()
        .describe("Filter by category (e.g. 'chat', 'code', 'reasoning')"),
      sort_by: tool.schema
        .enum(["price", "context", "name"])
        .optional()
        .describe(
          "Sort order: 'price' (cheapest first), 'context' (largest first), 'name' (alphabetical). Default: price",
        ),
    },
    async execute(args) {
      let entries = await candela.getModelCatalog();
      if (!entries) {
        return {
          title: "Catalog Unavailable",
          output:
            "Could not fetch the model catalog. Make sure Candela is running.",
        };
      }

      if (entries.length === 0) {
        return {
          title: "Empty Catalog",
          output: "The model catalog is empty. No models are configured.",
        };
      }

      // Apply filters
      if (args.provider) {
        const p = args.provider.toLowerCase();
        entries = entries.filter((e) => e.provider.toLowerCase().includes(p));
      }
      if (args.category) {
        const c = args.category.toLowerCase();
        entries = entries.filter((e) => e.category.toLowerCase().includes(c));
      }

      if (entries.length === 0) {
        return {
          title: "No Matching Models",
          output: "No models match the specified filters.",
        };
      }

      // Sort
      const sortBy = args.sort_by ?? "price";
      if (sortBy === "price") {
        entries.sort((a, b) => a.inputPerMillion - b.inputPerMillion);
      } else if (sortBy === "context") {
        entries.sort((a, b) => b.contextWindow - a.contextWindow);
      } else {
        entries.sort((a, b) => a.modelId.localeCompare(b.modelId));
      }

      const formatCtx = (tokens: number): string => {
        if (tokens === 0) return "—";
        if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
        return `${(tokens / 1000).toFixed(0)}K`;
      };

      const formatPrice = (price: number): string => {
        if (price === 0) return "free";
        if (price < 0.01) return `$${price.toFixed(4)}`;
        return `$${price.toFixed(2)}`;
      };

      const lines: string[] = [
        `## Model Catalog (${entries.length} models)`,
        "",
        "| Model | Provider | Input/1M | Output/1M | Context | Category |",
        "|-------|----------|----------|-----------|---------|----------|",
      ];

      for (const e of entries) {
        let inputPrice = formatPrice(e.inputPerMillion);
        if (e.inputPerMillionHigh > 0 && e.tierThresholdTokens > 0) {
          inputPrice += ` (>${formatCtx(e.tierThresholdTokens)}: ${formatPrice(e.inputPerMillionHigh)})`;
        }
        lines.push(
          `| ${e.modelId} | ${e.provider} | ${inputPrice} | ${formatPrice(e.outputPerMillion)} | ${formatCtx(e.contextWindow)} | ${e.category || "—"} |`,
        );
      }

      return {
        title: `Catalog: ${entries.length} models`,
        output: lines.join("\n"),
      };
    },
  });

  // ── candela_annotate ────────────────────────────────────────────────────────

  const annotate = tool({
    description:
      "Rate the quality of an LLM trace or attach a label. " +
      "Use after completing a task to record whether the result was good or bad. " +
      "You can provide an outcome (good/bad with optional 0-1 score) and/or a label.",
    args: {
      trace_id: tool.schema
        .string()
        .describe("Trace ID to annotate. Get from candela_traces."),
      outcome: tool.schema
        .enum(["good", "bad"])
        .optional()
        .describe("Overall quality rating"),
      score: tool.schema
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe(
          "Quality score 0.0-1.0 (optional, more precise than outcome)",
        ),
      label: tool.schema
        .string()
        .optional()
        .describe(
          "Category label: e.g. 'hallucination', 'clean-refactor', 'correct', 'partial'",
        ),
      comment: tool.schema
        .string()
        .optional()
        .describe("Free-text explanation of the rating"),
    },
    async execute(args) {
      const results: string[] = [];
      if (args.outcome) {
        const success = args.outcome === "good";
        const ok = await candela.setOutcome(
          args.trace_id,
          success,
          args.score,
          args.comment,
        );
        results.push(
          ok
            ? `Outcome set: ${args.outcome}${args.score != null ? ` (score: ${args.score})` : ""}`
            : "Failed to set outcome.",
        );
      }
      if (args.label) {
        const ok = await candela.addLabel(
          args.trace_id,
          args.label,
          "opencode-agent",
          args.comment,
        );
        results.push(
          ok ? `Label added: ${args.label}` : "Failed to add label.",
        );
      }
      if (results.length === 0) return "Provide at least an outcome or label.";
      return results.join("\n");
    },
  });

  // ── candela_memory ──────────────────────────────────────────────────────────

  const memory = tool({
    description:
      "Read, write, or list persistent project notes that survive across sessions. " +
      "Use this to store important discoveries, architecture decisions, or context " +
      "that future sessions should know about. Notes are scoped to the current project/repository.",
    args: {
      action: tool.schema
        .enum(["read", "write", "list", "delete"])
        .describe(
          "Action: read (get a note), write (save a note), list (all notes), delete (remove a note)",
        ),
      key: tool.schema
        .string()
        .optional()
        .describe(
          "Note key in kebab-case (required for read/write/delete). E.g. 'pagination-status', 'arch-decisions'",
        ),
      value: tool.schema
        .string()
        .optional()
        .describe(
          "Note content (required for write). Can be multi-line markdown.",
        ),
    },
    async execute(args, ctx) {
      const projectDir = ctx.directory;

      switch (args.action) {
        case "list": {
          const entries = listEntries(projectDir);
          if (entries.length === 0) return "No project notes stored yet.";
          const lines = [`## Project Notes (${entries.length})`, ""];
          for (const e of entries) {
            const preview =
              e.value.length > 80 ? `${e.value.slice(0, 80)}...` : e.value;
            lines.push(`- **${e.key}** (updated ${e.updatedAt}): ${preview}`);
          }
          return lines.join("\n");
        }
        case "read": {
          if (!args.key) return "Key is required for read.";
          const entry = getEntry(projectDir, args.key);
          if (!entry) return `No note found for key '${args.key}'.`;
          return `## ${args.key}\n\n${entry.value}\n\n_Updated: ${entry.updatedAt}_`;
        }
        case "write": {
          if (!args.key) return "Key is required for write.";
          if (!args.value) return "Value is required for write.";
          setEntry(projectDir, args.key, args.value);
          return `Saved note '${args.key}'.`;
        }
        case "delete": {
          if (!args.key) return "Key is required for delete.";
          const deleted = deleteEntry(projectDir, args.key);
          return deleted
            ? `Deleted note '${args.key}'.`
            : `No note found for key '${args.key}'.`;
        }
        default:
          return "Unknown action.";
      }
    },
  });

  // ── candela_settings ────────────────────────────────────────────────────────

  const settings = tool({
    description:
      "View or update Candela plugin settings. " +
      "Use to enable/disable smart model routing, adjust budget thresholds, " +
      "or check current configuration. " +
      "Smart routing suggests cheaper models when budget is getting tight.",
    args: {
      action: tool.schema
        .enum(["view", "enable-routing", "disable-routing", "set-threshold"])
        .describe(
          "Action: view (show current settings), enable-routing, disable-routing, " +
            "set-threshold (set budget threshold for routing suggestions)",
        ),
      value: tool.schema
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe(
          "Threshold value for set-threshold action (0.0-1.0). " +
            "E.g., 0.7 means suggestions start at 70% budget usage.",
        ),
    },
    async execute(args) {
      const current = resolveSettings();

      switch (args.action) {
        case "view": {
          const r = current.smartRouting;
          const lines = [
            "## Candela Settings",
            "",
            "### Smart Model Routing",
            "",
            `| Setting | Value |`,
            `|---------|-------|`,
            `| Enabled | ${r.enabled ? "✅ Yes" : "❌ No"} |`,
            `| Budget Threshold | ${(r.budgetThreshold * 100).toFixed(0)}% |`,
            `| Savings Threshold | ${(r.savingsThreshold * 100).toFixed(0)}% |`,
            "",
            `Settings file: \`${getSettingsPath()}\``,
            "",
            "**Environment overrides** (take priority):",
            "- `CANDELA_SMART_ROUTING=true` — enable smart routing",
            "- `CANDELA_ROUTING_THRESHOLD=0.7` — budget threshold (0.0–1.0)",
            "- `CANDELA_ROUTING_SAVINGS_THRESHOLD=0.5` — min savings to suggest (0.0–1.0)",
          ];
          return {
            title: `Settings: routing ${r.enabled ? "on" : "off"}, threshold ${(r.budgetThreshold * 100).toFixed(0)}%`,
            output: lines.join("\n"),
          };
        }
        case "enable-routing": {
          const updated = updateSmartRouting({ enabled: true });
          return {
            title: "Smart routing enabled",
            output:
              "✅ Smart model routing is now **enabled**.\n\n" +
              `When budget usage exceeds ${(updated.smartRouting.budgetThreshold * 100).toFixed(0)}%, ` +
              "the AI will receive suggestions to use cheaper models for simple tasks.\n\n" +
              "_Changes persist across sessions._",
          };
        }
        case "disable-routing": {
          updateSmartRouting({ enabled: false });
          return {
            title: "Smart routing disabled",
            output:
              "❌ Smart model routing is now **disabled**.\n\n" +
              "The AI will no longer receive model routing suggestions.\n\n" +
              "_Changes persist across sessions._",
          };
        }
        case "set-threshold": {
          if (args.value == null) {
            return "Please provide a threshold value (0.0–1.0). E.g., 0.7 for 70%.";
          }
          const updated = updateSmartRouting({ budgetThreshold: args.value });
          return {
            title: `Threshold set to ${(args.value * 100).toFixed(0)}%`,
            output:
              `✅ Budget threshold set to **${(args.value * 100).toFixed(0)}%**.\n\n` +
              `Smart routing suggestions will activate when budget usage exceeds ${(updated.smartRouting.budgetThreshold * 100).toFixed(0)}%.\n\n` +
              "_Changes persist across sessions._",
          };
        }
        default:
          return "Unknown action.";
      }
    },
  });

  // ── candela_compare_cost ────────────────────────────────────────────────────

  const compareCost = tool({
    description:
      "Compare the estimated cost of a prompt across different models. " +
      "Use when the user asks 'which model is cheapest for this?' or " +
      "'how much would this cost with GPT vs Claude vs Gemini?'. " +
      "Requires estimated token counts for the prompt.",
    args: {
      input_tokens: tool.schema
        .number()
        .describe("Estimated input token count for the prompt."),
      output_tokens: tool.schema
        .number()
        .describe("Estimated output token count for the response."),
      models: tool.schema
        .array(tool.schema.string())
        .optional()
        .describe(
          "Specific model IDs to compare. If omitted, compares the top 8 cheapest enabled models.",
        ),
    },
    async execute(args) {
      const catalog = await candela.getModelCatalog();
      if (!catalog || catalog.length === 0) {
        return "Model catalog unavailable. Is Candela running?";
      }

      const inputM = args.input_tokens / 1_000_000;
      const outputM = args.output_tokens / 1_000_000;

      // Filter to requested models or top cheapest
      let models = catalog.filter((m) => m.enabled);
      if (args.models && args.models.length > 0) {
        // Explicit requests bypass the price filter — user may want free-tier models
        const requested = new Set(args.models.map((m) => m.toLowerCase()));
        models = models.filter(
          (m) =>
            requested.has(m.modelId.toLowerCase()) ||
            [...requested].some((r) =>
              m.modelId.toLowerCase().includes(r.toLowerCase()),
            ),
        );
      } else {
        // Default: only priced models for meaningful comparison
        models = models.filter((m) => m.inputPerMillion > 0);
      }

      // Calculate costs and sort
      const results = models
        .map((m) => {
          const inputCost = m.inputPerMillion * inputM;
          const outputCost = m.outputPerMillion * outputM;
          return {
            model: m.modelId,
            inputCost,
            outputCost,
            totalCost: inputCost + outputCost,
            provider: m.provider,
          };
        })
        .sort((a, b) => a.totalCost - b.totalCost);

      // Take top 8 if unfiltered
      const display = args.models ? results : results.slice(0, 8);

      if (display.length === 0) {
        return "No matching models found in the catalog.";
      }

      const cheapest = display[0];
      const most = display[display.length - 1];

      const lines = [
        `## Cost Comparison (${formatTokens(args.input_tokens)} in, ${formatTokens(args.output_tokens)} out)`,
        "",
        "| Model | Provider | Input | Output | **Total** |",
        "|-------|----------|-------|--------|-----------|",
        ...display.map(
          (r) =>
            `| ${r.model} | ${r.provider} | ${formatCost(r.inputCost)} | ${formatCost(r.outputCost)} | **${formatCost(r.totalCost)}** |`,
        ),
      ];

      if (display.length > 1 && most.totalCost > 0) {
        const savingsPct = Math.round(
          ((most.totalCost - cheapest.totalCost) / most.totalCost) * 100,
        );
        lines.push(
          "",
          `💡 **Cheapest**: ${cheapest.model} at ${formatCost(cheapest.totalCost)}` +
            ` (${savingsPct}% savings vs ${most.model} at ${formatCost(most.totalCost)})`,
        );
      }

      return {
        title: `Cost comparison: ${display.length} models`,
        output: lines.join("\n"),
      };
    },
  });

  return {
    candela_cost_summary: costSummary,
    candela_check_budget: checkBudget,
    candela_traces: listTraces,
    candela_browse_catalog: browseCatalog,
    candela_annotate: annotate,
    candela_memory: memory,
    candela_settings: settings,
    candela_compare_cost: compareCost,
  };
}

// ── Trace fetcher ─────────────────────────────────────────────────────────────

/**
 * Fetch recent traces from Candela's SearchSpans RPC.
 * Falls back to GetDashboardData's span data if SearchSpans isn't available.
 */
async function fetchTraces(
  baseUrl: string,
  limit: number,
  modelFilter?: string,
  minCost?: number,
): Promise<TraceRecord[] | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    // Fetch more results when filtering by cost so we have enough after filtering
    const fetchSize = minCost !== undefined ? Math.min(limit * 5, 200) : limit;

    const body: Record<string, unknown> = {
      ...makeTimeRange(24),
      page_size: fetchSize,
    };

    if (modelFilter) {
      body.model_filter = modelFilter;
    }

    const res = await fetch(
      `${baseUrl}/candela.v1.DashboardService/SearchSpans`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      },
    );

    if (!res.ok) return null;
    const data = await res.json();
    const spans: unknown[] = data.spans ?? [];

    let traces: TraceRecord[] = spans
      .filter(
        (s): s is Record<string, unknown> => s != null && typeof s === "object",
      )
      .map((s) => ({
        traceId: String(s.traceId ?? s.trace_id ?? ""),
        model: String(s.model ?? "unknown"),
        provider: String(s.provider ?? ""),
        inputTokens: Number(
          s.inputTokens ??
            s.input_tokens ??
            s.genAiInputTokens ??
            s.gen_ai_input_tokens ??
            0,
        ),
        outputTokens: Number(
          s.outputTokens ??
            s.output_tokens ??
            s.genAiOutputTokens ??
            s.gen_ai_output_tokens ??
            0,
        ),
        costUsd: Number(s.costUsd ?? s.cost_usd ?? 0),
        latencyMs: Number(
          s.latencyMs ?? s.latency_ms ?? s.durationMs ?? s.duration_ms ?? 0,
        ),
        timestamp: String(s.timestamp ?? s.startTime ?? s.start_time ?? ""),
        statusCode: Number(
          s.statusCode ??
            s.status_code ??
            s.httpStatusCode ??
            s.http_status_code ??
            200,
        ),
        cacheReadTokens: Number(
          s.cacheReadTokens ??
            s.cache_read_tokens ??
            s.genAiCacheReadTokens ??
            s.gen_ai_cache_read_tokens ??
            0,
        ),
        cacheCreationTokens: Number(
          s.cacheCreationTokens ??
            s.cache_creation_tokens ??
            s.genAiCacheCreationTokens ??
            s.gen_ai_cache_creation_tokens ??
            0,
        ),
      }));

    // Apply cost filter BEFORE limit so we don't miss expensive calls
    if (minCost !== undefined) {
      traces = traces.filter((t) => t.costUsd >= minCost);
    }

    // Sort by timestamp descending — use 0 as fallback for invalid dates
    traces.sort((a, b) => {
      const ta = new Date(a.timestamp).getTime();
      const tb = new Date(b.timestamp).getTime();
      return (Number.isNaN(tb) ? 0 : tb) - (Number.isNaN(ta) ? 0 : ta);
    });

    return traces.slice(0, limit);
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Fetch all traces from a session start time to now.
 * Uses the same SearchSpans RPC but scoped to the session window.
 */
async function fetchSessionTraces(
  baseUrl: string,
  sessionStart: Date,
): Promise<TraceRecord[] | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    const body: Record<string, unknown> = {
      ...makeTimeRangeFromDate(sessionStart),
      page_size: 200, // generous limit for a single session
    };

    const res = await fetch(
      `${baseUrl}/candela.v1.DashboardService/SearchSpans`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      },
    );

    if (!res.ok) return null;
    const data = await res.json();
    const spans: unknown[] = data.spans ?? [];

    const traces: TraceRecord[] = spans
      .filter(
        (s): s is Record<string, unknown> => s != null && typeof s === "object",
      )
      .map((s) => ({
        traceId: String(s.traceId ?? s.trace_id ?? ""),
        model: String(s.model ?? "unknown"),
        provider: String(s.provider ?? ""),
        inputTokens: Number(
          s.inputTokens ??
            s.input_tokens ??
            s.genAiInputTokens ??
            s.gen_ai_input_tokens ??
            0,
        ),
        outputTokens: Number(
          s.outputTokens ??
            s.output_tokens ??
            s.genAiOutputTokens ??
            s.gen_ai_output_tokens ??
            0,
        ),
        costUsd: Number(s.costUsd ?? s.cost_usd ?? 0),
        latencyMs: Number(
          s.latencyMs ?? s.latency_ms ?? s.durationMs ?? s.duration_ms ?? 0,
        ),
        timestamp: String(s.timestamp ?? s.startTime ?? s.start_time ?? ""),
        statusCode: Number(
          s.statusCode ??
            s.status_code ??
            s.httpStatusCode ??
            s.http_status_code ??
            200,
        ),
        cacheReadTokens: Number(
          s.cacheReadTokens ??
            s.cache_read_tokens ??
            s.genAiCacheReadTokens ??
            s.gen_ai_cache_read_tokens ??
            0,
        ),
        cacheCreationTokens: Number(
          s.cacheCreationTokens ??
            s.cache_creation_tokens ??
            s.genAiCacheCreationTokens ??
            s.gen_ai_cache_creation_tokens ??
            0,
        ),
      }));

    // Sort by timestamp ascending for session narrative
    traces.sort((a, b) => {
      const ta = new Date(a.timestamp).getTime();
      const tb = new Date(b.timestamp).getTime();
      return (Number.isNaN(ta) ? 0 : ta) - (Number.isNaN(tb) ? 0 : tb);
    });

    return traces;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/** Human-readable session duration: "4m 32s" or "1h 12m". */
function formatSessionDuration(startTime: Date): string {
  const seconds = Math.max(
    0,
    Math.round((Date.now() - startTime.getTime()) / 1000),
  );
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (minutes < 60) return `${minutes}m ${secs}s`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${hours}h ${mins}m`;
}

// ── Trace detail types ────────────────────────────────────────────────────────

interface SpanRecord {
  spanId: string;
  parentSpanId: string;
  model: string;
  provider: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number;
  statusCode: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

interface TraceDetail {
  traceId: string;
  spans: SpanRecord[];
}

/**
 * Fetch a single trace by ID from Candela's GetTrace RPC.
 * Returns the trace with parsed spans, or null on failure.
 */
async function fetchTrace(
  baseUrl: string,
  traceId: string,
): Promise<TraceDetail | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    const res = await fetch(`${baseUrl}/candela.v1.TraceService/GetTrace`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trace_id: traceId }),
      signal: controller.signal,
    });

    if (!res.ok) return null;
    const data = await res.json();

    const trace = data.trace;
    if (!trace) return null;

    const rawSpans: unknown[] = Array.isArray(trace.spans) ? trace.spans : [];
    const spans: SpanRecord[] = rawSpans
      .filter(
        (s): s is Record<string, unknown> => s != null && typeof s === "object",
      )
      .map((s) => ({
        spanId: String(s.spanId ?? s.span_id ?? ""),
        parentSpanId: String(s.parentSpanId ?? s.parent_span_id ?? ""),
        model: String(s.model ?? "unknown"),
        provider: String(s.provider ?? ""),
        inputTokens: Number(
          s.inputTokens ??
            s.input_tokens ??
            s.genAiInputTokens ??
            s.gen_ai_input_tokens ??
            0,
        ),
        outputTokens: Number(
          s.outputTokens ??
            s.output_tokens ??
            s.genAiOutputTokens ??
            s.gen_ai_output_tokens ??
            0,
        ),
        costUsd: Number(s.costUsd ?? s.cost_usd ?? 0),
        latencyMs: Number(
          s.latencyMs ?? s.latency_ms ?? s.durationMs ?? s.duration_ms ?? 0,
        ),
        statusCode: Number(
          s.statusCode ??
            s.status_code ??
            s.httpStatusCode ??
            s.http_status_code ??
            0,
        ),
        cacheReadTokens: Number(
          s.cacheReadTokens ??
            s.cache_read_tokens ??
            s.genAiCacheReadTokens ??
            s.gen_ai_cache_read_tokens ??
            0,
        ),
        cacheCreationTokens: Number(
          s.cacheCreationTokens ??
            s.cache_creation_tokens ??
            s.genAiCacheCreationTokens ??
            s.gen_ai_cache_creation_tokens ??
            0,
        ),
      }));

    return {
      traceId: String(trace.traceId ?? trace.trace_id ?? traceId),
      spans,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
