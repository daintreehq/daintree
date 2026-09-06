import type { AssistantSessionState } from "@/store/assistantStore";
import { PROSE_SPECIMEN } from "./proseSpecimen";

// Synthetic review data; the generated lifecycle captures remain unmodified.
const now = Date.now();
export const OPERATIONS_SPECIMEN: AssistantSessionState = {
  ...PROSE_SPECIMEN,
  sessionId: "ses_operations_specimen",
  operations: {
    at: now,
    inbox: [
      {
        id: "waiting-agent",
        severity: "attention",
        source: "Agent",
        summary: "The test agent is waiting for a decision about the migration.",
        at: now - 30_000,
      },
    ],
    workflows: [
      {
        id: "workflow",
        goal: "Ship the account settings change",
        status: "running",
        progress: "2/4 done · current: Run tests",
        next: "Review the diff",
        blocked: false,
      },
    ],
    agents: [
      {
        id: "agent",
        title: "Account settings",
        goal: "Implement the settings form and verify validation",
        badge: "running",
        agentState: "working",
        preview: "Running the settings test suite…",
        startedAt: now - 90_000,
        needsAttention: false,
      },
    ],
    async: [
      {
        id: "background",
        title: "Inspect the worktree diff",
        tool: "worktree.diff",
        startedAt: now - 15_000,
      },
    ],
    timers: [],
    audit: [{ tool: "agent.launch", outcome: "ok", durationMs: 320, at: now - 90_000 }],
  },
};
