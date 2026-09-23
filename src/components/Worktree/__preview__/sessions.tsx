import "@/components/Panel/__preview__/installShims";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { DndContext } from "@dnd-kit/core";
import { GitBranch, Sprout } from "lucide-react";
import { resolveAppTheme } from "@shared/theme/themes";
import type { PtyPanelData } from "@shared/types/panel";
import type { AgentState, WorktreeState } from "@shared/types";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useFleetArmingStore } from "@/store/fleetArmingStore";
import { WorktreeDetailsSection } from "../WorktreeCard/WorktreeDetailsSection";
import { WorktreeTerminalSection } from "../WorktreeCard/WorktreeTerminalSection";
import type { WorktreeTerminalCounts } from "@/hooks/useWorktreeTerminals";
import "@/index.css";

// Dynamic rather than static so the harness entry obeys the app's lazy-load rule
// (#7659). Each row sits in the sortable wrapper's `m.div`, which needs a feature
// provider to render as it does in the app.
const { LazyMotion, domAnimation } = await import("framer-motion");

/**
 * Standalone visual-review harness for the expanded Active sessions list on a
 * worktree card.
 *
 * Renders the REAL `WorktreeTerminalSection` (rows, trigger, hint, sortable
 * wrappers) and the REAL collapsed `WorktreeDetailsSection` directly above it,
 * so the session rows are judged against the sibling disclosure they have to
 * sit beside. The card header above them is harness decoration copying the
 * sidebar card's title and branch lines.
 *
 * Query parameters:
 *   ?theme=daintree|bondi|namib   built-in theme id
 *   ?fixture=<name>               one of FIXTURES below
 *   ?variant=sidebar|grid         which card density
 *   ?width=320                    card width in CSS px
 */

const params = new URLSearchParams(window.location.search);
const themeId = params.get("theme") ?? "daintree";
const fixtureName = params.get("fixture") ?? "two-agents";
const variant = params.get("variant") === "grid" ? "grid" : "sidebar";
const width = Number(params.get("width") ?? (variant === "grid" ? "420" : "320"));

applyAppThemeToRoot(document.documentElement, resolveAppTheme(themeId));
document.body.style.background = "var(--color-surface-canvas)";
document.body.style.margin = "0";

const WORKTREE_ID = "wt-main";

interface SessionFixture {
  id: string;
  title: string;
  agentId?: string;
  agentState?: AgentState;
  location: "grid" | "dock";
  activityStatus?: "working" | "waiting" | "success" | "failure";
  lastCommand?: string;
  armed?: boolean;
}

interface Fixture {
  sessions: SessionFixture[];
  expanded: boolean;
  showHint?: boolean;
}

const FIXTURES: Record<string, Fixture> = {
  // The reported case: two Claude sessions, both waiting, one on each surface.
  "two-agents": {
    expanded: true,
    sessions: [
      { id: "s1", title: "Claude", agentId: "claude", agentState: "waiting", location: "dock" },
      { id: "s2", title: "Claude", agentId: "claude", agentState: "waiting", location: "grid" },
    ],
  },
  mixed: {
    expanded: true,
    sessions: [
      {
        id: "s1",
        title: "Claude: Rework the retry ladder for 429s",
        agentId: "claude",
        agentState: "working",
        location: "grid",
      },
      { id: "s2", title: "Codex", agentId: "codex", agentState: "waiting", location: "grid" },
      {
        id: "s3",
        title: "Terminal",
        location: "dock",
        activityStatus: "working",
        lastCommand: "npm run test -- --watch src/services/upload",
      },
      { id: "s4", title: "Gemini", agentId: "gemini", agentState: "completed", location: "dock" },
    ],
  },
  armed: {
    expanded: true,
    sessions: [
      {
        id: "s1",
        title: "Claude",
        agentId: "claude",
        agentState: "working",
        location: "grid",
        armed: true,
      },
      {
        id: "s2",
        title: "Codex",
        agentId: "codex",
        agentState: "waiting",
        location: "grid",
        armed: true,
      },
      { id: "s3", title: "Claude", agentId: "claude", agentState: "idle", location: "dock" },
    ],
  },
  // Only grid sessions are fleet-eligible, and the hint needs two of them.
  hint: {
    expanded: true,
    showHint: true,
    sessions: [
      { id: "s1", title: "Claude", agentId: "claude", agentState: "waiting", location: "grid" },
      { id: "s2", title: "Claude", agentId: "claude", agentState: "working", location: "grid" },
    ],
  },
  collapsed: {
    expanded: false,
    sessions: [
      { id: "s1", title: "Claude", agentId: "claude", agentState: "waiting", location: "dock" },
      { id: "s2", title: "Claude", agentId: "claude", agentState: "waiting", location: "grid" },
    ],
  },
};

const fixture = FIXTURES[fixtureName] ?? FIXTURES["two-agents"]!;

// The hint's dismissal lives in localStorage; the shims clear storage, so the
// flag is restored here for every fixture that is not about the hint.
if (!fixture.showHint) {
  localStorage.setItem("daintree:fleet-selection-hint-dismissed", "1");
}

// Inert fixtures: only the fields the row and the chrome read are filled in.
const terminals: PtyPanelData[] = fixture.sessions.map(
  (s) =>
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- inert fixture, see above
    ({
      id: s.id,
      kind: "terminal",
      title: s.title,
      location: s.location,
      cwd: "/Users/dev/daintree",
      cols: 120,
      rows: 40,
      worktreeId: WORKTREE_ID,
      launchAgentId: s.agentId,
      detectedAgentId: s.agentId,
      agentState: s.agentState,
      activityStatus: s.activityStatus,
      lastCommand: s.lastCommand,
    }) as PtyPanelData
);

const armedIds = fixture.sessions.filter((s) => s.armed).map((s) => s.id);
if (armedIds.length > 0) useFleetArmingStore.getState().armIds(armedIds);

const byState = {
  working: 0,
  waiting: 0,
  directing: 0,
  idle: 0,
  completed: 0,
  exited: 0,
} as Record<AgentState, number>;
for (const s of fixture.sessions) if (s.agentState) byState[s.agentState] += 1;
const counts = { total: fixture.sessions.length, byState } as WorktreeTerminalCounts;

// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- inert fixture
const worktree = {
  id: WORKTREE_ID,
  worktreeId: WORKTREE_ID,
  path: "/Users/dev/daintree",
  name: "daintree",
  branch: "develop",
  isCurrent: true,
  isMainWorktree: true,
  worktreeChanges: {
    worktreeId: WORKTREE_ID,
    rootPath: "/Users/dev/daintree",
    changes: [],
    changedFileCount: 0,
    lastCommitMessage: "Merge pull request #12632 from daintreehq/feature/issue-12609",
    lastCommitTimestampMs: Date.now() - 21 * 60_000,
  },
  lastActivityTimestamp: Date.now() - 21 * 60_000,
} as unknown as WorktreeState;

const noop = () => {};

function Card() {
  return (
    <div
      data-preview-card
      className={
        variant === "grid"
          ? "rounded-[var(--radius-lg)] border border-border-default bg-surface-panel px-3 py-3"
          : "bg-surface-sidebar px-3 py-3"
      }
      style={{ width }}
    >
      <div className="flex items-center gap-2 px-1.5 text-sm font-semibold text-text-primary">
        <Sprout className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span>daintree</span>
      </div>
      <div className="mt-1 flex items-center gap-2 px-1.5 text-2xs text-text-secondary">
        <GitBranch className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span className="font-mono">develop</span>
      </div>
      <div className="pb-2.5 pt-2">
        <WorktreeDetailsSection
          variant={variant}
          worktree={worktree}
          isExpanded={false}
          hasChanges={false}
          computedSubtitle={{ text: "No changes", tone: "muted" }}
          worktreeErrors={[]}
          isFocused={false}
          onToggleExpand={noop}
          onPathClick={noop}
          onDismissError={noop}
          onRetryError={async () => {}}
        />
        <WorktreeTerminalSection
          variant={variant}
          worktreeId={WORKTREE_ID}
          onStartSession={noop}
          isExpanded={fixture.expanded}
          counts={counts}
          terminals={terminals}
          onToggle={noop}
          onTerminalSelect={noop}
        />
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <LazyMotion features={domAnimation}>
      <TooltipProvider>
        <DndContext>
          <div data-preview-shell className="inline-block p-4">
            <Card />
          </div>
        </DndContext>
      </TooltipProvider>
    </LazyMotion>
  </StrictMode>
);
