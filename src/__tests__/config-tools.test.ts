import { describe, expect, it } from "vitest";
import { humanName, inferProvider } from "../config-tools.js";

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
