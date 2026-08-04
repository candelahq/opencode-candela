/**
 * Analytics reader for local session data.
 *
 * Reads the JSONL analytics file written by the plugin to compute
 * spend trends (yesterday, this week, daily average) for the
 * startup summary toast.
 *
 * Includes automatic rotation: entries older than 90 days are pruned
 * and the file is capped at MAX_FILE_BYTES (10 MB).
 */

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const ANALYTICS_PATH = join(
  homedir(),
  ".config",
  "opencode",
  "candela-analytics.jsonl",
);

/** Maximum age of analytics entries in milliseconds (90 days). */
const MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
/** Maximum file size before forced pruning (10 MB). */
const MAX_FILE_BYTES = 10 * 1024 * 1024;

let rotationDone = false;

/**
 * Prune analytics entries older than 90 days. Also triggers if file > 10 MB.
 * Runs at most once per process to avoid repeated disk writes.
 */
export function pruneAnalytics(): { prunedCount: number; keptCount: number } {
  if (rotationDone) return { prunedCount: 0, keptCount: 0 };
  rotationDone = true;

  if (!existsSync(ANALYTICS_PATH)) return { prunedCount: 0, keptCount: 0 };

  try {
    const stats = statSync(ANALYTICS_PATH);
    const cutoffMs = Date.now() - MAX_AGE_MS;

    const raw = readFileSync(ANALYTICS_PATH, "utf-8");
    const lines = raw.trim().split("\n").filter(Boolean);

    // First pass: keep only valid, non-expired entries
    const kept: { line: string; tsMs: number }[] = [];
    let pruned = 0;

    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        const tsMs = new Date(parsed.ts).getTime();
        if (isValidEntry(parsed) && Number.isFinite(tsMs) && tsMs >= cutoffMs) {
          kept.push({ line, tsMs });
        } else {
          pruned++;
        }
      } catch {
        pruned++; // drop malformed lines
      }
    }

    // Second pass: if still over MAX_FILE_BYTES, evict oldest entries
    if (stats.size > MAX_FILE_BYTES && kept.length > 0) {
      // Sort newest-first so we keep the most recent
      kept.sort((a, b) => b.tsMs - a.tsMs);
      let totalBytes = 0;
      let cutIdx = kept.length;
      for (let i = 0; i < kept.length; i++) {
        totalBytes += kept[i].line.length + 1; // +1 for newline
        if (totalBytes > MAX_FILE_BYTES) {
          cutIdx = i;
          break;
        }
      }
      if (cutIdx < kept.length) {
        pruned += kept.length - cutIdx;
        kept.length = cutIdx;
      }
      // Restore chronological order for the file
      kept.sort((a, b) => a.tsMs - b.tsMs);
    }

    if (pruned > 0) {
      writeFileSync(
        ANALYTICS_PATH,
        `${kept.map((k) => k.line).join("\n")}\n`,
        "utf-8",
      );
    }

    return { prunedCount: pruned, keptCount: kept.length };
  } catch {
    return { prunedCount: 0, keptCount: 0 };
  }
}

/** @internal — Reset the once-per-process flag. Only for tests. */
export function _resetRotationFlag(): void {
  rotationDone = false;
}

interface AnalyticsEntry {
  ts: string;
  sessionId: string;
  totalCost: number;
  /** Optional rich fields — present when written by newer plugin versions. */
  duration?: number;
  toolCalls?: number;
  toolUsage?: Record<string, number>;
  models?: string[];
  tag?: string;
  repo?: string;
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

export interface WeeklyDigest {
  thisWeekCost: number;
  lastWeekCost: number;
  changePercent: number; // positive = spending more
  thisWeekSessions: number;
  lastWeekSessions: number;
}

export function readWeeklyDigest(): WeeklyDigest | null {
  const entries = parseUniqueEntries();
  if (entries.length === 0) return null;

  const dailyCosts = new Map<string, number>();
  for (const e of entries) {
    const day = e.ts.slice(0, 10);
    dailyCosts.set(day, (dailyCosts.get(day) ?? 0) + e.totalCost);
  }
  if (dailyCosts.size < 14) return null;

  // Use UTC consistently — analytics entries store UTC ISO timestamps,
  // so week boundaries must also be computed in UTC.
  const now = new Date();
  const utcDay = now.getUTCDay();
  const diffToMonday = utcDay === 0 ? -6 : 1 - utcDay;
  const thisWeekStart = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() + diffToMonday,
    ),
  );
  const thisWeekStartStr = thisWeekStart.toISOString().slice(0, 10);

  const nextWeekStart = new Date(thisWeekStart);
  nextWeekStart.setUTCDate(nextWeekStart.getUTCDate() + 7);
  const nextWeekStartStr = nextWeekStart.toISOString().slice(0, 10);

  const lastWeekStart = new Date(thisWeekStart);
  lastWeekStart.setUTCDate(lastWeekStart.getUTCDate() - 7);
  const lastWeekStartStr = lastWeekStart.toISOString().slice(0, 10);

  let thisWeekCost = 0;
  let lastWeekCost = 0;
  let thisWeekSessions = 0;
  let lastWeekSessions = 0;

  for (const e of entries) {
    const tsStr = e.ts.slice(0, 10);
    if (tsStr >= thisWeekStartStr && tsStr < nextWeekStartStr) {
      thisWeekCost += e.totalCost;
      thisWeekSessions++;
    } else if (tsStr >= lastWeekStartStr && tsStr < thisWeekStartStr) {
      lastWeekCost += e.totalCost;
      lastWeekSessions++;
    }
  }

  const changePercent =
    lastWeekCost > 0 ? ((thisWeekCost - lastWeekCost) / lastWeekCost) * 100 : 0;

  return {
    thisWeekCost,
    lastWeekCost,
    changePercent,
    thisWeekSessions,
    lastWeekSessions,
  };
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

export interface CostStreak {
  /** Consecutive days (ending yesterday) where daily cost was under the target */
  currentStreak: number;
  /** Longest streak ever recorded */
  record: number;
  /** The daily target — rolling 7-day average */
  dailyTarget: number;
}

export function readCostStreaks(): CostStreak | null {
  const entries = parseUniqueEntries();
  if (entries.length === 0) return null;

  const dailyCosts = new Map<string, number>();
  for (const e of entries) {
    const day = e.ts.slice(0, 10);
    dailyCosts.set(day, (dailyCosts.get(day) ?? 0) + e.totalCost);
  }

  if (dailyCosts.size < 7) return null;

  const now = new Date();
  const sortedDays = Array.from(dailyCosts.keys()).sort();

  const firstDay = new Date(sortedDays[0]);
  const lastDay = new Date(now.toISOString().slice(0, 10)); // today

  // Create an array of all days from firstDay to today
  const allDays: string[] = [];
  for (
    let d = new Date(firstDay);
    d <= lastDay;
    d.setUTCDate(d.getUTCDate() + 1)
  ) {
    allDays.push(d.toISOString().slice(0, 10));
  }

  let record = 0;

  // Calculate streaks forward to get the record
  let current = 0;
  for (let i = 7; i < allDays.length; i++) {
    let sum = 0;
    for (let j = 1; j <= 7; j++) {
      sum += dailyCosts.get(allDays[i - j]) ?? 0;
    }
    const target = sum / 7;
    const cost = dailyCosts.get(allDays[i]) ?? 0;

    if (cost <= target) {
      current++;
      if (current > record) record = current;
    } else {
      current = 0;
    }
  }

  // Calculate current streak backwards from yesterday
  let currentStreak = 0;
  const yesterdayIdx = allDays.length - 2; // assuming last is today
  if (yesterdayIdx >= 7) {
    for (let i = yesterdayIdx; i >= 7; i--) {
      let sum = 0;
      for (let j = 1; j <= 7; j++) {
        sum += dailyCosts.get(allDays[i - j]) ?? 0;
      }
      const target = sum / 7;
      const cost = dailyCosts.get(allDays[i]) ?? 0;
      if (cost <= target) {
        currentStreak++;
      } else {
        break;
      }
    }
  }

  // Get today's target (rolling avg of last 7 days including yesterday)
  let sum = 0;
  for (let j = 1; j <= 7; j++) {
    sum += dailyCosts.get(allDays[allDays.length - 1 - j]) ?? 0;
  }
  const dailyTarget = sum / 7;

  return {
    currentStreak,
    record,
    dailyTarget,
  };
}

export interface CostAnomaly {
  isAnomaly: boolean;
  multiplier: number;
  avgSessionCost: number;
}

export function detectCostAnomaly(
  currentSessionCost: number,
): CostAnomaly | null {
  const entries = parseUniqueEntries();
  if (entries.length < 5) return null;

  // last 20 unique sessions
  const last20 = entries.sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, 20);

  const sum = last20.reduce((acc, e) => acc + e.totalCost, 0);
  const avgSessionCost = sum / last20.length;

  const multiplier =
    avgSessionCost > 0 ? currentSessionCost / avgSessionCost : 0;
  const isAnomaly = multiplier >= 2.0;

  return {
    isAnomaly,
    multiplier,
    avgSessionCost,
  };
}

// ── Session History ──────────────────────────────────────────────────────────

export interface SessionHistoryEntry {
  ts: string;
  sessionId: string;
  totalCost: number;
  duration: number | null;
  toolCalls: number | null;
  models: string[];
  tag: string | null;
  repo: string | null;
}

/**
 * Get the last N sessions from analytics, newest first.
 * Returns rich session data when available.
 */
export function getSessionHistory(limit = 15): SessionHistoryEntry[] {
  const entries = parseUniqueEntries();
  return entries
    .sort((a, b) => b.ts.localeCompare(a.ts))
    .slice(0, limit)
    .map((e) => ({
      ts: e.ts,
      sessionId: e.sessionId,
      totalCost: e.totalCost,
      duration: e.duration ?? null,
      toolCalls: e.toolCalls ?? null,
      models: e.models ?? [],
      tag: e.tag ?? null,
      repo: e.repo ?? null,
    }));
}

// ── Time-of-Day Patterns ─────────────────────────────────────────────────────

export interface TimeOfDayPattern {
  /** Average cost per session by hour bucket (morning/afternoon/evening/night). */
  buckets: {
    name: string;
    hours: string;
    avgCost: number;
    sessionCount: number;
  }[];
  /** The cheapest time bucket. */
  cheapest: string;
  /** The most expensive time bucket. */
  mostExpensive: string;
  /** Ratio: most expensive / cheapest. */
  costRatio: number;
}

/**
 * Analyze cost patterns by time of day.
 * Groups sessions into 4 buckets: Morning (6-12), Afternoon (12-18),
 * Evening (18-22), Night (22-6).
 * Returns null if fewer than 5 sessions.
 */
export function getTimeOfDayPatterns(): TimeOfDayPattern | null {
  const entries = parseUniqueEntries();
  if (entries.length < 5) return null;

  const bucketDefs = [
    { name: "Morning", hours: "6am–12pm", min: 6, max: 12 },
    { name: "Afternoon", hours: "12pm–6pm", min: 12, max: 18 },
    { name: "Evening", hours: "6pm–10pm", min: 18, max: 22 },
    { name: "Night", hours: "10pm–6am", min: 22, max: 6 },
  ];

  const bucketData: Record<string, { total: number; count: number }> = {};
  for (const b of bucketDefs) {
    bucketData[b.name] = { total: 0, count: 0 };
  }

  for (const e of entries) {
    const hour = new Date(e.ts).getUTCHours();
    let bucketName = "Night"; // default
    for (const b of bucketDefs) {
      if (b.min < b.max) {
        if (hour >= b.min && hour < b.max) {
          bucketName = b.name;
          break;
        }
      } else {
        // Night wraps: 22-6
        if (hour >= b.min || hour < b.max) {
          bucketName = b.name;
          break;
        }
      }
    }
    bucketData[bucketName].total += e.totalCost;
    bucketData[bucketName].count++;
  }

  const buckets = bucketDefs.map((b) => ({
    name: b.name,
    hours: b.hours,
    avgCost:
      bucketData[b.name].count > 0
        ? bucketData[b.name].total / bucketData[b.name].count
        : 0,
    sessionCount: bucketData[b.name].count,
  }));

  const activeBuckets = buckets.filter((b) => b.sessionCount > 0);
  if (activeBuckets.length < 2) return null;

  const cheapest = activeBuckets.reduce((min, b) =>
    b.avgCost < min.avgCost ? b : min,
  );
  const mostExpensive = activeBuckets.reduce((max, b) =>
    b.avgCost > max.avgCost ? b : max,
  );
  const costRatio =
    cheapest.avgCost > 0 ? mostExpensive.avgCost / cheapest.avgCost : 0;

  return {
    buckets,
    cheapest: cheapest.name,
    mostExpensive: mostExpensive.name,
    costRatio: Math.round(costRatio * 10) / 10,
  };
}

// ── Tool Cost Breakdown ──────────────────────────────────────────────────────

export interface ToolCostEntry {
  tool: string;
  totalCalls: number;
  /** Estimated cost per call (session cost / session calls * tool share). */
  estimatedCostPerCall: number;
  /** Total estimated cost across all sessions. */
  estimatedTotalCost: number;
  /** Percentage of total tool calls. */
  callShare: number;
}

/**
 * Analyze tool usage across sessions and estimate per-tool costs.
 * Uses proportional allocation: each tool's cost share equals its call share
 * within each session, multiplied by that session's total cost.
 * Returns null if no sessions have toolUsage data.
 */
export function getToolCostBreakdown(limit = 10): ToolCostEntry[] | null {
  const entries = parseUniqueEntries();
  const sessionsWithTools = entries.filter(
    (e) =>
      e.toolUsage && Object.keys(e.toolUsage).length > 0 && e.totalCost > 0,
  );
  if (sessionsWithTools.length === 0) return null;

  // Aggregate across all sessions using proportional cost allocation
  const toolTotals = new Map<string, { calls: number; cost: number }>();

  for (const session of sessionsWithTools) {
    const usage = session.toolUsage;
    if (!usage) continue;
    const sessionTotalCalls = Object.values(usage).reduce((a, b) => a + b, 0);
    if (sessionTotalCalls === 0) continue;

    for (const [tool, calls] of Object.entries(usage)) {
      const share = calls / sessionTotalCalls;
      const toolCost = share * session.totalCost;
      const existing = toolTotals.get(tool) ?? { calls: 0, cost: 0 };
      existing.calls += calls;
      existing.cost += toolCost;
      toolTotals.set(tool, existing);
    }
  }

  const totalCalls = [...toolTotals.values()].reduce(
    (sum, t) => sum + t.calls,
    0,
  );

  return [...toolTotals.entries()]
    .map(([tool, data]) => ({
      tool,
      totalCalls: data.calls,
      estimatedCostPerCall: data.calls > 0 ? data.cost / data.calls : 0,
      estimatedTotalCost: data.cost,
      callShare:
        totalCalls > 0 ? Math.round((data.calls / totalCalls) * 100) : 0,
    }))
    .sort((a, b) => b.estimatedTotalCost - a.estimatedTotalCost)
    .slice(0, limit);
}
