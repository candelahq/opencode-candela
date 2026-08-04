import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CandelaClient,
  makeTimeRange,
  makeTimeRangeFromDate,
} from "../candela-client.js";

describe("makeTimeRange", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-01T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("builds a ConnectRPC TimeRange for the given hours", () => {
    const range = makeTimeRange(2);
    expect(range).toEqual({
      time_range: {
        start: { seconds: "1785578400", nanos: 0 },
        end: { seconds: "1785585600", nanos: 0 },
      },
    });
  });
});

describe("makeTimeRangeFromDate", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-01T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("builds a ConnectRPC TimeRange from a specific start Date to now", () => {
    const start = new Date("2026-08-01T10:30:00Z");
    const range = makeTimeRangeFromDate(start);
    expect(range).toEqual({
      time_range: {
        start: { seconds: "1785580200", nanos: 0 },
        end: { seconds: "1785585600", nanos: 0 },
      },
    });
  });
});

describe("CandelaClient", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-01T12:00:00Z"));
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe("isAlive", () => {
    it("returns true and caches when health check succeeds", async () => {
      vi.mocked(fetch).mockResolvedValueOnce({ ok: true } as Response);
      const client = new CandelaClient();
      expect(await client.isAlive()).toBe(true);
      expect(fetch).toHaveBeenCalledTimes(1);

      // Should be cached
      expect(await client.isAlive()).toBe(true);
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it("returns false and caches when health check fails", async () => {
      vi.mocked(fetch).mockResolvedValueOnce({ ok: false } as Response);
      const client = new CandelaClient();
      expect(await client.isAlive()).toBe(false);
      expect(fetch).toHaveBeenCalledTimes(1);

      // Should be cached
      expect(await client.isAlive()).toBe(false);
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it("returns false on network error", async () => {
      vi.mocked(fetch).mockRejectedValueOnce(new Error("Network Error"));
      const client = new CandelaClient();
      expect(await client.isAlive()).toBe(false);
    });

    it("can reset health status", async () => {
      vi.mocked(fetch).mockResolvedValueOnce({ ok: false } as Response);
      const client = new CandelaClient();
      await client.isAlive();

      client.resetHealth();
      vi.mocked(fetch).mockResolvedValueOnce({ ok: true } as Response);
      expect(await client.isAlive()).toBe(true);
      expect(fetch).toHaveBeenCalledTimes(2);
    });
  });

  describe("getDashboardData", () => {
    it("returns null if not alive", async () => {
      vi.mocked(fetch).mockRejectedValueOnce(new Error()); // isAlive fails
      const client = new CandelaClient();
      expect(await client.getDashboardData()).toBeNull();
    });

    it("parses valid response with camelCase fields", async () => {
      vi.mocked(fetch).mockResolvedValueOnce({ ok: true } as Response); // isAlive
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          summary: {
            totalInputTokens: 100,
            totalOutputTokens: 50,
            totalCostUsd: 1.5,
            totalLlmCalls: 10,
          },
          models: [
            {
              model: "model-a",
              provider: "prov",
              inputTokens: 100,
              outputTokens: 50,
              costUsd: 1.5,
              callCount: 10,
              cacheReadTokens: 20,
              cacheCreationTokens: 10,
            },
          ],
          budgetContext: {
            budget: {
              limitUsd: 100,
              spentUsd: 80,
              periodEnd: "2026-08-01T15:00:00Z", // +3 hours
            },
            activeGrants: [
              {
                id: "g1",
                amountUsd: 50,
                spentUsd: 10,
                reason: "bonus",
                expiresAt: "2026-08-04T12:00:00Z", // +3 days
              },
            ],
            totalRemainingUsd: 60,
          },
        }),
      } as Response);

      const client = new CandelaClient();
      const data = await client.getDashboardData();
      expect(data).not.toBeNull();

      expect(data?.usage.totalTokens).toBe(150);
      expect(data?.usage.totalCostUsd).toBe(1.5);

      expect(data?.models[0].totalTokens).toBe(150);
      expect(data?.models[0].cacheReadTokens).toBe(20);

      expect(data?.budget?.limitUsd).toBe(100);
      expect(data?.budget?.remainingUsd).toBe(20);
      expect(data?.budget?.isNearLimit).toBe(true); // 80/100 >= 80%
      expect(data?.budget?.isExhausted).toBe(false);
      expect(data?.budget?.resetLabel).toBe("resets in 3h 0m");

      expect(data?.activeGrants[0].remainingUsd).toBe(40);
      expect(data?.activeGrants[0].isExpiringSoon).toBe(true); // < 7 days
      expect(data?.totalRemainingUsd).toBe(60);
    });

    it("parses valid response with snake_case fields (proto3 compatibility)", async () => {
      vi.mocked(fetch).mockResolvedValueOnce({ ok: true } as Response);
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          summary: {
            total_input_tokens: 100,
            total_output_tokens: 50,
            total_cost_usd: 1.5,
            total_llm_calls: 10,
          },
          models: [
            {
              model: "model-a",
              provider: "prov",
              input_tokens: 100,
              output_tokens: 50,
              cost_usd: 1.5,
              call_count: 10,
              cache_read_tokens: 20,
              cache_creation_tokens: 10,
            },
          ],
          budget_context: {
            budget: {
              limit_usd: 100,
              spent_usd: 80,
              period_end: "2026-08-01T15:00:00Z", // +3 hours
            },
            active_grants: [
              {
                id: "g1",
                amount_usd: 50,
                spent_usd: 10,
                reason: "bonus",
                expires_at: "2026-08-04T12:00:00Z", // +3 days
              },
            ],
            total_remaining_usd: 60,
          },
        }),
      } as Response);

      const client = new CandelaClient();
      const data = await client.getDashboardData();

      expect(data?.usage.totalTokens).toBe(150);
      expect(data?.models[0].cacheReadTokens).toBe(20);
      expect(data?.budget?.limitUsd).toBe(100);
      expect(data?.activeGrants[0].remainingUsd).toBe(40);
    });

    it("budget with NaN values returns null budget", async () => {
      vi.mocked(fetch).mockResolvedValueOnce({ ok: true } as Response);
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          budgetContext: {
            budget: {
              limitUsd: "not a number",
              spentUsd: 10,
            },
          },
        }),
      } as Response);

      const client = new CandelaClient();
      const data = await client.getDashboardData();
      expect(data?.budget).toBeNull();
    });

    it("budget with invalid date returns null budget", async () => {
      vi.mocked(fetch).mockResolvedValueOnce({ ok: true } as Response);
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          budgetContext: {
            budget: {
              limitUsd: 100,
              spentUsd: 10,
              periodEnd: "invalid date string",
            },
          },
        }),
      } as Response);

      const client = new CandelaClient();
      const data = await client.getDashboardData();
      expect(data?.budget).toBeNull();
    });

    it("detects grant expiry and exhaustion correctly", async () => {
      vi.mocked(fetch).mockResolvedValueOnce({ ok: true } as Response);
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          budgetContext: {
            activeGrants: [
              {
                amountUsd: 100,
                spentUsd: 100,
                expiresAt: "2026-08-20T12:00:00Z",
              }, // Exhausted, not expiring soon (>7 days)
              {
                amountUsd: 100,
                spentUsd: 50,
                expiresAt: "2026-08-05T12:00:00Z",
              }, // Not exhausted, expiring soon (<7 days)
            ],
          },
        }),
      } as Response);

      const client = new CandelaClient();
      const data = await client.getDashboardData();
      expect(data?.activeGrants[0].isExhausted).toBe(true);
      expect(data?.activeGrants[0].isExpiringSoon).toBe(false); // +19 days

      expect(data?.activeGrants[1].isExhausted).toBe(false);
      expect(data?.activeGrants[1].isExpiringSoon).toBe(true); // +4 days
    });

    it("404 status triggers legacyFanout", async () => {
      vi.mocked(fetch).mockResolvedValueOnce({ ok: true } as Response); // isAlive

      // tryGetDashboardData fails with 404
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: false,
        status: 404,
      } as Response);

      // legacyFanout fetches GetUsageSummary and GetMyBudget
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ totalInputTokens: 100, totalOutputTokens: 50 }),
      } as Response);
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ budget: { limitUsd: 50, spentUsd: 10 } }),
      } as Response);

      const client = new CandelaClient();
      const data = await client.getDashboardData();

      expect(data?.usage.totalTokens).toBe(150);
      expect(data?.budget?.limitUsd).toBe(50);
      expect(fetch).toHaveBeenCalledTimes(4); // isAlive, tryGet, legacy1, legacy2
    });

    it("returns cached data if within TTL", async () => {
      vi.mocked(fetch).mockResolvedValueOnce({ ok: true } as Response); // isAlive
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ summary: { totalInputTokens: 100 } }),
      } as Response);

      const client = new CandelaClient("http://localhost:8181", 5000); // 5s TTL
      const data1 = await client.getDashboardData();
      expect(data1?.usage.totalTokens).toBe(100);
      expect(fetch).toHaveBeenCalledTimes(2);

      // Advance time by 2s (within TTL)
      vi.advanceTimersByTime(2000);

      const data2 = await client.getDashboardData();
      expect(data2).toBe(data1); // Should return same cached object
      expect(fetch).toHaveBeenCalledTimes(2); // No extra fetches
    });

    it("fetches new data if TTL expired", async () => {
      vi.mocked(fetch).mockResolvedValueOnce({ ok: true } as Response); // isAlive
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ summary: { totalInputTokens: 100 } }),
      } as Response);

      const client = new CandelaClient("http://localhost:8181", 5000); // 5s TTL
      await client.getDashboardData();
      expect(fetch).toHaveBeenCalledTimes(2);

      // Advance time by 6s (beyond TTL)
      vi.advanceTimersByTime(6000);

      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ summary: { totalInputTokens: 200 } }),
      } as Response);

      const data2 = await client.getDashboardData();
      expect(data2?.usage.totalTokens).toBe(200);
      expect(fetch).toHaveBeenCalledTimes(3); // Fetched again
    });

    it("invalidates cache when invalidateCache is called", async () => {
      vi.mocked(fetch).mockResolvedValueOnce({ ok: true } as Response); // isAlive
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ summary: { totalInputTokens: 100 } }),
      } as Response);

      const client = new CandelaClient("http://localhost:8181", 5000);
      await client.getDashboardData();

      client.invalidateCache();

      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ summary: { totalInputTokens: 200 } }),
      } as Response);

      const data2 = await client.getDashboardData();
      expect(data2?.usage.totalTokens).toBe(200);
    });
  });

  describe("getModelBreakdown", () => {
    it("returns null if not alive", async () => {
      vi.mocked(fetch).mockRejectedValueOnce(new Error()); // isAlive fails
      const client = new CandelaClient();
      expect(await client.getModelBreakdown()).toBeNull();
    });

    it("parses models from response", async () => {
      vi.mocked(fetch).mockResolvedValueOnce({ ok: true } as Response); // isAlive
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          models: [
            {
              model: "model-x",
              provider: "prov-x",
              input_tokens: 50,
              output_tokens: 50,
              cost_usd: 2.0,
              call_count: 5,
              cache_read_tokens: 10,
              cache_creation_tokens: 5,
            },
          ],
        }),
      } as Response);

      const client = new CandelaClient();
      const models = await client.getModelBreakdown();

      expect(models).not.toBeNull();
      expect(models?.length).toBe(1);
      expect(models?.[0].model).toBe("model-x");
      expect(models?.[0].totalTokens).toBe(100);
      expect(models?.[0].totalCostUsd).toBe(2.0);
      expect(models?.[0].cacheReadTokens).toBe(10);
      expect(models?.[0].cacheCreationTokens).toBe(5);
    });
  });
});
