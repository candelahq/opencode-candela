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
 * - candela_list_traces: Recent LLM traces with cost and latency
 */

import { tool } from "@opencode-ai/plugin";
import type { CandelaClient } from "./candela-client.js";
import { makeTimeRange } from "./candela-client.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatCost(usd: number): string {
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}K`;
  return String(count);
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60_000);
  const secs = Math.round((ms % 60_000) / 1000);
  return `${mins}m${secs}s`;
}

function budgetBar(fraction: number, width = 20): string {
  const clamped = Math.max(0, Math.min(1, fraction));
  const filled = Math.round(clamped * width);
  const empty = width - filled;
  const bar = "█".repeat(filled) + "░".repeat(empty);
  if (clamped >= 0.9) return `🔴 [${bar}]`;
  if (clamped >= 0.6) return `🟡 [${bar}]`;
  return `🟢 [${bar}]`;
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
 * Create all Candela custom tools bound to a CandelaClient instance.
 *
 * Tools are created as a factory so they share the same client
 * (and its cache/health state) as the rest of the plugin.
 */
export function createCandelaTools(candela: CandelaClient, candelaUrl: string) {
  // ── candela_cost_summary ──────────────────────────────────────────────────

  const costSummary = tool({
    description:
      "Get a summary of LLM costs for the current session or time period. " +
      "Shows total spend, token usage, request count, and per-model breakdown. " +
      "Use this when the user asks about costs, spending, usage, or tokens.",
    args: {
      hours: tool.schema
        .number()
        .min(1)
        .max(720)
        .default(24)
        .describe(
          "Number of hours to look back. Default 24 (today). Use 1 for current session, 168 for this week.",
        ),
      model_filter: tool.schema
        .string()
        .optional()
        .describe(
          "Optional model name filter (e.g. 'claude-sonnet-4-20250514'). Shows only costs for this model.",
        ),
    },
    async execute(args) {
      const data = await candela.getDashboardData(args.hours);
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
          output: `No LLM calls recorded in the last ${args.hours} hour(s).`,
        };
      }

      // Filter models if requested
      let filteredModels = models;
      if (args.model_filter) {
        const filter = args.model_filter.toLowerCase();
        filteredModels = models.filter(
          (m) =>
            m.model.toLowerCase().includes(filter) ||
            m.provider.toLowerCase().includes(filter),
        );
      }

      // Build output
      const lines: string[] = [
        `## Cost Summary (last ${args.hours}h)`,
        "",
        `| Metric | Value |`,
        `|--------|-------|`,
        `| Total Cost | ${formatCost(usage.totalCostUsd)} |`,
        `| Total Tokens | ${formatTokens(usage.totalTokens)} (${formatTokens(usage.inputTokens)} in / ${formatTokens(usage.outputTokens)} out) |`,
        `| LLM Calls | ${usage.requestCount} |`,
        `| Avg Cost/Call | ${formatCost(usage.totalCostUsd / usage.requestCount)} |`,
      ];

      // Budget context
      if (data.budget) {
        const b = data.budget;
        lines.push(
          "",
          `**Budget**: ${formatCost(b.remainingUsd)} remaining of ${formatCost(b.limitUsd)} daily (${b.percentUsed.toFixed(0)}% used)`,
        );
      }

      // Model breakdown
      if (filteredModels.length > 0) {
        lines.push(
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
          lines.push(
            `| ${m.model} | ${m.provider} | ${formatTokens(m.totalTokens)} | ${formatCost(m.totalCostUsd)} | ${m.requestCount} | ${cacheInfo} |`,
          );
        }
        if (sorted.length > 15) {
          lines.push(`| ... | +${sorted.length - 15} more models | | | | |`);
        }
      }

      return {
        title: `Cost: ${formatCost(usage.totalCostUsd)} (${args.hours}h)`,
        output: lines.join("\n"),
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

  // ── candela_list_traces ───────────────────────────────────────────────────

  const listTraces = tool({
    description:
      "List recent LLM traces with cost, latency, and token details. " +
      "Use this when the user asks about recent calls, traces, requests, " +
      "latency, or wants to see what LLM calls were made.",
    args: {
      limit: tool.schema
        .number()
        .min(1)
        .max(50)
        .default(10)
        .describe("Number of recent traces to return. Default 10."),
      model_filter: tool.schema
        .string()
        .optional()
        .describe("Optional model name filter."),
      min_cost: tool.schema
        .number()
        .optional()
        .describe(
          "Optional minimum cost in USD. Use to find expensive calls (e.g. 0.10 for calls over 10 cents).",
        ),
    },
    async execute(args) {
      // Fetch traces via the SearchSpans RPC
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

      const lines: string[] = [
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
        lines.push(
          `| ${time} | ${t.model}${status} | ${tokens} | ${formatCost(t.costUsd)} | ${formatDuration(t.latencyMs)} | ${cache} |`,
        );
      }

      return {
        title: `Traces: ${traces.length} calls, ${formatCost(totalCost)}`,
        output: lines.join("\n"),
      };
    },
  });

  return {
    candela_cost_summary: costSummary,
    candela_check_budget: checkBudget,
    candela_list_traces: listTraces,
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
