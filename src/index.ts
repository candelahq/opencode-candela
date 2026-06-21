/**
 * opencode-candela — OpenCode plugin for Candela LLM observability.
 *
 * Hooks into OpenCode session lifecycle to provide:
 * - Session-scoped cost tracking with idle toasts
 * - Budget remaining warnings with reset countdown
 * - Active grant display with expiry warnings
 * - Candela proxy URL injection into shells
 * - Rich cost + budget context injection during session compaction
 * - Session attribution headers for cost tracking (chat.headers)
 * - Cost-aware model parameter adjustment (chat.params)
 * - Deterministic policy gates blocking destructive operations (tool.execute.before)
 * - Mission orchestration: structured plan → execute → validate → next (tools)
 *
 * Gracefully no-ops if Candela is not running.
 */

import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin/tool";
import { CandelaClient } from "./candela-client.js";
import type { BudgetInfo, GrantInfo } from "./candela-client.js";
import { discoverCandelaUrl } from "./discover.js";
import {
  readMissionStore,
  writeMissionStore,
  pruneMissions,
  createMission,
  getActiveMission,
  getNextMilestone,
  updateMilestone,
  cancelMission,
  formatMissionProgress,
} from "./missions.js";
import type { MissionStore } from "./types.js";

/** Format USD with appropriate precision */
function formatCost(usd: number): string {
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

/** Format token count with K/M suffixes */
function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}K`;
  return String(count);
}

/** Budget urgency emoji based on usage fraction. */
function budgetEmoji(fraction: number): string {
  if (fraction >= 0.9) return "🔴";
  if (fraction >= 0.6) return "🟡";
  return "🟢";
}

/** Format a grant for display: "🎁 $42.10 remaining (Hackathon — expires May 20)" */
function formatGrant(g: GrantInfo): string {
  const parts = [`🎁 ${formatCost(g.remainingUsd)} remaining`];
  if (g.reason) parts.push(`(${g.reason}`);
  if (g.expiresAt) {
    const expiry = g.expiresAt.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });
    parts.push(g.reason ? ` — expires ${expiry})` : `(expires ${expiry})`);
  } else if (g.reason) {
    parts.push(")");
  }
  return parts.join("");
}

export const CandelaPlugin: Plugin = async ({ client, directory, $ }) => {
  const candelaUrl = discoverCandelaUrl();
  const candela = new CandelaClient(candelaUrl);

  // Check if Candela is alive on init
  const alive = await candela.isAlive();
  if (alive) {
    // Single call to get usage + budget + grants
    const data = await candela.getDashboardData(24);

    const connectMsg = `Connected to Candela at ${candelaUrl}`;
    await client.app.log({
      body: {
        service: "opencode-candela",
        level: "info",
        message: connectMsg,
      },
    });

    // Show budget status on startup
    if (data?.budget) {
      const b = data.budget;
      const emoji = budgetEmoji(b.usedFraction);
      await client.app.log({
        body: {
          service: "opencode-candela",
          level: b.isNearLimit ? "warn" : "info",
          message: `${emoji} Budget: ${b.percentUsed.toFixed(0)}% used — ${formatCost(b.remainingUsd)} remaining${b.resetLabel ? ` (${b.resetLabel})` : ""}`,
        },
      });
    }

    // Show active grants on startup
    for (const g of data?.activeGrants ?? []) {
      if (g.isExhausted) continue;
      await client.app.log({
        body: {
          service: "opencode-candela",
          level: g.isExpiringSoon ? "warn" : "info",
          message: formatGrant(g),
        },
      });
    }
  } else {
    await client.app.log({
      body: {
        service: "opencode-candela",
        level: "debug",
        message: `Candela not detected at ${candelaUrl} — plugin will no-op`,
      },
    });
  }

  // Track per-session state
  let sessionStartTime: Date | null = null;
  let sessionToolCalls = 0;

  // ── Mission init ──────────────────────────────────────────────────────
  const missionStore = readMissionStore();
  const { pruned } = pruneMissions(missionStore);
  if (pruned > 0) {
    await client.app.log({
      body: {
        service: "opencode-candela",
        level: "debug",
        message: `Pruned ${pruned} mission${pruned === 1 ? "" : "s"} older than 90 days`,
      },
    });
  }
  const activeMission = getActiveMission(missionStore);
  if (activeMission) {
    await client.app.log({
      body: {
        service: "opencode-candela",
        level: "info",
        message: `Active mission: ${activeMission.goal} (${activeMission.milestones.filter(m => m.status === "done").length}/${activeMission.milestones.length} milestones)`,
      },
    });
  }

  // ── Policy configuration ─────────────────────────────────────────────────
  // Blocked file patterns (policy gates) — add project-specific patterns
  // via CANDELA_BLOCKED_PATTERNS env var (comma-separated globs).
  const defaultBlockedPatterns = [
    "pricing.yaml",
    "pricing.json",
    ".env",
    ".env.production",
  ];
  const extraPatterns = (process.env.CANDELA_BLOCKED_PATTERNS ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  const blockedPatterns = [...defaultBlockedPatterns, ...extraPatterns];

  const blockedCommands = [
    "rm -rf /",
    "drop table",
    "drop database",
    "truncate table",
    "format c:",
  ];

  return {
    /**
     * Inject Candela environment variables into all shell executions.
     * This ensures any subprocess (test runners, scripts, etc.) can
     * discover the Candela proxy.
     */
    "shell.env": async (_input, output) => {
      if (!alive) return;
      output.env.CANDELA_PROXY_URL = candelaUrl;
      output.env.OPENAI_BASE_URL = `${candelaUrl}/proxy/openai/v1`;
    },

    /**
     * Tag every LLM request with session metadata for cost attribution.
     * Candela uses these headers to break down costs per session/agent.
     */
    "chat.headers": async (input, output) => {
      if (!alive) return;
      output.headers["X-Candela-Session"] = input.sessionID;
      output.headers["X-Candela-Agent"] = input.agent;
      output.headers["X-Candela-Model"] =
        `${input.provider.info.id}/${input.model.id}`;
      output.headers["X-Candela-Source"] = "opencode";

      // Mission cost attribution (#5)
      const mission = getActiveMission(missionStore);
      if (mission) {
        output.headers["X-Candela-Mission-Id"] = mission.id;
        const working = mission.milestones.find((m) => m.status === "working");
        if (working) {
          output.headers["X-Candela-Milestone-Id"] = working.id;
        }
      }
    },

    /**
     * Cost-aware model parameter adjustment.
     * When budget is running low, limit output tokens and reduce temperature
     * to control costs. When budget is critical, apply aggressive limits.
     */
    "chat.params": async (_input, output) => {
      if (!alive) return;

      const data = await candela.getDashboardData(1);
      if (!data?.budget) return;

      const { usedFraction } = data.budget;

      // Critical: >95% budget used — hard cap output tokens
      if (usedFraction > 0.95) {
        output.maxOutputTokens = Math.min(
          output.maxOutputTokens ?? 8192,
          2048
        );
        output.temperature = Math.min(output.temperature, 0.2);
        await client.app.log({
          body: {
            service: "opencode-candela",
            level: "warn",
            message: `🔴 Budget critical (${(usedFraction * 100).toFixed(0)}%) — output capped at 2K tokens`,
          },
        });
      }
      // Warning: >80% budget used — reduce temperature for focus
      else if (usedFraction > 0.8) {
        output.temperature = Math.min(output.temperature, 0.4);
      }
    },

    /**
     * Deterministic policy gates — block destructive operations before
     * they reach the tool. Similar to Factory Droid's PreToolUse hooks.
     *
     * - Blocks file edits to sensitive paths (pricing configs, .env files)
     * - Blocks destructive shell commands (rm -rf /, DROP TABLE, etc.)
     * - Configurable via CANDELA_BLOCKED_PATTERNS env var
     */
    "tool.execute.before": async (input, output) => {
      // Policy gate: block writes to sensitive files
      if (
        input.tool === "file_edit" ||
        input.tool === "file_write" ||
        input.tool === "write" ||
        input.tool === "edit"
      ) {
        const filePath: string =
          output.args?.path ?? output.args?.file ?? output.args?.filePath ?? "";
        const matchedPattern = blockedPatterns.find((pattern) =>
          filePath.toLowerCase().includes(pattern.toLowerCase())
        );
        if (matchedPattern) {
          await client.app.log({
            body: {
              service: "opencode-candela",
              level: "warn",
              message: `🛡️ Policy blocked: ${input.tool} on "${filePath}" (matches "${matchedPattern}")`,
            },
          });
          throw new Error(
            `🛡️ Blocked by Candela policy: edits to files matching "${matchedPattern}" ` +
              `are not allowed. Edit this file manually and run tests.`
          );
        }
      }

      // Policy gate: block destructive shell commands
      if (input.tool === "shell" || input.tool === "bash" || input.tool === "terminal") {
        const cmd: string = String(
          output.args?.command ?? output.args?.cmd ?? output.args?.input ?? ""
        );
        const matchedCmd = blockedCommands.find((blocked) =>
          cmd.toLowerCase().includes(blocked.toLowerCase())
        );
        if (matchedCmd) {
          await client.app.log({
            body: {
              service: "opencode-candela",
              level: "warn",
              message: `🛡️ Policy blocked: shell command containing "${matchedCmd}"`,
            },
          });
          throw new Error(
            `🛡️ Blocked by Candela policy: commands containing "${matchedCmd}" ` +
              `are not allowed. Run this command manually if intended.`
          );
        }
      }
    },

    /**
     * Listen for events to track session lifecycle and show cost toasts.
     */
    event: async ({ event }) => {
      if (!alive) return;

      // Track session start — clear cache for fresh data
      if (event.type === "session.created") {
        sessionStartTime = new Date();
        sessionToolCalls = 0;
        candela.resetHealth();
        candela.invalidateCache();
      }

      // Show cost + budget summary when session goes idle
      if (event.type === "session.idle" && sessionStartTime) {
        const data = await candela.getDashboardData(1); // last hour
        if (data && data.usage.requestCount > 0) {
          const duration = Math.round(
            (Date.now() - sessionStartTime.getTime()) / 1000
          );
          const minutes = Math.floor(duration / 60);
          const seconds = duration % 60;

          // Build summary with budget context
          const parts = [
            `${formatTokens(data.usage.totalTokens)} tokens`,
            formatCost(data.usage.totalCostUsd),
            `${data.usage.requestCount} calls`,
            `${minutes}m${seconds}s`,
          ];

          // Add budget indicator if available
          if (data.budget) {
            const emoji = budgetEmoji(data.budget.usedFraction);
            parts.push(`${emoji}${data.budget.percentUsed.toFixed(0)}%`);
          }

          const summary = parts.join(" · ");

          try {
            await $`osascript -e ${"display notification \"" + summary + "\" with title \"Candela\" subtitle \"Session Summary\""}`;
          } catch {
            // Non-macOS or notification permission denied — log instead
            await client.app.log({
              body: {
                service: "opencode-candela",
                level: "info",
                message: `📊 Session: ${summary}`,
              },
            });
          }
        }

        // Budget warning toast (separate notification for visibility)
        if (data?.budget && data.budget.percentUsed > 90) {
          const b = data.budget;
          const budgetMsg = `${formatCost(b.remainingUsd)} remaining (${b.percentUsed.toFixed(0)}% used)${b.resetLabel ? ` — ${b.resetLabel}` : ""}`;
          try {
            await $`osascript -e ${"display notification \"" + budgetMsg + "\" with title \"Candela\" subtitle \"⚠️ Budget Warning\""}`;
          } catch {
            await client.app.log({
              body: {
                service: "opencode-candela",
                level: "warn",
                message: `⚠️ Budget: ${budgetMsg}`,
              },
            });
          }
        }
      }
    },

    /**
     * Track tool executions for session attribution.
     */
    "tool.execute.after": async () => {
      sessionToolCalls++;
    },

    /**
     * Inject cost + budget context into compaction summaries so the LLM
     * retains awareness of spending and budget constraints.
     */
    "experimental.session.compacting": async (_input, output) => {
      if (!alive) return;

      const data = await candela.getDashboardData(4); // last 4 hours
      if (data && data.usage.requestCount > 0) {
        // Model breakdown (from dedicated endpoint for full detail)
        const models = data.models.length > 0 ? data.models : (await candela.getModelBreakdown(4) ?? []);
        const modelLines = models
          .slice(0, 5)
          .map(
            (m) =>
              `  - ${m.model} (${m.provider}): ${formatTokens(m.totalTokens)} tokens, ${formatCost(m.totalCostUsd)}`
          )
          .join("\n");

        const sections: string[] = [
          `## Candela Cost Context`,
          `This session has used ${formatTokens(data.usage.totalTokens)} tokens ` +
            `(${formatCost(data.usage.totalCostUsd)}) across ${data.usage.requestCount} LLM calls.`,
        ];

        if (modelLines) {
          sections.push(`\nModel breakdown:\n${modelLines}`);
        }

        // Budget context — rich data for the LLM to pace itself
        if (data.budget) {
          const b = data.budget;
          sections.push(
            `\n## Candela Budget Context`,
            `Daily budget: ${formatCost(b.remainingUsd)} remaining of ${formatCost(b.limitUsd)} (${b.percentUsed.toFixed(0)}% used${b.resetLabel ? `, ${b.resetLabel}` : ""})`,
          );
        }

        // Grant context
        for (const g of data.activeGrants) {
          if (g.isExhausted) continue;
          const expiryNote = g.expiresAt
            ? ` — expires ${g.expiresAt.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`
            : "";
          sections.push(
            `Active grant: ${formatCost(g.remainingUsd)} of ${formatCost(g.amountUsd)} (${g.reason || "Bonus"}${expiryNote})`
          );
        }

        if (data.totalRemainingUsd !== null) {
          sections.push(`Total available: ${formatCost(data.totalRemainingUsd)}`);
        }

        sections.push(
          `Be cost-conscious — ${data.budget?.resetLabel ? `daily budget ${data.budget.resetLabel}.` : "prefer concise responses when possible."}`
        );

        output.context.push(sections.join("\n"));
      }
    },

    /**
     * Inject compact mission context into the system prompt so the LLM
     * knows about active missions and available mission tools.
     */
    "experimental.chat.system.transform": async (_input, output) => {
      const mission = getActiveMission(missionStore);
      if (!mission) return;
      output.system.push(
        `## Active Mission\n${formatMissionProgress(mission)}\n\n` +
          `Tools: mission_plan, mission_next, mission_validate, mission_status, mission_cancel`,
      );
    },

    // ── Mission Tools (#4) ─────────────────────────────────────────────
    tool: {
      /**
       * Decompose a goal into ordered milestones with success criteria.
       */
      mission_plan: tool({
        description:
          "Plan a mission by decomposing a goal into ordered milestones. " +
          "Each milestone should have a clear title, description, and optionally " +
          "a test command for validation and relevant file paths.",
        args: {
          goal: tool.schema.string().describe("The user's goal to accomplish"),
          milestones: tool.schema
            .array(
              tool.schema.object({
                title: tool.schema.string().describe("Short milestone title"),
                description: tool.schema
                  .string()
                  .describe("What this milestone accomplishes"),
                successCriteria: tool.schema
                  .string()
                  .optional()
                  .describe("What done looks like"),
                testCommand: tool.schema
                  .string()
                  .optional()
                  .describe("Shell command to validate (e.g. go test ./...)"),
                files: tool.schema
                  .array(tool.schema.string())
                  .optional()
                  .describe("Relevant file paths"),
              }),
            )
            .describe("Ordered list of milestones"),
        },
        async execute(args) {
          // Check for existing active mission
          const existing = getActiveMission(missionStore);
          if (existing) {
            return {
              title: "Mission Already Active",
              output:
                `A mission is already active: "${existing.goal}"\n` +
                `Use mission_cancel to cancel it first, or mission_status to check progress.`,
            };
          }

          const mission = createMission(
            missionStore,
            args.goal,
            args.milestones,
          );

          return {
            title: `🎯 Mission Planned (${mission.milestones.length} milestones)`,
            output: formatMissionProgress(mission) +
              "\n\nUse mission_next to start the first milestone.",
          };
        },
      }),

      /**
       * Execute the next pending milestone by spawning a child session.
       */
      mission_next: tool({
        description:
          "Execute the next pending milestone in the active mission. " +
          "Spawns a focused child session with the Build agent.",
        args: {},
        async execute(_args, ctx) {
          const mission = getActiveMission(missionStore);
          if (!mission) {
            return "No active mission. Use mission_plan first.";
          }

          const next = getNextMilestone(mission);
          if (!next) {
            return {
              title: "✅ All Milestones Complete",
              output: formatMissionProgress(mission),
            };
          }

          // Mark as working
          updateMilestone(missionStore, mission.id, next.id, {
            status: "working",
            startedAt: new Date().toISOString(),
          });

          // Spawn child session
          try {
            const session = await client.session.create({
              body: {
                parentID: ctx.sessionID,
                title: `Mission: ${next.title}`,
              },
            });

            const sessionId = session.data?.id;
            if (!sessionId) {
              throw new Error("session.create returned no ID");
            }

            // Record session ID on the milestone
            updateMilestone(missionStore, mission.id, next.id, {
              sessionId,
            });

            // Build a focused prompt for the worker
            const promptParts = [
              `## Milestone: ${next.title}`,
              ``,
              next.description,
            ];
            if (next.successCriteria) {
              promptParts.push(``, `**Success criteria:** ${next.successCriteria}`);
            }
            if (next.files?.length) {
              promptParts.push(``, `**Relevant files:** ${next.files.join(", ")}`);
            }
            if (next.testCommand) {
              promptParts.push(
                ``,
                `**Validation:** When done, the following command should pass: \`${next.testCommand}\``,
              );
            }

            // Send prompt (non-blocking via promptAsync)
            await client.session.promptAsync({
              path: { id: sessionId },
              body: {
                parts: [
                  { type: "text", text: promptParts.join("\n") },
                ],
              },
            });

            return {
              title: `▶ Started: ${next.title}`,
              output:
                `Worker session: ${sessionId}\n` +
                `Agent: build\n` +
                `\nThe worker is executing this milestone. ` +
                `Use mission_validate to check results when ready.`,
            };
          } catch (err) {
            // Revert milestone to pending on failure
            updateMilestone(missionStore, mission.id, next.id, {
              status: "pending",
              startedAt: undefined,
            });
            const msg = err instanceof Error ? err.message : String(err);
            return {
              title: "❌ Failed to Start Milestone",
              output: `Could not create worker session: ${msg}`,
            };
          }
        },
      }),

      /**
       * Validate a completed milestone by running its test command.
       */
      mission_validate: tool({
        description:
          "Validate a milestone by running its test command. " +
          "If no test command is set, marks the milestone as done.",
        args: {
          milestoneId: tool.schema
            .string()
            .optional()
            .describe(
              "ID of the milestone to validate. If omitted, validates the first 'working' milestone.",
            ),
        },
        async execute(args, ctx) {
          const mission = getActiveMission(missionStore);
          if (!mission) {
            return "No active mission.";
          }

          // Find the milestone to validate
          const ms = args.milestoneId
            ? mission.milestones.find((m) => m.id === args.milestoneId)
            : mission.milestones.find((m) => m.status === "working");

          if (!ms) {
            return "No milestone found to validate. Is one in 'working' status?";
          }

          // No test command — just mark as done
          if (!ms.testCommand) {
            updateMilestone(missionStore, mission.id, ms.id, {
              status: "done",
              testResult: "skip",
              completedAt: new Date().toISOString(),
            });
            return {
              title: `✅ ${ms.title}`,
              output:
                "No test command — marked as done.\n\n" +
                formatMissionProgress(
                  getActiveMission(missionStore) ?? mission,
                ),
            };
          }

          // Run test command via shell
          // The testCommand was specified by the LLM during mission_plan and
          // reviewed by the user as part of the mission plan approval.
          updateMilestone(missionStore, mission.id, ms.id, {
            status: "validating",
          });

          try {
            const result = await $`${ms.testCommand}`.nothrow().quiet();

            const exitCode = result.exitCode;
            const output = result.text();
            const passed = exitCode === 0;

            updateMilestone(missionStore, mission.id, ms.id, {
              status: passed ? "done" : "failed",
              testResult: passed ? "pass" : "fail",
              testOutput: output.slice(0, 2048),
              completedAt: new Date().toISOString(),
            });

            const updated = getActiveMission(missionStore) ?? mission;
            return {
              title: passed ? `✅ ${ms.title}` : `❌ ${ms.title}`,
              output:
                (passed
                  ? `Tests passed: \`${ms.testCommand}\`\n`
                  : `Tests failed (exit ${exitCode}): \`${ms.testCommand}\`\n${output.slice(0, 500)}\n`) +
                "\n" +
                formatMissionProgress(updated),
            };
          } catch (err) {
            // Shell execution failed entirely
            updateMilestone(missionStore, mission.id, ms.id, {
              status: "failed",
              testResult: "fail",
              testOutput:
                err instanceof Error ? err.message : String(err),
              completedAt: new Date().toISOString(),
            });
            return {
              title: `❌ ${ms.title}`,
              output: `Validation error: ${
                err instanceof Error ? err.message : String(err)
              }`,
            };
          }
        },
      }),

      /**
       * Show current mission status.
       */
      mission_status: tool({
        description:
          "Show the current status of the active mission with milestone progress.",
        args: {},
        async execute() {
          const mission = getActiveMission(missionStore);
          if (!mission) {
            return "No active mission. Use mission_plan to create one.";
          }
          return {
            title: `🎯 ${mission.goal}`,
            output: formatMissionProgress(mission),
          };
        },
      }),

      /**
       * Cancel the active mission.
       */
      mission_cancel: tool({
        description:
          "Cancel the active mission. Any in-progress milestones will be " +
          "skipped and running worker sessions will be aborted.",
        args: {},
        async execute() {
          const mission = getActiveMission(missionStore);
          if (!mission) {
            return "No active mission to cancel.";
          }

          const { workingSessionIds } = cancelMission(
            missionStore,
            mission.id,
          );

          // Abort running child sessions
          for (const sessionId of workingSessionIds) {
            try {
              await client.session.abort({
                path: { id: sessionId },
              });
            } catch {
              // Session may already be done — ignore
            }
          }

          return {
            title: "🚫 Mission Cancelled",
            output:
              `Cancelled: "${mission.goal}"\n` +
              (workingSessionIds.length > 0
                ? `Aborted ${workingSessionIds.length} worker session(s).`
                : "No active workers."),
          };
        },
      }),
    },
  };
};
