import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetRotationFlag,
  detectCostAnomaly,
  getCumulativeCost,
  getSessionCount,
  getSessionHistory,
  getTimeOfDayPatterns,
  pruneAnalytics,
  readCostStreaks,
  readSpendTrends,
  readWeeklyDigest,
} from "../analytics-reader.js";

// Mock node:fs to control the analytics file contents
vi.mock("node:fs", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    statSync: vi.fn(() => ({ size: 1024 })),
    writeFileSync: vi.fn(),
  };
});

// Mock node:os so homedir doesn't vary between machines
vi.mock("node:os", () => ({
  homedir: () => "/mock-home",
}));

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";

const mockExists = vi.mocked(existsSync);
const mockRead = vi.mocked(readFileSync);
const mockStat = vi.mocked(statSync);
const mockWrite = vi.mocked(writeFileSync);

let entryCounter = 0;
function makeEntry(
  date: string,
  cost: number,
  sessionId?: string,
  hour = 12,
): string {
  entryCounter++;
  const hh = String(hour).padStart(2, "0");
  return JSON.stringify({
    ts: `${date}T${hh}:00:00.000Z`,
    sessionId: sessionId ?? `sess-${entryCounter}`,
    totalCost: cost,
    duration: 300,
    toolCalls: 5,
    pluginVersion: "0.6.0",
    models: ["gpt-4o"],
  });
}

describe("analytics-reader", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    entryCounter = 0;
  });

  describe("readSpendTrends", () => {
    it("returns null when analytics file does not exist", () => {
      mockExists.mockReturnValue(false);
      expect(readSpendTrends()).toBeNull();
    });

    it("returns null when file is empty", () => {
      mockExists.mockReturnValue(true);
      mockRead.mockReturnValue("");
      expect(readSpendTrends()).toBeNull();
    });

    it("returns null when fewer than 2 days of data", () => {
      mockExists.mockReturnValue(true);
      mockRead.mockReturnValue(makeEntry("2026-08-03", 5.0));
      expect(readSpendTrends()).toBeNull();
    });

    it("computes correct trends for multi-day data", () => {
      const now = new Date();
      const today = now.toISOString().slice(0, 10);

      const yesterday = new Date(now);
      yesterday.setDate(yesterday.getDate() - 1);
      const yesterdayStr = yesterday.toISOString().slice(0, 10);

      const twoDaysAgo = new Date(now);
      twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
      const twoDaysAgoStr = twoDaysAgo.toISOString().slice(0, 10);

      mockExists.mockReturnValue(true);
      mockRead.mockReturnValue(
        [
          makeEntry(twoDaysAgoStr, 10.0),
          makeEntry(yesterdayStr, 20.0),
          makeEntry(yesterdayStr, 5.0), // Two entries same day
          makeEntry(today, 3.0),
        ].join("\n"),
      );

      const trends = readSpendTrends();
      expect(trends).not.toBeNull();
      // Each entry has a unique sessionId, so all 4 count
      expect(trends?.yesterdayCost).toBe(25.0); // 20 + 5
      expect(trends?.daysOfData).toBe(3);
      // Avg excludes today: (10 + 25) / 2 = 17.5
      expect(trends?.avgDailyCost).toBe(17.5);
    });

    it("deduplicates multiple idle snapshots for the same session", () => {
      const now = new Date();
      const yesterday = new Date(now);
      yesterday.setDate(yesterday.getDate() - 1);
      const yesterdayStr = yesterday.toISOString().slice(0, 10);

      const twoDaysAgo = new Date(now);
      twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
      const twoDaysAgoStr = twoDaysAgo.toISOString().slice(0, 10);

      mockExists.mockReturnValue(true);
      // dup-session written 3 times with increasing timestamps (idle snapshots)
      // third-session on twoDaysAgo ensures we have 2+ days for trends
      mockRead.mockReturnValue(
        [
          makeEntry(twoDaysAgoStr, 3.0, "third-session"),
          makeEntry(yesterdayStr, 8.0, "dup-session", 10),
          makeEntry(yesterdayStr, 12.0, "dup-session", 11),
          makeEntry(yesterdayStr, 15.0, "dup-session", 14),
          makeEntry(yesterdayStr, 7.0, "other-session"),
        ].join("\n"),
      );

      const trends = readSpendTrends();
      expect(trends).not.toBeNull();
      // 3 unique sessions: third(3.0 twoDaysAgo), dup(15.0 yesterday), other(7.0 yesterday)
      // yesterday = 15.0 + 7.0 = 22.0
      expect(trends?.yesterdayCost).toBe(22.0);
    });

    it("handles malformed lines gracefully", () => {
      const now = new Date();
      const yesterday = new Date(now);
      yesterday.setDate(yesterday.getDate() - 1);
      const yesterdayStr = yesterday.toISOString().slice(0, 10);

      const twoDaysAgo = new Date(now);
      twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
      const twoDaysAgoStr = twoDaysAgo.toISOString().slice(0, 10);

      mockExists.mockReturnValue(true);
      mockRead.mockReturnValue(
        [
          "NOT VALID JSON",
          makeEntry(twoDaysAgoStr, 10.0),
          "{bad json",
          makeEntry(yesterdayStr, 15.0),
        ].join("\n"),
      );

      const trends = readSpendTrends();
      expect(trends).not.toBeNull();
      expect(trends?.yesterdayCost).toBe(15.0);
    });

    it("rejects entries with invalid shapes (numeric ts, missing sessionId, Infinity cost)", () => {
      const now = new Date();
      const yesterday = new Date(now);
      yesterday.setDate(yesterday.getDate() - 1);
      const yesterdayStr = yesterday.toISOString().slice(0, 10);

      const twoDaysAgo = new Date(now);
      twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
      const twoDaysAgoStr = twoDaysAgo.toISOString().slice(0, 10);

      mockExists.mockReturnValue(true);
      mockRead.mockReturnValue(
        [
          // Invalid: numeric ts
          JSON.stringify({ ts: 12345, sessionId: "bad-ts", totalCost: 5.0 }),
          // Invalid: missing sessionId
          JSON.stringify({
            ts: `${yesterdayStr}T12:00:00.000Z`,
            totalCost: 5.0,
          }),
          // Invalid: Infinity cost
          JSON.stringify({
            ts: `${yesterdayStr}T12:00:00.000Z`,
            sessionId: "inf",
            totalCost: Infinity,
          }),
          // Valid entries
          makeEntry(twoDaysAgoStr, 10.0, "good-1"),
          makeEntry(yesterdayStr, 20.0, "good-2"),
        ].join("\n"),
      );

      const trends = readSpendTrends();
      expect(trends).not.toBeNull();
      // Only the 2 valid entries survive
      expect(trends?.yesterdayCost).toBe(20.0);
      expect(trends?.daysOfData).toBe(2);
    });
  });

  describe("getSessionCount", () => {
    it("returns 0 when file does not exist", () => {
      mockExists.mockReturnValue(false);
      expect(getSessionCount()).toBe(0);
    });

    it("counts unique sessions in the analytics file", () => {
      mockExists.mockReturnValue(true);
      mockRead.mockReturnValue(
        [
          makeEntry("2026-08-01", 5, "s1"),
          makeEntry("2026-08-02", 10, "s2"),
        ].join("\n"),
      );
      expect(getSessionCount()).toBe(2);
    });

    it("deduplicates repeated idle writes for same session", () => {
      mockExists.mockReturnValue(true);
      mockRead.mockReturnValue(
        [
          makeEntry("2026-08-01", 5, "same-id"),
          makeEntry("2026-08-01", 8, "same-id"),
          makeEntry("2026-08-02", 10, "other-id"),
        ].join("\n"),
      );
      expect(getSessionCount()).toBe(2); // not 3
    });
  });

  describe("getCumulativeCost", () => {
    it("returns 0 when file does not exist", () => {
      mockExists.mockReturnValue(false);
      expect(getCumulativeCost()).toBe(0);
    });

    it("sums totalCost across unique sessions", () => {
      mockExists.mockReturnValue(true);
      mockRead.mockReturnValue(
        [
          makeEntry("2026-08-01", 5.5, "s1"),
          makeEntry("2026-08-02", 12.3, "s2"),
          makeEntry("2026-08-03", 7.2, "s3"),
        ].join("\n"),
      );
      expect(getCumulativeCost()).toBe(25.0);
    });

    it("uses latest entry per session for cost", () => {
      mockExists.mockReturnValue(true);
      mockRead.mockReturnValue(
        [
          makeEntry("2026-08-01", 5.0, "s1", 10),
          makeEntry("2026-08-01", 12.0, "s1", 14), // later timestamp wins
          makeEntry("2026-08-02", 3.0, "s2"),
        ].join("\n"),
      );
      // s1: latest = 12.0, s2: 3.0 → total = 15.0
      expect(getCumulativeCost()).toBe(15.0);
    });

    it("skips malformed entries", () => {
      mockExists.mockReturnValue(true);
      mockRead.mockReturnValue(
        ["bad json", makeEntry("2026-08-01", 10.0)].join("\n"),
      );
      expect(getCumulativeCost()).toBe(10.0);
    });
  });

  describe("readWeeklyDigest", () => {
    it("returns null when file does not exist", () => {
      mockExists.mockReturnValue(false);
      expect(readWeeklyDigest()).toBeNull();
    });

    it("returns null when fewer than 14 days of data", () => {
      mockExists.mockReturnValue(true);
      // Generate 10 days of data (not enough)
      const lines: string[] = [];
      for (let i = 1; i <= 10; i++) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        lines.push(makeEntry(d.toISOString().slice(0, 10), 5.0, `s${i}`));
      }
      mockRead.mockReturnValue(lines.join("\n"));
      expect(readWeeklyDigest()).toBeNull();
    });

    it("computes weekly comparison with sufficient data", () => {
      mockExists.mockReturnValue(true);
      // Generate 21 days of data
      const lines: string[] = [];
      for (let i = 0; i < 21; i++) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        // Vary cost to make weeks different
        const cost = i < 7 ? 10.0 : i < 14 ? 5.0 : 2.0;
        lines.push(makeEntry(d.toISOString().slice(0, 10), cost, `s${i}`));
      }
      mockRead.mockReturnValue(lines.join("\n"));

      const digest = readWeeklyDigest();
      expect(digest).not.toBeNull();
      expect(digest?.thisWeekSessions).toBeGreaterThan(0);
      expect(digest?.lastWeekSessions).toBeGreaterThan(0);
      expect(typeof digest?.changePercent).toBe("number");
    });
  });

  describe("readCostStreaks", () => {
    it("returns null with fewer than 7 days", () => {
      mockExists.mockReturnValue(true);
      const lines: string[] = [];
      for (let i = 0; i < 5; i++) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        lines.push(makeEntry(d.toISOString().slice(0, 10), 5.0, `s${i}`));
      }
      mockRead.mockReturnValue(lines.join("\n"));
      expect(readCostStreaks()).toBeNull();
    });

    it("computes streak correctly", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-08-10T12:00:00Z")); // Sunday

      mockExists.mockReturnValue(true);
      const lines: string[] = [];
      for (let i = 0; i < 10; i++) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        // Days 1,2,3 (yesterday back) cost 1.0 each
        // All other days cost 20.0 each
        // 7-day avg will be ~(20*4 + 1*3)/7 ≈ 11.9, so 1.0 is well under
        const cost = i > 0 && i <= 3 ? 1.0 : 20.0;
        lines.push(makeEntry(d.toISOString().slice(0, 10), cost, `s${i}`));
      }
      mockRead.mockReturnValue(lines.join("\n"));

      const streaks = readCostStreaks();
      expect(streaks).not.toBeNull();
      expect(streaks?.currentStreak).toBeGreaterThanOrEqual(2);
      expect(streaks?.dailyTarget).toBeGreaterThan(0);
      vi.useRealTimers();
    });
  });

  describe("detectCostAnomaly", () => {
    it("returns null with fewer than 5 sessions", () => {
      mockExists.mockReturnValue(true);
      const lines: string[] = [];
      for (let i = 0; i < 3; i++) {
        lines.push(makeEntry("2026-08-01", 5.0, `s${i}`));
      }
      mockRead.mockReturnValue(lines.join("\n"));
      expect(detectCostAnomaly(15.0)).toBeNull();
    });

    it("detects anomaly when current cost is 3x average", () => {
      mockExists.mockReturnValue(true);
      const lines: string[] = [];
      for (let i = 0; i < 10; i++) {
        lines.push(makeEntry("2026-08-01", 5.0, `s${i}`));
      }
      mockRead.mockReturnValue(lines.join("\n"));

      const anomaly = detectCostAnomaly(15.0);
      expect(anomaly).not.toBeNull();
      expect(anomaly?.isAnomaly).toBe(true);
      expect(anomaly?.multiplier).toBe(3.0);
    });

    it("does not flag normal sessions", () => {
      mockExists.mockReturnValue(true);
      const lines: string[] = [];
      for (let i = 0; i < 10; i++) {
        lines.push(makeEntry("2026-08-01", 5.0, `s${i}`));
      }
      mockRead.mockReturnValue(lines.join("\n"));

      const anomaly = detectCostAnomaly(7.0);
      expect(anomaly).not.toBeNull();
      expect(anomaly?.isAnomaly).toBe(false);
    });
  });

  describe("pruneAnalytics", () => {
    beforeEach(() => {
      _resetRotationFlag();
    });

    it("does nothing when file does not exist", () => {
      mockExists.mockReturnValue(false);
      const result = pruneAnalytics();
      expect(result).toEqual({ prunedCount: 0, keptCount: 0 });
      expect(mockWrite).not.toHaveBeenCalled();
    });

    it("prunes entries older than 90 days", () => {
      mockExists.mockReturnValue(true);
      mockStat.mockReturnValue({ size: 1024 } as ReturnType<typeof statSync>);

      const recent = new Date();
      recent.setDate(recent.getDate() - 10);
      const old = new Date();
      old.setDate(old.getDate() - 100);

      const lines = [
        makeEntry(old.toISOString().slice(0, 10), 5.0, "old-session"),
        makeEntry(recent.toISOString().slice(0, 10), 3.0, "recent-session"),
      ];
      mockRead.mockReturnValue(lines.join("\n"));

      const result = pruneAnalytics();
      expect(result.prunedCount).toBe(1);
      expect(result.keptCount).toBe(1);
      expect(mockWrite).toHaveBeenCalled();
    });

    it("only runs once per process (idempotent)", () => {
      mockExists.mockReturnValue(true);
      mockStat.mockReturnValue({ size: 1024 } as ReturnType<typeof statSync>);
      mockRead.mockReturnValue(makeEntry("2026-08-01", 5.0));

      // First call runs
      pruneAnalytics();
      // Second call should be a no-op
      const result = pruneAnalytics();
      expect(result).toEqual({ prunedCount: 0, keptCount: 0 });
    });
  });

  describe("getSessionHistory", () => {
    it("returns empty array when no file", () => {
      mockExists.mockReturnValue(false);
      expect(getSessionHistory()).toEqual([]);
    });

    it("returns sessions newest-first with rich fields", () => {
      mockExists.mockReturnValue(true);
      const lines = [
        JSON.stringify({
          ts: "2026-08-01T10:00:00.000Z",
          sessionId: "s1",
          totalCost: 2.0,
          duration: 600,
          toolCalls: 10,
          models: ["gpt-4o"],
          tag: "debugging",
          repo: "my-app",
        }),
        JSON.stringify({
          ts: "2026-08-02T14:00:00.000Z",
          sessionId: "s2",
          totalCost: 5.0,
          duration: 1200,
          toolCalls: 25,
          models: ["claude-sonnet"],
        }),
      ];
      mockRead.mockReturnValue(lines.join("\n"));
      const history = getSessionHistory(10);
      expect(history).toHaveLength(2);
      // Newest first
      expect(history[0].sessionId).toBe("s2");
      expect(history[0].totalCost).toBe(5.0);
      expect(history[0].tag).toBeNull();
      expect(history[1].sessionId).toBe("s1");
      expect(history[1].tag).toBe("debugging");
      expect(history[1].repo).toBe("my-app");
    });

    it("respects limit", () => {
      mockExists.mockReturnValue(true);
      const lines = Array.from({ length: 20 }, (_, i) =>
        makeEntry("2026-08-01", i + 1),
      );
      mockRead.mockReturnValue(lines.join("\n"));
      expect(getSessionHistory(5)).toHaveLength(5);
    });
  });

  describe("getTimeOfDayPatterns", () => {
    it("returns null with fewer than 5 sessions", () => {
      mockExists.mockReturnValue(true);
      const lines = [
        makeEntry("2026-08-01", 1.0, undefined, 9),
        makeEntry("2026-08-01", 2.0, undefined, 14),
      ];
      mockRead.mockReturnValue(lines.join("\n"));
      expect(getTimeOfDayPatterns()).toBeNull();
    });

    it("groups sessions into time buckets", () => {
      mockExists.mockReturnValue(true);
      const lines = [
        makeEntry("2026-08-01", 1.0, undefined, 7), // Morning
        makeEntry("2026-08-01", 1.5, undefined, 10), // Morning
        makeEntry("2026-08-01", 5.0, undefined, 14), // Afternoon
        makeEntry("2026-08-01", 6.0, undefined, 15), // Afternoon
        makeEntry("2026-08-01", 2.0, undefined, 20), // Evening
      ];
      mockRead.mockReturnValue(lines.join("\n"));
      const patterns = getTimeOfDayPatterns();
      expect(patterns).not.toBeNull();
      expect(patterns?.mostExpensive).toBe("Afternoon");
      expect(patterns?.cheapest).toBe("Morning");
      expect(patterns?.costRatio).toBeGreaterThan(1);
    });
  });
});
