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
import { makeTimeRange, makeTimeRangeFromDate } from "./candela-client.js";
import {
  budgetBar,
  formatCost,
  formatDuration,
  formatTokens,
} from "./utils.js";

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

      // Cache effectiveness
      const totalCacheRead = models.reduce((s, m) => s + m.cacheReadTokens, 0);
      if (totalCacheRead > 0 && usage.inputTokens > 0) {
        const hitRate = Math.min(
          100,
          (totalCacheRead / usage.inputTokens) * 100,
        ).toFixed(0);
        lines.push(
          "",
          `**Cache**: ${hitRate}% hit rate (${formatTokens(totalCacheRead)} cached reads of ${formatTokens(usage.inputTokens)} input)`,
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

  // ── candela_session_cost ────────────────────────────────────────────────

  const sessionCost = tool({
    description:
      "Get the cost of the current coding session. " +
      "Shows total spend, token usage, per-model breakdown, and cache stats since the session started. " +
      "Use this when the user asks about current session cost, this session's spending, or how much this conversation cost.",
    args: {},
    async execute() {
      const session = getSession();
      if (!session.startTime) {
        return {
          title: "No Active Session",
          output:
            "No active session detected. Session tracking starts when you begin a conversation.",
        };
      }

      // Fetch spans from session start to now
      const traces = await fetchSessionTraces(candelaUrl, session.startTime);
      if (!traces) {
        return {
          title: "Candela Unavailable",
          output: "Could not fetch session data. Make sure Candela is running.",
        };
      }

      if (traces.length === 0) {
        const elapsed = formatSessionDuration(session.startTime);
        return {
          title: "No Session Costs",
          output: `Session started ${elapsed} ago but no LLM calls recorded yet.`,
        };
      }

      // Aggregate
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

      const lines: string[] = [
        `## Session Cost (${elapsed})`,
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

      // Cache stats
      if (totalCacheRead > 0 && totalInput > 0) {
        const hitRate = Math.min(
          100,
          (totalCacheRead / totalInput) * 100,
        ).toFixed(0);
        lines.push(`| Cache Hit Rate | ${hitRate}% |`);
      }

      // Per-model breakdown
      const byModel = new Map<
        string,
        { cost: number; calls: number; tokens: number }
      >();
      for (const t of traces) {
        const key = t.model || "unknown";
        const existing = byModel.get(key) ?? { cost: 0, calls: 0, tokens: 0 };
        existing.cost += t.costUsd;
        existing.calls += 1;
        existing.tokens += t.inputTokens + t.outputTokens;
        byModel.set(key, existing);
      }

      if (byModel.size > 0) {
        lines.push(
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
          lines.push(
            `| ${model} | ${formatCost(stats.cost)} | ${stats.calls} | ${formatTokens(stats.tokens)} |`,
          );
        }
      }

      // Budget context
      const data = await candela.getDashboardData(24);
      if (data?.budget) {
        const b = data.budget;
        lines.push(
          "",
          `**Budget**: ${formatCost(b.remainingUsd)} remaining of ${formatCost(b.limitUsd)} (${b.percentUsed.toFixed(0)}% used)`,
        );
      }

      return {
        title: `Session: ${formatCost(totalCost)} (${traces.length} calls, ${elapsed})`,
        output: lines.join("\n"),
      };
    },
  });

  // ── candela_inspect_trace ───────────────────────────────────────────────

  const inspectTrace = tool({
    description:
      "Inspect a specific trace by its trace ID. " +
      "Shows the full span tree with per-span token breakdown, latency, cost, status, and cache stats. " +
      "Use this when the user wants to investigate a specific LLM call or debug latency/cost anomalies. " +
      "Get trace IDs from candela_list_traces first.",
    args: {
      trace_id: tool.schema.string().describe("The trace ID to inspect"),
    },
    async execute(args) {
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

      // Aggregate trace-level stats
      const totalCost = spans.reduce(
        (sum: number, s: SpanRecord) => sum + s.costUsd,
        0,
      );
      const totalInput = spans.reduce(
        (sum: number, s: SpanRecord) => sum + s.inputTokens,
        0,
      );
      const totalOutput = spans.reduce(
        (sum: number, s: SpanRecord) => sum + s.outputTokens,
        0,
      );
      const totalCache = spans.reduce(
        (sum: number, s: SpanRecord) => sum + s.cacheReadTokens,
        0,
      );

      const lines: string[] = [
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
        lines.push(`| Cache Read | ${formatTokens(totalCache)} |`);
      }

      // Root span details
      const root =
        spans.find(
          (s: SpanRecord) => !s.parentSpanId || s.parentSpanId === "",
        ) ?? spans[0];
      if (root) {
        lines.push(
          "",
          "### Root Span",
          "",
          `| Field | Value |`,
          `|-------|-------|`,
          `| Model | ${root.model} |`,
          `| Provider | ${root.provider || "—"} |`,
          `| Status | ${root.statusCode === 200 ? "✅ 200" : `❌ ${root.statusCode}`} |`,
          `| Latency | ${formatDuration(root.latencyMs)} |`,
          `| Cost | ${formatCost(root.costUsd)} |`,
        );

        if (root.cacheReadTokens > 0 || root.cacheCreationTokens > 0) {
          lines.push(
            `| Cache Read | ${formatTokens(root.cacheReadTokens)} |`,
            `| Cache Write | ${formatTokens(root.cacheCreationTokens)} |`,
          );
        }
      }

      // Span waterfall (if multiple spans)
      if (spans.length > 1) {
        lines.push(
          "",
          "### Span Waterfall",
          "",
          "| # | Span ID | Model | Latency | Cost | Status |",
          "|---|---------|-------|---------|------|--------|",
        );

        for (let i = 0; i < spans.length; i++) {
          const s = spans[i];
          const depth = s.parentSpanId ? "  └─ " : "";
          const status = s.statusCode === 200 ? "✅" : `❌${s.statusCode}`;
          lines.push(
            `| ${i + 1} | ${depth}${s.spanId.slice(0, 8)} | ${s.model} | ${formatDuration(s.latencyMs)} | ${formatCost(s.costUsd)} | ${status} |`,
          );
        }
      }

      return {
        title: `Trace: ${formatCost(totalCost)} · ${spans.length} span${spans.length > 1 ? "s" : ""} · ${root?.model ?? "unknown"}`,
        output: lines.join("\n"),
      };
    },
  });

  return {
    candela_cost_summary: costSummary,
    candela_check_budget: checkBudget,
    candela_list_traces: listTraces,
    candela_session_cost: sessionCost,
    candela_inspect_trace: inspectTrace,
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

    const rawSpans: unknown[] = trace.spans ?? [];
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
