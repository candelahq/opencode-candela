/**
 * Analytics reader for local session data.
 *
 * Reads the JSONL analytics file written by the plugin to compute
 * spend trends (yesterday, this week, daily average) for the
 * startup summary toast.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const ANALYTICS_PATH = join(
  homedir(),
  ".config",
  "opencode",
  "candela-analytics.jsonl",
);

interface AnalyticsEntry {
  ts: string;
  sessionId: string;
  totalCost: number;
}

export interface SpendTrend {
  /** Total spend from sessions that started yesterday (calendar day). */
  yesterdayCost: number;
  /** Total spend from sessions in the last 7 calendar days. */
  weekCost: number;
  /** Average daily spend across all recorded days. */
  avgDailyCost: number;
  /** Number of distinct calendar days with data. */
  daysOfData: number;
}

/**
 * Read the analytics JSONL file and compute spend trends.
 * Returns null if the file doesn't exist or has < 2 days of data.
 */
export function readSpendTrends(): SpendTrend | null {
  if (!existsSync(ANALYTICS_PATH)) return null;

  try {
    const raw = readFileSync(ANALYTICS_PATH, "utf-8");
    const lines = raw.trim().split("\n").filter(Boolean);
    if (lines.length === 0) return null;

    // Parse entries, skipping malformed lines
    const entries: AnalyticsEntry[] = [];
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        if (parsed.ts && typeof parsed.totalCost === "number") {
          entries.push(parsed);
        }
      } catch {
        // Skip malformed lines
      }
    }

    if (entries.length === 0) return null;

    // Group costs by calendar day (YYYY-MM-DD)
    const dailyCosts = new Map<string, number>();
    for (const e of entries) {
      const day = e.ts.slice(0, 10); // "2026-08-03"
      dailyCosts.set(day, (dailyCosts.get(day) ?? 0) + e.totalCost);
    }

    if (dailyCosts.size < 2) return null;

    const now = new Date();
    const todayStr = now.toISOString().slice(0, 10);

    // Yesterday
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toISOString().slice(0, 10);
    const yesterdayCost = dailyCosts.get(yesterdayStr) ?? 0;

    // Last 7 days (excluding today)
    let weekCost = 0;
    for (let i = 1; i <= 7; i++) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      const dayStr = d.toISOString().slice(0, 10);
      weekCost += dailyCosts.get(dayStr) ?? 0;
    }

    // Average daily (exclude today since it's partial)
    let totalCost = 0;
    let daysExcludingToday = 0;
    for (const [day, cost] of dailyCosts) {
      if (day !== todayStr) {
        totalCost += cost;
        daysExcludingToday++;
      }
    }
    const avgDailyCost =
      daysExcludingToday > 0 ? totalCost / daysExcludingToday : 0;

    return {
      yesterdayCost,
      weekCost,
      avgDailyCost,
      daysOfData: dailyCosts.size,
    };
  } catch {
    return null;
  }
}

/** Count total sessions recorded in analytics. */
export function getSessionCount(): number {
  if (!existsSync(ANALYTICS_PATH)) return 0;
  try {
    const raw = readFileSync(ANALYTICS_PATH, "utf-8");
    return raw.trim().split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
}

/** Sum total cost across all recorded sessions. */
export function getCumulativeCost(): number {
  if (!existsSync(ANALYTICS_PATH)) return 0;
  try {
    const raw = readFileSync(ANALYTICS_PATH, "utf-8");
    let total = 0;
    for (const line of raw.trim().split("\n").filter(Boolean)) {
      try {
        const parsed = JSON.parse(line);
        if (typeof parsed.totalCost === "number") {
          total += parsed.totalCost;
        }
      } catch {
        // skip
      }
    }
    return total;
  } catch {
    return 0;
  }
}
