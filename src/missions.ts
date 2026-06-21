/**
 * File-based mission state persistence.
 *
 * Stores mission state at ~/.config/opencode/candela-missions.json.
 * Uses atomic writes (write to tmp, rename) to prevent corruption.
 * Prunes completed missions older than 90 days on load.
 */

import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import type { Mission, Milestone, MissionStore, MilestoneStatus } from "./types.js";

// ── Constants ──────────────────────────────────────────────────────────────

const MISSIONS_DIR = join(homedir(), ".config", "opencode");
const MISSIONS_FILE = join(MISSIONS_DIR, "candela-missions.json");
const RETENTION_DAYS = 90;
const MAX_TEST_OUTPUT = 2048; // 2KB

// ── ID Generation ──────────────────────────────────────────────────────────

/** Generate a short mission ID. */
export function newMissionId(): string {
  return `mission_${randomUUID().slice(0, 8)}`;
}

/** Generate a short milestone ID. */
export function newMilestoneId(): string {
  return `ms_${randomUUID().slice(0, 8)}`;
}

// ── Persistence ────────────────────────────────────────────────────────────

/** Create an empty mission store. */
function emptyStore(): MissionStore {
  return { activeMissionId: null, missions: {} };
}

/** Read the mission store from disk. Returns empty store if file doesn't exist. */
export function readMissionStore(): MissionStore {
  try {
    const raw = readFileSync(MISSIONS_FILE, "utf-8");
    const store = JSON.parse(raw) as MissionStore;
    // Validate basic structure
    if (!store.missions || typeof store.missions !== "object") {
      return emptyStore();
    }
    return store;
  } catch {
    return emptyStore();
  }
}

/** Write the mission store to disk atomically (write to tmp, rename). */
export function writeMissionStore(store: MissionStore): void {
  mkdirSync(MISSIONS_DIR, { recursive: true });
  const tmpFile = `${MISSIONS_FILE}.${Date.now()}.tmp`;
  writeFileSync(tmpFile, JSON.stringify(store, null, 2), "utf-8");
  renameSync(tmpFile, MISSIONS_FILE);
}

// ── Retention ──────────────────────────────────────────────────────────────

/** Days since an ISO 8601 timestamp. */
function daysSince(isoDate: string): number {
  const then = new Date(isoDate).getTime();
  return (Date.now() - then) / (1000 * 60 * 60 * 24);
}

/**
 * Prune completed/failed/cancelled missions older than RETENTION_DAYS.
 * Called on plugin init.
 */
export function pruneMissions(store: MissionStore): { pruned: number } {
  let pruned = 0;
  const terminalStatuses = new Set(["done", "failed", "cancelled"]);

  for (const [id, mission] of Object.entries(store.missions)) {
    if (
      terminalStatuses.has(mission.status) &&
      mission.completedAt &&
      daysSince(mission.completedAt) > RETENTION_DAYS
    ) {
      delete store.missions[id];
      if (store.activeMissionId === id) {
        store.activeMissionId = null;
      }
      pruned++;
    }
  }

  if (pruned > 0) {
    writeMissionStore(store);
  }
  return { pruned };
}

// ── Mission Operations ─────────────────────────────────────────────────────

/** Get the active mission, or null. */
export function getActiveMission(store: MissionStore): Mission | null {
  if (!store.activeMissionId) return null;
  return store.missions[store.activeMissionId] ?? null;
}

/** Create a new mission and set it as active. */
export function createMission(
  store: MissionStore,
  goal: string,
  milestones: Array<{
    title: string;
    description: string;
    successCriteria?: string;
    testCommand?: string;
    files?: string[];
  }>,
): Mission {
  const mission: Mission = {
    id: newMissionId(),
    goal,
    status: "executing",
    createdAt: new Date().toISOString(),
    milestones: milestones.map((m, i) => ({
      id: newMilestoneId(),
      ordinal: i,
      title: m.title,
      description: m.description,
      status: "pending" as MilestoneStatus,
      successCriteria: m.successCriteria,
      testCommand: m.testCommand,
      files: m.files,
    })),
  };

  store.missions[mission.id] = mission;
  store.activeMissionId = mission.id;
  writeMissionStore(store);
  return mission;
}

/** Get the next pending milestone in the active mission. */
export function getNextMilestone(mission: Mission): Milestone | null {
  return mission.milestones.find((m) => m.status === "pending") ?? null;
}

/** Update a milestone's status and metadata. */
export function updateMilestone(
  store: MissionStore,
  missionId: string,
  milestoneId: string,
  updates: Partial<Pick<Milestone, "status" | "sessionId" | "testResult" | "testOutput" | "startedAt" | "completedAt">>,
): void {
  const mission = store.missions[missionId];
  if (!mission) return;

  const milestone = mission.milestones.find((m) => m.id === milestoneId);
  if (!milestone) return;

  Object.assign(milestone, updates);

  // Truncate test output if too long
  if (milestone.testOutput && milestone.testOutput.length > MAX_TEST_OUTPUT) {
    milestone.testOutput =
      milestone.testOutput.slice(0, MAX_TEST_OUTPUT) + "\n…(truncated)";
  }

  // Check if all milestones are terminal — update mission status
  const allDone = mission.milestones.every(
    (m) => m.status === "done" || m.status === "skipped",
  );
  const anyFailed = mission.milestones.some((m) => m.status === "failed");

  if (allDone) {
    mission.status = "done";
    mission.completedAt = new Date().toISOString();
  } else if (anyFailed) {
    // Don't auto-fail the whole mission — let the user decide via mission_cancel
    // Just leave it in "executing" so they can retry or skip
  }

  writeMissionStore(store);
}

/** Cancel the active mission and abort any working milestones. */
export function cancelMission(
  store: MissionStore,
  missionId: string,
): { workingSessionIds: string[] } {
  const mission = store.missions[missionId];
  if (!mission) return { workingSessionIds: [] };

  const workingSessionIds: string[] = [];

  for (const ms of mission.milestones) {
    if (ms.status === "working" || ms.status === "validating") {
      if (ms.sessionId) workingSessionIds.push(ms.sessionId);
      ms.status = "skipped";
      ms.completedAt = new Date().toISOString();
    }
    if (ms.status === "pending") {
      ms.status = "skipped";
    }
  }

  mission.status = "cancelled";
  mission.completedAt = new Date().toISOString();

  if (store.activeMissionId === missionId) {
    store.activeMissionId = null;
  }

  writeMissionStore(store);
  return { workingSessionIds };
}

/** Format mission progress as a compact string for display / system prompt. */
export function formatMissionProgress(mission: Mission): string {
  const done = mission.milestones.filter((m) => m.status === "done" || m.status === "skipped").length;
  const total = mission.milestones.length;
  const lines = mission.milestones.map((ms) => {
    const icons: Record<MilestoneStatus, string> = {
      pending: "☐",
      working: "▶",
      validating: "🔍",
      done: "✅",
      failed: "❌",
      skipped: "⏭",
    };
    return `  ${icons[ms.status]} ${ms.title}`;
  });
  return `Mission (${done}/${total}): ${mission.goal}\n${lines.join("\n")}`;
}
