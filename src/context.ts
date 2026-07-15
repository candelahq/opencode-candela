/**
 * Candela context injection for OpenCode.
 *
 * Appends cost-awareness context to the system prompt so the AI agent
 * can self-moderate its spending. This runs before every LLM call via
 * the `experimental.chat.system.transform` hook.
 *
 * Example injected context:
 *   [Candela] Budget: 45% used ($5.50 of $12.00). Today's spend: $3.20.
 *   Current model: claude-sonnet-4 via candela-anthropic.
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
 * Creates the `experimental.chat.system.transform` hook handler.
 *
 * Injects budget/cost context into the system prompt so the agent
 * knows how much has been spent and can make cost-conscious decisions.
 */
export function createContextHook(candela: CandelaClient) {
  // Cache to avoid hammering the API on every message
  let cachedContext: string | null = null;
  let lastFetch = 0;
  const CACHE_TTL = 60_000; // 1 minute

  return async (
    input: { sessionID?: string; model: { id: string; providerID: string } },
    output: { system: string[] },
  ) => {
    const now = Date.now();

    // Refresh cache if stale
    if (!cachedContext || now - lastFetch > CACHE_TTL) {
      lastFetch = now;
      try {
        const data = await candela.getDashboardData(24);
        if (!data) return;

        const parts: string[] = ["[Candela]"];

        // Budget status
        if (data.budget) {
          const b = data.budget;
          parts.push(
            `Budget: ${b.percentUsed.toFixed(0)}% used (${formatCost(b.spentUsd)} of ${formatCost(b.limitUsd)}).`,
          );

          // Urgency markers
          if (b.usedFraction >= 0.9) {
            parts.push(
              "⚠️ BUDGET CRITICAL — minimize token usage, avoid long outputs.",
            );
          } else if (b.usedFraction >= 0.6) {
            parts.push("Budget getting tight — be concise where possible.");
          }
        }

        // Today's spend
        if (data.usage.totalCostUsd != null) {
          parts.push(`Today's spend: ${formatCost(data.usage.totalCostUsd)}.`);
        }

        cachedContext = parts.join(" ");
      } catch {
        // Non-fatal — skip injection on error
        return;
      }
    }

    if (!cachedContext) return;

    // Build model-specific context
    const modelContext = `Current model: ${input.model.id} via ${input.model.providerID}.`;

    // Suggest cheaper alternatives if not already using one
    const isCurrentCheap = CHEAP_MODELS.some((m) =>
      input.model.id.toLowerCase().includes(m.toLowerCase()),
    );
    const suggestion = isCurrentCheap
      ? ""
      : " For simple tasks (formatting, small edits), consider cheaper models.";

    output.system.push(`${cachedContext} ${modelContext}${suggestion}`);
  };
}
