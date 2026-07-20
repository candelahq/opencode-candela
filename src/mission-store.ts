/**
 * File-based mission state persistence.
 *
 * Stores missions in `~/.config/opencode/candela-missions.json`.
 * Uses atomic writes (tmp → rename) to prevent corruption on crash.
 *
 * The server plugin has no access to OpenCode's TUI KV store,
 * so file-based persistence is required. The TUI plugin reads
 * the same file for sidebar display.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Mission, MissionStore } from "./types.js";

/** Default storage path. Overridable for testing. */
const DEFAULT_PATH = join(
  homedir(),
  ".config",
  "opencode",
  "candela-missions.json",
);

/** Empty store shape. */
function emptyStore(): MissionStore {
  return { activeMissionId: null, missions: [] };
}

/**
 * Read missions from disk. Returns an empty store on missing/corrupt file.
 */
export function readMissions(path = DEFAULT_PATH): MissionStore {
  try {
    const raw = readFileSync(path, "utf-8");
    const data = JSON.parse(raw);
    // Basic shape validation
    if (data && typeof data === "object" && Array.isArray(data.missions)) {
      return data as MissionStore;
    }
    return emptyStore();
  } catch {
    return emptyStore();
  }
}

/**
 * Write missions to disk atomically.
 * Writes to a temp file then renames to prevent corruption.
 */
export function writeMissions(store: MissionStore, path = DEFAULT_PATH): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(store, null, 2), "utf-8");
  renameSync(tmp, path);
}

/**
 * Get the currently active mission, or null.
 */
export function getActiveMission(path = DEFAULT_PATH): Mission | null {
  const store = readMissions(path);
  if (!store.activeMissionId) return null;
  return store.missions.find((m) => m.id === store.activeMissionId) ?? null;
}

/**
 * Read-modify-write a specific mission by ID.
 * The updater function mutates the mission in place.
 */
export function updateMission(
  missionId: string,
  updater: (mission: Mission) => void,
  path = DEFAULT_PATH,
): void {
  const store = readMissions(path);
  const mission = store.missions.find((m) => m.id === missionId);
  if (!mission) return;
  updater(mission);
  writeMissions(store, path);
}

/**
 * Add a new mission and set it as active.
 * Fails if there's already an active mission.
 */
export function addMission(mission: Mission, path = DEFAULT_PATH): boolean {
  const store = readMissions(path);
  if (store.activeMissionId) return false;
  store.missions.push(mission);
  store.activeMissionId = mission.id;
  writeMissions(store, path);
  return true;
}

/**
 * Prune completed/cancelled missions older than `days`.
 * Called on plugin init for housekeeping.
 */
export function pruneCompleted(days: number, path = DEFAULT_PATH): number {
  const store = readMissions(path);
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const before = store.missions.length;

  store.missions = store.missions.filter((m) => {
    if (m.status === "active") return true;
    if (!m.completedAt) return true;
    return new Date(m.completedAt).getTime() > cutoff;
  });

  const pruned = before - store.missions.length;
  if (pruned > 0) {
    writeMissions(store, path);
  }
  return pruned;
}
