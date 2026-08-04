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
 * Smart Model Routing (opt-in via CANDELA_SMART_ROUTING=true):
 *   When enabled and budget exceeds the configured threshold, the
 *   system prompt includes a specific, priced suggestion to use a
 *   cheaper model. Uses real catalog pricing data rather than a
 *   hard-coded list.
 *
 * Example injected context:
 *   [Candela] Budget: 85% used ($10.20 of $12.00). Today's spend: $8.40.
 *   ⚠️ Budget tight — be concise, skip optional context.
 *   Current model: claude-sonnet-4 via candela-anthropic ($3.00/1M in).
 *   💡 Smart routing: For simple tasks, use gemini-3.5-flash ($0.08/1M in) — save ~97%.
 *   Cache hit rate: 45%.
 */

import type { CandelaClient, CatalogEntry } from "./candela-client.js";
import { listEntries } from "./memory-store.js";
import type { SmartRoutingSettings } from "./settings.js";
import { formatCost } from "./utils.js";

// ── Smart Routing ─────────────────────────────────────────────────────────────

/**
 * Find the cheapest alternative model from the catalog.
 *
 * Returns the cheapest enabled model that:
 * - Is not the current model
 * - Has input pricing < current model's pricing * (1 - savingsThreshold)
 * - Has a context window ≥ 32K (usable for coding tasks)
 */
function matchCatalogEntry(
  catalog: CatalogEntry[],
  modelId: string,
): CatalogEntry | undefined {
  // Prefer exact match
  const exact = catalog.find((c) => c.modelId === modelId);
  if (exact) return exact;
  // Fall back to longest substring match
  let best: CatalogEntry | undefined;
  let bestLen = 0;
  for (const c of catalog) {
    if (modelId.includes(c.modelId) && c.modelId.length > bestLen) {
      best = c;
      bestLen = c.modelId.length;
    }
  }
  return best;
}

function findCheapestAlternative(
  currentModelId: string,
  catalog: CatalogEntry[],
  savingsThreshold: number,
): { model: CatalogEntry; savingsPercent: number } | null {
  const current = matchCatalogEntry(catalog, currentModelId);

  if (!current || current.inputPerMillion === 0) return null;

  // Filter to usable alternatives with significant savings
  const minPrice = current.inputPerMillion * (1 - savingsThreshold);
  const candidates = catalog
    .filter(
      (e) =>
        e.enabled &&
        e.modelId !== current.modelId &&
        e.inputPerMillion > 0 &&
        e.inputPerMillion < minPrice &&
        e.contextWindow >= 32_000,
    )
    .sort((a, b) => a.inputPerMillion - b.inputPerMillion);

  if (candidates.length === 0) return null;

  const cheapest = candidates[0];
  const savingsPercent = Math.round(
    ((current.inputPerMillion - cheapest.inputPerMillion) /
      current.inputPerMillion) *
      100,
  );

  return { model: cheapest, savingsPercent };
}

/** Format price per million tokens for display. */
function formatPricePerMillion(price: number): string {
  if (price === 0) return "free";
  if (price < 0.01) return `$${price.toFixed(4)}/1M`;
  return `$${price.toFixed(2)}/1M`;
}

// ── Budget Guidance ───────────────────────────────────────────────────────────

// Models considered "cheap" — fallback when catalog is unavailable
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

// ── Context Hook ──────────────────────────────────────────────────────────────

/**
 * Creates the `experimental.chat.system.transform` hook handler.
 *
 * Injects budget/cost context into the system prompt so the agent
 * knows how much has been spent and can make cost-conscious decisions.
 *
 * Throttled: only injects on every call when budget ≥ 80%. Below that,
 * only the first call of a session gets context (saves ~100 tokens/msg).
 *
 * @param candela        API client for fetching dashboard/catalog data
 * @param projectDir     Working directory for project-scoped memory notes
 * @param getRoutingSettings Smart routing config getter.
 */
export function createContextHook(
  candela: CandelaClient,
  projectDir: string,
  getRoutingSettings?: () => SmartRoutingSettings,
) {
  // Cache to avoid hammering the API on every message
  let cachedContext: string | null = null;
  let cachedFraction = 0;
  let lastFetch = 0;
  const injectedSessions = new Set<string>();
  const CACHE_TTL = 60_000; // 1 minute

  // Smart routing cache — catalog doesn't change often
  let cachedCatalog: CatalogEntry[] | null = null;
  let lastCatalogAttempt = 0;
  const CATALOG_TTL = 300_000; // 5 minutes

  const hook = async (
    input: { sessionID?: string; model: { id: string; providerID: string } },
    output: { system: string[] },
  ) => {
    const now = Date.now();

    // Refresh cache if stale
    if (!cachedContext || now - lastFetch > CACHE_TTL) {
      // Set lastFetch before await to prevent thundering herd —
      // concurrent callers will use stale cache while we refresh.
      lastFetch = now;
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
    const isFirstCall = !injectedSessions.has(sessionID);
    if (!isFirstCall && cachedFraction < 0.8) return;
    injectedSessions.add(sessionID);

    // Build model-specific context
    const modelId = input?.model?.id;
    const providerID = input?.model?.providerID;
    const modelContext: string[] = [];

    if (modelId) {
      modelContext.push(`Current model: ${modelId} via ${providerID}.`);
    }

    // ── Smart Model Routing (opt-in) ──────────────────────────────────────
    const routing = getRoutingSettings?.();
    if (
      routing?.enabled &&
      modelId &&
      cachedFraction >= routing.budgetThreshold
    ) {
      // Fetch catalog (cached for 5 minutes)
      if (now - lastCatalogAttempt > CATALOG_TTL) {
        lastCatalogAttempt = now;
        try {
          cachedCatalog = await candela.getModelCatalog();
        } catch {
          // Non-fatal — skip routing suggestion this time
        }
      }

      if (cachedCatalog && cachedCatalog.length > 0) {
        const alt = findCheapestAlternative(
          modelId,
          cachedCatalog,
          routing.savingsThreshold,
        );

        if (alt) {
          // Look up current model pricing for the display
          const currentEntry = matchCatalogEntry(cachedCatalog, modelId);
          const currentPrice = currentEntry
            ? ` (${formatPricePerMillion(currentEntry.inputPerMillion)} in)`
            : "";

          modelContext[0] = `Current model: ${modelId} via ${providerID}${currentPrice}.`;

          modelContext.push(
            `💡 Smart routing: For simple tasks, use ${alt.model.modelId} ` +
              `(${formatPricePerMillion(alt.model.inputPerMillion)} in) — ` +
              `save ~${alt.savingsPercent}% on input pricing.`,
          );
        }
      }
    } else if (!routing?.enabled && modelId) {
      // Fallback to the generic suggestion when smart routing is off
      const isCurrentCheap = CHEAP_MODELS.some((m) =>
        modelId.toLowerCase().includes(m.toLowerCase()),
      );
      if (!isCurrentCheap) {
        modelContext.push(
          "For simple tasks (formatting, small edits), consider cheaper models.",
        );
      }
    }

    output.system.push(`${cachedContext} ${modelContext.join(" ")}`.trimEnd());

    // On first call of a session, include memory note keys (capped at 10)
    if (isFirstCall) {
      const entries = listEntries(projectDir);
      if (entries.length > 0) {
        const recent = entries
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
          .slice(0, 10);
        const keys = recent.map((e) => e.key).join(", ");
        const suffix =
          entries.length > 10 ? ` (+${entries.length - 10} more)` : "";
        output.system.push(
          `\u{1F4DD} Project notes (${entries.length}): ${keys}${suffix}. Use candela_memory to read.`,
        );
      }
    }
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
