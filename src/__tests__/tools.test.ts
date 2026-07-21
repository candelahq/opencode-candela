import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CandelaClient } from "../candela-client.js";
import { createCandelaTools, type SessionState } from "../tools.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build a mock CandelaClient */
function makeMockClient(
  dashboardData: Record<string, unknown> | null = null,
): CandelaClient {
  return {
    getDashboardData: vi.fn().mockResolvedValue(dashboardData),
  } as unknown as CandelaClient;
}

/** Build a session state accessor */
function makeSession(
  overrides: Partial<SessionState> = {},
): () => SessionState {
  const state: SessionState = {
    startTime: overrides.startTime ?? null,
    toolCalls: overrides.toolCalls ?? 0,
    id: overrides.id ?? null,
  };
  return () => state;
}

/** Minimal ToolContext stub for execute() calls */
function makeContext() {
  return {
    sessionID: "test-session",
    messageID: "test-message",
    agent: "test",
    directory: "/tmp",
    worktree: "/tmp",
    abort: new AbortController().signal,
    metadata: vi.fn(),
    ask: vi.fn(),
  };
}

/** Build a SearchSpans response with the given spans */
function makeSpansResponse(
  spans: Array<{
    model?: string;
    provider?: string;
    input_tokens?: number;
    output_tokens?: number;
    cost_usd?: number;
    latency_ms?: number;
    timestamp?: string;
    status_code?: number;
    cache_read_tokens?: number;
    cache_creation_tokens?: number;
  }>,
) {
  return {
    ok: true,
    json: () =>
      Promise.resolve({
        spans: spans.map((s) => ({
          trace_id: "trace-1",
          model: s.model ?? "claude-sonnet-4",
          provider: s.provider ?? "anthropic",
          input_tokens: s.input_tokens ?? 1000,
          output_tokens: s.output_tokens ?? 500,
          cost_usd: s.cost_usd ?? 0.05,
          latency_ms: s.latency_ms ?? 1200,
          timestamp: s.timestamp ?? new Date().toISOString(),
          status_code: s.status_code ?? 200,
          cache_read_tokens: s.cache_read_tokens ?? 0,
          cache_creation_tokens: s.cache_creation_tokens ?? 0,
        })),
      }),
  };
}

/** Build a dashboard response with optional budget */
function makeDashboard(budget?: {
  limitUsd?: number;
  spentUsd?: number;
  remainingUsd?: number;
  percentUsed?: number;
  usedFraction?: number;
}) {
  return {
    usage: {
      totalTokens: 1000,
      inputTokens: 500,
      outputTokens: 500,
      totalCostUsd: 5,
      requestCount: 10,
    },
    models: [],
    budget: budget
      ? {
          limitUsd: budget.limitUsd ?? 50,
          spentUsd: budget.spentUsd ?? 10,
          remainingUsd: budget.remainingUsd ?? 40,
          percentUsed: budget.percentUsed ?? 20,
          usedFraction: budget.usedFraction ?? 0.2,
          isNearLimit: false,
          isExhausted: false,
          periodEnd: null,
          resetLabel: "resets in 12h",
        }
      : null,
    activeGrants: [],
    totalRemainingUsd: null,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("candela_session_cost", () => {
  const CANDELA_URL = "http://localhost:4100";

  beforeEach(() => {
    vi.useFakeTimers();
    // Set a stable "now" so session duration calculations are predictable
    vi.setSystemTime(new Date("2026-07-19T20:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("returns 'No Active Session' when startTime is null", async () => {
    const client = makeMockClient();
    const tools = createCandelaTools(client, CANDELA_URL, makeSession());

    const result = await tools.candela_session_cost.execute({}, makeContext());

    expect(result).toEqual(
      expect.objectContaining({ title: "No Active Session" }),
    );
  });

  it("returns 'Candela Unavailable' when fetch fails", async () => {
    const client = makeMockClient();
    const sessionStart = new Date("2026-07-19T19:30:00Z");

    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("connection refused")),
    );

    const tools = createCandelaTools(
      client,
      CANDELA_URL,
      makeSession({ startTime: sessionStart }),
    );

    const result = await tools.candela_session_cost.execute({}, makeContext());

    expect(result).toEqual(
      expect.objectContaining({ title: "Candela Unavailable" }),
    );
  });

  it("returns 'No Session Costs' when no spans found", async () => {
    const client = makeMockClient();
    const sessionStart = new Date("2026-07-19T19:55:00Z"); // 5 min ago

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeSpansResponse([])));

    const tools = createCandelaTools(
      client,
      CANDELA_URL,
      makeSession({ startTime: sessionStart }),
    );

    const result = await tools.candela_session_cost.execute({}, makeContext());

    expect(result).toEqual(
      expect.objectContaining({ title: "No Session Costs" }),
    );
    expect((result as { output: string }).output).toContain("5m 0s ago");
  });

  it("aggregates cost, tokens, and call count from traces", async () => {
    const client = makeMockClient(makeDashboard());
    const sessionStart = new Date("2026-07-19T19:50:00Z"); // 10 min ago

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        makeSpansResponse([
          {
            model: "claude-sonnet-4",
            input_tokens: 2000,
            output_tokens: 800,
            cost_usd: 0.12,
            latency_ms: 1500,
          },
          {
            model: "claude-sonnet-4",
            input_tokens: 1500,
            output_tokens: 600,
            cost_usd: 0.08,
            latency_ms: 900,
          },
          {
            model: "gpt-4.1-nano",
            input_tokens: 500,
            output_tokens: 200,
            cost_usd: 0.01,
            latency_ms: 300,
          },
        ]),
      ),
    );

    const tools = createCandelaTools(
      client,
      CANDELA_URL,
      makeSession({ startTime: sessionStart }),
    );

    const result = (await tools.candela_session_cost.execute(
      {},
      makeContext(),
    )) as { title: string; output: string };

    // Title should contain total cost and call count
    expect(result.title).toContain("3 calls");
    expect(result.title).toContain("10m 0s");

    // Output table should contain aggregated values
    expect(result.output).toContain("LLM Calls | 3");
    expect(result.output).toContain("Input Tokens");
    expect(result.output).toContain("Output Tokens");
    expect(result.output).toContain("Avg Latency");
    expect(result.output).toContain("Cost/Call");
  });

  it("shows per-model breakdown sorted by cost descending", async () => {
    const client = makeMockClient(makeDashboard());
    const sessionStart = new Date("2026-07-19T19:50:00Z");

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        makeSpansResponse([
          { model: "claude-sonnet-4", cost_usd: 0.15 },
          { model: "gpt-4.1-nano", cost_usd: 0.01 },
          { model: "claude-sonnet-4", cost_usd: 0.1 },
        ]),
      ),
    );

    const tools = createCandelaTools(
      client,
      CANDELA_URL,
      makeSession({ startTime: sessionStart }),
    );

    const result = (await tools.candela_session_cost.execute(
      {},
      makeContext(),
    )) as { title: string; output: string };

    // Per-model section should exist
    expect(result.output).toContain("Per-Model Breakdown");

    // claude-sonnet-4 should appear before gpt-4.1-nano (higher cost)
    const claudeIdx = result.output.indexOf("claude-sonnet-4");
    const nanoIdx = result.output.indexOf("gpt-4.1-nano");
    expect(claudeIdx).toBeLessThan(nanoIdx);

    // claude should show 2 calls
    const claudeLine = result.output
      .split("\n")
      .find((l: string) => l.includes("claude-sonnet-4"));
    expect(claudeLine).toContain("2");
  });

  it("clamps cache hit rate to 100%", async () => {
    const client = makeMockClient(makeDashboard());
    const sessionStart = new Date("2026-07-19T19:50:00Z");

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        makeSpansResponse([
          {
            input_tokens: 500,
            cache_read_tokens: 800, // exceeds input!
          },
        ]),
      ),
    );

    const tools = createCandelaTools(
      client,
      CANDELA_URL,
      makeSession({ startTime: sessionStart }),
    );

    const result = (await tools.candela_session_cost.execute(
      {},
      makeContext(),
    )) as { title: string; output: string };

    expect(result.output).toContain("Cache Hit Rate | 100%");
    expect(result.output).not.toMatch(/Cache Hit Rate \| 1[0-9][1-9]%/);
  });

  it("includes budget context when available", async () => {
    const client = makeMockClient(
      makeDashboard({
        limitUsd: 100,
        remainingUsd: 60,
        percentUsed: 40,
      }),
    );
    const sessionStart = new Date("2026-07-19T19:50:00Z");

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(makeSpansResponse([{ cost_usd: 0.05 }])),
    );

    const tools = createCandelaTools(
      client,
      CANDELA_URL,
      makeSession({ startTime: sessionStart }),
    );

    const result = (await tools.candela_session_cost.execute(
      {},
      makeContext(),
    )) as { title: string; output: string };

    expect(result.output).toContain("Budget");
    expect(result.output).toContain("remaining");
    expect(result.output).toContain("40%");
  });

  it("handles HTTP error from SearchSpans gracefully", async () => {
    const client = makeMockClient();
    const sessionStart = new Date("2026-07-19T19:50:00Z");

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 500 }),
    );

    const tools = createCandelaTools(
      client,
      CANDELA_URL,
      makeSession({ startTime: sessionStart }),
    );

    const result = await tools.candela_session_cost.execute({}, makeContext());

    expect(result).toEqual(
      expect.objectContaining({ title: "Candela Unavailable" }),
    );
  });
});

// ── makeTimeRangeFromDate ─────────────────────────────────────────────────────

describe("makeTimeRangeFromDate", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-19T20:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("creates a time range from the given date to now", async () => {
    const { makeTimeRangeFromDate } = await import("../candela-client.js");

    const start = new Date("2026-07-19T19:30:00Z");
    const result = makeTimeRangeFromDate(start);

    const tr = result.time_range as {
      start: { seconds: string };
      end: { seconds: string };
    };
    const startSec = Number(tr.start.seconds);
    const endSec = Number(tr.end.seconds);

    // start should match the provided date
    expect(startSec).toBe(Math.floor(start.getTime() / 1000));
    // end should match "now" (2026-07-19T20:00:00Z)
    expect(endSec).toBe(
      Math.floor(new Date("2026-07-19T20:00:00Z").getTime() / 1000),
    );
    // 30 minute gap
    expect(endSec - startSec).toBe(1800);
  });
});

// ── candela_inspect_trace ─────────────────────────────────────────────────────

describe("candela_inspect_trace", () => {
  const CANDELA_URL = "http://localhost:4100";

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Build a GetTrace response */
  function makeTraceResponse(
    spans: Array<{
      span_id?: string;
      parent_span_id?: string;
      model?: string;
      provider?: string;
      input_tokens?: number;
      output_tokens?: number;
      cost_usd?: number;
      latency_ms?: number;
      status_code?: number;
      cache_read_tokens?: number;
      cache_creation_tokens?: number;
    }>,
  ) {
    return {
      ok: true,
      json: () =>
        Promise.resolve({
          trace: {
            trace_id: "abc123",
            spans: spans.map((s, i) => ({
              span_id: s.span_id ?? `span-${i}`,
              parent_span_id: s.parent_span_id ?? "",
              model: s.model ?? "claude-sonnet-4",
              provider: s.provider ?? "anthropic",
              input_tokens: s.input_tokens ?? 1000,
              output_tokens: s.output_tokens ?? 500,
              cost_usd: s.cost_usd ?? 0.05,
              latency_ms: s.latency_ms ?? 1200,
              status_code: s.status_code,
              cache_read_tokens: s.cache_read_tokens ?? 0,
              cache_creation_tokens: s.cache_creation_tokens ?? 0,
            })),
          },
        }),
    };
  }

  it("returns 'Trace Not Found' when fetch fails", async () => {
    const client = makeMockClient();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("connection refused")),
    );

    const tools = createCandelaTools(client, CANDELA_URL, makeSession());
    const result = await tools.candela_inspect_trace.execute(
      { trace_id: "abc123" },
      makeContext(),
    );

    expect(result).toEqual(
      expect.objectContaining({ title: "Trace Not Found" }),
    );
  });

  it("returns 'Empty Trace' when no spans", async () => {
    const client = makeMockClient();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({ trace: { trace_id: "abc123", spans: [] } }),
      }),
    );

    const tools = createCandelaTools(client, CANDELA_URL, makeSession());
    const result = await tools.candela_inspect_trace.execute(
      { trace_id: "abc123" },
      makeContext(),
    );

    expect(result).toEqual(expect.objectContaining({ title: "Empty Trace" }));
  });

  it("aggregates cost and tokens from multiple spans", async () => {
    const client = makeMockClient();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        makeTraceResponse([
          { input_tokens: 2000, output_tokens: 800, cost_usd: 0.12 },
          {
            span_id: "child",
            parent_span_id: "span-0",
            input_tokens: 1000,
            output_tokens: 400,
            cost_usd: 0.06,
          },
        ]),
      ),
    );

    const tools = createCandelaTools(client, CANDELA_URL, makeSession());
    const result = (await tools.candela_inspect_trace.execute(
      { trace_id: "abc123" },
      makeContext(),
    )) as { title: string; output: string };

    expect(result.title).toContain("2 spans");
    expect(result.output).toContain("Spans | 2");
  });

  it("shows cache hit rate as percentage, not just raw count", async () => {
    const client = makeMockClient();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          makeTraceResponse([{ input_tokens: 2000, cache_read_tokens: 1500 }]),
        ),
    );

    const tools = createCandelaTools(client, CANDELA_URL, makeSession());
    const result = (await tools.candela_inspect_trace.execute(
      { trace_id: "abc123" },
      makeContext(),
    )) as { title: string; output: string };

    expect(result.output).toContain("Cache Hit Rate | 75%");
  });

  it("clamps cache hit rate to 100%", async () => {
    const client = makeMockClient();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          makeTraceResponse([{ input_tokens: 500, cache_read_tokens: 800 }]),
        ),
    );

    const tools = createCandelaTools(client, CANDELA_URL, makeSession());
    const result = (await tools.candela_inspect_trace.execute(
      { trace_id: "abc123" },
      makeContext(),
    )) as { title: string; output: string };

    expect(result.output).toContain("Cache Hit Rate | 100%");
  });

  it("shows root span details with model, provider, latency", async () => {
    const client = makeMockClient();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        makeTraceResponse([
          {
            model: "claude-sonnet-4",
            provider: "anthropic",
            status_code: 200,
            latency_ms: 2500,
          },
        ]),
      ),
    );

    const tools = createCandelaTools(client, CANDELA_URL, makeSession());
    const result = (await tools.candela_inspect_trace.execute(
      { trace_id: "abc123" },
      makeContext(),
    )) as { title: string; output: string };

    expect(result.output).toContain("Root Span");
    expect(result.output).toContain("claude-sonnet-4");
    expect(result.output).toContain("anthropic");
    expect(result.output).toContain("✅ 200");
    expect(result.output).toContain("2.5s");
  });

  it("renders unknown status when statusCode is missing", async () => {
    const client = makeMockClient();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        makeTraceResponse([
          { model: "gpt-4o" }, // no status_code field → defaults to 0
        ]),
      ),
    );

    const tools = createCandelaTools(client, CANDELA_URL, makeSession());
    const result = (await tools.candela_inspect_trace.execute(
      { trace_id: "abc123" },
      makeContext(),
    )) as { title: string; output: string };

    expect(result.output).toContain("❓ unknown");
    expect(result.output).not.toContain("✅ 200");
  });
});

// ── candela_browse_catalog ──────────────────────────────────────────────────

describe("candela_browse_catalog", () => {
  const CANDELA_URL = "http://localhost:4100";

  /** Build a CatalogEntry with sensible defaults — override only what matters. */
  function model(overrides: Record<string, unknown> = {}) {
    return {
      modelId: overrides.modelId ?? "claude-sonnet-4",
      provider: overrides.provider ?? "anthropic",
      displayName: overrides.displayName ?? "Claude Sonnet 4",
      inputPerMillion: overrides.inputPerMillion ?? 3.0,
      outputPerMillion: overrides.outputPerMillion ?? 15.0,
      contextWindow: overrides.contextWindow ?? 200000,
      category: overrides.category ?? "chat",
      enabled: overrides.enabled ?? true,
      inputPerMillionHigh: overrides.inputPerMillionHigh ?? 0,
      outputPerMillionHigh: overrides.outputPerMillionHigh ?? 0,
      tierThresholdTokens: overrides.tierThresholdTokens ?? 0,
    };
  }

  /** Create tools with a pre-configured catalog mock. */
  function catalogTools(entries: ReturnType<typeof model>[] | null) {
    const client = makeMockClient();
    (client as unknown as Record<string, unknown>).getModelCatalog = vi
      .fn()
      .mockResolvedValue(entries);
    return createCandelaTools(client, CANDELA_URL, makeSession());
  }

  /** Extract data rows from table output (skip header + separator). */
  function dataRows(output: string) {
    return output
      .split("\n")
      .filter(
        (l) =>
          l.startsWith("| ") &&
          !l.startsWith("| Model") &&
          !l.startsWith("|---"),
      );
  }

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns 'Catalog Unavailable' when Candela is down", async () => {
    const tools = catalogTools(null);
    const result = (await tools.candela_browse_catalog.execute(
      {},
      makeContext(),
    )) as { title: string; output: string };
    expect(result.title).toBe("Catalog Unavailable");
  });

  it("returns 'Empty Catalog' when no models exist", async () => {
    const tools = catalogTools([]);
    const result = (await tools.candela_browse_catalog.execute(
      {},
      makeContext(),
    )) as { title: string; output: string };
    expect(result.title).toBe("Empty Catalog");
  });

  it("shows all models sorted by price (default)", async () => {
    const tools = catalogTools([
      model({ modelId: "gpt-4o", provider: "openai", inputPerMillion: 5 }),
      model({
        modelId: "gemini-2.5-flash",
        provider: "google",
        inputPerMillion: 0.15,
        contextWindow: 1000000,
      }),
    ]);
    const result = (await tools.candela_browse_catalog.execute(
      {},
      makeContext(),
    )) as { title: string; output: string };

    expect(result.title).toBe("Catalog: 2 models");
    const rows = dataRows(result.output);
    expect(rows[0]).toContain("gemini-2.5-flash"); // cheapest first
    expect(rows[1]).toContain("gpt-4o");
  });

  it("filters by provider", async () => {
    const tools = catalogTools([
      model({ modelId: "gpt-4o", provider: "openai" }),
      model({ modelId: "claude-sonnet-4", provider: "anthropic" }),
    ]);
    const result = (await tools.candela_browse_catalog.execute(
      { provider: "anthropic" },
      makeContext(),
    )) as { title: string; output: string };

    expect(result.title).toBe("Catalog: 1 models");
    expect(result.output).toContain("claude-sonnet-4");
    expect(result.output).not.toContain("gpt-4o");
  });

  it("filters by category", async () => {
    const tools = catalogTools([
      model({
        modelId: "text-embedding-3",
        inputPerMillion: 0.02,
        category: "embedding",
      }),
      model({ modelId: "gpt-4o", provider: "openai", category: "chat" }),
    ]);
    const result = (await tools.candela_browse_catalog.execute(
      { category: "embedding" },
      makeContext(),
    )) as { title: string; output: string };

    expect(result.title).toBe("Catalog: 1 models");
    expect(result.output).toContain("text-embedding-3");
    expect(result.output).not.toContain("gpt-4o");
  });

  it("sorts by context window size", async () => {
    const tools = catalogTools([
      model({
        modelId: "gpt-4o",
        provider: "openai",
        contextWindow: 128000,
      }),
      model({
        modelId: "gemini-2.5-pro",
        provider: "google",
        contextWindow: 1000000,
      }),
    ]);
    const result = (await tools.candela_browse_catalog.execute(
      { sort_by: "context" },
      makeContext(),
    )) as { title: string; output: string };

    const rows = dataRows(result.output);
    expect(rows[0]).toContain("gemini-2.5-pro"); // largest first
    expect(rows[1]).toContain("gpt-4o");
  });

  it("shows tiered pricing", async () => {
    const tools = catalogTools([
      model({
        modelId: "gemini-2.5-pro",
        provider: "google",
        inputPerMillion: 1.25,
        contextWindow: 1000000,
        inputPerMillionHigh: 2.5,
        outputPerMillionHigh: 10,
        tierThresholdTokens: 200000,
      }),
    ]);
    const result = (await tools.candela_browse_catalog.execute(
      {},
      makeContext(),
    )) as { title: string; output: string };

    expect(result.output).toContain("$1.25");
    expect(result.output).toContain("$2.50");
    expect(result.output).toContain(">200K");
  });

  it("returns 'No Matching Models' when filters exclude everything", async () => {
    const tools = catalogTools([
      model({ modelId: "gpt-4o", provider: "openai" }),
    ]);
    const result = (await tools.candela_browse_catalog.execute(
      { provider: "mistral" },
      makeContext(),
    )) as { title: string; output: string };

    expect(result.title).toBe("No Matching Models");
  });

  it("sorts alphabetically by name", async () => {
    const tools = catalogTools([
      model({ modelId: "gpt-4o", provider: "openai" }),
      model({ modelId: "claude-sonnet-4", provider: "anthropic" }),
    ]);
    const result = (await tools.candela_browse_catalog.execute(
      { sort_by: "name" },
      makeContext(),
    )) as { title: string; output: string };

    const rows = dataRows(result.output);
    expect(rows[0]).toContain("claude-sonnet-4");
    expect(rows[1]).toContain("gpt-4o");
  });

  it("formats context windows correctly (K and M)", async () => {
    const tools = catalogTools([
      model({
        modelId: "small-model",
        provider: "test",
        contextWindow: 8192,
        inputPerMillion: 1,
      }),
      model({
        modelId: "large-model",
        provider: "test",
        contextWindow: 2000000,
        inputPerMillion: 2,
      }),
    ]);
    const result = (await tools.candela_browse_catalog.execute(
      { sort_by: "name" },
      makeContext(),
    )) as { title: string; output: string };

    expect(result.output).toContain("2.0M");
    expect(result.output).toContain("8K");
  });
});
