/**
 * Mission orchestration types.
 *
 * A Mission is a structured goal decomposed into ordered Milestones.
 * The LLM creates missions via `mission_plan`, advances them via
 * `mission_next`, and validates results via `mission_validate`.
 */

/** Status of a single milestone within a mission. */
export type MilestoneStatus =
  | "pending"
  | "working"
  | "validating"
  | "done"
  | "failed";

/** A discrete unit of work within a mission. */
export interface Milestone {
  /** Unique identifier (UUID). */
  id: string;
  /** Short, descriptive title. */
  title: string;
  /** How to know this milestone is complete. */
  successCriteria?: string;
  /** Shell command to validate completion (e.g. `npm test`). */
  testCommand?: string;
  /** Current status. */
  status: MilestoneStatus;
  /** Child session ID if dispatched via `mission_next`. */
  sessionId?: string;
}

/** Overall status of a mission. */
export type MissionStatus = "active" | "completed" | "cancelled";

/** A structured goal with ordered milestones. */
export interface Mission {
  /** Unique identifier (UUID). */
  id: string;
  /** Short title for display. */
  title: string;
  /** Original user goal / description. */
  goal: string;
  /** Current status. */
  status: MissionStatus;
  /** Ordered milestones. */
  milestones: Milestone[];
  /** ISO 8601 creation timestamp. */
  createdAt: string;
  /** ISO 8601 completion/cancellation timestamp. */
  completedAt?: string;
  /** ISO 8601 timestamp of last milestone status change. Used for staleness detection. */
  lastActivityAt?: string;
}

/** Root storage shape for the missions JSON file. */
export interface MissionStore {
  /** ID of the currently active mission, or null. */
  activeMissionId: string | null;
  /** All missions (active + historical). */
  missions: Mission[];
}

/** Status icons for TUI/tool display. */
export const MILESTONE_ICONS: Record<MilestoneStatus, string> = {
  pending: "☐",
  working: "▶",
  validating: "🔍",
  done: "✅",
  failed: "❌",
};
