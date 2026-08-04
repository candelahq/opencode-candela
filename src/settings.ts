/**
 * Plugin settings for opt-in features.
 *
 * Controls configurable behavior like smart model routing.
 * Settings are resolved in priority order:
 *   1. Environment variables (highest priority, explicit override)
 *   2. Persisted settings file (~/.config/opencode/candela-settings.json)
 *   3. Defaults (lowest priority)
 *
 * Smart model routing is OFF by default — users must opt in.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SmartRoutingSettings {
  /** Whether smart model routing suggestions are enabled. Default: false. */
  enabled: boolean;
  /**
   * Budget usage fraction (0.0–1.0) at which routing suggestions activate.
   * Default: 0.7 (70% budget used).
   */
  budgetThreshold: number;
  /**
   * Minimum savings fraction (0.0–1.0) to show a suggestion.
   * Default: 0.5 (suggest when cheaper model saves ≥ 50%).
   */
  savingsThreshold: number;
}

export interface PluginSettings {
  smartRouting: SmartRoutingSettings;
  /** Number of cross-promotion impressions already shown. */
  crossPromoShown: number;
  /** Daily cost goal in USD. Null means no goal set. */
  dailyCostGoal: number | null;
  /** Suppress info-level toasts. Only warnings/errors shown. */
  quietMode: boolean;
  /** Per-session cost cap in USD. Null means no cap. */
  sessionCostCap: number | null;
  /** Current session tag for cost attribution. Null means untagged. */
  sessionTag: string | null;
}

// ── Defaults ──────────────────────────────────────────────────────────────────

const DEFAULTS: PluginSettings = {
  smartRouting: {
    enabled: false,
    budgetThreshold: 0.7,
    savingsThreshold: 0.5,
  },
  crossPromoShown: 0,
  dailyCostGoal: null,
  quietMode: false,
  sessionCostCap: null,
  sessionTag: null,
};

// ── Persisted settings file ───────────────────────────────────────────────────

const SETTINGS_PATH = join(
  homedir(),
  ".config",
  "opencode",
  "candela-settings.json",
);

interface PersistedSettings {
  version: 1;
  smartRouting?: Partial<SmartRoutingSettings>;
  crossPromoShown?: number;
  dailyCostGoal?: number | null;
  quietMode?: boolean;
  sessionCostCap?: number | null;
  sessionTag?: string | null;
}

function readPersisted(): PersistedSettings {
  try {
    if (!existsSync(SETTINGS_PATH)) return { version: 1 };
    const raw = readFileSync(SETTINGS_PATH, "utf-8");
    const data = JSON.parse(raw);
    if (data?.version === 1) return data as PersistedSettings;
    return { version: 1 };
  } catch {
    return { version: 1 };
  }
}

function writePersisted(settings: PersistedSettings): void {
  const dir = dirname(SETTINGS_PATH);
  mkdirSync(dir, { recursive: true });
  const tmp = `${SETTINGS_PATH}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(settings, null, 2), "utf-8");
  renameSync(tmp, SETTINGS_PATH);
}

// ── Environment variable parsing ──────────────────────────────────────────────

function envBool(key: string): boolean | undefined {
  const val = process.env[key];
  if (val === undefined || val === "") return undefined;
  return val === "1" || val === "true" || val === "yes";
}

function envFloat(key: string, min: number, max: number): number | undefined {
  const val = process.env[key];
  if (val === undefined || val === "") return undefined;
  const num = parseFloat(val);
  if (Number.isNaN(num)) return undefined;
  return Math.max(min, Math.min(max, num));
}

// ── Resolve settings ──────────────────────────────────────────────────────────

/**
 * Resolve plugin settings.
 * Priority: env vars > persisted file > defaults.
 */
export function resolveSettings(): PluginSettings {
  const persisted = readPersisted();

  return {
    smartRouting: {
      enabled:
        envBool("CANDELA_SMART_ROUTING") ??
        persisted.smartRouting?.enabled ??
        DEFAULTS.smartRouting.enabled,
      budgetThreshold:
        envFloat("CANDELA_ROUTING_THRESHOLD", 0, 1) ??
        persisted.smartRouting?.budgetThreshold ??
        DEFAULTS.smartRouting.budgetThreshold,
      savingsThreshold:
        envFloat("CANDELA_ROUTING_SAVINGS_THRESHOLD", 0, 1) ??
        persisted.smartRouting?.savingsThreshold ??
        DEFAULTS.smartRouting.savingsThreshold,
    },
    crossPromoShown: persisted.crossPromoShown ?? DEFAULTS.crossPromoShown,
    dailyCostGoal:
      envFloat("CANDELA_DAILY_GOAL", 0, 10000) ??
      persisted.dailyCostGoal ??
      DEFAULTS.dailyCostGoal,
    quietMode:
      envBool("CANDELA_QUIET") ?? persisted.quietMode ?? DEFAULTS.quietMode,
    sessionCostCap:
      envFloat("CANDELA_SESSION_CAP", 0, 10000) ??
      persisted.sessionCostCap ??
      DEFAULTS.sessionCostCap,
    sessionTag: persisted.sessionTag ?? DEFAULTS.sessionTag,
  };
}

// ── Runtime updates ───────────────────────────────────────────────────────────

/**
 * Update smart routing settings at runtime.
 * Persists to disk so changes survive restarts.
 */
export function updateSmartRouting(
  update: Partial<SmartRoutingSettings>,
): PluginSettings {
  const persisted = readPersisted();
  const current = persisted.smartRouting ?? {};

  let { budgetThreshold, savingsThreshold } = update;
  if (budgetThreshold !== undefined) {
    budgetThreshold = Math.max(0, Math.min(1, budgetThreshold));
  }
  if (savingsThreshold !== undefined) {
    savingsThreshold = Math.max(0, Math.min(1, savingsThreshold));
  }

  persisted.smartRouting = {
    ...current,
    ...update,
    ...(budgetThreshold !== undefined && { budgetThreshold }),
    ...(savingsThreshold !== undefined && { savingsThreshold }),
  };

  writePersisted(persisted);

  // Return the fully resolved settings after the update
  return resolveSettings();
}

/**
 * Get the current settings file path (for display to users).
 */
export function getSettingsPath(): string {
  return SETTINGS_PATH;
}

/**
 * Record a cross-promotion impression. Persists so we cap at MAX_IMPRESSIONS
 * across restarts.
 */
export function incrementCrossPromo(): number {
  const persisted = readPersisted();
  persisted.crossPromoShown = (persisted.crossPromoShown ?? 0) + 1;
  writePersisted(persisted);
  return persisted.crossPromoShown;
}

/**
 * Set or clear the daily cost goal.
 * Pass null to clear. Persists to disk.
 */
export function updateDailyCostGoal(goal: number | null): PluginSettings {
  const persisted = readPersisted();
  persisted.dailyCostGoal = goal !== null ? Math.max(0, goal) : null;
  writePersisted(persisted);
  return resolveSettings();
}

/** Toggle quiet mode (suppress info toasts). */
export function toggleQuietMode(): PluginSettings {
  const persisted = readPersisted();
  persisted.quietMode = !(persisted.quietMode ?? false);
  writePersisted(persisted);
  return resolveSettings();
}

/** Set or clear the per-session cost cap. */
export function updateSessionCostCap(cap: number | null): PluginSettings {
  const persisted = readPersisted();
  persisted.sessionCostCap = cap !== null ? Math.max(0, cap) : null;
  writePersisted(persisted);
  return resolveSettings();
}

/** Set or clear the session tag for cost attribution. */
export function updateSessionTag(tag: string | null): PluginSettings {
  const persisted = readPersisted();
  persisted.sessionTag = tag?.trim() || null;
  writePersisted(persisted);
  return resolveSettings();
}
