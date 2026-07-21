/**
 * Candela config management tools for OpenCode.
 *
 * These tools let the AI agent manage OpenCode's configuration:
 * - candela_configure_model: Add/update/remove models routed through Candela
 * - candela_list_models: Show configured models with Candela cost enrichment
 *
 * Uses the OpenCode SDK config API (client.config.get/update) instead of
 * raw file I/O. Changes are applied live — no restart needed.
 */

import type { PluginInput } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import type { CandelaClient } from "./candela-client.js";
import { formatCost } from "./utils.js";

// ── Types ─────────────────────────────────────────────────────────────────────

/** SDK client type extracted from PluginInput. */
type OpenCodeClient = PluginInput["client"];

// ── Known proxy routes ────────────────────────────────────────────────────────

const PROXY_ROUTES: Record<string, { route: string; providerKey: string }> = {
  anthropic: {
    route: "/proxy/anthropic/v1",
    providerKey: "candela-anthropic",
  },
  claude: { route: "/proxy/anthropic/v1", providerKey: "candela-anthropic" },
  openai: { route: "/proxy/openai/v1", providerKey: "candela-openai" },
  gpt: { route: "/proxy/openai/v1", providerKey: "candela-openai" },
  gemini: { route: "/proxy/gemini-oai/v1", providerKey: "candela-gemini" },
  google: { route: "/proxy/gemini-oai/v1", providerKey: "candela-gemini" },
  deepseek: { route: "/proxy/deepseek/v1", providerKey: "candela-deepseek" },
  "deepseek-v3": {
    route: "/proxy/deepseek-v3/v1",
    providerKey: "candela-deepseek-v3",
  },
  mistral: { route: "/proxy/mistral/v1", providerKey: "candela-mistral" },
  qwen: { route: "/proxy/qwen/v1", providerKey: "candela-qwen" },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Infer provider from model name. */
export function inferProvider(modelId: string): string | null {
  const lower = modelId.toLowerCase();
  if (
    lower.includes("claude") ||
    lower.includes("sonnet") ||
    lower.includes("haiku") ||
    lower.includes("opus")
  )
    return "anthropic";
  if (
    lower.includes("gpt") ||
    lower.startsWith("o3") ||
    lower.startsWith("o4") ||
    lower.startsWith("o1")
  )
    return "openai";
  if (lower.includes("gemini")) return "gemini";
  if (lower.includes("deepseek") && lower.includes("v3")) return "deepseek-v3";
  if (lower.includes("deepseek")) return "deepseek";
  if (lower.includes("mistral") || lower.includes("codestral"))
    return "mistral";
  if (lower.includes("qwen")) return "qwen";
  return null;
}

/** Format a human-readable model name from an ID. */
export function humanName(modelId: string): string {
  return modelId
    .replace(/-maas$/, "")
    .replace(/-/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  "candela-anthropic": "Claude via Candela",
  "candela-openai": "OpenAI via Candela",
  "candela-gemini": "Gemini via Candela",
  "candela-deepseek": "DeepSeek via Candela",
  "candela-deepseek-v3": "DeepSeek V3 via Candela",
  "candela-mistral": "Mistral via Candela",
  "candela-qwen": "Qwen via Candela",
};

// ── Tool Factories ────────────────────────────────────────────────────────────

export function createConfigTools(
  candela: CandelaClient,
  candelaUrl: string,
  client: OpenCodeClient,
) {
  // ── candela_configure_model ────────────────────────────────────────────

  const configureModel = tool({
    description:
      "Add, update, or remove a model in OpenCode's configuration, routed through Candela's proxy. " +
      "Use this when the user wants to add a new model, switch models, or configure model routing. " +
      "Changes are applied live — no restart needed. " +
      "Example: 'add claude sonnet 4 through candela' or 'remove gpt-4o'.",
    args: {
      action: tool.schema
        .enum(["add", "remove", "set-default"])
        .describe(
          "Action to perform: add a model, remove it, or set it as the default model.",
        ),
      model_id: tool.schema
        .string()
        .describe(
          "Model ID (e.g. 'claude-sonnet-4', 'gpt-4.1', 'gemini-3.5-flash').",
        ),
      provider: tool.schema
        .string()
        .optional()
        .describe(
          "Provider name (e.g. 'anthropic', 'openai', 'gemini'). " +
            "Auto-detected from model name if omitted.",
        ),
      display_name: tool.schema
        .string()
        .optional()
        .describe(
          "Human-readable name for the model. Auto-generated if omitted.",
        ),
    },
    async execute(args) {
      // Resolve provider and route
      const rawProvider = args.provider ?? inferProvider(args.model_id);
      if (!rawProvider) {
        return {
          title: "Unknown Provider",
          output:
            `Could not infer provider for model "${args.model_id}". ` +
            "Please specify the provider explicitly (e.g. provider: 'anthropic').",
        };
      }

      const providerName = rawProvider.toLowerCase();
      const route = PROXY_ROUTES[providerName];
      if (!route) {
        return {
          title: "Unknown Provider Route",
          output:
            `No Candela proxy route known for provider "${providerName}". ` +
            `Known providers: ${Object.keys(PROXY_ROUTES).join(", ")}.`,
        };
      }

      const providerKey = route.providerKey;

      // Read current config via SDK
      const { data: config } = await client.config.get();
      if (!config) {
        return {
          title: "Config Error",
          output: "Failed to read OpenCode config via SDK.",
        };
      }

      if (args.action === "remove") {
        const provider = config.provider?.[providerKey];
        if (provider?.models?.[args.model_id]) {
          // Build a patch that removes the model
          const updatedModels = { ...provider.models };
          delete updatedModels[args.model_id];

          const patch =
            Object.keys(updatedModels).length === 0
              ? // Remove entire provider if no models left — null signals deletion in PATCH
                // biome-ignore lint/suspicious/noExplicitAny: PATCH requires null to delete keys
                { provider: { [providerKey]: null as any } }
              : {
                  provider: {
                    [providerKey]: { ...provider, models: updatedModels },
                  },
                };

          const { error } = await client.config.update({ body: patch });
          if (error) {
            return {
              title: "Config Update Failed",
              output: `Failed to update config: ${String(error)}`,
            };
          }
          return {
            title: `Removed ${args.model_id}`,
            output:
              `Removed **${args.model_id}** from ${providerKey}.\n\n` +
              "✅ Changes applied live — no restart needed.",
          };
        }
        return {
          title: "Model Not Found",
          output: `Model "${args.model_id}" not found in ${providerKey}.`,
        };
      }

      // Add or update
      const existingProvider = config.provider?.[providerKey];
      const displayName = args.display_name ?? humanName(args.model_id);

      const providerPatch = existingProvider
        ? {
            ...existingProvider,
            models: {
              ...(existingProvider.models ?? {}),
              [args.model_id]: { name: displayName },
            },
          }
        : {
            npm: "@ai-sdk/openai-compatible",
            name:
              PROVIDER_DISPLAY_NAMES[providerKey] ??
              `${providerName} via Candela`,
            options: {
              baseURL: `${candelaUrl}${route.route}`,
            },
            models: {
              [args.model_id]: { name: displayName },
            },
          };

      const body: Record<string, unknown> = {
        provider: { [providerKey]: providerPatch },
      };

      // Set as default model if requested
      if (args.action === "set-default") {
        body.model = `${providerKey}/${args.model_id}`;
      }

      const { error } = await client.config.update({ body });
      if (error) {
        return {
          title: "Config Update Failed",
          output: `Failed to update config: ${String(error)}`,
        };
      }

      const actionLabel =
        args.action === "set-default" ? "set as default" : "added";
      const lines = [
        `## Model ${actionLabel}: ${args.model_id}`,
        "",
        "| Field | Value |",
        "|-------|-------|",
        `| Model ID | \`${args.model_id}\` |`,
        `| Display Name | ${displayName} |`,
        `| Provider | ${providerKey} |`,
        `| Proxy URL | \`${candelaUrl}${route.route}\` |`,
      ];

      if (args.action === "set-default") {
        lines.push(`| Default Model | \`${providerKey}/${args.model_id}\` |`);
      }

      lines.push("", "✅ **Changes applied live** — no restart needed.");

      return {
        title: `${actionLabel}: ${args.model_id} via Candela`,
        output: lines.join("\n"),
      };
    },
  });

  // ── candela_list_models ──────────────────────────────────────────────

  const listModels = tool({
    description:
      "List all models configured in OpenCode, showing which ones are routed through Candela. " +
      "Enriches with cost data from Candela if available. " +
      "Use when the user asks 'what models do I have?' or 'which models are available?'.",
    args: {
      show_usage: tool.schema
        .boolean()
        .default(false)
        .describe(
          "If true, also show recent usage/cost data per model from Candela.",
        ),
    },
    async execute(args) {
      // Read config via SDK — returns merged project + global config
      const { data: config } = await client.config.get();
      if (!config) {
        return {
          title: "Config Error",
          output: "Failed to read OpenCode config via SDK.",
        };
      }

      const allProviders = config.provider ?? {};

      if (Object.keys(allProviders).length === 0) {
        return {
          title: "No Models Configured",
          output:
            "No providers configured in OpenCode. " +
            'Use `candela_configure_model` to add a model (e.g. "add claude sonnet 4").',
        };
      }

      // Get usage data if requested
      let modelUsage: Map<string, { cost: number; calls: number }> | null =
        null;
      if (args.show_usage) {
        const data = await candela.getDashboardData(24);
        if (data?.models) {
          modelUsage = new Map();
          for (const m of data.models) {
            modelUsage.set(m.model, {
              cost: m.totalCostUsd,
              calls: m.requestCount,
            });
          }
        }
      }

      const lines: string[] = ["## Configured Models", ""];

      const usageHeader = args.show_usage ? " Cost (24h) | Calls |" : "";
      const usageSep = args.show_usage ? "------------|-------|" : "";
      lines.push(
        `| Provider | Model | Name | Via Candela |${usageHeader}`,
        `|----------|-------|------|-------------|${usageSep}`,
      );

      let totalModels = 0;
      let candelaModels = 0;

      for (const [providerKey, provider] of Object.entries(allProviders)) {
        const isCandela = providerKey.startsWith("candela-");
        const models = provider.models ?? {};

        for (const [modelId, modelConfig] of Object.entries(models)) {
          totalModels++;
          if (isCandela) candelaModels++;

          let usageCols = "";
          if (args.show_usage) {
            const usage = modelUsage?.get(modelId);
            usageCols = usage
              ? ` ${formatCost(usage.cost)} | ${usage.calls} |`
              : " — | — |";
          }

          lines.push(
            `| ${providerKey} | \`${modelId}\` | ${modelConfig.name ?? "—"} | ${isCandela ? "✅" : "❌"} |${usageCols}`,
          );
        }
      }

      lines.push(
        "",
        `**${totalModels} models** configured (${candelaModels} via Candela proxy).`,
      );

      return {
        title: `${totalModels} models (${candelaModels} via Candela)`,
        output: lines.join("\n"),
      };
    },
  });

  return {
    candela_configure_model: configureModel,
    candela_list_models: listModels,
  };
}
