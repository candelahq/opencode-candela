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

/** Type guard: require string ts, non-empty string sessionId, finite cost. */
function isValidEntry(parsed: unknown): parsed is AnalyticsEntry {
  if (typeof parsed !== "object" || parsed === null) return false;
  const p = parsed as Record<string, unknown>;
  return (
    typeof p.ts === "string" &&
    p.ts.length > 0 &&
    typeof p.sessionId === "string" &&
    p.sessionId.length > 0 &&
    typeof p.totalCost === "number" &&
    Number.isFinite(p.totalCost)
  );
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
    const rawEntries: AnalyticsEntry[] = [];
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        if (isValidEntry(parsed)) {
          rawEntries.push(parsed);
        }
      } catch {
        // Skip malformed lines
      }
    }

    if (rawEntries.length === 0) return null;

    // Deduplicate: session.idle writes multiple snapshots per session.
    // Keep only the latest entry per sessionId.
    const bySession = new Map<string, AnalyticsEntry>();
    for (const e of rawEntries) {
      const existing = bySession.get(e.sessionId);
      if (!existing || e.ts > existing.ts) {
        bySession.set(e.sessionId, e);
      }
    }
    const entries = [...bySession.values()];

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

/**
 * Parse the JSONL file and deduplicate by sessionId (keep latest per session).
 * Shared by getSessionCount and getCumulativeCost.
 */
function parseUniqueEntries(): AnalyticsEntry[] {
  if (!existsSync(ANALYTICS_PATH)) return [];
  try {
    const raw = readFileSync(ANALYTICS_PATH, "utf-8");
    const bySession = new Map<string, AnalyticsEntry>();
    for (const line of raw.trim().split("\n").filter(Boolean)) {
      try {
        const parsed = JSON.parse(line);
        if (isValidEntry(parsed)) {
          const existing = bySession.get(parsed.sessionId);
          if (!existing || parsed.ts > existing.ts) {
            bySession.set(parsed.sessionId, parsed);
          }
        }
      } catch {
        // skip
      }
    }
    return [...bySession.values()];
  } catch {
    return [];
  }
}

/** Count unique sessions recorded in analytics. */
export function getSessionCount(): number {
  return parseUniqueEntries().length;
}

/** Sum total cost across unique sessions. */
export function getCumulativeCost(): number {
  return parseUniqueEntries().reduce((sum, e) => sum + e.totalCost, 0);
}
