import "./buttonStatesBootstrap";
import { Component, StrictMode, useEffect, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { resolveAppTheme } from "@shared/theme/themes";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";
import { initBuiltInPanelKinds } from "@/panels/registry";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useAppThemeStore } from "@/store/appThemeStore";
import { SettingsValidationProvider } from "@/components/Settings/SettingsValidationRegistry";
import { SettingsFlushProvider } from "@/components/Settings/SettingsFlushRegistry";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import type { Fixture } from "./buttonStatesFrame";
import { REVIEW_SETTINGS_FIXTURES } from "./buttonStatesReviewSettings";
import { SURFACE_FIXTURES } from "./buttonStatesSurfaces";
import "@/index.css";

// Dynamic rather than static so the harness entry obeys the app's lazy-load rule
// (#7659). The setup surfaces animate with `m.*`, which needs a feature provider.
const { LazyMotion, domAnimation } = await import("framer-motion");

/**
 * Visual-review harness for button loading, disabled, destructive, icon-gap and
 * size-override states across the app.
 *
 * Every fixture mounts the SHIPPED component — the Review Hub commit panel, the
 * Settings tabs, the recovery banner, the setup wizard, the worktree card rows —
 * fed through its real props and stores, under the real theme tokens and
 * `index.css`. The bridge is shimmed (`buttonStatesBootstrap.ts`) so each
 * surface's reads resolve to a plausible fixture, and its writes can be held
 * pending: the spec flips `window.__buttonStatesHold` and then clicks the control
 * the way a user does, which is the only honest road to an "…ing" state.
 *
 * Only the captions and the block frames around stacked components are harness
 * decoration (`data-harness-decoration`).
 *
 * Query parameters:
 *   ?theme=daintree|svalbard|…   built-in theme id
 *   ?fixture=<name>              one of FIXTURES below
 *   plus per-fixture knobs documented on the fixture (`collecting`, `git`, `first`, …)
 */

const FIXTURES: Record<string, Fixture> = { ...REVIEW_SETTINGS_FIXTURES, ...SURFACE_FIXTURES };

const params = new URLSearchParams(window.location.search);
const themeId = params.get("theme") ?? "daintree";
const fixtureName = params.get("fixture") ?? "primitive";
const fixture = FIXTURES[fixtureName];
if (!fixture) {
  throw new Error(
    `unknown fixture "${fixtureName}" — expected one of ${Object.keys(FIXTURES).join(", ")}`
  );
}

applyAppThemeToRoot(document.documentElement, resolveAppTheme(themeId));
document.documentElement.style.height = "auto";
document.body.style.height = "auto";
document.body.style.overflow = "visible";
document.body.style.background = "var(--color-surface-canvas)";
document.body.style.margin = "0";

// Seeded before the first render, never from inside a component body.
initBuiltInPanelKinds();
useAppThemeStore.setState({ selectedSchemeId: themeId });
fixture.seed?.();

/**
 * A fixture that throws must fail the capture loudly, not photograph an empty
 * frame: the message lands on `data-preview-error`, which the spec checks.
 */
class FixtureBoundary extends Component<{ children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null };
  static getDerivedStateFromError(error: unknown) {
    return { error: formatErrorMessage(error, "fixture threw") };
  }
  componentDidCatch(error: unknown) {
    document.documentElement.setAttribute(
      "data-preview-error",
      formatErrorMessage(error, "fixture threw")
    );
  }
  render() {
    return this.state.error ? (
      <pre className="text-xs text-status-error">{this.state.error}</pre>
    ) : (
      this.props.children
    );
  }
}

function Ready() {
  useEffect(() => {
    document.documentElement.setAttribute("data-preview-ready", "");
  }, []);
  return null;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <LazyMotion features={domAnimation}>
      <TooltipProvider>
        <SettingsValidationProvider>
          <SettingsFlushProvider>
            <div className="p-4">
              <div
                data-preview-surface
                data-fixture={fixtureName}
                className="inline-block"
                style={{ width: fixture.width ? `${fixture.width}px` : undefined }}
              >
                <FixtureBoundary>{fixture.render()}</FixtureBoundary>
              </div>
            </div>
          </SettingsFlushProvider>
        </SettingsValidationProvider>
        <Ready />
      </TooltipProvider>
    </LazyMotion>
  </StrictMode>
);
