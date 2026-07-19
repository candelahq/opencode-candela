/**
 * Candela context injection for OpenCode.
 *
 * Appends cost-awareness context to the system prompt so the AI agent
 * can self-moderate its spending. This runs before every LLM call via
 * the `experimental.chat.system.transform` hook.
 *
 * Injection is throttled: below 80% budget, only the first call of
 * each session gets cost context (the inline TUI indicator provides
 * ambient awareness). At ≥80%, every call gets urgency context.
 *
 * Example injected context:
 *   [Candela] Budget: 85% used ($10.20 of $12.00). Today's spend: $8.40.
 *   ⚠️ Budget tight — be concise, skip optional context.
 *   Current model: claude-sonnet-4 via candela-anthropic.
 *   Cache hit rate: 45%.
 *   For simple tasks, prefer cheaper models (haiku, flash-lite, gpt-4.1-nano).
 */

import type { CandelaClient } from "./candela-client.js";
import { formatCost } from "./utils.js";

// Models considered "cheap" for cost-aware recommendations
const CHEAP_MODELS = [
  "claude-haiku-4.5",
  "gemini-3.5-flash",
  "gemini-3-flash-lite",
  "gpt-4.1-nano",
  "gpt-4.1-mini",
  "mistral-small-2503",
];

/**
 * Returns a graduated behavioral prompt based on budget usage.
 * More nuanced than a binary "critical / not critical" marker.
 */
function budgetGuidance(fraction: number): string {
  if (fraction >= 0.95)
    return "🔴 BUDGET CRITICAL: Minimal tokens. Shortest possible answers. No exploratory reads.";
  if (fraction >= 0.85)
    return "⚠️ Budget tight — be concise. Skip optional context. Consolidate file reads.";
  if (fraction >= 0.7)
    return "Budget awareness — prefer concise responses where possible.";
  return "";
}

/**
 * Creates the `experimental.chat.system.transform` hook handler.
 *
 * Injects budget/cost context into the system prompt so the agent
 * knows how much has been spent and can make cost-conscious decisions.
 *
 * Throttled: only injects on every call when budget ≥ 80%. Below that,
 * only the first call of a session gets context (saves ~100 tokens/msg).
 */
export function createContextHook(candela: CandelaClient) {
  // Cache to avoid hammering the API on every message
  let cachedContext: string | null = null;
  let cachedFraction = 0;
  let lastFetch = 0;
  const injectedSessions = new Set<string>();
  const CACHE_TTL = 60_000; // 1 minute

  const hook = async (
    input: { sessionID?: string; model: { id: string; providerID: string } },
    output: { system: string[] },
  ) => {
    const now = Date.now();

    // Refresh cache if stale
    if (!cachedContext || now - lastFetch > CACHE_TTL) {
      try {
        const data = await candela.getDashboardData(24);
        if (data) {
          const parts: string[] = ["[Candela]"];

          // Budget status
          if (data.budget) {
            const b = data.budget;
            cachedFraction = b.usedFraction;
            parts.push(
              `Budget: ${b.percentUsed.toFixed(0)}% used (${formatCost(b.spentUsd)} of ${formatCost(b.limitUsd)}).`,
            );

            // Graduated urgency
            const guidance = budgetGuidance(b.usedFraction);
            if (guidance) parts.push(guidance);
          } else {
            cachedFraction = 0;
          }

          // Last 24h spend
          if (data.usage.totalCostUsd != null) {
            parts.push(
              `Last 24h spend: ${formatCost(data.usage.totalCostUsd)}.`,
            );
          }

          // Cache effectiveness
          const totalCacheRead = data.models.reduce(
            (s, m) => s + m.cacheReadTokens,
            0,
          );
          if (totalCacheRead > 0 && data.usage.inputTokens > 0) {
            const hitRate = Math.min(
              100,
              (totalCacheRead / data.usage.inputTokens) * 100,
            ).toFixed(0);
            parts.push(`Cache hit rate: ${hitRate}%.`);
          }

          cachedContext = parts.join(" ");
          lastFetch = now;
        }
      } catch {
        // Non-fatal — keep using stale cache if we have it
      }
    }

    if (!cachedContext) return;

    // Throttle: below 80% budget, only inject on the first call of each
    // session. The inline TUI indicator provides ambient awareness for
    // the rest. Above 80%, inject every call so the AI stays cost-aware.
    const sessionID = input?.sessionID ?? "default";
    if (injectedSessions.has(sessionID) && cachedFraction < 0.8) return;
    injectedSessions.add(sessionID);

    // Build model-specific context
    const modelId = input?.model?.id;
    const providerID = input?.model?.providerID;
    const modelContext = modelId
      ? `Current model: ${modelId} via ${providerID}.`
      : "";

    // Suggest cheaper alternatives if not already using one
    const isCurrentCheap = modelId
      ? CHEAP_MODELS.some((m) =>
          modelId.toLowerCase().includes(m.toLowerCase()),
        )
      : false;
    const suggestion = isCurrentCheap
      ? ""
      : " For simple tasks (formatting, small edits), consider cheaper models.";

    output.system.push(`${cachedContext} ${modelContext}${suggestion}`);
  };

  return {
    hook,
    /** Reset the first-call flag. Call on session.created. */
    resetSession() {
      injectedSessions.clear();
      cachedContext = null;
    },
  };
}
