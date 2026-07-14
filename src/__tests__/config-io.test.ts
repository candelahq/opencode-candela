import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readJsoncFile, writeJsonFile } from "../utils.js";

const TEST_DIR = join(import.meta.dirname, "../../.test-tmp");
const TEST_FILE = join(TEST_DIR, "test-config.json");

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

// ── readJsoncFile ─────────────────────────────────────────────────────────────

describe("readJsoncFile", () => {
  it("returns empty object for non-existent file", () => {
    expect(readJsoncFile("/tmp/does-not-exist.json")).toEqual({});
  });

  it("reads and parses a JSON file", () => {
    const data = { key: "value", num: 42 };
    writeJsonFile(TEST_FILE, data);
    expect(readJsoncFile(TEST_FILE)).toEqual(data);
  });

  it("reads JSONC with comments and URLs", () => {
    const content = `{
  // This is a comment
  "baseURL": "http://localhost:8181/proxy/v1",
  "name": "test",
}`;
    const { writeFileSync } = require("node:fs");
    writeFileSync(TEST_FILE, content, "utf-8");

    const result = readJsoncFile<{ baseURL: string; name: string }>(TEST_FILE);
    expect(result.baseURL).toBe("http://localhost:8181/proxy/v1");
    expect(result.name).toBe("test");
  });
});

// ── writeJsonFile ─────────────────────────────────────────────────────────────

describe("writeJsonFile", () => {
  it("creates parent directories recursively", () => {
    const deepPath = join(TEST_DIR, "a", "b", "c", "config.json");
    writeJsonFile(deepPath, { ok: true });
    expect(existsSync(deepPath)).toBe(true);
    expect(readJsoncFile(deepPath)).toEqual({ ok: true });
  });

  it("writes formatted JSON with trailing newline", () => {
    writeJsonFile(TEST_FILE, { a: 1 });
    const raw = readFileSync(TEST_FILE, "utf-8");
    expect(raw).toBe('{\n  "a": 1\n}\n');
  });

  it("creates a .bak backup before overwriting", () => {
    // First write
    writeJsonFile(TEST_FILE, { version: 1 });
    // Overwrite
    writeJsonFile(TEST_FILE, { version: 2 });

    const backupPath = `${TEST_FILE}.bak`;
    expect(existsSync(backupPath)).toBe(true);

    const backup = readJsoncFile<{ version: number }>(backupPath);
    expect(backup.version).toBe(1);

    const current = readJsoncFile<{ version: number }>(TEST_FILE);
    expect(current.version).toBe(2);
  });

  it("does not create .bak for new files", () => {
    writeJsonFile(TEST_FILE, { fresh: true });
    expect(existsSync(`${TEST_FILE}.bak`)).toBe(false);
  });

  it("cleans up temp file after write", () => {
    writeJsonFile(TEST_FILE, { clean: true });
    expect(existsSync(`${TEST_FILE}.tmp`)).toBe(false);
  });

  it("roundtrips complex config without data loss", () => {
    const config = {
      $schema: "https://opencode.ai/config.json",
      provider: {
        "candela-anthropic": {
          npm: "@ai-sdk/openai-compatible",
          options: {
            baseURL: "http://localhost:8181/proxy/anthropic/v1",
          },
          models: {
            "claude-sonnet-4": { name: "Claude Sonnet 4" },
          },
        },
      },
    };

    writeJsonFile(TEST_FILE, config);
    const result = readJsoncFile(TEST_FILE);
    expect(result).toEqual(config);
  });
});
