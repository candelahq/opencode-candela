import { describe, expect, it } from "vitest";
import { isCandelaRequest } from "../index.js";

describe("isCandelaRequest", () => {
  const candelaUrl = "http://127.0.0.1:8181";

  it("returns false for null or undefined input", () => {
    expect(isCandelaRequest(null, candelaUrl)).toBe(false);
    expect(isCandelaRequest(undefined, candelaUrl)).toBe(false);
    expect(isCandelaRequest({}, candelaUrl)).toBe(false);
  });

  it("returns false for direct third-party providers without Candela routing", () => {
    expect(
      isCandelaRequest(
        {
          provider: "anthropic",
          model: "claude-3-5-sonnet",
        },
        candelaUrl,
      ),
    ).toBe(false);

    expect(
      isCandelaRequest(
        {
          provider: {
            id: "openai",
            baseURL: "https://api.openai.com/v1",
          },
          model: {
            id: "gpt-4o",
            providerID: "openai",
          },
        },
        candelaUrl,
      ),
    ).toBe(false);
  });

  it("returns true when provider ID indicates Candela", () => {
    expect(
      isCandelaRequest(
        {
          provider: "candela-anthropic",
          model: "claude-3-5-sonnet",
        },
        candelaUrl,
      ),
    ).toBe(true);

    expect(
      isCandelaRequest(
        {
          provider: { id: "candela" },
        },
        candelaUrl,
      ),
    ).toBe(true);
  });

  it("returns true when baseURL matches Candela proxy URL", () => {
    expect(
      isCandelaRequest(
        {
          provider: {
            id: "custom",
            baseURL: `${candelaUrl}/proxy/openai/v1`,
          },
        },
        candelaUrl,
      ),
    ).toBe(true);
  });

  it("returns true when model provider or model ID indicates Candela", () => {
    expect(
      isCandelaRequest(
        {
          model: {
            id: "claude-3-5-sonnet",
            providerID: "candela-anthropic",
          },
        },
        candelaUrl,
      ),
    ).toBe(true);

    expect(
      isCandelaRequest(
        {
          model: "candela/gpt-4o",
        },
        candelaUrl,
      ),
    ).toBe(true);
  });
});
