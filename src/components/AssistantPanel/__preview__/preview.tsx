import { StrictMode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { resolveAppTheme } from "@shared/theme/themes";
import { WorktreeStoreProvider } from "@/contexts/WorktreeStoreContext";
import { installPreviewShims } from "./previewShims";
import { useAppThemeStore } from "@/store/appThemeStore";
import { useTerminalFontStore } from "@/store/terminalFontStore";
import { AssistantPanelView } from "../AssistantPanelView";
import type { AssistantSessionState } from "@/store/assistantStore";
import { CAPTURED_STATES, type CapturedStateName } from "./capturedStates";
import { PROSE_SPECIMEN } from "./proseSpecimen";
import { OPERATIONS_SPECIMEN } from "./operationsSpecimen";
import "@/index.css";

// As early as this module's own body runs, which is AFTER every static import above has
// already been evaluated — ES modules give no way to run code before them. That is fine
// and worth saying plainly rather than implying an ordering guarantee this does not
// have: nothing here touches the bridge at module scope. The stores that need it read it
// when a component mounts, which is later than this by a wide margin.
installPreviewShims();

/**
 * States CAPTURED from the real pipeline (`e2e/helpers/captureAssistantStates.mts`):
 * the fake engine's actual frames, through the real transport, the real Zod
 * validation and the real reducer. Reviewing hand-written fixtures would review a
 * designer's belief about what the panel receives; these are what it receives.
 */
/**
 * The captured states, plus one HAND-WRITTEN prose specimen.
 *
 * The specimen is kept separate and named as such (see `proseSpecimen.ts`): the
 * captured states are valuable precisely because nobody wrote them, and the specimen is
 * valuable precisely because someone did — it contains one of every element the
 * transcript styles, which no scripted lifecycle turn does.
 */
const STATES = {
  ...CAPTURED_STATES,
  prose: PROSE_SPECIMEN,
  operations: OPERATIONS_SPECIMEN,
} satisfies Record<string, AssistantSessionState>;
type StateName = CapturedStateName | "prose" | "operations";

/**
 * A type PREDICATE, not an assertion. `Object.keys` widens to `string[]` and a query
 * parameter is arbitrary input; narrowing by check means an unknown name is rejected
 * rather than rendered as `undefined` and crashed on.
 */
function isStateName(value: string): value is StateName {
  return Object.prototype.hasOwnProperty.call(STATES, value);
}

const STATE_NAMES = Object.keys(STATES).filter(isStateName);

/**
 * Standalone visual-review harness for the assistant panel.
 *
 * Served by its own Vite entry (`assistant-preview.html`) rather than mounted inside
 * the app, because the panel is otherwise only reachable with a live engine mid-turn
 * — which is no way to check that a surface looks right. This renders every fixture
 * state, in a chosen theme, at the panel's real width, so a screenshot pass can
 * compare them deliberately.
 *
 * The theme is applied through the app's own theme store, not a hand-copied
 * palette: a preview that approximates the tokens would validate a design that does
 * not exist in the product.
 *
 * Query parameters (so a screenshot script can drive it):
 *   ?theme=daintree|bondi|…   built-in theme id
 *   ?fixture=streaming        render one fixture full-height instead of the grid
 *   width and fontSize       review a sidebar width and terminal font size
 */

const params = new URLSearchParams(window.location.search);
const themeId = params.get("theme") ?? "daintree";
const width = Math.max(320, Math.min(960, Number(params.get("width")) || 380));
const fontSize = Math.max(11, Math.min(24, Number(params.get("fontSize")) || 12));
const fixtureParam = params.get("fixture");
const single: StateName | null = fixtureParam && isStateName(fixtureParam) ? fixtureParam : null;
/**
 * Force the auto-approve banner on, whatever the fixture captured.
 *
 * The banner is a session SETTING, not a frame the engine ever sends, so no captured
 * state carries it and the masthead below the welcome block cannot otherwise be
 * reviewed with the row that sits there in the product for most real users.
 */
const forceAutoApprove = params.get("autoApprove") === "1";

/**
 * Stable no-op route for the specimen's references.
 *
 * Declared at module scope rather than inline: `onActivateReference` reaches a memoized
 * component, and a fresh closure per render is exactly the mistake the prop's own
 * documentation warns about. A harness that models the prop wrongly would review a
 * rendering the product never produces.
 */
const noopRoute = () => {};

function Panel({ name }: { name: StateName }) {
  const state = useMemo(() => {
    const base = STATES[name]!;
    const captured = forceAutoApprove ? { ...base, autoApprove: true } : base;
    if (captured.turnStartedAt === null) return captured;
    // Rebase the live clock so an old capture does not appear to have run for weeks.
    const offset = Date.now() - (captured.lastActivityAt ?? captured.turnStartedAt);
    return {
      ...captured,
      turnStartedAt: captured.turnStartedAt + offset,
      lastActivityAt: captured.lastActivityAt === null ? null : captured.lastActivityAt + offset,
    };
  }, [name]);
  const [operationsOpen, setOperationsOpen] = useState(name === "operations");
  return (
    <AssistantPanelView
      state={state}
      composerId={`assistant-preview-${name}`}
      operationsOpen={operationsOpen}
      onOperationsOpenChange={setOperationsOpen}
      onRequestOperations={noopRoute}
      onRequestTimers={noopRoute}
      onSubmit={() => true}
      onInterrupt={() => {}}
      onDecideApproval={() => {}}
      // Needed for the question sheet to render at all — the panel treats a missing
      // handler as "this surface cannot answer" and draws nothing, so without it the
      // captured question states would review a composer with no sheet above it.
      onAnswerQuestion={() => true}
      // Both are needed for a reference to render as a link at all — recognition is
      // gated on the capability and rendering on the handler. Without them the
      // specimen's `PR #11250` shows as plain text and the affordance under review is
      // simply absent from the picture.
      forgeAvailable
      onActivateReference={noopRoute}
    />
  );
}

function App() {
  const [ready, setReady] = useState(false);
  const scheme = useMemo(() => resolveAppTheme(themeId), []);

  useEffect(() => {
    useAppThemeStore.getState().setSelectedSchemeIdSilent(scheme.id, { crossfade: false });
    useTerminalFontStore.getState().setFontSize(fontSize);
    // The panel paints its own surface, but the page behind it must be the theme's
    // canvas — otherwise a screenshot shows the panel floating on browser white and
    // every contrast judgement made from it is wrong.
    document.body.style.background = "var(--color-surface-canvas)";
    document.body.style.margin = "0";
    setReady(true);
  }, [scheme]);

  if (!ready) return null;

  if (single) {
    return (
      <div style={{ height: "100vh", width: `${width}px` }}>
        <Panel name={single} />
      </div>
    );
  }

  const names = STATE_NAMES;
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: `repeat(${names.length}, ${width}px)`,
        gap: "16px",
        padding: "16px",
        height: "100vh",
        boxSizing: "border-box",
      }}
    >
      {names.map((name) => (
        <div
          key={name}
          style={{
            display: "flex",
            flexDirection: "column",
            minHeight: 0,
            border: "1px solid var(--color-border-default)",
            borderRadius: "var(--radius-sm)",
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
          <div style={{ flex: 1, minHeight: 0 }}>
            <Panel name={name} />
          </div>
        </div>
      ))}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {/* The composer is the terminal's real input bar, which reads the per-view worktree
        store — so the harness needs the real provider above it. Without one every
        fixture threw and the page rendered blank, which is the worst way for a visual
        review tool to fail: it looks like the panel, and it is nothing. */}
    <WorktreeStoreProvider>
      <App />
    </WorktreeStoreProvider>
  </StrictMode>
);
