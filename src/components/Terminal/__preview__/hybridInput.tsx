import "./hybridInputShims";
import { StrictMode, use, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { EditorState } from "@codemirror/state";
import { resolveAppTheme } from "@shared/theme/themes";
import type { BuiltInAgentId } from "@shared/config/agentIds";
import type { Project } from "@shared/types/project";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";
import { WorktreeStoreContext, WorktreeStoreProvider } from "@/contexts/WorktreeStoreContext";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useProjectStore } from "@/store/projectStore";
import { useTerminalInputStore } from "@/store/terminalInputStore";
import { usePanelStore, useVoiceRecordingStore } from "@/store";
import { HybridInputBar } from "../HybridInputBar";
import { DRAFTS, TILE_AGENTS, WIDTHS, resolveDraft, type DraftName } from "./hybridInputFixtures";
import "@/index.css";

/**
 * Standalone visual-review harness for the agent composer's LAYOUT.
 *
 * The two variables that decide this component's layout — the width of the grid
 * column it sits in, and how many lines the draft wraps to — are properties of
 * the workspace around it, not states the component can be asked for. Reaching
 * a 260px composer holding a three-line draft in the real app means building a
 * seven-way split and typing into one pane of it.
 *
 * So this mounts the real `HybridInputBar` against the real stores, the real
 * CodeMirror autosize and the real `index.css`, and puts it in a column of a
 * chosen width with a seeded draft. What it renders is the product's own
 * component; only the column around it is the harness's.
 *
 * One caveat worth holding while reading a capture: in the app the composer is
 * pinned to the FOOT of its pane, so a growing shell expands upward. These
 * specimens are aligned at their tops, so growth reads downward here. Either
 * way the question is whether a control stays put relative to the pane edge.
 *
 * Query parameters (the screenshot spec drives these):
 *   ?theme=daintree|bondi|namib|…   built-in theme id
 *   ?case=ladder|growth|tiles       which arrangement to render
 *   ?draft=empty|short|reported|overflow   the seeded draft (ladder case)
 *   ?stash=1                        seed a stashed draft, adding the third trailing button
 */

const params = new URLSearchParams(window.location.search);
const themeId = params.get("theme") ?? "daintree";
const caseName = params.get("case") ?? "ladder";
const draftName = params.get("draft") ?? "reported";
const withStash = params.get("stash") === "1";
// `voice=0` renders the composer as a user who has never set voice up sees it:
// paperclip only. That is the sparsest the trailing group gets, and the case
// the rail beneath a wrapped draft is hardest on.
const withVoice = params.get("voice") !== "0";

applyAppThemeToRoot(document.documentElement, resolveAppTheme(themeId));
document.body.style.background = "var(--color-surface-canvas)";

const PROJECT_ID = "preview-project";
const CWD = "/Users/dev/Projects/daintree";

const PROJECT: Project = {
  id: PROJECT_ID,
  path: CWD,
  name: "daintree",
  emoji: "🌳",
  lastOpened: 0,
};

useProjectStore.setState({ currentProject: PROJECT });

// `VoiceInputButton` renders nothing until voice is configured, so without this
// the harness would photograph a one-button trailing group and understate the
// case this review is about — the composer as a user who has set voice up sees
// it, with both the paperclip and the mic present on every pane.
useVoiceRecordingStore.setState({ isConfigured: withVoice });

// In the app exactly one pane is focused, and the focused shell is the only one
// wearing a ring — so the tile sheet gets one too. Seeded at module scope: a
// store hook referenced inside a component body is a React Compiler error.
usePanelStore.setState({ focusedId: "tile-9" });

/**
 * Seed one pane's draft, and optionally its stash, before the bar mounts.
 *
 * The bar only asks the stash map `has(key)` to decide whether to render the
 * restore button, so any real `EditorState` serves — the value itself is never
 * read on this path.
 */
function seedPane(terminalId: string, draft: string): void {
  const key = `${PROJECT_ID}:${terminalId}`;
  useTerminalInputStore.setState((s) => {
    const draftInputs = new Map(s.draftInputs);
    draftInputs.set(key, draft);
    const stashedEditorStates = new Map(s.stashedEditorStates);
    if (withStash) {
      stashedEditorStates.set(key, EditorState.create({ doc: "a stashed draft" }));
    }
    return { draftInputs, stashedEditorStates };
  });
}

/** The per-view worktree store is created by the provider, so it is seeded from inside the tree. */
function Ready({ children }: { children: ReactNode }) {
  const store = use(WorktreeStoreContext);
  const [ready] = useState(() => {
    store?.setState({ worktrees: new Map() });
    return true;
  });
  return ready ? children : null;
}

const noop = () => {};

function Bar({ terminalId, agentId }: { terminalId: string; agentId: BuiltInAgentId }) {
  return <HybridInputBar terminalId={terminalId} onSend={noop} cwd={CWD} agentId={agentId} />;
}

/**
 * A labelled column of a fixed width. The label sits outside the column so it
 * can never be mistaken for part of the composer.
 */
function Column({ width, label, children }: { width: number; label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1" data-preview-column={String(width)}>
      <div className="font-mono text-xs uppercase tracking-wide text-text-secondary">{label}</div>
      <div
        className="border border-divider bg-surface-panel"
        style={{ width: `${width}px` }}
        data-preview-frame={String(width)}
      >
        {children}
      </div>
    </div>
  );
}

const GROWTH_WIDTH = 360;
const GROWTH_DRAFTS: DraftName[] = ["empty", "short", "reported", "overflow"];
const SIDEBAR_WIDTHS = [380, 430] as const;
const SIDEBAR_DRAFTS: DraftName[] = ["short", "reported", "sidebar"];

// Every pane the chosen case will mount, seeded here at module scope so no
// component writes a store during render — a re-render would repeat the write
// and could clobber a draft the user has since typed into.
switch (caseName) {
  case "growth":
    GROWTH_DRAFTS.forEach((d) => seedPane(`growth-${d}`, DRAFTS[d]));
    break;
  case "sidebar":
    SIDEBAR_WIDTHS.forEach((w) =>
      SIDEBAR_DRAFTS.forEach((d) => seedPane(`sidebar-${w}-${d}`, DRAFTS[d]))
    );
    break;
  case "tiles":
    TILE_AGENTS.forEach((_agent, i) => {
      seedPane(`tile-${i}`, i % 3 === 0 ? DRAFTS.short : DRAFTS.empty);
    });
    break;
  default: {
    const draft = resolveDraft(draftName);
    WIDTHS.forEach((w) => seedPane(`ladder-${w}`, draft));
  }
}

/** The reflow ladder: one draft, every width, so the breakpoint behaviour is one picture. */
function Ladder() {
  return (
    <div className="flex flex-wrap items-start gap-6 p-8" data-preview-case="ladder">
      {WIDTHS.map((w) => (
        <Column key={w} width={w} label={`${w}px`}>
          <Bar terminalId={`ladder-${w}`} agentId="claude" />
        </Column>
      ))}
    </div>
  );
}

/** Vertical growth at one representative narrow width. */
function Growth() {
  const width = GROWTH_WIDTH;
  return (
    <div className="flex flex-wrap items-start gap-6 p-8" data-preview-case="growth">
      {GROWTH_DRAFTS.map((d) => (
        <Column key={d} width={width} label={`${width}px · ${d}`}>
          <Bar terminalId={`growth-${d}`} agentId="claude" />
        </Column>
      ))}
    </div>
  );
}

/**
 * The second reported case: the Daintree Assistant sidebar. `HelpPanel` opens
 * at `HELP_PANEL_DEFAULT_WIDTH` (380px) and the report was taken at ~430px, so
 * both are rendered, each at one line, then two, then the reported draft, so
 * the transition into the rail is one picture per width.
 */
function Sidebar() {
  return (
    <div className="flex items-start gap-8 p-8" data-preview-case="sidebar">
      {SIDEBAR_WIDTHS.map((w) => (
        <div key={w} className="flex flex-col gap-6">
          {SIDEBAR_DRAFTS.map((d) => (
            <Column key={d} width={w} label={`${w}px · ${d}`}>
              <Bar terminalId={`sidebar-${w}-${d}`} agentId="claude" />
            </Column>
          ))}
        </div>
      ))}
    </div>
  );
}

/**
 * Ten tiled panes at a realistic fleet column width — the case the repeated
 * trailing icons are actually judged in.
 */
function Tiles() {
  return (
    <div
      className="grid gap-3 p-8"
      style={{ gridTemplateColumns: "repeat(5, 300px)" }}
      data-preview-case="tiles"
    >
      {TILE_AGENTS.map((agent, i) => (
        <div
          key={`${agent}-${i}`}
          className="border border-divider bg-surface-panel"
          data-preview-tile={i}
        >
          <Bar terminalId={`tile-${i}`} agentId={agent} />
        </div>
      ))}
    </div>
  );
}

const CASES: Record<string, () => ReactNode> = {
  ladder: Ladder,
  growth: Growth,
  sidebar: Sidebar,
  tiles: Tiles,
};

const Chosen = CASES[caseName] ?? Ladder;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TooltipProvider>
      <WorktreeStoreProvider>
        <Ready>
          <div data-preview-shell />
          <Chosen />
        </Ready>
      </WorktreeStoreProvider>
    </TooltipProvider>
  </StrictMode>
);
