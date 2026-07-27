const fs = require('fs');
let code = fs.readFileSync('src/tools.ts', 'utf8');

// Also update imports
code = code.replace(
  `import {
  budgetBar,
  formatCost,
  formatDuration,
  formatTokens,
} from "./utils.js";`,
  `import {
  budgetBar,
  formatCost,
  formatDuration,
  formatTokens,
  formatSessionDuration,
} from "./utils.js";`
);
code = code.replace(
  `import { makeTimeRange, makeTimeRangeFromDate } from "./candela-client.js";`,
  `import { makeTimeRange, makeTimeRangeFromDate, fetchSessionTraces, fetchTrace, type SpanRecord } from "./candela-client.js";`
);

// We need to replace the entire block of costSummary to inspectTrace
const costSummaryStart = code.indexOf('  const costSummary = tool({');
const browseCatalogStart = code.indexOf('  const browseCatalog = tool({');

const newTools = `  const costSummary = tool({
    description:
      "Get a summary of LLM costs for the current session or time period. " +
      "Shows total spend, token usage, request count, and per-model breakdown. " +
      "Use this when the user asks about costs, spending, usage, or tokens.",
    args: {
      scope: tool.schema
        .enum(["session", "1h", "24h", "7d"])
        .default("24h")
        .describe("Time period to analyze. Use 'session' for the current coding session."),
      model_filter: tool.schema
        .string()
        .optional()
        .describe(
          "Optional model name filter (e.g. 'claude-sonnet-4-20250514'). Shows only costs for this model.",
        ),
    },
    async execute(args) {
      if (args.scope === "session") {
        const session = getSession();
        if (!session.startTime) {
          return {
            title: "No Active Session",
            output: "No active session detected. Session tracking starts when you begin a conversation.",
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
            output: \`Session started \${elapsed} ago but no LLM calls recorded yet.\`,
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
          \`## Session Cost (\${elapsed})\`,
          "",
          session.id ? \`**Session**: \\\`\${session.id.slice(0, 8)}...\\\`\` : "",
          "",
          \`| Metric | Value |\`,
          \`|--------|-------|\`,
          \`| Total Cost | \${formatCost(totalCost)} |\`,
          \`| LLM Calls | \${traces.length} |\`,
          \`| Input Tokens | \${formatTokens(totalInput)} |\`,
          \`| Output Tokens | \${formatTokens(totalOutput)} |\`,
          \`| Avg Latency | \${formatDuration(avgLatency)} |\`,
          \`| Cost/Call | \${formatCost(totalCost / traces.length)} |\`,
        ];

        // Cache stats
        if (totalCacheRead > 0 && totalInput > 0) {
          const hitRate = Math.min(
            100,
            (totalCacheRead / totalInput) * 100,
          ).toFixed(0);
          lines.push(\`| Cache Hit Rate | \${hitRate}% |\`);
        }

        // Per-model breakdown
        let filteredTraces = traces;
        if (args.model_filter) {
          const filter = args.model_filter.toLowerCase();
          filteredTraces = traces.filter((t) =>
            (t.model || "").toLowerCase().includes(filter) ||
            (t.provider || "").toLowerCase().includes(filter)
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
              \`| \${model} | \${formatCost(stats.cost)} | \${stats.calls} | \${formatTokens(stats.tokens)} |\`,
            );
          }
        }

        // Budget context
        const data = await candela.getDashboardData(24);
        if (data?.budget) {
          const b = data.budget;
          lines.push(
            "",
            \`**Budget**: \${formatCost(b.remainingUsd)} remaining of \${formatCost(b.limitUsd)} (\${b.percentUsed.toFixed(0)}% used)\`,
          );
        }

        return {
          title: \`Session: \${formatCost(totalCost)} (\${traces.length} calls, \${elapsed})\`,
          output: lines.join("\\n"),
        };
      }

      const hours = args.scope === "1h" ? 1 : args.scope === "7d" ? 168 : 24;
      const data = await candela.getDashboardData(hours);
      if (!data) {
        return {
          title: "Candela Unavailable",
          output:
            "Candela server is not reachable. Make sure \`candela\` is running locally or set CANDELA_PROXY_URL.",
        };
      }

      const { usage, models } = data;

      if (usage.requestCount === 0) {
        return {
          title: "No Usage",
          output: \`No LLM calls recorded in the last \${hours} hour(s).\`,
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
        \`## Cost Summary (last \${hours}h)\`,
        "",
        \`| Metric | Value |\`,
        \`|--------|-------|\`,
        \`| Total Cost | \${formatCost(usage.totalCostUsd)} |\`,
        \`| Total Tokens | \${formatTokens(usage.totalTokens)} (\${formatTokens(usage.inputTokens)} in / \${formatTokens(usage.outputTokens)} out) |\`,
        \`| LLM Calls | \${usage.requestCount} |\`,
        \`| Avg Cost/Call | \${formatCost(usage.totalCostUsd / usage.requestCount)} |\`,
      ];

      // Budget context
      if (data.budget) {
        const b = data.budget;
        lines.push(
          "",
          \`**Budget**: \${formatCost(b.remainingUsd)} remaining of \${formatCost(b.limitUsd)} daily (\${b.percentUsed.toFixed(0)}% used)\`,
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
          \`**Cache**: \${hitRate}% hit rate (\${formatTokens(totalCacheRead)} cached reads of \${formatTokens(usage.inputTokens)} input)\`,
        );
      }

      // Model breakdown
      if (filteredModels.length > 0) {
        lines.push(
          "",
          \`### \${args.model_filter ? "Filtered" : "Per-Model"} Breakdown\`,
          "",
          \`| Model | Provider | Tokens | Cost | Calls | Cache |\`,
          \`|-------|----------|--------|------|-------|-------|\`,
        );

        const sorted = [...filteredModels].sort(
          (a, b) => b.totalCostUsd - a.totalCostUsd,
        );
        for (const m of sorted.slice(0, 15)) {
          const cacheInfo =
            m.cacheReadTokens > 0
              ? \`\${formatTokens(m.cacheReadTokens)} read\`
              : "—";
          lines.push(
            \`| \${m.model} | \${m.provider} | \${formatTokens(m.totalTokens)} | \${formatCost(m.totalCostUsd)} | \${m.requestCount} | \${cacheInfo} |\`,
          );
        }
        if (sorted.length > 15) {
          lines.push(\`| ... | +\${sorted.length - 15} more models | | | | |\`);
        }
      }

      return {
        title: \`Cost: \${formatCost(usage.totalCostUsd)} (\${hours}h)\`,
        output: lines.join("\\n"),
      };
    },
  });

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
            "Candela server is not reachable. Make sure \`candela\` is running.",
        };
      }

      const lines: string[] = ["## Budget Status", ""];

      if (!data.budget) {
        lines.push(
          "No budget configured. Running in unlimited mode.",
          "",
          \`Today's spend: \${formatCost(data.usage.totalCostUsd)} across \${data.usage.requestCount} calls.\`,
        );
      } else {
        const b = data.budget;
        lines.push(
          budgetBar(b.usedFraction),
          "",
          \`| Metric | Value |\`,
          \`|--------|-------|\`,
          \`| Daily Limit | \${formatCost(b.limitUsd)} |\`,
          \`| Spent | \${formatCost(b.spentUsd)} |\`,
          \`| Remaining | \${formatCost(b.remainingUsd)} |\`,
          \`| Used | \${b.percentUsed.toFixed(1)}% |\`,
          \`| Status | \${b.isExhausted ? "🔴 EXHAUSTED" : b.isNearLimit ? "🟡 Near Limit" : "🟢 OK"} |\`,
        );

        if (b.resetLabel) {
          lines.push(\`| Reset | \${b.resetLabel} |\`);
        }
        if (b.periodEnd) {
          lines.push(\`| Period End | \${b.periodEnd.toISOString()} |\`);
        }
      }

      // Active grants
      const activeGrants = data.activeGrants.filter((g) => !g.isExhausted);
      if (activeGrants.length > 0) {
        lines.push(
          "",
          "### Active Grants",
          "",
          \`| Grant | Amount | Remaining | Reason | Expires |\`,
          \`|-------|--------|-----------|--------|---------|\`,
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
            \`| \${g.id.slice(0, 8)}... | \${formatCost(g.amountUsd)} | \${formatCost(g.remainingUsd)} | \${g.reason || "—"} | \${expiry}\${warning} |\`,
          );
        }
      }

      // Total available
      if (data.totalRemainingUsd !== null) {
        lines.push(
          "",
          \`**Total Available** (budget + grants): \${formatCost(data.totalRemainingUsd)}\`,
        );
      }

      const title = data.budget
        ? \`Budget: \${data.budget.percentUsed.toFixed(0)}% used — \${formatCost(data.budget.remainingUsd)} remaining\`
        : \`No budget — \${formatCost(data.usage.totalCostUsd)} spent today\`;

      return { title, output: lines.join("\\n") };
    },
  });

  const listTraces = tool({
    description:
      "List recent LLM traces or inspect a specific trace by ID. " +
      "Use this when the user asks about recent calls, traces, requests, " +
      "latency, or wants to see what LLM calls were made. Provide a trace_id to see detailed span trees.",
    args: {
      trace_id: tool.schema
        .string()
        .optional()
        .describe("Optional trace ID to inspect. If omitted, lists recent traces."),
      limit: tool.schema
        .number()
        .min(1)
        .max(50)
        .default(10)
        .describe("Number of recent traces to return when listing. Default 10."),
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
      if (args.trace_id) {
        const traceData = await fetchTrace(candelaUrl, args.trace_id);
        if (!traceData) {
          return {
            title: "Trace Not Found",
            output: \`Could not fetch trace \\\`\${args.trace_id}\\\`. It may not exist or Candela may be unavailable.\`,
          };
        }

        const spans = traceData.spans ?? [];
        if (spans.length === 0) {
          return {
            title: "Empty Trace",
            output: \`Trace \\\`\${args.trace_id}\\\` exists but has no spans.\`,
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
          \`## Trace \\\`\${args.trace_id.slice(0, 12)}…\\\`\`,
          "",
          \`| Metric | Value |\`,
          \`|--------|-------|\`,
          \`| Spans | \${spans.length} |\`,
          \`| Total Cost | \${formatCost(totalCost)} |\`,
          \`| Input Tokens | \${formatTokens(totalInput)} |\`,
          \`| Output Tokens | \${formatTokens(totalOutput)} |\`,
        ];

        if (totalCache > 0) {
          lines.push(\`| Cache Read | \${formatTokens(totalCache)} |\`);
          if (totalInput > 0) {
            const hitRate = Math.min(
              100,
              (totalCache / totalInput) * 100,
            ).toFixed(0);
            lines.push(\`| Cache Hit Rate | \${hitRate}% |\`);
          }
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
            \`| Field | Value |\`,
            \`|-------|-------|\`,
            \`| Model | \${root.model} |\`,
            \`| Provider | \${root.provider || "—"} |\`,
            \`| Status | \${root.statusCode === 200 ? "✅ 200" : root.statusCode === 0 ? "❓ unknown" : \`❌ \${root.statusCode}\`} |\`,
            \`| Latency | \${formatDuration(root.latencyMs)} |\`,
            \`| Cost | \${formatCost(root.costUsd)} |\`,
          );

          if (root.cacheReadTokens > 0 || root.cacheCreationTokens > 0) {
            lines.push(
              \`| Cache Read | \${formatTokens(root.cacheReadTokens)} |\`,
              \`| Cache Write | \${formatTokens(root.cacheCreationTokens)} |\`,
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
            const status =
              s.statusCode === 200
                ? "✅"
                : s.statusCode === 0
                  ? "❓"
                  : \`❌\${s.statusCode}\`;
            lines.push(
              \`| \${i + 1} | \${depth}\${s.spanId.slice(0, 8)} | \${s.model} | \${formatDuration(s.latencyMs)} | \${formatCost(s.costUsd)} | \${status} |\`,
            );
          }
        }

        return {
          title: \`Trace: \${formatCost(totalCost)} · \${spans.length} span\${spans.length > 1 ? "s" : ""} · \${root?.model ?? "unknown"}\`,
          output: lines.join("\\n"),
        };
      } else {
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
          \`## Recent Traces (\${traces.length} shown)\`,
          "",
          \`**Total Cost**: \${formatCost(totalCost)} | **Avg Latency**: \${formatDuration(avgLatency)}\`,
          "",
          \`| Time | Model | Tokens | Cost | Latency | Cache |\`,
          \`|------|-------|--------|------|---------|-------|\`,
        ];

        for (const t of traces) {
          const time = new Date(t.timestamp).toLocaleTimeString(undefined, {
            hour: "2-digit",
            minute: "2-digit",
          });
          const tokens = \`\${formatTokens(t.inputTokens)}→\${formatTokens(t.outputTokens)}\`;
          const cache =
            t.cacheReadTokens > 0
              ? \`\${formatTokens(t.cacheReadTokens)} hit\`
              : "—";
          const status = t.statusCode === 200 ? "" : \` ❌\${t.statusCode}\`;
          lines.push(
            \`| \${time} | \${t.model}\${status} | \${tokens} | \${formatCost(t.costUsd)} | \${formatDuration(t.latencyMs)} | \${cache} |\`,
          );
        }

        return {
          title: \`Traces: \${traces.length} calls, \${formatCost(totalCost)}\`,
          output: lines.join("\\n"),
        };
      }
    },
  });
`;

code = code.substring(0, costSummaryStart) + newTools + '\n' + code.substring(browseCatalogStart);

// Finally fix the exported tools
code = code.replace(
  `  return {
    candela_cost_summary: costSummary,
    candela_check_budget: checkBudget,
    candela_list_traces: listTraces,
    candela_session_cost: sessionCost,
    candela_inspect_trace: inspectTrace,
    candela_browse_catalog: browseCatalog,
  };`,
  `  return {
    candela_cost_summary: costSummary,
    candela_check_budget: checkBudget,
    candela_traces: listTraces,
    candela_browse_catalog: browseCatalog,
  };`
);

fs.writeFileSync('src/tools.ts', code);
