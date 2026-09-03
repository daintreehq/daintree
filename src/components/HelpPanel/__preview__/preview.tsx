import { StrictMode, useEffect, useId, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { MAX_ASSISTANT_SLOTS } from "@shared/config/assistantSlots";
import { resolveAppTheme } from "@shared/theme/themes";
import { WorktreeStoreProvider } from "@/contexts/WorktreeStoreContext";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";
import { installPreviewShims } from "./previewShims";
import { HelpPanelHeader } from "../HelpPanelHeader";
import { HelpSessionTabs, type HelpSessionTab } from "../HelpSessionTabs";
import "@/index.css";

// This runs after every static import above has been evaluated — ES modules give no way
// to run code before them — which is fine and worth saying plainly rather than implying
// an ordering guarantee it does not have: nothing here touches the bridge at module
// scope. What needs it reads it when a component mounts, which is later by a wide margin.
installPreviewShims();

/**
 * Standalone visual-review harness for the assistant panel's session-tab strip.
 *
 * The strip only exists when a project has two or three assistant lanes open, which in
 * the real app means launching a second session and waiting for it — no way to look at
 * a state deliberately, and no way at all to see a BACKGROUND lane's marker, which is
 * the whole reason the strip carries state. So this renders the real
 * `HelpPanelHeader` + `HelpSessionTabs` pair against the theme's real tokens, at the
 * panel's real widths, from fixtures that name each state.
 *
 * What is real here: both components, `applyAppThemeToRoot`, `index.css` (so the
 * `.session-tab` rail and its forced-colors and reduced-motion fallbacks are the
 * product's, not a copy), and the panel's own width constants.
 *
 * What is a stand-in, and why it does not matter for this surface:
 *  - The body below the strip is a plain `surface-canvas` block, not the transcript.
 *    It is here only to give the strip its real bottom neighbour, which is what the
 *    "does this read as a second title bar" judgement needs.
 *  - Lane state is passed in as data rather than read from a live session, which is the
 *    only way to look at a BACKGROUND lane's marker at all.
 *
 * Query parameters (so the screenshot spec can drive it):
 *   ?theme=daintree|bondi|…   built-in theme id
 *   ?fixture=three-mixed      which strip state to render
 *   ?width=380                panel width in CSS px (default 380, the app's default)
 */

type AgentState = HelpSessionTab["agentState"];

interface Fixture {
  what: string;
  /** One entry per open lane, in strip order. `null` is a lane with no marker. */
  lanes: AgentState[];
  activeIndex: number;
  /** False draws the unfocused header, which is how the strip looks most of the time. */
  focused: boolean;
}

/**
 * The states that carry design weight. A project runs at most
 * {@link MAX_ASSISTANT_SLOTS} lanes and every label is `Session N`, so there is no
 * long-label case to fixture — but there IS a width case, and an earlier version of
 * this comment got it wrong. Three lanes come to roughly 325px of content against 319px
 * of room at the panel's 320px minimum, so `three-mixed` at `?width=320` is a real
 * pressure test, not a formality. It is also the only place the trailing new-session
 * control's absence matters: at three lanes there is nowhere to put a fourth, so the
 * control is gone and the width it would have cost with it.
 */
const FIXTURES = {
  "one-lane": {
    what: "the state every project starts in — one lane, nothing running",
    lanes: [null],
    activeIndex: 0,
    focused: true,
  },
  "one-lane-working": {
    what: "one lane, busy — the case where header and strip both speak for it",
    lanes: ["working"],
    activeIndex: 0,
    focused: true,
  },
  "two-idle": {
    what: "the common case — two lanes, neither reporting",
    lanes: [null, null],
    activeIndex: 0,
    focused: true,
  },
  "two-background-working": {
    what: "the reason the strip carries state — the lane you cannot see is busy",
    lanes: [null, "working"],
    activeIndex: 0,
    focused: true,
  },
  "three-mixed": {
    what: "all three markers at once — they must stay distinguishable",
    lanes: ["directing", "working", "waiting"],
    activeIndex: 0,
    focused: true,
  },
  "three-active-last": {
    what: "selection on the far lane, with markers either side of it",
    lanes: ["working", "waiting", null],
    activeIndex: 2,
    focused: true,
  },
  unfocused: {
    what: "the panel not focused — no title-bar lift behind the header",
    lanes: [null, "waiting"],
    activeIndex: 0,
    focused: false,
  },
} satisfies Record<string, Fixture>;

type FixtureName = keyof typeof FIXTURES;

/** A predicate, not an assertion — a query parameter is arbitrary input. */
function isFixtureName(value: string): value is FixtureName {
  return Object.prototype.hasOwnProperty.call(FIXTURES, value);
}

export const FIXTURE_NAMES = Object.keys(FIXTURES).filter(isFixtureName);

const params = new URLSearchParams(window.location.search);
const themeId = params.get("theme") ?? "daintree";
const fixtureParam = params.get("fixture") ?? "";
const single: FixtureName | null = isFixtureName(fixtureParam) ? fixtureParam : null;
const width = Number(params.get("width")) || 380;

/**
 * The panel chrome under review: the header, the strip, and enough of the body below it
 * to judge the seam between them.
 */
function Chrome({ name }: { name: FixtureName }) {
  const fixture = FIXTURES[name];
  const [activeSlot, setActiveSlot] = useState(fixture.activeIndex);
  const idBase = useId();
  const bodyId = `${idBase}-body`;

  const tabs: HelpSessionTab[] = fixture.lanes.map((agentState, index) => ({
    slot: index,
    label: `Session ${index + 1}`,
    agentState,
  }));

  return (
    <div className="flex flex-col h-full bg-surface-canvas">
      <HelpPanelHeader
        // The active lane's state, exactly as `HelpPanel` feeds it — the header speaks
        // for the lane on screen and nothing else. Hardcoding `null` here made the one
        // thing the header and the strip can disagree about invisible to the harness.
        agentState={tabs[activeSlot]?.agentState ?? null}
        canRestartConversation
        canEndSession
        onRestartConversation={() => {}}
        onEndSession={() => {}}
        onOpenDocs={() => {}}
        onClose={() => {}}
        isFocused={fixture.focused}
      />
      <HelpSessionTabs
        tabs={tabs}
        activeSlot={activeSlot}
        onSelect={setActiveSlot}
        onClose={() => {}}
        canOpenSession={tabs.length < MAX_ASSISTANT_SLOTS}
        onOpenSession={() => {}}
        idBase={idBase}
        panelId={bodyId}
      />
      {/* Stand-in for the transcript. Deliberately quiet: its only job is to be the
          strip's real bottom neighbour on the theme's canvas. */}
      <div id={bodyId} className="flex-1 min-h-0 px-3 py-3 space-y-2" aria-hidden="true">
        <div className="h-2 w-4/5 rounded-full bg-overlay-soft" />
        <div className="h-2 w-3/5 rounded-full bg-overlay-soft" />
        <div className="h-2 w-2/3 rounded-full bg-overlay-soft" />
      </div>
    </div>
  );
}

function App() {
  const [ready, setReady] = useState(false);
  const scheme = useMemo(() => resolveAppTheme(themeId), []);

  useEffect(() => {
    applyAppThemeToRoot(document.documentElement, scheme);
    // The panel paints its own surface, but the page behind it must be the theme's
    // canvas — a strip screenshotted against browser white makes every contrast
    // judgement taken from it wrong.
    document.body.style.background = "var(--color-surface-canvas)";
    document.body.style.margin = "0";
    setReady(true);
  }, [scheme]);

  if (!ready) return null;

  if (single) {
    return (
      <div data-preview-panel style={{ height: "100vh", width: `${width}px` }}>
        <Chrome name={single} />
      </div>
    );
  }

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: `repeat(${FIXTURE_NAMES.length}, ${width}px)`,
        gap: "16px",
        padding: "16px",
        height: "100vh",
        boxSizing: "border-box",
      }}
    >
      {FIXTURE_NAMES.map((name) => (
        <div
          key={name}
          style={{
            display: "flex",
            flexDirection: "column",
            minHeight: 0,
            border: "1px solid var(--color-border-default)",
            borderRadius: "var(--radius-lg)",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              padding: "6px 10px",
              fontSize: "var(--text-2xs)",
              fontFamily: "ui-monospace, monospace",
              letterSpacing: "0.06em",
              textTransform: "uppercase",
              color: "var(--color-text-muted)",
              background: "var(--color-surface-toolbar)",
              borderBottom: "1px solid var(--color-border-divider)",
            }}
          >
            {name}
          </div>
          <div data-preview-panel style={{ flex: 1, minHeight: 0 }}>
            <Chrome name={name} />
          </div>
        </div>
      ))}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {/* The header's dropdown and anything the strip pulls in reach the per-view
        worktree store the same way the panel does, so the real provider has to sit
        above them — without one the harness renders blank, which is the worst way for
        a visual-review tool to fail. */}
    <WorktreeStoreProvider>
      <App />
    </WorktreeStoreProvider>
  </StrictMode>
);
