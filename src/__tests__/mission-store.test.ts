import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addMission,
  getActiveMission,
  pruneCompleted,
  readMissions,
  updateMission,
  writeMissions,
} from "../mission-store.js";
import type { Mission, MissionStore } from "../types.js";

// Use a temp directory for all tests
const TEST_DIR = join(tmpdir(), `candela-test-${process.pid}`);
const TEST_PATH = join(TEST_DIR, "missions.json");

function makeMission(overrides: Partial<Mission> = {}): Mission {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    title: overrides.title ?? "Test Mission",
    goal: overrides.goal ?? "Test goal",
    status: overrides.status ?? "active",
    milestones: overrides.milestones ?? [
      { id: "ms-1", title: "Step 1", status: "pending" },
      { id: "ms-2", title: "Step 2", status: "pending" },
    ],
    createdAt: overrides.createdAt ?? new Date().toISOString(),
    completedAt: overrides.completedAt,
  };
}

describe("mission-store", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    // Clean up any existing test file
    try {
      rmSync(TEST_PATH);
    } catch {
      // ignore
    }
  });

  afterEach(() => {
    try {
      rmSync(TEST_DIR, { recursive: true });
    } catch {
      // ignore
    }
  });

  // ── readMissions ────────────────────────────────────────────────────

  it("returns empty store when file doesn't exist", () => {
    const store = readMissions(TEST_PATH);
    expect(store.activeMissionId).toBeNull();
    expect(store.missions).toEqual([]);
  });

  it("returns empty store on corrupt JSON", () => {
    writeFileSync(TEST_PATH, "not json{{{", "utf-8");
    const store = readMissions(TEST_PATH);
    expect(store.missions).toEqual([]);
  });

  it("returns empty store on invalid shape", () => {
    writeFileSync(TEST_PATH, JSON.stringify({ foo: "bar" }), "utf-8");
    const store = readMissions(TEST_PATH);
    expect(store.missions).toEqual([]);
  });

  it("reads valid store", () => {
    const mission = makeMission();
    const store: MissionStore = {
      activeMissionId: mission.id,
      missions: [mission],
    };
    writeFileSync(TEST_PATH, JSON.stringify(store), "utf-8");

    const result = readMissions(TEST_PATH);
    expect(result.activeMissionId).toBe(mission.id);
    expect(result.missions).toHaveLength(1);
    expect(result.missions[0].title).toBe("Test Mission");
  });

  // ── writeMissions ───────────────────────────────────────────────────

  it("creates parent directories if needed", () => {
    const deepPath = join(TEST_DIR, "a", "b", "c", "missions.json");
    const store: MissionStore = { activeMissionId: null, missions: [] };
    writeMissions(store, deepPath);
    expect(existsSync(deepPath)).toBe(true);
  });

  it("atomic write: file is valid JSON even on success", () => {
    const mission = makeMission();
    const store: MissionStore = {
      activeMissionId: mission.id,
      missions: [mission],
    };
    writeMissions(store, TEST_PATH);
    const raw = readFileSync(TEST_PATH, "utf-8");
    expect(() => JSON.parse(raw)).not.toThrow();
    expect(JSON.parse(raw).missions).toHaveLength(1);
  });

  // ── addMission ──────────────────────────────────────────────────────

  it("adds a mission and sets it as active", () => {
    const mission = makeMission();
    const result = addMission(mission, TEST_PATH);
    expect(result).toBe(true);

    const store = readMissions(TEST_PATH);
    expect(store.activeMissionId).toBe(mission.id);
    expect(store.missions).toHaveLength(1);
  });

  it("rejects second mission while one is active", () => {
    const first = makeMission({ id: "first" });
    addMission(first, TEST_PATH);

    const second = makeMission({ id: "second" });
    const result = addMission(second, TEST_PATH);
    expect(result).toBe(false);

    const store = readMissions(TEST_PATH);
    expect(store.missions).toHaveLength(1);
  });

  // ── getActiveMission ────────────────────────────────────────────────

  it("returns null when no active mission", () => {
    expect(getActiveMission(TEST_PATH)).toBeNull();
  });

  it("returns the active mission", () => {
    const mission = makeMission({ title: "Active One" });
    addMission(mission, TEST_PATH);
    const active = getActiveMission(TEST_PATH);
    expect(active).not.toBeNull();
    expect(active!.title).toBe("Active One");
  });

  // ── updateMission ───────────────────────────────────────────────────

  it("updates a specific mission via updater function", () => {
    const mission = makeMission();
    addMission(mission, TEST_PATH);

    updateMission(
      mission.id,
      (m) => {
        m.milestones[0].status = "done";
      },
      TEST_PATH,
    );

    const store = readMissions(TEST_PATH);
    expect(store.missions[0].milestones[0].status).toBe("done");
  });

  it("no-ops for non-existent mission ID", () => {
    const mission = makeMission();
    addMission(mission, TEST_PATH);

    // Should not throw
    updateMission(
      "non-existent",
      (m) => {
        m.title = "changed";
      },
      TEST_PATH,
    );

    const store = readMissions(TEST_PATH);
    expect(store.missions[0].title).toBe("Test Mission");
  });

  it("updater can modify store-level properties like activeMissionId", () => {
    const mission = makeMission();
    addMission(mission, TEST_PATH);

    // Verify active before
    expect(readMissions(TEST_PATH).activeMissionId).toBe(mission.id);

    // Use store param to clear activeMissionId
    updateMission(
      mission.id,
      (m, store) => {
        m.status = "completed";
        m.completedAt = new Date().toISOString();
        store.activeMissionId = null;
      },
      TEST_PATH,
    );

    const result = readMissions(TEST_PATH);
    expect(result.activeMissionId).toBeNull();
    expect(result.missions[0].status).toBe("completed");
  });

  // ── pruneCompleted ──────────────────────────────────────────────────

  it("prunes completed missions older than N days", () => {
    const old = makeMission({
      id: "old",
      status: "completed",
      completedAt: new Date(
        Date.now() - 100 * 24 * 60 * 60 * 1000,
      ).toISOString(),
    });
    const recent = makeMission({
      id: "recent",
      status: "completed",
      completedAt: new Date().toISOString(),
    });
    const active = makeMission({ id: "active", status: "active" });

    const store: MissionStore = {
      activeMissionId: "active",
      missions: [old, recent, active],
    };
    writeMissions(store, TEST_PATH);

    const pruned = pruneCompleted(90, TEST_PATH);
    expect(pruned).toBe(1);

    const result = readMissions(TEST_PATH);
    expect(result.missions).toHaveLength(2);
    expect(result.missions.map((m) => m.id)).toContain("recent");
    expect(result.missions.map((m) => m.id)).toContain("active");
  });

  it("returns 0 when nothing to prune", () => {
    const store: MissionStore = { activeMissionId: null, missions: [] };
    writeMissions(store, TEST_PATH);
    expect(pruneCompleted(90, TEST_PATH)).toBe(0);
  });
});
