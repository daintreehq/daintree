import { StrictMode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { resolveAppTheme } from "@shared/theme/themes";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";
import { AssistantPanelView } from "../AssistantPanelView";
import type { AssistantSessionState } from "@/store/assistantStore";
import { CAPTURED_STATES, type CapturedStateName } from "./capturedStates";
import { PROSE_SPECIMEN } from "./proseSpecimen";
import "@/index.css";

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
} satisfies Record<string, AssistantSessionState>;
type StateName = CapturedStateName | "prose";

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
 * The theme is applied through the app's OWN `applyAppThemeToRoot`, not a hand-copied
 * palette: a preview that approximates the tokens would validate a design that does
 * not exist in the product.
 *
 * Query parameters (so a screenshot script can drive it):
 *   ?theme=daintree|bondi|…   built-in theme id
 *   ?fixture=streaming        render one fixture full-height instead of the grid
 */

const params = new URLSearchParams(window.location.search);
const themeId = params.get("theme") ?? "daintree";
const fixtureParam = params.get("fixture");
const single: StateName | null = fixtureParam && isStateName(fixtureParam) ? fixtureParam : null;

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
  const state = STATES[name]!;
  return (
    <AssistantPanelView
      state={state}
      onSubmit={() => true}
      onInterrupt={() => {}}
      onDecideApproval={() => {}}
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
    applyAppThemeToRoot(document.documentElement, scheme);
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
      <div style={{ height: "100vh", width: "420px" }}>
        <Panel name={single} />
      </div>
    );
  }

  const names = STATE_NAMES;
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: `repeat(${names.length}, 420px)`,
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
            borderRadius: "8px",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              padding: "6px 10px",
              fontSize: "11px",
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
    <App />
  </StrictMode>
);
