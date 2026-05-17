/**
 * Candela API client for querying observability data.
 *
 * Talks to the Candela server's ConnectRPC endpoints over HTTP.
 * All methods are safe to call when Candela is offline — they return
 * null/defaults rather than throwing.
 */

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
}

export interface BudgetInfo {
  totalBudgetUsd: number;
  usedUsd: number;
  remainingUsd: number;
  percentUsed: number;
}

export class CandelaClient {
  private baseUrl: string;
  private alive: boolean | null = null;

  constructor(baseUrl = "http://localhost:8181") {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
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

  /**
   * Get usage summary for the current user over the last N hours.
   * Uses the ConnectRPC JSON transport (POST with JSON body).
   */
  async getUsageSummary(hours = 24): Promise<UsageSummary | null> {
    if (!(await this.isAlive())) return null;
    try {
      const now = new Date();
      const start = new Date(now.getTime() - hours * 60 * 60 * 1000);
      const res = await fetch(
        `${this.baseUrl}/candela.dashboard.v1.DashboardService/GetUsageSummary`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            startTime: start.toISOString(),
            endTime: now.toISOString(),
          }),
        }
      );
      if (!res.ok) return null;
      const data = await res.json();
      return {
        totalTokens: Number(data.totalTokens ?? 0),
        inputTokens: Number(data.inputTokens ?? 0),
        outputTokens: Number(data.outputTokens ?? 0),
        totalCostUsd: Number(data.totalCostUsd ?? 0),
        requestCount: Number(data.requestCount ?? 0),
      };
    } catch {
      return null;
    }
  }

  /**
   * Get model-by-model cost breakdown.
   */
  async getModelBreakdown(hours = 24): Promise<ModelUsage[] | null> {
    if (!(await this.isAlive())) return null;
    try {
      const now = new Date();
      const start = new Date(now.getTime() - hours * 60 * 60 * 1000);
      const res = await fetch(
        `${this.baseUrl}/candela.dashboard.v1.DashboardService/GetModelBreakdown`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            startTime: start.toISOString(),
            endTime: now.toISOString(),
          }),
        }
      );
      if (!res.ok) return null;
      const data = await res.json();
      return (data.models ?? []).map((m: Record<string, unknown>) => ({
        model: String(m.model ?? ""),
        provider: String(m.provider ?? ""),
        totalTokens: Number(m.totalTokens ?? 0),
        totalCostUsd: Number(m.totalCostUsd ?? 0),
        requestCount: Number(m.requestCount ?? 0),
      }));
    } catch {
      return null;
    }
  }

  /**
   * Get budget remaining for the current user.
   */
  async getBudgetRemaining(): Promise<BudgetInfo | null> {
    if (!(await this.isAlive())) return null;
    try {
      const res = await fetch(
        `${this.baseUrl}/candela.budget.v1.BudgetService/GetMyBudget`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        }
      );
      if (!res.ok) return null;
      const data = await res.json();
      const total = Number(data.totalBudgetUsd ?? 0);
      const used = Number(data.usedUsd ?? 0);
      return {
        totalBudgetUsd: total,
        usedUsd: used,
        remainingUsd: total - used,
        percentUsed: total > 0 ? (used / total) * 100 : 0,
      };
    } catch {
      return null;
    }
  }
}
