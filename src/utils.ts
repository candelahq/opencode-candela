/**
 * Shared utility functions for the Candela OpenCode plugin.
 *
 * Centralises formatting helpers and config I/O so that tools.ts,
 * config-tools.ts, and index.ts don't duplicate logic.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

// ── Formatting ────────────────────────────────────────────────────────────────

/** Format USD with appropriate precision based on magnitude. */
export function formatCost(usd: number): string {
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

/** Format token count with K/M suffixes. */
export function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}K`;
  return String(count);
}

/** Format duration with ms/s/min suffixes. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60_000);
  const secs = Math.round((ms % 60_000) / 1000);
  return `${mins}m${secs}s`;
}

/** Visual budget bar with emoji indicator. Fraction clamped to [0, 1]. */
export function budgetBar(fraction: number, width = 20): string {
  const clamped = Math.max(0, Math.min(1, fraction));
  const filled = Math.round(clamped * width);
  const empty = width - filled;
  const bar = "█".repeat(filled) + "░".repeat(empty);
  if (clamped >= 0.9) return `🔴 [${bar}]`;
  if (clamped >= 0.6) return `🟡 [${bar}]`;
  return `🟢 [${bar}]`;
}

// ── JSONC Config I/O ──────────────────────────────────────────────────────────

/**
 * Parse JSONC (JSON with comments) safely.
 *
 * Handles:
 * - Single-line comments (`// ...`)
 * - Block comments (`/* ... *​/`)
 * - `//` inside quoted strings (e.g., URLs like `http://...`)
 * - Trailing commas before `}` or `]`
 *
 * Uses a string-aware approach: matches quoted strings first and
 * preserves them, then strips comment tokens that appear outside
 * of strings.
 */
export function parseJsonc(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) return {};

  // Match quoted strings OR comments. Preserve strings, remove comments.
  const cleaned = trimmed
    .replace(
      /("(?:[^"\\]|\\.)*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g,
      (_match, quoted: string | undefined) => (quoted ? quoted : ""),
    )
    .replace(/,\s*([}\]])/g, "$1");

  return JSON.parse(cleaned);
}

/**
 * Read and parse a JSONC config file.
 * Returns an empty object if the file doesn't exist or is empty.
 */
export function readJsoncFile<T = Record<string, unknown>>(path: string): T {
  if (!existsSync(path)) return {} as T;
  const raw = readFileSync(path, "utf-8");
  return parseJsonc(raw) as T;
}

/**
 * Write a config object as formatted JSON.
 *
 * Safety measures:
 * - Creates parent directories recursively
 * - Writes to a temp file first, then atomically renames
 * - Creates a .bak backup of the previous file
 */
export function writeJsonFile(path: string, data: unknown): void {
  const content = `${JSON.stringify(data, null, "  ")}\n`;
  const dir = dirname(path);

  // Ensure directory exists
  mkdirSync(dir, { recursive: true });

  // Backup existing file
  if (existsSync(path)) {
    try {
      const backup = `${path}.bak`;
      const existing = readFileSync(path, "utf-8");
      writeFileSync(backup, existing, "utf-8");
    } catch {
      // Non-fatal — backup is best-effort
    }
  }

  // Atomic write: write to temp, then rename
  const tmpPath = `${path}.tmp`;
  writeFileSync(tmpPath, content, "utf-8");
  renameSync(tmpPath, path);
}
