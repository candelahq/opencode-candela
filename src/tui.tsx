/**
 * opencode-candela TUI plugin — mission progress sidebar and slash commands.
 *
 * This module exports a TuiPluginModule (separate from the server plugin).
 * It runs in OpenCode's terminal renderer context with access to:
 * - api.slots: Register UI components into host layout slots
 * - api.keymap: Register keyboard shortcuts and slash commands
 * - api.state: Reactive session/message state (SolidJS signals)
 * - api.ui: Dialogs, toasts, prompts
 * - api.kv: Plugin-scoped key-value storage
 * - api.client: SDK client for API calls
 */

/** @jsxImportSource @opentui/solid */
import type { TuiPluginModule } from "@opencode-ai/plugin/tui";
import { readMissionStore, getActiveMission, formatMissionProgress } from "./missions.js";
import { MILESTONE_ICONS } from "./types.js";
import type { Mission, MilestoneStatus } from "./types.js";

/**
 * Status icon for a milestone.
 */
function icon(status: MilestoneStatus): string {
  return MILESTONE_ICONS[status] ?? "?";
}

export const CandelaTuiPlugin: TuiPluginModule = {
  id: "opencode-candela",
  tui: async (api) => {
    // ── Slash Commands ────────────────────────────────────────────────────

    api.keymap.registerLayer({
      commands: [
        {
          name: "candela.mission",
          title: "🎯 Start Mission",
          description: "Plan and execute a multi-step goal with validation",
          slash: { name: "mission", aliases: ["m"] },
          async execute() {
            // Read current state — if mission already active, show status instead
            const store = readMissionStore();
            const active = getActiveMission(store);
            if (active) {
              api.ui.toast({
                variant: "info",
                title: "Mission Active",
                message: `"${active.goal}" is in progress. Use /mission-status to check.`,
              });
              return;
            }

            // Navigate to session with a mission planning prompt
            api.route.navigate("session", {
              prompt:
                "I'd like to start a new mission. Please ask me what I want to accomplish, " +
                "then use the mission_plan tool to decompose it into milestones.",
            });
          },
        },
        {
          name: "candela.mission.status",
          title: "📊 Mission Status",
          description: "Show current mission progress",
          slash: { name: "mission-status", aliases: ["ms"] },
          async execute() {
            const store = readMissionStore();
            const active = getActiveMission(store);
            if (!active) {
              api.ui.toast({
                variant: "info",
                title: "No Active Mission",
                message: "Use /mission to start one.",
              });
              return;
            }

            // Navigate to session with status request
            api.route.navigate("session", {
              prompt: "Use mission_status to show the current mission progress.",
            });
          },
        },
        {
          name: "candela.mission.cancel",
          title: "🚫 Cancel Mission",
          description: "Cancel the active mission",
          slash: { name: "mission-cancel", aliases: ["mc"] },
          async execute() {
            const store = readMissionStore();
            const active = getActiveMission(store);
            if (!active) {
              api.ui.toast({
                variant: "info",
                title: "No Active Mission",
                message: "Nothing to cancel.",
              });
              return;
            }

            api.route.navigate("session", {
              prompt: "Use mission_cancel to cancel the active mission.",
            });
          },
        },
      ],
    });

    // ── Sidebar: Mission Progress ────────────────────────────────────────

    api.slots.register({
      order: 100, // Render above default sidebar content
      slots: {
        sidebar_content(_ctx) {
          // Read mission state from file (same source as server plugin)
          const store = readMissionStore();
          const mission = getActiveMission(store);

          if (!mission) return null;

          const done = mission.milestones.filter(
            (m) => m.status === "done" || m.status === "skipped",
          ).length;
          const total = mission.milestones.length;

          return (
            <box flexDirection="column" paddingTop={1}>
              <text bold>
                🎯 Mission ({done}/{total})
              </text>
              <text dimColor>{mission.goal}</text>
              {mission.milestones.map((ms) => (
                <text key={ms.id}>
                  {icon(ms.status)} {ms.title}
                </text>
              ))}
            </box>
          );
        },
      },
    });
  },
};

export default CandelaTuiPlugin;
