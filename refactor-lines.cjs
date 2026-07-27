const fs = require('fs');

const lines = fs.readFileSync('src/tools.ts', 'utf8').split('\n');

const costSummaryReplacement = `  const costSummary = tool({
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

        if (totalCacheRead > 0 && totalInput > 0) {
          const hitRate = Math.min(
            100,
            (totalCacheRead / totalInput) * 100,
          ).toFixed(0);
          outLines.push(\`| Cache Hit Rate | \${hitRate}% |\`);
        }

        let filteredTraces = traces;
        if (args.model_filter) {
          const filter = args.model_filter.toLowerCase();
          filteredTraces = traces.filter((t) =>
            (t.model || "").toLowerCase().includes(filter) ||
            (t.provider || "").toLowerCase().includes(filter)
          );
        }

        const byModel = new Map();
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
            "|-------|------|-------|--------|"
          );
          const sorted = [...byModel.entries()].sort(
            (a, b) => b[1].cost - a[1].cost,
          );
          for (const [model, stats] of sorted) {
            outLines.push(
              \`| \${model} | \${formatCost(stats.cost)} | \${stats.calls} | \${formatTokens(stats.tokens)} |\`
            );
          }
        }

        const data = await candela.getDashboardData(24);
        if (data?.budget) {
          const b = data.budget;
          outLines.push(
            "",
            \`**Budget**: \${formatCost(b.remainingUsd)} remaining of \${formatCost(b.limitUsd)} (\${b.percentUsed.toFixed(0)}% used)\`
          );
        }

        return {
          title: \`Session: \${formatCost(totalCost)} (\${traces.length} calls, \${elapsed})\`,
          output: outLines.join("\\n"),
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
        \`## Cost Summary (last \${hours}h)\`,
        "",
        \`| Metric | Value |\`,
        \`|--------|-------|\`,
        \`| Total Cost | \${formatCost(usage.totalCostUsd)} |\`,
        \`| Total Tokens | \${formatTokens(usage.totalTokens)} (\${formatTokens(usage.inputTokens)} in / \${formatTokens(usage.outputTokens)} out) |\`,
        \`| LLM Calls | \${usage.requestCount} |\`,
        \`| Avg Cost/Call | \${formatCost(usage.totalCostUsd / usage.requestCount)} |\`,
      ];

      if (data.budget) {
        const b = data.budget;
        outLines.push(
          "",
          \`**Budget**: \${formatCost(b.remainingUsd)} remaining of \${formatCost(b.limitUsd)} daily (\${b.percentUsed.toFixed(0)}% used)\`
        );
      }

      const totalCacheRead = models.reduce((s, m) => s + m.cacheReadTokens, 0);
      if (totalCacheRead > 0 && usage.inputTokens > 0) {
        const hitRate = Math.min(
          100,
          (totalCacheRead / usage.inputTokens) * 100,
        ).toFixed(0);
        outLines.push(
          "",
          \`**Cache**: \${hitRate}% hit rate (\${formatTokens(totalCacheRead)} cached reads of \${formatTokens(usage.inputTokens)} input)\`
        );
      }

      if (filteredModels.length > 0) {
        outLines.push(
          "",
          \`### \${args.model_filter ? "Filtered" : "Per-Model"} Breakdown\`,
          "",
          \`| Model | Provider | Tokens | Cost | Calls | Cache |\`,
          \`|-------|----------|--------|------|-------|-------|\`
        );

        const sorted = [...filteredModels].sort(
          (a, b) => b.totalCostUsd - a.totalCostUsd,
        );
        for (const m of sorted.slice(0, 15)) {
          const cacheInfo =
            m.cacheReadTokens > 0
              ? \`\${formatTokens(m.cacheReadTokens)} read\`
              : "—";
          outLines.push(
            \`| \${m.model} | \${m.provider} | \${formatTokens(m.totalTokens)} | \${formatCost(m.totalCostUsd)} | \${m.requestCount} | \${cacheInfo} |\`
          );
        }
        if (sorted.length > 15) {
          outLines.push(\`| ... | +\${sorted.length - 15} more models | | | | |\`);
        }
      }

      return {
        title: \`Cost: \${formatCost(usage.totalCostUsd)} (\${hours}h)\`,
        output: outLines.join("\\n"),
      };
    },
  });`.split('\n');

const tracesReplacement = `  const listTraces = tool({
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

        const totalCost = spans.reduce(
          (sum, s) => sum + s.costUsd,
          0,
        );
        const totalInput = spans.reduce(
          (sum, s) => sum + s.inputTokens,
          0,
        );
        const totalOutput = spans.reduce(
          (sum, s) => sum + s.outputTokens,
          0,
        );
        const totalCache = spans.reduce(
          (sum, s) => sum + s.cacheReadTokens,
          0,
        );

        const outLines = [
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
          outLines.push(\`| Cache Read | \${formatTokens(totalCache)} |\`);
          if (totalInput > 0) {
            const hitRate = Math.min(
              100,
              (totalCache / totalInput) * 100,
            ).toFixed(0);
            outLines.push(\`| Cache Hit Rate | \${hitRate}% |\`);
          }
        }

        const root =
          spans.find(
            (s) => !s.parentSpanId || s.parentSpanId === "",
          ) ?? spans[0];
        if (root) {
          outLines.push(
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
            outLines.push(
              \`| Cache Read | \${formatTokens(root.cacheReadTokens)} |\`,
              \`| Cache Write | \${formatTokens(root.cacheCreationTokens)} |\`,
            );
          }
        }

        if (spans.length > 1) {
          outLines.push(
            "",
            "### Span Waterfall",
            "",
            "| # | Span ID | Model | Latency | Cost | Status |",
            "|---|---------|-------|---------|------|--------|"
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
            outLines.push(
              \`| \${i + 1} | \${depth}\${s.spanId.slice(0, 8)} | \${s.model} | \${formatDuration(s.latencyMs)} | \${formatCost(s.costUsd)} | \${status} |\`
            );
          }
        }

        return {
          title: \`Trace: \${formatCost(totalCost)} · \${spans.length} span\${spans.length > 1 ? "s" : ""} · \${root?.model ?? "unknown"}\`,
          output: outLines.join("\\n"),
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
          outLines.push(
            \`| \${time} | \${t.model}\${status} | \${tokens} | \${formatCost(t.costUsd)} | \${formatDuration(t.latencyMs)} | \${cache} |\`
          );
        }

        return {
          title: \`Traces: \${traces.length} calls, \${formatCost(totalCost)}\`,
          output: outLines.join("\\n"),
        };
      }
    },
  });`.split('\n');

// 0-indexed line numbers
// costSummary is 69 to 186 (index 68 to 185)
// checkBudget is 190 to 273 (index 189 to 272)
// listTraces is 277 to 356 (index 276 to 355)
// sessionCost is 360 to 476 (index 359 to 475)
// inspectTrace is 480 to 603 (index 479 to 602)
// browseCatalog is 607 to 705 (index 606 to 704)
// return is 709 to 716 (index 708 to 715)

const part1 = lines.slice(0, 68);
const part2 = costSummaryReplacement;
const part3 = lines.slice(186, 276); // Between costSummary and listTraces
const part4 = tracesReplacement;
const part5 = lines.slice(356, 359); // Between listTraces and sessionCost
// delete sessionCost (index 359 to 475)
const part6 = lines.slice(476, 479); // Between sessionCost and inspectTrace
// delete inspectTrace (index 479 to 602)
const part7 = lines.slice(603, 708); // Between inspectTrace and return
const returnReplacement = [
  "  return {",
  "    candela_cost_summary: costSummary,",
  "    candela_check_budget: checkBudget,",
  "    candela_traces: listTraces,",
  "    candela_browse_catalog: browseCatalog,",
  "  };"
];
const part8 = lines.slice(716); // After return

let finalLines = [
  ...part1,
  ...part2,
  ...part3,
  ...part4,
  ...part7, // Skip empty spaces of deleted tools
  ...returnReplacement,
  ...part8
];

// Fix imports
let finalCode = finalLines.join('\n');
finalCode = finalCode.replace(
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
finalCode = finalCode.replace(
  `import { makeTimeRange, makeTimeRangeFromDate } from "./candela-client.js";`,
  `import { makeTimeRange, makeTimeRangeFromDate, fetchSessionTraces, fetchTrace, type SpanRecord } from "./candela-client.js";`
);

fs.writeFileSync('src/tools.ts', finalCode);
