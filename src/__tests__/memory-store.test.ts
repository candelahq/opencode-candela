import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  deleteEntry,
  getEntry,
  getMemoryPath,
  listEntries,
  readMemory,
  setEntry,
} from "../memory-store.js";

// Use a temp directory so tests don't pollute the real config
let testDir: string;

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: () => testDir,
  };
});

beforeEach(() => {
  testDir = join(tmpdir(), `candela-memory-test-${process.pid}-${Date.now()}`);
  mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  try {
    rmSync(testDir, { recursive: true, force: true });
  } catch {
    // cleanup best-effort
  }
});

describe("readMemory", () => {
  it("returns empty store for missing file", () => {
    const store = readMemory("/some/nonexistent/project");
    expect(store).toEqual({ version: 1, entries: [] });
  });

  it("returns empty store for corrupt file", () => {
    const projectDir = "/test/project";
    const path = getMemoryPath(projectDir);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "not valid json{{", "utf-8");

    const store = readMemory(projectDir);
    expect(store).toEqual({ version: 1, entries: [] });
  });

  it("returns empty store for wrong version", () => {
    const projectDir = "/test/project";
    const path = getMemoryPath(projectDir);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, JSON.stringify({ version: 99, entries: [] }), "utf-8");

    const store = readMemory(projectDir);
    expect(store).toEqual({ version: 1, entries: [] });
  });
});

describe("setEntry + getEntry", () => {
  it("writes and reads back a note", () => {
    const projectDir = "/test/roundtrip";
    setEntry(projectDir, "arch-decision", "Use PostgreSQL for persistence");

    const entry = getEntry(projectDir, "arch-decision");
    expect(entry).not.toBeNull();
    expect(entry?.key).toBe("arch-decision");
    expect(entry?.value).toBe("Use PostgreSQL for persistence");
    expect(entry?.createdAt).toBeTruthy();
    expect(entry?.updatedAt).toBeTruthy();
  });

  it("updates existing key preserving createdAt", () => {
    const projectDir = "/test/update";
    setEntry(projectDir, "status", "v1");
    const first = getEntry(projectDir, "status");
    const originalCreatedAt = first?.createdAt;

    setEntry(projectDir, "status", "v2");
    const second = getEntry(projectDir, "status");

    expect(second?.value).toBe("v2");
    expect(second?.createdAt).toBe(originalCreatedAt);
  });

  it("returns null for missing key", () => {
    const entry = getEntry("/test/missing", "nonexistent");
    expect(entry).toBeNull();
  });
});

describe("deleteEntry", () => {
  it("removes an existing entry", () => {
    const projectDir = "/test/delete";
    setEntry(projectDir, "tmp-note", "will be deleted");
    expect(getEntry(projectDir, "tmp-note")).not.toBeNull();

    const deleted = deleteEntry(projectDir, "tmp-note");
    expect(deleted).toBe(true);
    expect(getEntry(projectDir, "tmp-note")).toBeNull();
  });

  it("returns false for missing key", () => {
    const deleted = deleteEntry("/test/delete-miss", "ghost");
    expect(deleted).toBe(false);
  });
});

describe("listEntries", () => {
  it("returns all entries for a project", () => {
    const projectDir = "/test/list";
    setEntry(projectDir, "note-a", "Alpha");
    setEntry(projectDir, "note-b", "Beta");
    setEntry(projectDir, "note-c", "Charlie");

    const entries = listEntries(projectDir);
    expect(entries).toHaveLength(3);
    expect(entries.map((e) => e.key)).toEqual(["note-a", "note-b", "note-c"]);
  });

  it("returns empty array when no notes exist", () => {
    const entries = listEntries("/test/empty");
    expect(entries).toEqual([]);
  });
});
