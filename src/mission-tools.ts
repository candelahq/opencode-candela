/**
 * Mission LLM tools — plan, next, validate, status, cancel.
 *
 * These tools give the AI agent structured mission orchestration:
 * decompose goals into milestones, dispatch child sessions,
 * validate results, and track progress.
 */

import { tool } from "@opencode-ai/plugin";
import {
  addMission,
  getActiveMission,
  updateMission,
} from "./mission-store.js";
import { MILESTONE_ICONS, type Milestone, type Mission } from "./types.js";

/** Format a milestone checklist for display. */
export function formatMilestoneList(milestones: Milestone[]): string {
  return milestones
    .map(
      (m, i) =>
        `${i + 1}. ${MILESTONE_ICONS[m.status]} ${m.title}${m.successCriteria ? ` — ${m.successCriteria}` : ""}`,
    )
    .join("\n");
}

/** Compact progress line: "(3/5 done)" */
function progressLine(milestones: Milestone[]): string {
  const done = milestones.filter((m) => m.status === "done").length;
  return `(${done}/${milestones.length} done)`;
}

/**
 * Create mission orchestration tools.
 *
 * @param client - The OpenCode SDK client (for session management)
 * @param storePath - Override mission store path (for testing)
 */
export function createMissionTools(
  client: {
    session: {
      create: (input: {
        body: { parentID?: string; agent?: string };
      }) => Promise<{ id: string }>;
      abort: (input: { sessionID: string }) => Promise<void>;
    };
  },
  storePath?: string,
) {
  // ── mission_plan ──────────────────────────────────────────────────────

  const missionPlan = tool({
    description:
      "Decompose a user goal into ordered milestones with success criteria. " +
      "Creates a new mission and sets it as active. " +
      "Only one mission can be active at a time — cancel the current one first if needed. " +
      "Each milestone should be a discrete, testable unit of work.",
    args: {
      goal: tool.schema.string().describe("The user's goal to decompose"),
      title: tool.schema.string().describe("Short mission title"),
      milestones: tool.schema
        .array(
          tool.schema.object({
            title: tool.schema.string().describe("Milestone title"),
            success_criteria: tool.schema
              .string()
              .optional()
              .describe("How to know it's done"),
            test_command: tool.schema
              .string()
              .optional()
              .describe("Shell command to validate (e.g. npm test)"),
          }),
        )
        .describe("Ordered list of milestones"),
    },
    async execute(args) {
      const existing = getActiveMission(storePath);
      if (existing) {
        return {
          title: "Mission Already Active",
          output: `There's already an active mission: "${existing.title}" ${progressLine(existing.milestones)}.\nCancel it with \`mission_cancel\` first.`,
        };
      }

      const mission: Mission = {
        id: crypto.randomUUID(),
        title: args.title,
        goal: args.goal,
        status: "active",
        milestones: args.milestones.map((m) => ({
          id: crypto.randomUUID(),
          title: m.title,
          successCriteria: m.success_criteria,
          testCommand: m.test_command,
          status: "pending",
        })),
        createdAt: new Date().toISOString(),
        lastActivityAt: new Date().toISOString(),
      };

      const added = addMission(mission, storePath);
      if (!added) {
        return {
          title: "Failed to Create Mission",
          output: "Could not save mission. A mission may already be active.",
        };
      }

      return {
        title: `Mission: ${mission.title}`,
        output: [
          `## 📋 ${mission.title}`,
          "",
          `**Goal:** ${mission.goal}`,
          "",
          "### Milestones",
          formatMilestoneList(mission.milestones),
          "",
          `Use \`mission_next\` to start the first milestone.`,
        ].join("\n"),
      };
    },
  });

  // ── mission_next ──────────────────────────────────────────────────────

  const missionNext = tool({
    description:
      "Start the next pending milestone in the active mission. " +
      "Marks it as 'working' and spawns a child session with a focused prompt. " +
      "The child session works on just this milestone.",
    args: {},
    async execute(_args, context) {
      const mission = getActiveMission(storePath);
      if (!mission) {
        return {
          title: "No Active Mission",
          output: "No active mission. Create one with `mission_plan`.",
        };
      }

      // Prevent concurrent milestones
      const activeMilestone = mission.milestones.find(
        (m) => m.status === "working" || m.status === "validating",
      );
      if (activeMilestone) {
        return {
          title: "Milestone Already Active",
          output: `There is already an active milestone: "${activeMilestone.title}" (${activeMilestone.status}).\nComplete or validate it before starting the next one.`,
        };
      }

      const milestone = mission.milestones.find((m) => m.status === "pending");
      if (!milestone) {
        const allDone = mission.milestones.every((m) => m.status === "done");
        return {
          title: allDone ? "Mission Complete" : "No Pending Milestones",
          output: allDone
            ? `All milestones in "${mission.title}" are done! 🎉`
            : `No pending milestones. Some may have failed — check \`mission_status\`.`,
        };
      }

      // Mark as working before spawning session
      updateMission(
        mission.id,
        (m) => {
          const ms = m.milestones.find((x) => x.id === milestone.id);
          if (ms) ms.status = "working";
          m.lastActivityAt = new Date().toISOString();
        },
        storePath,
      );

      try {
        const session = await client.session.create({
          body: {
            parentID: context.sessionID,
            agent: "code",
          },
        });

        // Record session ID on milestone
        updateMission(
          mission.id,
          (m) => {
            const ms = m.milestones.find((x) => x.id === milestone.id);
            if (ms) ms.sessionId = session.id;
          },
          storePath,
        );

        return {
          title: `▶ ${milestone.title}`,
          output: [
            `Started milestone: **${milestone.title}**`,
            "",
            milestone.successCriteria
              ? `**Success criteria:** ${milestone.successCriteria}`
              : "",
            milestone.testCommand
              ? `**Test command:** \`${milestone.testCommand}\``
              : "",
            "",
            `Child session: \`${session.id.slice(0, 8)}\``,
            "",
            `When done, run \`mission_validate\` to check results.`,
          ]
            .filter(Boolean)
            .join("\n"),
        };
      } catch (err) {
        // Revert milestone to pending on session creation failure
        updateMission(
          mission.id,
          (m) => {
            const ms = m.milestones.find((x) => x.id === milestone.id);
            if (ms) ms.status = "pending";
          },
          storePath,
        );

        return {
          title: "Session Creation Failed",
          output: `Failed to spawn child session for "${milestone.title}": ${err instanceof Error ? err.message : "unknown error"}`,
        };
      }
    },
  });

  // ── mission_validate ──────────────────────────────────────────────────

  const missionValidate = tool({
    description:
      "Validate a milestone by running its test command. " +
      "If the milestone has no test command, it's marked as done. " +
      "Validates the first 'working' or 'validating' milestone by default. " +
      "Pass status='done' or status='failed' to record the test result.",
    args: {
      milestone_id: tool.schema
        .string()
        .optional()
        .describe(
          "Specific milestone ID to validate (defaults to first working/validating)",
        ),
      status: tool.schema
        .enum(["done", "failed"])
        .optional()
        .describe(
          "The validation result: 'done' if tests passed, 'failed' if they failed",
        ),
    },
    async execute(args) {
      const mission = getActiveMission(storePath);
      if (!mission) {
        return {
          title: "No Active Mission",
          output: "No active mission.",
        };
      }

      const milestone = args.milestone_id
        ? mission.milestones.find((m) => m.id === args.milestone_id)
        : mission.milestones.find(
            (m) => m.status === "working" || m.status === "validating",
          );

      if (!milestone) {
        return {
          title: "No Working Milestone",
          output:
            "No milestone is currently being worked on. Use `mission_next` to start one.",
        };
      }

      // If status is provided, apply it directly (agent reporting test result)
      if (args.status) {
        const newStatus = args.status;
        updateMission(
          mission.id,
          (m, store) => {
            const ms = m.milestones.find((x) => x.id === milestone.id);
            if (ms) ms.status = newStatus;
            m.lastActivityAt = new Date().toISOString();

            // Check if all milestones are done → complete mission
            if (
              newStatus === "done" &&
              m.milestones.every((x) => x.status === "done")
            ) {
              m.status = "completed";
              m.completedAt = new Date().toISOString();
              store.activeMissionId = null;
            }
          },
          storePath,
        );

        const icon = newStatus === "done" ? "✅" : "❌";
        return {
          title: `${icon} ${milestone.title}`,
          output: `Milestone "${milestone.title}" marked as ${newStatus}.`,
        };
      }

      if (!milestone.testCommand) {
        // No test command — mark as done directly
        updateMission(
          mission.id,
          (m, store) => {
            const ms = m.milestones.find((x) => x.id === milestone.id);
            if (ms) ms.status = "done";
            m.lastActivityAt = new Date().toISOString();

            // Check if all milestones are done → complete mission
            if (m.milestones.every((x) => x.status === "done")) {
              m.status = "completed";
              m.completedAt = new Date().toISOString();
              store.activeMissionId = null;
            }
          },
          storePath,
        );

        return {
          title: `✅ ${milestone.title}`,
          output: `Milestone "${milestone.title}" marked as done (no test command).`,
        };
      }

      // Mark as validating
      updateMission(
        mission.id,
        (m) => {
          const ms = m.milestones.find((x) => x.id === milestone.id);
          if (ms) ms.status = "validating";
          m.lastActivityAt = new Date().toISOString();
        },
        storePath,
      );

      return {
        title: `🔍 Validating: ${milestone.title}`,
        output: [
          `Run this test command to validate:`,
          "",
          "```",
          milestone.testCommand,
          "```",
          "",
          `Then call \`mission_validate\` with status='done' or status='failed'.`,
        ].join("\n"),
      };
    },
  });

  // ── mission_status ────────────────────────────────────────────────────

  const missionStatus = tool({
    description:
      "Show the current mission progress with milestone status icons. " +
      "Returns a compact view of all milestones and their states.",
    args: {},
    async execute() {
      const mission = getActiveMission(storePath);
      if (!mission) {
        return {
          title: "No Active Mission",
          output: "No active mission. Create one with `mission_plan`.",
        };
      }

      const done = mission.milestones.filter((m) => m.status === "done").length;
      const total = mission.milestones.length;

      return {
        title: `📋 ${mission.title} (${done}/${total})`,
        output: [
          `## 📋 ${mission.title} ${progressLine(mission.milestones)}`,
          "",
          formatMilestoneList(mission.milestones),
          "",
          `**Goal:** ${mission.goal}`,
        ].join("\n"),
      };
    },
  });

  // ── mission_cancel ────────────────────────────────────────────────────

  const missionCancel = tool({
    description:
      "Cancel the active mission. Aborts any running child sessions " +
      "and marks the mission as cancelled.",
    args: {},
    async execute() {
      const mission = getActiveMission(storePath);
      if (!mission) {
        return {
          title: "No Active Mission",
          output: "No active mission to cancel.",
        };
      }

      // Abort running child sessions (working OR validating)
      const activeMilestones = mission.milestones.filter(
        (m) =>
          (m.status === "working" || m.status === "validating") && m.sessionId,
      );
      for (const ms of activeMilestones) {
        try {
          await client.session.abort({
            sessionID: ms.sessionId!,
          });
        } catch {
          // Best-effort abort
        }
      }

      // Update mission status and clear active in one atomic write
      updateMission(
        mission.id,
        (m, store) => {
          m.status = "cancelled";
          m.completedAt = new Date().toISOString();
          m.lastActivityAt = new Date().toISOString();
          store.activeMissionId = null;
        },
        storePath,
      );

      return {
        title: "Mission Cancelled",
        output: `Mission "${mission.title}" has been cancelled.${activeMilestones.length > 0 ? ` Aborted ${activeMilestones.length} running session(s).` : ""}`,
      };
    },
  });

  return {
    mission_plan: missionPlan,
    mission_next: missionNext,
    mission_validate: missionValidate,
    mission_status: missionStatus,
    mission_cancel: missionCancel,
  };
}
