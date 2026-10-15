import "./hybridInputShims";
import { StrictMode, use, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { resolveAppTheme } from "@shared/theme/themes";
import type { BuiltInAgentId } from "@shared/config/agentIds";
import type { Project } from "@shared/types/project";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";
import { WorktreeStoreContext, WorktreeStoreProvider } from "@/contexts/WorktreeStoreContext";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useAppThemeStore } from "@/store/appThemeStore";
import { useProjectStore } from "@/store/projectStore";
import { useTerminalInputStore } from "@/store/terminalInputStore";
import { usePanelStore, useVoiceRecordingStore } from "@/store";
import {
  useTerminalColorSchemeStore,
  selectEffectiveTheme,
} from "@/store/terminalColorSchemeStore";
import { cn } from "@/lib/utils";
import { HybridInputBar } from "../HybridInputBar";
import { insertFileAttachments } from "../fileAttachments";
import { fileDropChipField, imageChipField } from "../inputEditorExtensions";
import {
  CHIP_ATTACHMENTS,
  CHIP_DRAFT,
  DRAFTS,
  PANE_AGENTS,
  PANE_TITLES,
  TERMINAL_LINES,
  TILE_AGENTS,
  WIDTHS,
  resolveDraft,
  type DraftName,
} from "./hybridInputFixtures";
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
 *   ?case=controls                  the control row at rest and disabled (the states spec hovers it)
 *   ?case=panes|fleet               whole grid panes, one of them selected (the selection-states spec)
 *   ?case=chips                     one composer carrying every chip kind (the chips spec attaches the files)
 *   ?selected=N                     which pane of `panes`/`fleet` is the focused pane
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
// The composer paints from the terminal palette, which follows the app theme by
// default. Without this every theme's composer wore Daintree's terminal colours.
useAppThemeStore.setState({ selectedSchemeId: themeId });
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
const selectedPane = Number(params.get("selected") ?? "1");
usePanelStore.setState({
  focusedId:
    caseName === "panes" || caseName === "fleet" ? `${caseName}-${selectedPane}` : "tile-9",
});

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

function Bar({
  terminalId,
  agentId,
  disabled,
}: {
  terminalId: string;
  agentId: BuiltInAgentId;
  disabled?: boolean;
}) {
  return (
    <HybridInputBar
      terminalId={terminalId}
      onSend={noop}
      cwd={CWD}
      agentId={agentId}
      disabled={disabled}
    />
  );
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
const CONTROL_STATES = ["enabled", "disabled"] as const;
const CHIPS_PANE = "chips";
const CHIPS_WIDTH = 560;

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
  case "controls":
    CONTROL_STATES.forEach((state) => seedPane(`controls-${state}`, DRAFTS.short));
    break;
  case "chips":
    seedPane(CHIPS_PANE, CHIP_DRAFT);
    break;
  case "tiles":
    TILE_AGENTS.forEach((_agent, i) => {
      seedPane(`tile-${i}`, i % 3 === 0 ? DRAFTS.short : DRAFTS.empty);
    });
    break;
  case "panes":
  case "fleet":
    // Empty drafts throughout: the reported case is a row of untouched
    // composers, all showing a placeholder, where nothing but the composer's
    // own state can say which one is live.
    PANE_AGENTS.slice(0, caseName === "panes" ? 3 : 6).forEach((_agent, i) => {
      seedPane(`${caseName}-${i}`, DRAFTS.empty);
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

/**
 * The control row — `❯`, attach, stash and mic — as one enabled and one
 * disabled composer. The vertical padding leaves room for a tooltip on either
 * side, so a hover capture shows which way it opened.
 */
function Controls() {
  return (
    <div className="flex w-fit flex-col gap-24 py-16 pl-8 pr-40" data-preview-case="controls">
      {CONTROL_STATES.map((state) => (
        <Column key={state} width={420} label={`420px · ${state}`}>
          <Bar terminalId={`controls-${state}`} agentId="claude" disabled={state === "disabled"} />
        </Column>
      ))}
    </div>
  );
}

/**
 * A grid pane as the composer actually sits in one: the pane's own frame
 * (`terminal-selected` on the focused pane, exactly as `ContentPanel` resolves
 * it), its title bar with the focus lift, a terminal body, then the composer.
 * The body is a stand-in for xterm with a focus target inside it, so the spec
 * can put the keyboard in the selected pane's terminal rather than in its
 * composer — the state the report is about.
 */
function Pane({
  prefix,
  index,
  agentId,
}: {
  prefix: string;
  index: number;
  agentId: BuiltInAgentId;
}) {
  const id = `${prefix}-${index}`;
  const selected = index === selectedPane;
  const theme = useTerminalColorSchemeStore(selectEffectiveTheme);
  return (
    <div
      className={cn(
        "flex min-w-0 flex-col overflow-hidden rounded-lg border bg-surface shadow-[var(--theme-shadow-ambient)]",
        selected ? "terminal-selected" : "border-overlay"
      )}
      data-preview-pane={id}
    >
      <div
        className={cn(
          "flex h-8 shrink-0 items-center border-b border-divider px-3 text-xs text-text-secondary",
          selected &&
            "bg-[var(--panel-header-focus-bg,var(--color-overlay-medium))] text-text-primary"
        )}
      >
        {PANE_TITLES[index % PANE_TITLES.length]}
      </div>
      <div
        className="relative h-36 overflow-hidden px-3.5 py-2 font-mono text-xs leading-5"
        style={{ background: theme.background, color: theme.foreground }}
      >
        {/* Focus lands on an invisible target, as xterm's does on its helper
            textarea, so the body draws no ring the real terminal never shows. */}
        <div
          tabIndex={-1}
          data-preview-terminal={id}
          className="absolute top-0 left-0 size-0 opacity-0"
        />
        {TERMINAL_LINES.map((line, i) => (
          <div key={i} className="truncate">
            {line}
          </div>
        ))}
      </div>
      <Bar terminalId={id} agentId={agentId} />
    </div>
  );
}

/** The reported case: three agent panes side by side, every composer empty. */
function Panes() {
  return (
    <div
      className="grid w-fit gap-1.5 p-6"
      style={{ gridTemplateColumns: "repeat(3, 440px)" }}
      data-preview-case="panes"
    >
      {PANE_AGENTS.slice(0, 3).map((agent, i) => (
        <Pane key={i} prefix="panes" index={i} agentId={agent} />
      ))}
    </div>
  );
}

/** A denser fleet, two rows of three, where finding the live pane is the whole job. */
function Fleet() {
  return (
    <div
      className="grid w-fit gap-1.5 p-6"
      style={{ gridTemplateColumns: "repeat(3, 340px)" }}
      data-preview-case="fleet"
    >
      {PANE_AGENTS.map((agent, i) => (
        <Pane key={i} prefix="fleet" index={i} agentId={agent} />
      ))}
    </div>
  );
}

function chipsView(): EditorView {
  const dom = document.querySelector(`[data-hybrid-input-root="${CHIPS_PANE}"] .cm-editor`);
  const view = dom instanceof HTMLElement ? EditorView.findFromDOM(dom) : null;
  if (!view) throw new Error("the chips composer has no editor");
  return view;
}

/**
 * Hooks the chips spec drives. `attach` puts the fixture files into the draft
 * through `insertFileAttachments`, the function a drop, a paste and the attach
 * picker all end in, so the chips are inserted exactly as the app inserts them.
 * `caretAfter` parks the caret at a chip's trailing edge, which is where the
 * spec's real Backspace starts the two-step delete from.
 */
const chipsHooks = {
  async attach(): Promise<number> {
    const view = chipsView();
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    await insertFileAttachments({ current: view }, view, CHIP_ATTACHMENTS, CWD);
    return view.state.field(imageChipField).length + view.state.field(fileDropChipField).length;
  },
  caretAfter(kind: "image" | "file-drop"): void {
    const view = chipsView();
    const entries = view.state.field(kind === "image" ? imageChipField : fileDropChipField);
    const entry = entries[0];
    if (!entry) throw new Error(`no ${kind} chip to park the caret after`);
    view.focus();
    view.dispatch({ selection: { anchor: entry.to } });
  },
};
Reflect.set(window, "__composerChips", chipsHooks);

/**
 * One composer at a working pane width, holding a draft with every chip kind.
 * The space above it is room for the hover cards, which open upward, and the
 * space to the right is room for one opened over the last chip on a line.
 */
function Chips() {
  return (
    <div className="flex w-fit flex-col px-8 pt-72 pr-48 pb-10" data-preview-case="chips">
      <Column width={CHIPS_WIDTH} label={`${CHIPS_WIDTH}px · attachments`}>
        <Bar terminalId={CHIPS_PANE} agentId="claude" />
      </Column>
    </div>
  );
}

const CASES: Record<string, () => ReactNode> = {
  chips: Chips,
  controls: Controls,
  panes: Panes,
  fleet: Fleet,
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
