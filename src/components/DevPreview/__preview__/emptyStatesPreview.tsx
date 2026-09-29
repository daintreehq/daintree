// First: the bridge stand-in must exist before any client module reads it.
import "./emptyStatesShims";
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { resolveAppTheme } from "@shared/theme/themes";
import { getInvalidCommandMessage } from "@shared/utils/devCommandValidation";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";
import { TooltipProvider } from "@/components/ui/tooltip";
import { DevPreviewEmptyStates } from "../DevPreviewEmptyStates";
import {
  EMPTY_STATE_FIXTURES,
  isEmptyStateFixtureName,
  type EmptyStateFixture,
} from "./emptyStatesFixtures";
import "@/index.css";

/**
 * Standalone visual-review harness for `DevPreviewEmptyStates`.
 *
 * The real component against the real theme tokens and `index.css`, inside a box
 * the size of a grid pane. Every prop `DevPreviewPane` would hand it comes from
 * the `?fixture=` state; the command field holds its own state here so they behave as they do in the app.
 *
 * Query parameters:
 *   ?theme=daintree|bondi|…   built-in theme id
 *   ?fixture=detected         one state; see emptyStatesFixtures.ts
 */

const params = new URLSearchParams(window.location.search);
const fixtureParam = params.get("fixture") ?? "";
const fixture: EmptyStateFixture =
  EMPTY_STATE_FIXTURES[isEmptyStateFixtureName(fixtureParam) ? fixtureParam : "detected"];

applyAppThemeToRoot(document.documentElement, resolveAppTheme(params.get("theme") ?? "daintree"));
document.body.style.background = "var(--color-surface-grid, var(--color-surface-canvas))";
document.body.style.margin = "0";

function Harness() {
  const [commandInput, setCommandInput] = useState(fixture.commandInput ?? "");
  const candidates = fixture.candidates ?? [];

  return (
    <div className="p-6">
      <div
        data-preview-pane
        className="relative overflow-hidden rounded-[var(--radius-lg)] border border-border-default bg-surface-canvas"
        style={{ width: fixture.width ?? 640, height: fixture.height ?? 440 }}
      >
        <DevPreviewEmptyStates
          isRestarting={fixture.isRestarting ?? false}
          status={fixture.status}
          isProxyUrlPending={false}
          error={fixture.error ?? null}
          handleRetry={() => undefined}
          setDevPreviewConsoleOpen={() => undefined}
          id="dev-preview-bbda886a-4f1c"
          currentUrl={fixture.currentUrl ?? ""}
          handleOpenExternal={() => undefined}
          isUnconfigured={fixture.isUnconfigured ?? false}
          primaryCandidate={candidates[0]}
          isAutoDetecting={fixture.isAutoDetecting ?? false}
          attemptingCommand={fixture.attemptingCommand ?? null}
          isSettingsLoading={false}
          handleAutoDetect={async () => true}
          autoDetectFailedCommand={fixture.autoDetectFailedCommand ?? null}
          candidates={candidates}
          handlePickCandidate={() => undefined}
          handleOpenSettings={() => undefined}
          commandInput={commandInput}
          setCommandInput={setCommandInput}
          handleSaveCommand={async () => undefined}
          commandInputError={getInvalidCommandMessage(commandInput)}
          isSavingCommand={fixture.isSavingCommand ?? false}
          saveCommandFailed={fixture.saveCommandFailed ?? false}
          devCommand={fixture.devCommand ?? ""}
          handleStartFromRestored={() => undefined}
          hasBeenVisible={fixture.hasBeenVisible ?? true}
          isEvicted={fixture.isEvicted ?? false}
        />
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TooltipProvider>
      <Harness />
    </TooltipProvider>
  </StrictMode>
);
