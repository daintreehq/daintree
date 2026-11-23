import {
  AntigravityIcon,
  ClaudeIcon,
  CodexIcon,
  CursorIcon,
  DaintreeIcon,
  OpenCodeIcon,
} from "@/components/icons";
import {
  SESSION_COLORS,
  SESSION_ICONS,
  SESSION_PRIORITY,
} from "@/components/Worktree/terminalStateConfig";
import { getAgentConfig } from "@/config/agents";
import { getCIStatusVisual } from "@/lib/worktreeCIStatus";
import type { SessionPresentationState } from "@/lib/paneSessionPresentation";
import type { CIStatus } from "@shared/types/forge";
import type { MockAgent, MockCIVisual, MockKit, MockStateVisual } from "@daintreehq/tour/mock-app";

function agent(id: string, name: string, Icon: MockAgent["Icon"]): MockAgent {
  return { id, name, Icon, color: getAgentConfig(id)?.color };
}

// The session states, so a finished pane can show its unread disc before the check.
function state(id: SessionPresentationState): MockStateVisual {
  return {
    // Idle keeps the header's glyph box empty, as a real pane does.
    Icon: id === "idle" ? null : SESSION_ICONS[id],
    colorClass: SESSION_COLORS[id],
    // The working spinner turns exactly as it does in a real pane header.
    iconClassName: id === "working" ? "animate-spin-slow motion-reduce:animate-none" : undefined,
  };
}

/** The app's own CI mark for a checks state; only `state` decides it. */
function ci(ciState: CIStatus["state"]): MockCIVisual {
  const visual = getCIStatusVisual({
    state: ciState,
    total: 0,
    passed: 0,
    failed: 0,
    pending: 0,
    rawData: null,
  });
  if (!visual) throw new Error(`No CI visual for "${ciState}"`);
  return visual.kind === "icon"
    ? { kind: "icon", Icon: visual.Icon, colorClass: visual.colorClass }
    : { kind: "dot", colorClass: visual.colorClass };
}

/** The built-in tour's picture of Daintree, handed to the mockup kit. */
export const DAINTREE_MOCK_KIT: MockKit = {
  agents: {
    claude: agent("claude", "Claude", ClaudeIcon),
    codex: agent("codex", "Codex", CodexIcon),
    antigravity: agent("antigravity", "Antigravity", AntigravityIcon),
    cursor: agent("cursor", "Cursor", CursorIcon),
    opencode: agent("opencode", "OpenCode", OpenCodeIcon),
  },
  states: Object.fromEntries(SESSION_PRIORITY.map((id) => [id, state(id)])),
  statePriority: SESSION_PRIORITY,
  ci: {
    success: ci("success"),
    failure: ci("failure"),
    pending: ci("pending"),
    neutral: ci("neutral"),
  },
  assistantIcon: DaintreeIcon,
};
