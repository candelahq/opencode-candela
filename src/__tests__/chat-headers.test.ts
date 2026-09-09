import { describe, expect, it } from "vitest";
import { isCandelaRequest, matchesOrigin } from "../index.js";

describe("matchesOrigin", () => {
  it("matches identical origins", () => {
    expect(
      matchesOrigin("http://127.0.0.1:8181/v1", "http://127.0.0.1:8181"),
    ).toBe(true);
    expect(
      matchesOrigin(
        "https://candela.corp.internal/v1",
        "https://candela.corp.internal",
      ),
    ).toBe(true);
  });

  it("treats localhost and 127.0.0.1 on the same port as equivalent loopback origins", () => {
    expect(
      matchesOrigin("http://localhost:8181/v1", "http://127.0.0.1:8181"),
    ).toBe(true);
    expect(
      matchesOrigin("http://127.0.0.1:8181/v1", "http://localhost:8181"),
    ).toBe(true);
  });

  it("rejects different ports on loopback", () => {
    expect(
      matchesOrigin("http://localhost:3000/v1", "http://localhost:8181"),
    ).toBe(false);
    expect(
      matchesOrigin("http://127.0.0.1:8080/v1", "http://127.0.0.1:8181"),
    ).toBe(false);
  });

  it("rejects malicious URLs containing target URL as query, path, or subdomain", () => {
    expect(
      matchesOrigin(
        "http://attacker.com/?target=http://127.0.0.1:8181",
        "http://127.0.0.1:8181",
      ),
    ).toBe(false);
    expect(
      matchesOrigin(
        "http://127.0.0.1:8181.attacker.com/v1",
        "http://127.0.0.1:8181",
      ),
    ).toBe(false);
    expect(
      matchesOrigin(
        "http://attacker.com/127.0.0.1:8181",
        "http://127.0.0.1:8181",
      ),
    ).toBe(false);
    expect(
      matchesOrigin(
        "http://user:pass@attacker.com:8181",
        "http://127.0.0.1:8181",
      ),
    ).toBe(false);
  });

  it("safely handles null, undefined, or malformed URLs", () => {
    expect(matchesOrigin(undefined, "http://127.0.0.1:8181")).toBe(false);
    expect(matchesOrigin("not-a-url", "http://127.0.0.1:8181")).toBe(false);
    expect(matchesOrigin("http://127.0.0.1:8181", "not-a-url")).toBe(false);
  });
});

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

  it("returns false for attacker URL trying to trick substring match", () => {
    expect(
      isCandelaRequest(
        {
          provider: {
            id: "third-party",
            baseURL: "http://attacker.com/?candela=http://127.0.0.1:8181",
          },
          model: "gpt-4o",
        },
        candelaUrl,
      ),
    ).toBe(false);

    expect(
      isCandelaRequest(
        {
          provider: {
            id: "third-party",
            baseURL: "http://127.0.0.1:8181.attacker.com/v1",
          },
          model: "gpt-4o",
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

  it("returns true when baseURL matches Candela proxy URL origin", () => {
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

    // Also supports localhost when candelaUrl is 127.0.0.1
    expect(
      isCandelaRequest(
        {
          provider: {
            id: "custom",
            baseURL: "http://localhost:8181/v1",
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
