import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CandelaClient } from "../candela-client.js";
import { createContextHook } from "../context.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeDashboardData(overrides: {
  budget?: {
    percentUsed?: number;
    spentUsd?: number;
    limitUsd?: number;
    usedFraction?: number;
    remainingUsd?: number;
    isNearLimit?: boolean;
    isExhausted?: boolean;
    periodEnd?: Date | null;
    resetLabel?: string;
  } | null;
  totalCostUsd?: number | null;
}) {
  return {
    usage: {
      totalTokens: 1000,
      inputTokens: 500,
      outputTokens: 500,
      totalCostUsd: overrides.totalCostUsd ?? 3.2,
      requestCount: 10,
    },
    models: [],
    budget: overrides.budget
      ? {
          limitUsd: 12,
          spentUsd: 5.5,
          remainingUsd: 6.5,
          percentUsed: 45,
          usedFraction: 0.45,
          isNearLimit: false,
          isExhausted: false,
          periodEnd: null,
          resetLabel: "resets in 12h",
          ...overrides.budget,
        }
      : overrides.budget === null
        ? null
        : undefined,
    activeGrants: [],
    totalRemainingUsd: null,
  };
}

function makeMockClient(
  data: ReturnType<typeof makeDashboardData> | null = null,
): CandelaClient {
  return {
    getDashboardData: vi.fn().mockResolvedValue(data),
  } as unknown as CandelaClient;
}

function makeInput(modelId = "claude-sonnet-4", providerID = "candela") {
  return {
    model: { id: modelId, providerID },
  };
}

function makeOutput() {
  return { system: [] as string[] };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("createContextHook", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── Cache behavior ────────────────────────────────────────────────────────

  describe("cache behavior", () => {
    it("fetches data on first call", async () => {
      const data = makeDashboardData({ budget: { usedFraction: 0.45 } });
      const client = makeMockClient(data);
      const { hook } = createContextHook(client);

      const output = makeOutput();
      await hook(makeInput(), output);

      expect(client.getDashboardData).toHaveBeenCalledTimes(1);
      expect(output.system).toHaveLength(1);
      expect(output.system[0]).toContain("[Candela]");
    });

    it("reuses cached context within TTL", async () => {
      // Use >= 80% budget so throttling doesn't suppress the second call
      const data = makeDashboardData({
        budget: { usedFraction: 0.85, percentUsed: 85 },
        totalCostUsd: 1.5,
      });
      const client = makeMockClient(data);
      const { hook } = createContextHook(client);

      // First call
      await hook(makeInput(), makeOutput());
      expect(client.getDashboardData).toHaveBeenCalledTimes(1);

      // Second call within 60s — should use cache (and still inject at >= 80%)
      vi.advanceTimersByTime(30_000);
      const output2 = makeOutput();
      await hook(makeInput(), output2);
      expect(client.getDashboardData).toHaveBeenCalledTimes(1);
      expect(output2.system).toHaveLength(1);
    });

    it("refreshes after TTL expires", async () => {
      const data = makeDashboardData({
        budget: { usedFraction: 0.85, percentUsed: 85 },
        totalCostUsd: 1.5,
      });
      const client = makeMockClient(data);
      const { hook } = createContextHook(client);

      await hook(makeInput(), makeOutput());
      expect(client.getDashboardData).toHaveBeenCalledTimes(1);

      // Advance past 60s TTL
      vi.advanceTimersByTime(61_000);
      await hook(makeInput(), makeOutput());
      expect(client.getDashboardData).toHaveBeenCalledTimes(2);
    });
  });

  // ── Budget urgency ────────────────────────────────────────────────────────

  describe("budget urgency messages", () => {
    it("adds critical warning at >= 95% usage", async () => {
      const data = makeDashboardData({
        budget: { usedFraction: 0.96, percentUsed: 96, spentUsd: 11.5 },
        totalCostUsd: 5,
      });
      const client = makeMockClient(data);
      const { hook } = createContextHook(client);

      const output = makeOutput();
      await hook(makeInput(), output);
      expect(output.system[0]).toContain("BUDGET CRITICAL");
    });

    it("adds tight warning at >= 85% usage", async () => {
      const data = makeDashboardData({
        budget: { usedFraction: 0.87, percentUsed: 87 },
        totalCostUsd: 4,
      });
      const client = makeMockClient(data);
      const { hook } = createContextHook(client);

      const output = makeOutput();
      await hook(makeInput(), output);
      expect(output.system[0]).toContain("Budget tight");
    });

    it("no urgency marker below 70%", async () => {
      const data = makeDashboardData({
        budget: { usedFraction: 0.5, percentUsed: 50 },
        totalCostUsd: 2,
      });
      const client = makeMockClient(data);
      const { hook } = createContextHook(client);

      const output = makeOutput();
      await hook(makeInput(), output);
      expect(output.system[0]).not.toContain("BUDGET CRITICAL");
      expect(output.system[0]).not.toContain("Budget tight");
      expect(output.system[0]).not.toContain("Budget awareness");
    });

    it("adds awareness at >= 70% usage", async () => {
      const data = makeDashboardData({
        budget: { usedFraction: 0.75, percentUsed: 75 },
        totalCostUsd: 4,
      });
      const client = makeMockClient(data);
      const { hook } = createContextHook(client);

      const output = makeOutput();
      await hook(makeInput(), output);
      expect(output.system[0]).toContain("Budget awareness");
    });
  });

  // ── Cheap model detection ─────────────────────────────────────────────────

  describe("cheap model detection", () => {
    it("does not suggest cheaper models when already using one", async () => {
      const data = makeDashboardData({
        budget: null,
        totalCostUsd: 1,
      });
      const client = makeMockClient(data);
      const { hook } = createContextHook(client);

      const output = makeOutput();
      await hook(makeInput("claude-haiku-4.5", "candela"), output);
      expect(output.system[0]).not.toContain("consider cheaper models");
    });

    it("suggests cheaper models for expensive model", async () => {
      const data = makeDashboardData({
        budget: null,
        totalCostUsd: 1,
      });
      const client = makeMockClient(data);
      const { hook } = createContextHook(client);

      const output = makeOutput();
      await hook(makeInput("claude-sonnet-4", "candela"), output);
      expect(output.system[0]).toContain("consider cheaper models");
    });

    it("matches cheap models case-insensitively", async () => {
      const data = makeDashboardData({ budget: null, totalCostUsd: 1 });
      const client = makeMockClient(data);
      const { hook } = createContextHook(client);

      const output = makeOutput();
      await hook(makeInput("GPT-4.1-Nano", "openai"), output);
      expect(output.system[0]).not.toContain("consider cheaper models");
    });
  });

  // ── Graceful error handling ───────────────────────────────────────────────

  describe("graceful error handling", () => {
    it("injects nothing when API returns null on first call", async () => {
      const client = makeMockClient(null);
      const { hook } = createContextHook(client);

      const output = makeOutput();
      await hook(makeInput(), output);
      expect(output.system).toHaveLength(0);
    });

    it("falls back to stale cache when API throws", async () => {
      // Use >= 80% budget so throttling allows re-injection with stale cache
      const data = makeDashboardData({
        budget: { usedFraction: 0.9, percentUsed: 90 },
        totalCostUsd: 2,
      });
      const client = makeMockClient(data);
      const { hook } = createContextHook(client);

      // Succeed first
      const output1 = makeOutput();
      await hook(makeInput(), output1);
      expect(output1.system).toHaveLength(1);

      // Now make API throw and advance past TTL
      vi.advanceTimersByTime(61_000);
      (client.getDashboardData as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("network"),
      );

      const output2 = makeOutput();
      await hook(makeInput(), output2);
      // Should still inject the stale context
      expect(output2.system).toHaveLength(1);
      expect(output2.system[0]).toContain("[Candela]");
    });

    it("does not lock out retries after failure", async () => {
      const client = {
        getDashboardData: vi
          .fn()
          .mockRejectedValueOnce(new Error("fail"))
          .mockResolvedValueOnce(
            makeDashboardData({ budget: null, totalCostUsd: 1 }),
          ),
      } as unknown as CandelaClient;
      const { hook } = createContextHook(client);

      // First call — fails
      const out1 = makeOutput();
      await hook(makeInput(), out1);
      expect(out1.system).toHaveLength(0);

      // Second call — should retry immediately since lastFetch was not updated
      const out2 = makeOutput();
      await hook(makeInput(), out2);
      expect(client.getDashboardData).toHaveBeenCalledTimes(2);
      expect(out2.system).toHaveLength(1);
    });
  });

  // ── Defensive model access ────────────────────────────────────────────────

  describe("defensive model access", () => {
    it("handles missing model gracefully", async () => {
      const data = makeDashboardData({ budget: null, totalCostUsd: 1 });
      const client = makeMockClient(data);
      const { hook } = createContextHook(client);

      const output = makeOutput();
      // Pass input with no model property
      await hook({} as Parameters<typeof hook>[0], output);
      expect(output.system).toHaveLength(1);
      expect(output.system[0]).toContain("[Candela]");
    });

    it("handles null model.id gracefully", async () => {
      const data = makeDashboardData({ budget: null, totalCostUsd: 1 });
      const client = makeMockClient(data);
      const { hook } = createContextHook(client);

      const output = makeOutput();
      await hook({ model: {} } as Parameters<typeof hook>[0], output);
      expect(output.system).toHaveLength(1);
    });
  });

  // ── Label correctness ─────────────────────────────────────────────────────

  describe("label correctness", () => {
    it('uses "Last 24h spend" not "Today\'s spend"', async () => {
      const data = makeDashboardData({ budget: null, totalCostUsd: 3.2 });
      const client = makeMockClient(data);
      const { hook } = createContextHook(client);

      const output = makeOutput();
      await hook(makeInput(), output);
      expect(output.system[0]).toContain("Last 24h spend");
      expect(output.system[0]).not.toContain("Today's spend");
    });
  });
});
