import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverCandelaUrl } from "../discover.js";

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("discoverCandelaUrl", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Clear relevant env vars before each test
    delete process.env.CANDELA_PROXY_URL;
    delete process.env.CANDELA_CONFIG;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns default URL when no env vars or configs exist", () => {
    const url = discoverCandelaUrl();
    expect(url).toBe("http://localhost:8181");
  });

  it("returns CANDELA_PROXY_URL when set (highest priority)", () => {
    process.env.CANDELA_PROXY_URL = "http://custom-proxy:9999";
    const url = discoverCandelaUrl();
    expect(url).toBe("http://custom-proxy:9999");
  });

  it("CANDELA_PROXY_URL takes priority over CANDELA_CONFIG", () => {
    process.env.CANDELA_PROXY_URL = "http://proxy-wins:1234";
    process.env.CANDELA_CONFIG = "/some/config.yaml";
    const url = discoverCandelaUrl();
    expect(url).toBe("http://proxy-wins:1234");
  });

  it("falls back to default when CANDELA_CONFIG points to nonexistent file", () => {
    process.env.CANDELA_CONFIG = "/nonexistent/path/config.yaml";
    const url = discoverCandelaUrl();
    // Should fall through to default since file doesn't exist
    expect(url).toBe("http://localhost:8181");
  });
});
