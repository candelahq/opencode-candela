import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CandelaClient } from "../candela-client.js";
import {
  createConfigTools,
  humanName,
  inferProvider,
} from "../config-tools.js";

// ── inferProvider ─────────────────────────────────────────────────────────────

describe("inferProvider", () => {
  it("detects Anthropic models", () => {
    expect(inferProvider("claude-sonnet-4")).toBe("anthropic");
    expect(inferProvider("claude-opus-4.8")).toBe("anthropic");
    expect(inferProvider("claude-haiku-4.5")).toBe("anthropic");
    // Also matches by family name alone
    expect(inferProvider("sonnet-4-latest")).toBe("anthropic");
    expect(inferProvider("opus-next")).toBe("anthropic");
    expect(inferProvider("haiku-mini")).toBe("anthropic");
  });

  it("detects OpenAI models", () => {
    expect(inferProvider("gpt-4.1")).toBe("openai");
    expect(inferProvider("gpt-4.1-mini")).toBe("openai");
    expect(inferProvider("gpt-4o")).toBe("openai");
    expect(inferProvider("o3")).toBe("openai");
    expect(inferProvider("o4-mini")).toBe("openai");
    expect(inferProvider("o1-preview")).toBe("openai");
  });

  it("detects Gemini models", () => {
    expect(inferProvider("gemini-3.5-flash")).toBe("gemini");
    expect(inferProvider("gemini-2.5-pro")).toBe("gemini");
    expect(inferProvider("gemini-2.0-flash")).toBe("gemini");
  });

  it("detects DeepSeek models", () => {
    expect(inferProvider("deepseek-r1-0528-maas")).toBe("deepseek");
  });

  it("detects DeepSeek V3 models (before generic deepseek)", () => {
    expect(inferProvider("deepseek-v3.2-maas")).toBe("deepseek-v3");
  });

  it("detects Mistral models", () => {
    expect(inferProvider("mistral-medium-3")).toBe("mistral");
    expect(inferProvider("mistral-small-2503")).toBe("mistral");
    expect(inferProvider("codestral-2")).toBe("mistral");
  });

  it("detects Qwen models", () => {
    expect(inferProvider("qwen3-coder-480b-a35b-instruct-maas")).toBe("qwen");
    expect(inferProvider("qwen3-235b-a22b-instruct-2507-maas")).toBe("qwen");
  });

  it("is case-insensitive", () => {
    expect(inferProvider("Claude-Sonnet-4")).toBe("anthropic");
    expect(inferProvider("GPT-4.1")).toBe("openai");
    expect(inferProvider("GEMINI-3.5-FLASH")).toBe("gemini");
  });

  it("returns null for unknown models", () => {
    expect(inferProvider("llama-3.1")).toBeNull();
    expect(inferProvider("phi-4")).toBeNull();
    expect(inferProvider("unknown-model")).toBeNull();
  });
});

// ── humanName ─────────────────────────────────────────────────────────────────

describe("humanName", () => {
  it("converts dashes to spaces and capitalizes words", () => {
    expect(humanName("claude-sonnet-4")).toBe("Claude Sonnet 4");
    expect(humanName("gpt-4.1-mini")).toBe("Gpt 4.1 Mini");
  });

  it("strips -maas suffix", () => {
    expect(humanName("deepseek-r1-0528-maas")).toBe("Deepseek R1 0528");
    expect(humanName("qwen3-coder-480b-a35b-instruct-maas")).toBe(
      "Qwen3 Coder 480b A35b Instruct",
    );
  });

  it("handles single word models", () => {
    expect(humanName("o3")).toBe("O3");
  });
});

// ── candela_configure_model (browse & list) ─────────────────────────────────

describe("candela_configure_model (list/browse)", () => {
  const CANDELA_URL = "http://localhost:4100";

  function makeMockClient() {
    return {
      getDashboardData: vi.fn().mockResolvedValue(null),
    } as unknown as CandelaClient;
  }

  function makeMockOpenCodeClient(configData: Record<string, unknown> = {}) {
    return {
      config: {
        get: vi.fn().mockResolvedValue({ data: configData }),
        update: vi.fn().mockResolvedValue({}),
      },
    } as unknown as Parameters<typeof createConfigTools>[2];
  }

  function makeContext() {
    return {
      sessionID: "test",
      messageID: "test",
      agent: "test",
      directory: "/tmp",
      worktree: "/tmp",
      abort: new AbortController().signal,
      metadata: vi.fn(),
      ask: vi.fn(),
    };
  }

  function model(overrides: Record<string, unknown> = {}) {
    return {
      modelId: overrides.modelId ?? "claude-sonnet-4",
      provider: overrides.provider ?? "anthropic",
      displayName: overrides.displayName ?? "Claude Sonnet 4",
      inputPerMillion: overrides.inputPerMillion ?? 3.0,
      outputPerMillion: overrides.outputPerMillion ?? 15.0,
      contextWindow: overrides.contextWindow ?? 200000,
      category: overrides.category ?? "chat",
      enabled: overrides.enabled ?? true,
      inputPerMillionHigh: overrides.inputPerMillionHigh ?? 0,
      outputPerMillionHigh: overrides.outputPerMillionHigh ?? 0,
      tierThresholdTokens: overrides.tierThresholdTokens ?? 0,
    };
  }

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe("action: browse", () => {
    function catalogTools(entries: ReturnType<typeof model>[] | null) {
      const client = makeMockClient();
      (client as unknown as Record<string, unknown>).getModelCatalog = vi
        .fn()
        .mockResolvedValue(entries);
      const opencodeClient = makeMockOpenCodeClient();
      return createConfigTools(client, CANDELA_URL, opencodeClient);
    }

    it("returns 'Catalog Unavailable' when Candela is down", async () => {
      const tools = catalogTools(null);
      const result = (await tools.candela_configure_model.execute(
        { action: "browse" },
        makeContext() as unknown as Parameters<
          typeof tools.candela_configure_model.execute
        >[1],
      )) as { title: string; output: string };
      expect(result.title).toBe("Catalog Unavailable");
    });

    it("shows all models sorted by price (default)", async () => {
      const tools = catalogTools([
        model({ modelId: "gpt-4o", provider: "openai", inputPerMillion: 5 }),
        model({
          modelId: "gemini-2.5-flash",
          provider: "google",
          inputPerMillion: 0.15,
          contextWindow: 1000000,
        }),
      ]);
      const result = (await tools.candela_configure_model.execute(
        { action: "browse" },
        makeContext() as unknown as Parameters<
          typeof tools.candela_configure_model.execute
        >[1],
      )) as { title: string; output: string };

      expect(result.title).toBe("Catalog: 2 models");
      expect(result.output).toContain("gemini-2.5-flash"); // cheapest first
    });
  });

  describe("action: list", () => {
    it("returns 'No Models Configured' when empty", async () => {
      const client = makeMockClient();
      const opencodeClient = makeMockOpenCodeClient({});
      const tools = createConfigTools(client, CANDELA_URL, opencodeClient);

      const result = (await tools.candela_configure_model.execute(
        { action: "list" },
        makeContext() as unknown as Parameters<
          typeof tools.candela_configure_model.execute
        >[1],
      )) as { title: string; output: string };

      expect(result.title).toBe("No Models Configured");
    });

    it("lists configured models", async () => {
      const client = makeMockClient();
      const opencodeClient = makeMockOpenCodeClient({
        provider: {
          "candela-anthropic": {
            models: { "claude-sonnet-4": { name: "Claude Sonnet 4" } },
          },
        },
      });
      const tools = createConfigTools(client, CANDELA_URL, opencodeClient);

      const result = (await tools.candela_configure_model.execute(
        { action: "list" },
        makeContext() as unknown as Parameters<
          typeof tools.candela_configure_model.execute
        >[1],
      )) as { title: string; output: string };

      expect(result.title).toContain("1 models (1 via Candela)");
      expect(result.output).toContain("claude-sonnet-4");
      expect(result.output).toContain("candela-anthropic");
    });
  });
});
