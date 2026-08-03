/**
 * File-based memory store for cross-session project notes.
 *
 * Stores notes in `~/.config/opencode/candela-memory/<hash>.json`
 * where <hash> is derived from the git remote URL or project path.
 * Uses atomic writes (tmp → rename) to prevent corruption on crash.
 */

import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface MemoryEntry {
  key: string;
  value: string;
  createdAt: string;
  updatedAt: string;
}

interface MemoryStore {
  version: 1;
  entries: MemoryEntry[];
}

function emptyStore(): MemoryStore {
  return { version: 1, entries: [] };
}

/** Get project identity: git remote URL if available, else absolute path. */
function getProjectHash(projectDir: string): string {
  try {
    const remote = execSync("git remote get-url origin", {
      cwd: projectDir,
      encoding: "utf-8",
      timeout: 3000,
    }).trim();
    if (remote)
      return createHash("sha256").update(remote).digest("hex").slice(0, 16);
  } catch {
    // Not a git repo or no remote
  }
  return createHash("sha256").update(projectDir).digest("hex").slice(0, 16);
}

export function getMemoryPath(projectDir: string): string {
  const hash = getProjectHash(projectDir);
  return join(
    homedir(),
    ".config",
    "opencode",
    "candela-memory",
    `${hash}.json`,
  );
}

export function readMemory(projectDir: string): MemoryStore {
  try {
    const raw = readFileSync(getMemoryPath(projectDir), "utf-8");
    const data = JSON.parse(raw);
    if (data?.version === 1 && Array.isArray(data.entries))
      return data as MemoryStore;
    return emptyStore();
  } catch {
    return emptyStore();
  }
}

function writeMemory(store: MemoryStore, projectDir: string): void {
  const path = getMemoryPath(projectDir);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(store, null, 2), "utf-8");
  renameSync(tmp, path);
}

export function getEntry(projectDir: string, key: string): MemoryEntry | null {
  const store = readMemory(projectDir);
  return store.entries.find((e) => e.key === key) ?? null;
}

export function setEntry(projectDir: string, key: string, value: string): void {
  const store = readMemory(projectDir);
  const now = new Date().toISOString();
  const existing = store.entries.find((e) => e.key === key);
  if (existing) {
    existing.value = value;
    existing.updatedAt = now;
  } else {
    store.entries.push({ key, value, createdAt: now, updatedAt: now });
  }
  writeMemory(store, projectDir);
}

export function deleteEntry(projectDir: string, key: string): boolean {
  const store = readMemory(projectDir);
  const idx = store.entries.findIndex((e) => e.key === key);
  if (idx === -1) return false;
  store.entries.splice(idx, 1);
  writeMemory(store, projectDir);
  return true;
}

export function listEntries(projectDir: string): MemoryEntry[] {
  return readMemory(projectDir).entries;
}
