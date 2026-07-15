import { describe, expect, it } from "vitest";
import {
  budgetBar,
  formatCost,
  formatDuration,
  formatTokens,
  parseJsonc,
} from "../utils.js";

// ── formatCost ────────────────────────────────────────────────────────────────

describe("formatCost", () => {
  it("shows 4 decimals for sub-cent amounts", () => {
    expect(formatCost(0.001)).toBe("$0.0010");
    expect(formatCost(0.0099)).toBe("$0.0099");
  });

  it("shows 3 decimals for sub-dollar amounts", () => {
    expect(formatCost(0.01)).toBe("$0.010");
    expect(formatCost(0.5)).toBe("$0.500");
    expect(formatCost(0.999)).toBe("$0.999");
  });

  it("shows 2 decimals for dollar+ amounts", () => {
    expect(formatCost(1)).toBe("$1.00");
    expect(formatCost(42.5)).toBe("$42.50");
    expect(formatCost(100)).toBe("$100.00");
  });

  it("handles zero", () => {
    expect(formatCost(0)).toBe("$0.0000");
  });
});

// ── formatTokens ──────────────────────────────────────────────────────────────

describe("formatTokens", () => {
  it("shows raw count for < 1K", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(999)).toBe("999");
  });

  it("shows K suffix for thousands", () => {
    expect(formatTokens(1000)).toBe("1.0K");
    expect(formatTokens(1500)).toBe("1.5K");
    expect(formatTokens(999_999)).toBe("1000.0K");
  });

  it("shows M suffix for millions", () => {
    expect(formatTokens(1_000_000)).toBe("1.0M");
    expect(formatTokens(2_500_000)).toBe("2.5M");
  });
});

// ── formatDuration ────────────────────────────────────────────────────────────

describe("formatDuration", () => {
  it("shows ms for < 1s", () => {
    expect(formatDuration(0)).toBe("0ms");
    expect(formatDuration(50)).toBe("50ms");
    expect(formatDuration(999)).toBe("999ms");
  });

  it("shows seconds for < 1min", () => {
    expect(formatDuration(1000)).toBe("1.0s");
    expect(formatDuration(1500)).toBe("1.5s");
    expect(formatDuration(59_999)).toBe("60.0s");
  });

  it("shows minutes and seconds for >= 1min", () => {
    expect(formatDuration(60_000)).toBe("1m0s");
    expect(formatDuration(90_000)).toBe("1m30s");
    expect(formatDuration(125_000)).toBe("2m5s");
  });
});

// ── budgetBar ─────────────────────────────────────────────────────────────────

describe("budgetBar", () => {
  it("shows green for low usage", () => {
    expect(budgetBar(0)).toContain("🟢");
    expect(budgetBar(0.3)).toContain("🟢");
    expect(budgetBar(0.59)).toContain("🟢");
  });

  it("shows yellow for medium usage", () => {
    expect(budgetBar(0.6)).toContain("🟡");
    expect(budgetBar(0.75)).toContain("🟡");
    expect(budgetBar(0.89)).toContain("🟡");
  });

  it("shows red for high usage", () => {
    expect(budgetBar(0.9)).toContain("🔴");
    expect(budgetBar(1.0)).toContain("🔴");
  });

  it("clamps fraction to [0, 1]", () => {
    // Should not throw RangeError for out-of-bounds fractions
    expect(() => budgetBar(-0.5)).not.toThrow();
    expect(() => budgetBar(1.5)).not.toThrow();
    expect(() => budgetBar(NaN)).not.toThrow();
    expect(() => budgetBar(Infinity)).not.toThrow();

    // Negative clamps to 0 (green)
    expect(budgetBar(-1)).toContain("🟢");
    // Over 1 clamps to 1 (red)
    expect(budgetBar(2)).toContain("🔴");
  });

  it("uses correct width", () => {
    const bar = budgetBar(0.5, 10);
    // Should have exactly 10 bar chars
    const barChars = bar.match(/[█░]/g);
    expect(barChars).toHaveLength(10);
  });
});

// ── parseJsonc ────────────────────────────────────────────────────────────────

describe("parseJsonc", () => {
  it("parses plain JSON", () => {
    const result = parseJsonc('{"key": "value"}');
    expect(result).toEqual({ key: "value" });
  });

  it("strips single-line comments", () => {
    const result = parseJsonc(`{
      // This is a comment
      "key": "value"
    }`);
    expect(result).toEqual({ key: "value" });
  });

  it("strips block comments", () => {
    const result = parseJsonc(`{
      /* block comment */
      "key": "value"
    }`);
    expect(result).toEqual({ key: "value" });
  });

  it("strips multi-line block comments", () => {
    const result = parseJsonc(`{
      /*
       * Multi-line
       * block comment
       */
      "key": "value"
    }`);
    expect(result).toEqual({ key: "value" });
  });

  it("preserves // inside quoted strings (URLs)", () => {
    const result = parseJsonc(
      '{"baseURL": "http://localhost:8181/proxy/anthropic/v1"}',
    ) as Record<string, unknown>;
    expect(result.baseURL).toBe("http://localhost:8181/proxy/anthropic/v1");
  });

  it("handles real opencode config with URLs and comments", () => {
    const config = `{
      // OpenCode config
      "$schema": "https://opencode.ai/config.json",
      "provider": {
        "candela-anthropic": {
          "npm": "@ai-sdk/openai-compatible",
          "options": {
            "baseURL": "http://localhost:8181/proxy/anthropic/v1"
          },
          "models": {
            "claude-sonnet-4": {
              "name": "Claude Sonnet 4"
            },
          }
        }
      }
    }`;
    const result = parseJsonc(config) as Record<string, unknown>;
    const provider = (result.provider as Record<string, unknown>)[
      "candela-anthropic"
    ] as Record<string, unknown>;
    const options = provider.options as Record<string, unknown>;
    expect(options.baseURL).toBe("http://localhost:8181/proxy/anthropic/v1");
    expect(result.$schema).toBe("https://opencode.ai/config.json");
  });

  it("handles trailing commas", () => {
    const result = parseJsonc('{"a": 1, "b": 2, }');
    expect(result).toEqual({ a: 1, b: 2 });
  });

  it("handles trailing commas in arrays", () => {
    const result = parseJsonc('{"items": [1, 2, 3, ]}');
    expect(result).toEqual({ items: [1, 2, 3] });
  });

  it("returns empty object for empty string", () => {
    expect(parseJsonc("")).toEqual({});
  });

  it("returns empty object for whitespace", () => {
    expect(parseJsonc("   \n  ")).toEqual({});
  });

  it("handles escaped quotes in strings", () => {
    const result = parseJsonc('{"msg": "say \\"hello\\""}');
    expect(result).toEqual({ msg: 'say "hello"' });
  });

  it("handles strings containing // that look like comments", () => {
    const result = parseJsonc(
      '{"protocol": "https://example.com", "note": "see // docs"}',
    ) as Record<string, unknown>;
    expect(result.protocol).toBe("https://example.com");
    expect(result.note).toBe("see // docs");
  });
});
