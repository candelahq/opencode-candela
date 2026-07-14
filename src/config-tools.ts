/**
 * Candela config management tools for OpenCode.
 *
 * These tools let the AI agent manage OpenCode's configuration:
 * - candela_configure_model: Add/update/remove models routed through Candela
 * - candela_list_models: Show configured models with Candela cost enrichment
 * - candela_restart_opencode: Restart OpenCode after config changes
 *
 * Config format: JSONC (.opencode.json) with providers using
 * @ai-sdk/openai-compatible and Candela proxy baseURLs.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { tool } from "@opencode-ai/plugin";
import type { CandelaClient } from "./candela-client.js";
import { formatCost, readJsoncFile, writeJsonFile } from "./utils.js";

// ── Types ─────────────────────────────────────────────────────────────────────

interface OpenCodeConfig {
  $schema?: string;
  model?: string;
  provider?: Record<string, ProviderConfig>;
  [key: string]: unknown;
}

interface ProviderConfig {
  npm?: string;
  name?: string;
  options?: { baseURL?: string; [key: string]: unknown };
  models?: Record<string, { name?: string; [key: string]: unknown }>;
}

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

// ── Tool Factories ────────────────────────────────────────────────────────────

export function createConfigTools(candela: CandelaClient, candelaUrl: string) {
  // ── candela_configure_model ────────────────────────────────────────────

  const configureModel = tool({
    description:
      "Add, update, or remove a model in OpenCode's configuration, routed through Candela's proxy. " +
      "Use this when the user wants to add a new model, switch models, or configure model routing. " +
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
      scope: tool.schema
        .enum(["project", "global"])
        .default("project")
        .describe(
          "Config scope: 'project' (.opencode.json in cwd) or 'global' (~/.config/opencode/).",
        ),
    },
    async execute(args, context) {
      const configPath =
        args.scope === "global"
          ? join(homedir(), ".config", "opencode", "opencode.json")
          : join(context.directory, ".opencode.json");

      const config = readJsoncFile<OpenCodeConfig>(configPath);
      if (!config.provider) config.provider = {};
      if (!config.$schema) config.$schema = "https://opencode.ai/config.json";

      // Normalise provider name to lowercase for lookup
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

      if (args.action === "remove") {
        const provider = config.provider[providerKey];
        if (provider?.models?.[args.model_id]) {
          delete provider.models[args.model_id];
          // Clean up empty provider
          if (Object.keys(provider.models).length === 0) {
            delete config.provider[providerKey];
          }
          writeJsonFile(configPath, config);
          return {
            title: `Removed ${args.model_id}`,
            output:
              `Removed **${args.model_id}** from ${providerKey} in \`${configPath}\`.\n\n` +
              "⚠️ Restart OpenCode for changes to take effect. " +
              "Use the `candela_restart_opencode` tool or press `Ctrl+C` and relaunch.",
          };
        }
        return {
          title: "Model Not Found",
          output: `Model "${args.model_id}" not found in ${providerKey}.`,
        };
      }

      // Add or update
      if (!config.provider[providerKey]) {
        const providerDisplayNames: Record<string, string> = {
          "candela-anthropic": "Claude via Candela",
          "candela-openai": "OpenAI via Candela",
          "candela-gemini": "Gemini via Candela",
          "candela-deepseek": "DeepSeek via Candela",
          "candela-deepseek-v3": "DeepSeek V3 via Candela",
          "candela-mistral": "Mistral via Candela",
          "candela-qwen": "Qwen via Candela",
        };

        config.provider[providerKey] = {
          npm: "@ai-sdk/openai-compatible",
          name:
            providerDisplayNames[providerKey] ?? `${providerName} via Candela`,
          options: {
            baseURL: `${candelaUrl}${route.route}`,
          },
          models: {},
        };
      }

      const provider = config.provider[providerKey];
      if (!provider.models) provider.models = {};

      const displayName = args.display_name ?? humanName(args.model_id);
      provider.models[args.model_id] = { name: displayName };

      // Set as default model if requested
      if (args.action === "set-default") {
        config.model = `${providerKey}/${args.model_id}`;
      }

      writeJsonFile(configPath, config);

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
        `| Config File | \`${configPath}\` |`,
        `| Scope | ${args.scope} |`,
      ];

      if (args.action === "set-default") {
        lines.push(`| Default Model | \`${config.model}\` |`);
      }

      lines.push(
        "",
        "⚠️ **Restart OpenCode** for changes to take effect. " +
          "Use the `candela_restart_opencode` tool or press `Ctrl+C` and relaunch.",
      );

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
    async execute(args, context) {
      // Read both project and global configs
      const projectPath = join(context.directory, ".opencode.json");
      const globalPath = join(
        homedir(),
        ".config",
        "opencode",
        "opencode.json",
      );

      const projectConfig = readJsoncFile<OpenCodeConfig>(projectPath);
      const globalConfig = readJsoncFile<OpenCodeConfig>(globalPath);

      // Merge providers — project models override global, but we merge model maps
      const allProviders: Record<string, ProviderConfig & { source: string }> =
        {};
      for (const [key, val] of Object.entries(globalConfig.provider ?? {})) {
        allProviders[key] = { ...val, source: "global" };
      }
      for (const [key, val] of Object.entries(projectConfig.provider ?? {})) {
        if (allProviders[key]) {
          // Merge model maps: global models + project overrides
          const mergedModels = {
            ...(allProviders[key].models ?? {}),
            ...(val.models ?? {}),
          };
          allProviders[key] = {
            ...val,
            models: mergedModels,
            source: "project",
          };
        } else {
          allProviders[key] = { ...val, source: "project" };
        }
      }

      if (Object.keys(allProviders).length === 0) {
        return {
          title: "No Models Configured",
          output:
            "No providers configured in OpenCode. " +
            'Use `candela_configure_model` to add a model (e.g. "add claude-sonnet-4").',
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
        `| Provider | Model | Name | Via Candela | Source |${usageHeader}`,
        `|----------|-------|------|-------------|--------|${usageSep}`,
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
            `| ${providerKey} | \`${modelId}\` | ${modelConfig.name ?? "—"} | ${isCandela ? "✅" : "❌"} | ${provider.source} |${usageCols}`,
          );
        }
      }

      lines.push(
        "",
        `**${totalModels} models** configured (${candelaModels} via Candela proxy).`,
      );

      if (existsSync(projectPath)) {
        lines.push(`\nProject config: \`${projectPath}\``);
      }
      if (existsSync(globalPath)) {
        lines.push(`Global config: \`${globalPath}\``);
      }

      return {
        title: `${totalModels} models (${candelaModels} via Candela)`,
        output: lines.join("\n"),
      };
    },
  });

  // ── candela_restart_opencode ─────────────────────────────────────────

  const restartOpencode = tool({
    description:
      "Restart OpenCode to pick up configuration changes. " +
      "Use after adding or removing models with candela_configure_model. " +
      "OpenCode reads config at startup, so a restart is needed for changes to take effect.",
    args: {
      confirm: tool.schema
        .boolean()
        .default(true)
        .describe("Set to false for a dry-run that shows what would happen."),
    },
    async execute(args) {
      if (!args.confirm) {
        return {
          title: "Restart Preview (dry-run)",
          output:
            "This would restart OpenCode by:\n" +
            "1. Writing a restart marker file\n" +
            "2. Exiting the current process (`process.exit(0)`)\n" +
            "3. You may need to manually relaunch if no process supervisor is running\n\n" +
            "Set `confirm: true` to execute.",
        };
      }

      // Write a restart marker so the user can see why opencode exited
      const markerPath = join(
        homedir(),
        ".local",
        "share",
        "opencode",
        ".candela-restart",
      );
      try {
        const markerDir = dirname(markerPath);
        mkdirSync(markerDir, { recursive: true });
        writeFileSync(
          markerPath,
          JSON.stringify({
            reason: "Config change via candela_restart_opencode tool",
            timestamp: new Date().toISOString(),
          }),
          "utf-8",
        );
      } catch {
        // Non-fatal — marker is just informational
      }

      // Schedule exit after a short delay to allow response to be sent
      setTimeout(() => {
        process.exit(0);
      }, 500);

      return {
        title: "Restarting OpenCode...",
        output:
          "🔄 **Exiting OpenCode** in 500ms.\n\n" +
          "OpenCode will exit. If a process supervisor is running, it will relaunch automatically.\n" +
          "Otherwise, run `opencode` manually to restart with the updated config.",
      };
    },
  });

  return {
    candela_configure_model: configureModel,
    candela_list_models: listModels,
    candela_restart_opencode: restartOpencode,
  };
}
