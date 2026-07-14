/**
 * Candela API client for querying observability data.
 *
 * Talks to the Candela server's ConnectRPC endpoints over HTTP.
 * All methods are safe to call when Candela is offline — they return
 * null/defaults rather than throwing.
 *
 * Uses the consolidated GetDashboardData RPC (include_budget=true) to
 * fetch usage, budget, and grant data in a single round-trip. Falls
 * back to legacy RPCs for backends that haven't upgraded yet.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export interface UsageSummary {
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  totalCostUsd: number;
  requestCount: number;
}

export interface ModelUsage {
  model: string;
  provider: string;
  totalTokens: number;
  totalCostUsd: number;
  requestCount: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

/** Snapshot of a user's recurring budget for the current period. */
export interface BudgetInfo {
  limitUsd: number;
  spentUsd: number;
  /** Budget remaining, clamped >= 0. */
  remainingUsd: number;
  /** 0–100 percentage consumed. */
  percentUsed: number;
  /** 0.0–1.0 fraction consumed. */
  usedFraction: number;
  /** True at >= 80% usage — triggers yellow indicator. */
  isNearLimit: boolean;
  /** True when budget is fully consumed. */
  isExhausted: boolean;
  /** When this period resets (UTC), null if unknown. */
  periodEnd: Date | null;
  /** Human-readable countdown: "resets in 6h 23m". */
  resetLabel: string;
}

/** A one-time bonus budget grant. */
export interface GrantInfo {
  id: string;
  amountUsd: number;
  spentUsd: number;
  remainingUsd: number;
  reason: string;
  expiresAt: Date | null;
  /** True when the grant expires within 7 days. */
  isExpiringSoon: boolean;
  /** True when the grant is fully consumed. */
  isExhausted: boolean;
}

/** Consolidated dashboard data — usage + budget in one response. */
export interface DashboardData {
  // Usage
  usage: UsageSummary;
  models: ModelUsage[];
  // Budget context (null if not configured or unavailable)
  budget: BudgetInfo | null;
  activeGrants: GrantInfo[];
  /** Server-computed total: grants + budget remaining. */
  totalRemainingUsd: number | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Compute a human-readable reset countdown from a future Date. */
function computeResetLabel(periodEnd: Date | null): string {
  if (!periodEnd) return "";
  const diff = periodEnd.getTime() - Date.now();
  if (diff <= 0) return "resetting";
  const hours = Math.floor(diff / 3_600_000);
  const minutes = Math.floor((diff % 3_600_000) / 60_000);
  if (hours >= 1) return `resets in ${hours}h ${minutes}m`;
  return `resets in ${minutes}m`;
}

/** Build a BudgetInfo from raw proto3 JSON fields. */
function parseBudget(raw: Record<string, unknown>): BudgetInfo | null {
  if (!raw) return null;
  const limitUsd = Number(raw.limitUsd ?? raw.limit_usd ?? 0);
  const spentUsd = Number(raw.spentUsd ?? raw.spent_usd ?? 0);
  if (!Number.isFinite(limitUsd) || !Number.isFinite(spentUsd)) return null;
  const remaining = Math.max(0, limitUsd - spentUsd);
  const fraction = limitUsd > 0 ? Math.min(1, spentUsd / limitUsd) : 0;
  const periodEndRaw = (raw.periodEnd ?? raw.period_end) as string | undefined;
  const periodEnd = periodEndRaw ? new Date(periodEndRaw) : null;
  if (periodEnd && Number.isNaN(periodEnd.getTime())) return null;

  return {
    limitUsd,
    spentUsd,
    remainingUsd: remaining,
    percentUsed: fraction * 100,
    usedFraction: fraction,
    isNearLimit: fraction >= 0.8,
    isExhausted: spentUsd >= limitUsd,
    periodEnd,
    resetLabel: computeResetLabel(periodEnd),
  };
}

/** Build GrantInfo[] from raw proto3 JSON array. */
function parseGrants(raw: unknown[]): GrantInfo[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (g): g is Record<string, unknown> => g != null && typeof g === "object",
    )
    .map((g) => {
      const amountUsd = Number(g.amountUsd ?? g.amount_usd ?? 0);
      const spentUsd = Number(g.spentUsd ?? g.spent_usd ?? 0);
      const expiresRaw = (g.expiresAt ?? g.expires_at) as string | undefined;
      const expiresAt = expiresRaw ? new Date(expiresRaw) : null;
      return {
        id: String(g.id ?? ""),
        amountUsd,
        spentUsd,
        remainingUsd: Math.max(0, amountUsd - spentUsd),
        reason: String(g.reason ?? ""),
        expiresAt,
        isExpiringSoon:
          expiresAt !== null &&
          expiresAt.getTime() > Date.now() &&
          expiresAt.getTime() - Date.now() < 7 * 86_400_000,
        isExhausted: spentUsd >= amountUsd,
      };
    });
}

/** Build a ConnectRPC TimeRange JSON body for the given hours window. */
export function makeTimeRange(hours: number): Record<string, unknown> {
  const now = new Date();
  const start = new Date(now.getTime() - hours * 60 * 60 * 1000);
  return {
    time_range: {
      start: { seconds: String(Math.floor(start.getTime() / 1000)), nanos: 0 },
      end: { seconds: String(Math.floor(now.getTime() / 1000)), nanos: 0 },
    },
  };
}

/** Parse raw proto3 JSON model array into ModelUsage[]. */
function parseModels(raw: unknown[]): ModelUsage[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (m): m is Record<string, unknown> => m != null && typeof m === "object",
    )
    .map((m) => ({
      model: String(m.model ?? ""),
      provider: String(m.provider ?? ""),
      totalTokens:
        Number(m.inputTokens ?? m.input_tokens ?? 0) +
        Number(m.outputTokens ?? m.output_tokens ?? 0),
      totalCostUsd: Number(m.costUsd ?? m.cost_usd ?? 0),
      requestCount: Number(m.callCount ?? m.call_count ?? 0),
      cacheReadTokens: Number(m.cacheReadTokens ?? m.cache_read_tokens ?? 0),
      cacheCreationTokens: Number(
        m.cacheCreationTokens ?? m.cache_creation_tokens ?? 0,
      ),
    }));
}

// ── Client ────────────────────────────────────────────────────────────────────

export class CandelaClient {
  private baseUrl: string;
  private alive: boolean | null = null;
  private cacheTtlMs: number;
  private cache: { data: DashboardData; fetchedAt: number } | null = null;

  /**
   * @param baseUrl   Candela server URL (default: http://localhost:8181)
   * @param cacheTtlMs  Response cache TTL in ms. 0 = no caching (event-driven).
   */
  constructor(baseUrl = "http://localhost:8181", cacheTtlMs = 0) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.cacheTtlMs = cacheTtlMs;
  }

  /**
   * Check if Candela is reachable. Result is cached for the session
   * to avoid repeated health checks on every hook invocation.
   */
  async isAlive(): Promise<boolean> {
    if (this.alive !== null) return this.alive;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2000);
      const res = await fetch(`${this.baseUrl}/healthz`, {
        signal: controller.signal,
      });
      clearTimeout(timeout);
      this.alive = res.ok;
    } catch {
      this.alive = false;
    }
    return this.alive;
  }

  /**
   * Reset the cached health status. Useful if the user starts
   * Candela mid-session.
   */
  resetHealth(): void {
    this.alive = null;
  }

  /** Force-clear the response cache (e.g., on session start). */
  invalidateCache(): void {
    this.cache = null;
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Get consolidated dashboard data: usage + models + budget + grants.
   * Single RPC call (GetDashboardData) with automatic fallback to
   * legacy RPCs for older backends.
   */
  async getDashboardData(hours = 24): Promise<DashboardData | null> {
    if (!(await this.isAlive())) return null;

    // Return cached data if within TTL
    if (this.cache && this.cacheTtlMs > 0) {
      const age = Date.now() - this.cache.fetchedAt;
      if (age < this.cacheTtlMs) return this.cache.data;
    }

    // Try consolidated RPC first, fall back to legacy
    const data =
      (await this.tryGetDashboardData(hours)) ??
      (await this.legacyFanout(hours));

    if (data) {
      this.cache = { data, fetchedAt: Date.now() };
    }
    return data;
  }

  /**
   * Get model-by-model cost breakdown. Separate call for detailed
   * per-model data in compaction context.
   */
  async getModelBreakdown(hours = 24): Promise<ModelUsage[] | null> {
    if (!(await this.isAlive())) return null;
    try {
      const res = await fetch(
        `${this.baseUrl}/candela.v1.DashboardService/GetModelBreakdown`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(makeTimeRange(hours)),
        },
      );
      if (!res.ok) return null;
      const data = await res.json();
      return parseModels(data.models ?? []);
    } catch {
      return null;
    }
  }

  // ── Private: consolidated RPC ─────────────────────────────────────────────

  private async tryGetDashboardData(
    hours: number,
  ): Promise<DashboardData | null> {
    try {
      const res = await fetch(
        `${this.baseUrl}/candela.v1.DashboardService/GetDashboardData`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...makeTimeRange(hours),
            include_budget: true,
          }),
        },
      );
      // 404 / 501 = backend hasn't upgraded → trigger fallback
      if (res.status === 404 || res.status === 501) return null;
      if (!res.ok) return null;

      const data = await res.json();

      // Parse summary
      const s = data.summary ?? {};
      const usage: UsageSummary = {
        totalTokens:
          Number(s.totalInputTokens ?? s.total_input_tokens ?? 0) +
          Number(s.totalOutputTokens ?? s.total_output_tokens ?? 0),
        inputTokens: Number(s.totalInputTokens ?? s.total_input_tokens ?? 0),
        outputTokens: Number(s.totalOutputTokens ?? s.total_output_tokens ?? 0),
        totalCostUsd: Number(s.totalCostUsd ?? s.total_cost_usd ?? 0),
        requestCount: Number(s.totalLlmCalls ?? s.total_llm_calls ?? 0),
      };

      // Parse models
      const models = parseModels(data.models ?? []);

      // Parse budget context
      const bc = data.budgetContext ?? data.budget_context;
      let budget: BudgetInfo | null = null;
      let activeGrants: GrantInfo[] = [];
      let totalRemainingUsd: number | null = null;

      if (bc && typeof bc === "object") {
        budget = parseBudget(bc.budget ?? {});
        activeGrants = parseGrants(bc.activeGrants ?? bc.active_grants ?? []);
        const rawRemaining = Number(
          bc.totalRemainingUsd ?? bc.total_remaining_usd ?? 0,
        );
        if (Number.isFinite(rawRemaining) && rawRemaining >= 0) {
          totalRemainingUsd = rawRemaining;
        }
      }

      return { usage, models, budget, activeGrants, totalRemainingUsd };
    } catch {
      return null;
    }
  }

  // ── Private: legacy fallback ──────────────────────────────────────────────

  private async legacyFanout(hours: number): Promise<DashboardData | null> {
    try {
      const timeRange = makeTimeRange(hours);

      // Fan out: usage summary + budget (parallel)
      const [summaryRes, budgetRes] = await Promise.all([
        fetch(`${this.baseUrl}/candela.v1.DashboardService/GetUsageSummary`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(timeRange),
        }).catch(() => null),
        fetch(`${this.baseUrl}/candela.v1.UserService/GetMyBudget`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        }).catch(() => null),
      ]);

      // Parse usage
      let usage: UsageSummary = {
        totalTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalCostUsd: 0,
        requestCount: 0,
      };
      if (summaryRes?.ok) {
        const s = await summaryRes.json();
        usage = {
          totalTokens:
            Number(s.totalInputTokens ?? s.total_input_tokens ?? 0) +
            Number(s.totalOutputTokens ?? s.total_output_tokens ?? 0),
          inputTokens: Number(s.totalInputTokens ?? s.total_input_tokens ?? 0),
          outputTokens: Number(
            s.totalOutputTokens ?? s.total_output_tokens ?? 0,
          ),
          totalCostUsd: Number(s.totalCostUsd ?? s.total_cost_usd ?? 0),
          requestCount: Number(s.totalLlmCalls ?? s.total_llm_calls ?? 0),
        };
      }

      // Parse budget (from UserService/GetMyBudget — the correct path)
      let budget: BudgetInfo | null = null;
      let activeGrants: GrantInfo[] = [];
      let totalRemainingUsd: number | null = null;
      if (budgetRes?.ok) {
        try {
          const b = await budgetRes.json();
          budget = parseBudget(b.budget ?? {});
          activeGrants = parseGrants(b.activeGrants ?? b.active_grants ?? []);
          const rawRemaining = Number(
            b.totalRemainingUsd ?? b.total_remaining_usd ?? 0,
          );
          if (Number.isFinite(rawRemaining) && rawRemaining >= 0) {
            totalRemainingUsd = rawRemaining;
          }
        } catch {
          // Budget parsing is non-fatal
        }
      }

      return { usage, models: [], budget, activeGrants, totalRemainingUsd };
    } catch {
      return null;
    }
  }
}
