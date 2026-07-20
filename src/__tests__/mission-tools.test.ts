import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeMissions } from "../mission-store.js";
import { createMissionTools, formatMilestoneList } from "../mission-tools.js";
import type { MissionStore } from "../types.js";

// Use a temp directory for all tests
const TEST_DIR = join(tmpdir(), `candela-mission-tools-${process.pid}`);
const TEST_PATH = join(TEST_DIR, "missions.json");

function makeContext() {
  return {
    sessionID: "test-session",
    messageID: "test-message",
    agent: "code",
    directory: "/tmp/test",
    worktree: "/tmp/test",
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {},
  };
}

function makeMockClient() {
  return {
    session: {
      create: vi.fn().mockResolvedValue({ id: "child-session-123" }),
      abort: vi.fn().mockResolvedValue(undefined),
    },
  };
}

describe("mission-tools", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
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

  // ── formatMilestoneList ─────────────────────────────────────────────

  it("formats milestones with status icons", () => {
    const result = formatMilestoneList([
      { id: "1", title: "First", status: "done" },
      { id: "2", title: "Second", status: "working" },
      {
        id: "3",
        title: "Third",
        status: "pending",
        successCriteria: "tests pass",
      },
    ]);
    expect(result).toContain("✅ First");
    expect(result).toContain("▶ Second");
    expect(result).toContain("☐ Third — tests pass");
  });

  // ── mission_plan ────────────────────────────────────────────────────

  it("creates a mission with milestones", async () => {
    const client = makeMockClient();
    const tools = createMissionTools(client, TEST_PATH);

    const result = (await tools.mission_plan.execute(
      {
        goal: "Build a REST API",
        title: "REST API",
        milestones: [
          { title: "Design schema" },
          { title: "Implement endpoints", success_criteria: "all tests pass" },
          { title: "Add auth", test_command: "npm test" },
        ],
      },
      makeContext(),
    )) as { title: string; output: string };

    expect(result.title).toContain("REST API");
    expect(result.output).toContain("Design schema");
    expect(result.output).toContain("Implement endpoints");
    expect(result.output).toContain("mission_next");
  });

  it("rejects mission_plan when one is already active", async () => {
    const client = makeMockClient();
    const tools = createMissionTools(client, TEST_PATH);

    // Create first mission
    await tools.mission_plan.execute(
      {
        goal: "First",
        title: "First",
        milestones: [{ title: "Step 1" }],
      },
      makeContext(),
    );

    // Second should fail
    const result = (await tools.mission_plan.execute(
      {
        goal: "Second",
        title: "Second",
        milestones: [{ title: "Step 1" }],
      },
      makeContext(),
    )) as { title: string; output: string };

    expect(result.title).toBe("Mission Already Active");
    expect(result.output).toContain("mission_cancel");
  });

  // ── mission_next ────────────────────────────────────────────────────

  it("starts the next pending milestone", async () => {
    const client = makeMockClient();
    const tools = createMissionTools(client, TEST_PATH);

    await tools.mission_plan.execute(
      {
        goal: "Build API",
        title: "API",
        milestones: [{ title: "Design" }, { title: "Implement" }],
      },
      makeContext(),
    );

    const result = (await tools.mission_next.execute({}, makeContext())) as {
      title: string;
      output: string;
    };

    expect(result.title).toContain("Design");
    expect(result.output).toContain("Child session");
    expect(client.session.create).toHaveBeenCalled();
  });

  it("returns error when no active mission", async () => {
    const client = makeMockClient();
    const tools = createMissionTools(client, TEST_PATH);

    const result = (await tools.mission_next.execute({}, makeContext())) as {
      title: string;
    };

    expect(result.title).toBe("No Active Mission");
  });

  it("reverts milestone to pending on session creation failure", async () => {
    const client = makeMockClient();
    client.session.create.mockRejectedValue(new Error("session limit"));
    const tools = createMissionTools(client, TEST_PATH);

    await tools.mission_plan.execute(
      {
        goal: "Build API",
        title: "API",
        milestones: [{ title: "Design" }],
      },
      makeContext(),
    );

    const result = (await tools.mission_next.execute({}, makeContext())) as {
      title: string;
      output: string;
    };

    expect(result.title).toBe("Session Creation Failed");
    expect(result.output).toContain("session limit");

    // Verify milestone reverted to pending
    const status = (await tools.mission_status.execute({}, makeContext())) as {
      output: string;
    };
    expect(status.output).toContain("☐ Design");
  });

  // ── mission_validate ──────────────────────────────────────────────

  it("marks milestone as done when no test command", async () => {
    const client = makeMockClient();
    const tools = createMissionTools(client, TEST_PATH);

    await tools.mission_plan.execute(
      {
        goal: "Build API",
        title: "API",
        milestones: [{ title: "Design" }],
      },
      makeContext(),
    );

    // Start it first
    await tools.mission_next.execute({}, makeContext());

    const result = (await tools.mission_validate.execute(
      {},
      makeContext(),
    )) as { title: string; output: string };

    expect(result.title).toContain("✅");
    expect(result.output).toContain("done");
  });

  it("returns test command when milestone has one", async () => {
    const client = makeMockClient();
    const tools = createMissionTools(client, TEST_PATH);

    await tools.mission_plan.execute(
      {
        goal: "Build API",
        title: "API",
        milestones: [{ title: "Tests", test_command: "npm test" }],
      },
      makeContext(),
    );
    await tools.mission_next.execute({}, makeContext());

    const result = (await tools.mission_validate.execute(
      {},
      makeContext(),
    )) as { title: string; output: string };

    expect(result.title).toContain("Validating");
    expect(result.output).toContain("npm test");
  });

  // ── mission_status ────────────────────────────────────────────────

  it("shows progress with status icons", async () => {
    const client = makeMockClient();
    const tools = createMissionTools(client, TEST_PATH);

    await tools.mission_plan.execute(
      {
        goal: "Build API",
        title: "API Project",
        milestones: [{ title: "Step 1" }, { title: "Step 2" }],
      },
      makeContext(),
    );

    const result = (await tools.mission_status.execute({}, makeContext())) as {
      title: string;
      output: string;
    };

    expect(result.title).toContain("API Project");
    expect(result.title).toContain("0/2");
    expect(result.output).toContain("☐ Step 1");
    expect(result.output).toContain("☐ Step 2");
  });

  it("returns no active mission message", async () => {
    const client = makeMockClient();
    const tools = createMissionTools(client, TEST_PATH);

    const result = (await tools.mission_status.execute({}, makeContext())) as {
      title: string;
    };

    expect(result.title).toBe("No Active Mission");
  });

  // ── mission_cancel ────────────────────────────────────────────────

  it("cancels the active mission", async () => {
    const client = makeMockClient();
    const tools = createMissionTools(client, TEST_PATH);

    await tools.mission_plan.execute(
      {
        goal: "Build API",
        title: "API",
        milestones: [{ title: "Step 1" }],
      },
      makeContext(),
    );

    const result = (await tools.mission_cancel.execute({}, makeContext())) as {
      title: string;
      output: string;
    };

    expect(result.title).toBe("Mission Cancelled");

    // Verify no active mission remains
    const status = (await tools.mission_status.execute({}, makeContext())) as {
      title: string;
    };
    expect(status.title).toBe("No Active Mission");
  });

  it("aborts running child sessions on cancel", async () => {
    const client = makeMockClient();
    const tools = createMissionTools(client, TEST_PATH);

    await tools.mission_plan.execute(
      {
        goal: "Build API",
        title: "API",
        milestones: [{ title: "Step 1" }],
      },
      makeContext(),
    );

    // Start milestone (creates child session)
    await tools.mission_next.execute({}, makeContext());

    // Cancel
    await tools.mission_cancel.execute({}, makeContext());

    expect(client.session.abort).toHaveBeenCalledWith({
      sessionID: "child-session-123",
    });
  });

  // ── end-to-end flow ─────────────────────────────────────────────────

  it("completes a full mission lifecycle and clears activeMissionId", async () => {
    const client = makeMockClient();
    const tools = createMissionTools(client, TEST_PATH);

    // Plan
    await tools.mission_plan.execute(
      {
        goal: "Build API",
        title: "API",
        milestones: [{ title: "Design" }, { title: "Build" }],
      },
      makeContext(),
    );

    // Start + validate milestone 1
    await tools.mission_next.execute({}, makeContext());
    await tools.mission_validate.execute({}, makeContext());

    // Start + validate milestone 2
    await tools.mission_next.execute({}, makeContext());
    await tools.mission_validate.execute({}, makeContext());

    // Prove activeMissionId was cleared by creating a new mission
    const planResult = (await tools.mission_plan.execute(
      {
        goal: "New project",
        title: "New",
        milestones: [{ title: "Step 1" }],
      },
      makeContext(),
    )) as { title: string };

    // Should succeed, not "Mission Already Active"
    expect(planResult.title).toContain("New");
    expect(planResult.title).not.toBe("Mission Already Active");
  });

  // ── concurrent milestone guard ──────────────────────────────────────

  it("blocks mission_next when a milestone is already working", async () => {
    const client = makeMockClient();
    const tools = createMissionTools(client, TEST_PATH);

    await tools.mission_plan.execute(
      {
        goal: "Build API",
        title: "API",
        milestones: [{ title: "Step 1" }, { title: "Step 2" }],
      },
      makeContext(),
    );

    // Start first milestone
    await tools.mission_next.execute({}, makeContext());

    // Try to start second — should be blocked
    const result = (await tools.mission_next.execute({}, makeContext())) as {
      title: string;
    };

    expect(result.title).toBe("Milestone Already Active");
  });

  // ── mission_validate with status arg ────────────────────────────────

  it("marks milestone as done via status arg", async () => {
    const client = makeMockClient();
    const tools = createMissionTools(client, TEST_PATH);

    await tools.mission_plan.execute(
      {
        goal: "Build API",
        title: "API",
        milestones: [{ title: "Tests", test_command: "npm test" }],
      },
      makeContext(),
    );
    await tools.mission_next.execute({}, makeContext());

    const result = (await tools.mission_validate.execute(
      { status: "done" },
      makeContext(),
    )) as { title: string; output: string };

    expect(result.title).toContain("✅");
    expect(result.output).toContain("done");
  });

  it("marks milestone as failed via status arg", async () => {
    const client = makeMockClient();
    const tools = createMissionTools(client, TEST_PATH);

    await tools.mission_plan.execute(
      {
        goal: "Build API",
        title: "API",
        milestones: [{ title: "Tests", test_command: "npm test" }],
      },
      makeContext(),
    );
    await tools.mission_next.execute({}, makeContext());

    const result = (await tools.mission_validate.execute(
      { status: "failed" },
      makeContext(),
    )) as { title: string; output: string };

    expect(result.title).toContain("❌");
    expect(result.output).toContain("failed");
  });
});
