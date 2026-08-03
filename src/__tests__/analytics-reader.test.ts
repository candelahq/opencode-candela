import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getCumulativeCost,
  getSessionCount,
  readSpendTrends,
} from "../analytics-reader.js";

// Mock node:fs to control the analytics file contents
vi.mock("node:fs", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
  };
});

// Mock node:os so homedir doesn't vary between machines
vi.mock("node:os", () => ({
  homedir: () => "/mock-home",
}));

import { existsSync, readFileSync } from "node:fs";

const mockExists = vi.mocked(existsSync);
const mockRead = vi.mocked(readFileSync);

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
});
