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

function makeEntry(date: string, cost: number, sessionId = "sess-1"): string {
  return JSON.stringify({
    ts: `${date}T12:00:00.000Z`,
    sessionId,
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
      expect(trends?.yesterdayCost).toBe(25.0); // 20 + 5
      expect(trends?.daysOfData).toBe(3);
      // Avg excludes today: (10 + 25) / 2 = 17.5
      expect(trends?.avgDailyCost).toBe(17.5);
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

    it("counts lines in the analytics file", () => {
      mockExists.mockReturnValue(true);
      mockRead.mockReturnValue(
        [makeEntry("2026-08-01", 5), makeEntry("2026-08-02", 10)].join("\n"),
      );
      expect(getSessionCount()).toBe(2);
    });
  });

  describe("getCumulativeCost", () => {
    it("returns 0 when file does not exist", () => {
      mockExists.mockReturnValue(false);
      expect(getCumulativeCost()).toBe(0);
    });

    it("sums totalCost across all entries", () => {
      mockExists.mockReturnValue(true);
      mockRead.mockReturnValue(
        [
          makeEntry("2026-08-01", 5.5),
          makeEntry("2026-08-02", 12.3),
          makeEntry("2026-08-03", 7.2),
        ].join("\n"),
      );
      expect(getCumulativeCost()).toBe(25.0);
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
