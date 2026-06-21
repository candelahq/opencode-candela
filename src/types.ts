/**
 * Shared types for Candela Missions.
 *
 * Used by both the server plugin (src/index.ts) and TUI plugin (src/tui.tsx).
 * Mission state is persisted to a JSON file — these types define its schema.
 */

/** Status of a mission. */
export type MissionStatus =
  | "planning"
  | "executing"
  | "done"
  | "failed"
  | "cancelled";

/** Status of an individual milestone within a mission. */
export type MilestoneStatus =
  | "pending"
  | "working"
  | "validating"
  | "done"
  | "failed"
  | "skipped";

/** A single milestone within a mission. */
export interface Milestone {
  /** Unique milestone ID (e.g. "ms_abc123"). */
  id: string;
  /** Display order (0-indexed). */
  ordinal: number;
  /** Short title for display (e.g. "Add OAuth2 routes"). */
  title: string;
  /** Detailed description of what this milestone accomplishes. */
  description: string;
  /** Current status. */
  status: MilestoneStatus;
  /** OpenCode session ID executing this milestone. */
  sessionId?: string;
  /** Shell command to validate completion (e.g. "go test ./..."). */
  testCommand?: string;
  /** Result of test command execution. */
  testResult?: "pass" | "fail" | "skip";
  /** Truncated test output (max 2KB). */
  testOutput?: string;
  /** What "done" looks like for this milestone. */
  successCriteria?: string;
  /** Relevant file paths for this milestone. */
  files?: string[];
  /** ISO 8601 timestamp when work started. */
  startedAt?: string;
  /** ISO 8601 timestamp when completed/failed. */
  completedAt?: string;
}

/** A mission — a structured, multi-step goal with ordered milestones. */
export interface Mission {
  /** Unique mission ID (e.g. "mission_abc123"). */
  id: string;
  /** The user's original goal. */
  goal: string;
  /** Current status. */
  status: MissionStatus;
  /** ISO 8601 timestamp when created. */
  createdAt: string;
  /** ISO 8601 timestamp when completed/failed/cancelled. */
  completedAt?: string;
  /** Ordered list of milestones. */
  milestones: Milestone[];
}

/** Root structure of the persisted missions JSON file. */
export interface MissionStore {
  /** The currently active mission (if any). */
  activeMissionId: string | null;
  /** All missions (active + historical). Keyed by mission ID. */
  missions: Record<string, Mission>;
}

/** Status icon mapping for display. */
export const MILESTONE_ICONS: Record<MilestoneStatus, string> = {
  pending: "☐",
  working: "▶",
  validating: "🔍",
  done: "✅",
  failed: "❌",
  skipped: "⏭",
};

/** Status icon mapping for missions. */
export const MISSION_ICONS: Record<MissionStatus, string> = {
  planning: "📋",
  executing: "🚀",
  done: "✅",
  failed: "❌",
  cancelled: "🚫",
};
