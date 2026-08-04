import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    renameSync: vi.fn(),
  };
});

vi.mock("node:os", () => ({
  homedir: () => "/mock-home",
}));

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  getSettingsPath,
  resolveSettings,
  toggleQuietMode,
  updateDailyCostGoal,
  updateSessionCostCap,
  updateSessionTag,
  updateSmartRouting,
} from "../settings.js";

const mockExists = vi.mocked(existsSync);
const mockRead = vi.mocked(readFileSync);
const mockWrite = vi.mocked(writeFileSync);

/**
 * Wire up a "virtual filesystem" so writes are readable on next call.
 * The update functions do: readPersisted -> mutate -> writePersisted -> resolveSettings -> readPersisted.
 * We need the second readPersisted to see what was written.
 */
function wireWriteThrough() {
  let stored: string | null = null;
  mockWrite.mockImplementation((_path, data) => {
    stored = data as string;
  });
  mockRead.mockImplementation(() => {
    if (stored !== null) return stored;
    throw new Error("ENOENT");
  });
  mockExists.mockImplementation(() => stored !== null);
}

/** Pre-seed the virtual fs with initial settings. */
function seedSettings(data: Record<string, unknown>) {
  let stored: string = JSON.stringify({ version: 1, ...data });
  mockExists.mockImplementation(() => true);
  mockRead.mockImplementation(() => stored);
  mockWrite.mockImplementation((_path, d) => {
    stored = d as string;
  });
}

describe("settings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Clear env vars
    delete process.env.CANDELA_SMART_ROUTING;
    delete process.env.CANDELA_DAILY_GOAL;
    delete process.env.CANDELA_QUIET;
    delete process.env.CANDELA_SESSION_CAP;
    delete process.env.CANDELA_ROUTING_THRESHOLD;
    delete process.env.CANDELA_ROUTING_SAVINGS_THRESHOLD;
  });

  describe("resolveSettings", () => {
    it("returns defaults when no file exists", () => {
      mockExists.mockReturnValue(false);
      const settings = resolveSettings();
      expect(settings.smartRouting.enabled).toBe(false);
      expect(settings.smartRouting.budgetThreshold).toBe(0.7);
      expect(settings.smartRouting.savingsThreshold).toBe(0.5);
      expect(settings.crossPromoShown).toBe(0);
      expect(settings.dailyCostGoal).toBeNull();
      expect(settings.quietMode).toBe(false);
      expect(settings.sessionCostCap).toBeNull();
      expect(settings.sessionTag).toBeNull();
    });

    it("merges persisted settings with defaults", () => {
      mockExists.mockReturnValue(true);
      mockRead.mockReturnValue(
        JSON.stringify({
          version: 1,
          smartRouting: { enabled: true },
          dailyCostGoal: 25,
        }),
      );
      const settings = resolveSettings();
      expect(settings.smartRouting.enabled).toBe(true);
      expect(settings.smartRouting.budgetThreshold).toBe(0.7); // default
      expect(settings.dailyCostGoal).toBe(25);
    });

    it("env vars take priority over persisted", () => {
      mockExists.mockReturnValue(true);
      mockRead.mockReturnValue(
        JSON.stringify({ version: 1, dailyCostGoal: 25, quietMode: false }),
      );
      process.env.CANDELA_DAILY_GOAL = "50";
      process.env.CANDELA_QUIET = "true";
      const settings = resolveSettings();
      expect(settings.dailyCostGoal).toBe(50);
      expect(settings.quietMode).toBe(true);
    });

    it("handles malformed settings file gracefully", () => {
      mockExists.mockReturnValue(true);
      mockRead.mockReturnValue("not json");
      const settings = resolveSettings();
      expect(settings.smartRouting.enabled).toBe(false);
    });
  });

  describe("getSettingsPath", () => {
    it("returns path under mock home", () => {
      expect(getSettingsPath()).toContain("/mock-home/");
      expect(getSettingsPath()).toContain("candela-settings.json");
    });
  });

  describe("updateDailyCostGoal", () => {
    it("sets a goal and persists", () => {
      wireWriteThrough();
      const result = updateDailyCostGoal(20);
      expect(result.dailyCostGoal).toBe(20);
      expect(mockWrite).toHaveBeenCalled();
    });

    it("clears goal when null", () => {
      seedSettings({ dailyCostGoal: 20 });
      const result = updateDailyCostGoal(null);
      expect(result.dailyCostGoal).toBeNull();
    });

    it("clamps negative values to 0", () => {
      wireWriteThrough();
      const result = updateDailyCostGoal(-5);
      expect(result.dailyCostGoal).toBe(0);
    });
  });

  describe("toggleQuietMode", () => {
    it("enables quiet mode when currently off", () => {
      wireWriteThrough();
      const result = toggleQuietMode();
      expect(result.quietMode).toBe(true);
      expect(mockWrite).toHaveBeenCalled();
    });

    it("disables quiet mode when currently on", () => {
      seedSettings({ quietMode: true });
      const result = toggleQuietMode();
      expect(result.quietMode).toBe(false);
    });
  });

  describe("updateSessionCostCap", () => {
    it("sets a cap and persists", () => {
      wireWriteThrough();
      const result = updateSessionCostCap(10);
      expect(result.sessionCostCap).toBe(10);
      expect(mockWrite).toHaveBeenCalled();
    });

    it("clears cap when null", () => {
      seedSettings({ sessionCostCap: 10 });
      const result = updateSessionCostCap(null);
      expect(result.sessionCostCap).toBeNull();
    });

    it("clamps negative values to 0", () => {
      wireWriteThrough();
      const result = updateSessionCostCap(-3);
      expect(result.sessionCostCap).toBe(0);
    });

    it("respects env var override", () => {
      wireWriteThrough();
      process.env.CANDELA_SESSION_CAP = "25";
      const result = updateSessionCostCap(10);
      // Env var takes priority in resolve
      expect(result.sessionCostCap).toBe(25);
    });
  });

  describe("updateSessionTag", () => {
    it("sets a tag and persists", () => {
      wireWriteThrough();
      const result = updateSessionTag("debugging");
      expect(result.sessionTag).toBe("debugging");
      expect(mockWrite).toHaveBeenCalled();
    });

    it("trims whitespace", () => {
      wireWriteThrough();
      const result = updateSessionTag("  refactoring  ");
      expect(result.sessionTag).toBe("refactoring");
    });

    it("clears tag when null", () => {
      seedSettings({ sessionTag: "old" });
      const result = updateSessionTag(null);
      expect(result.sessionTag).toBeNull();
    });

    it("clears tag when empty string", () => {
      wireWriteThrough();
      const result = updateSessionTag("");
      expect(result.sessionTag).toBeNull();
    });
  });

  describe("updateSmartRouting", () => {
    it("updates routing settings and persists", () => {
      wireWriteThrough();
      const result = updateSmartRouting({ enabled: true });
      expect(result.smartRouting.enabled).toBe(true);
      expect(mockWrite).toHaveBeenCalled();
    });

    it("preserves unset routing fields as defaults", () => {
      wireWriteThrough();
      const result = updateSmartRouting({ enabled: true });
      expect(result.smartRouting.budgetThreshold).toBe(0.7);
      expect(result.smartRouting.savingsThreshold).toBe(0.5);
    });
  });
});
