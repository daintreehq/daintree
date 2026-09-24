import "./installConsoleShims";
import "./installShims";
import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { resolveAppTheme } from "@shared/theme/themes";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";
import { TooltipProvider } from "@/components/ui/tooltip";
import { flushConsoleCaptureBuffer, useConsoleCaptureStore } from "@/store/consoleCaptureStore";
import { ConsolePanel } from "../ConsolePanel";
import {
  CONSOLE_FIXTURES,
  CONSOLE_PANE_ID,
  isConsoleFixtureName,
  type ConsoleFixtureName,
  type ConsoleStackFixture,
} from "./consoleFixtures";
import "@/index.css";

/**
 * Standalone visual-review harness for the dev preview console's stack traces.
 *
 * A stack trace only exists once a guest page has thrown, warned, or traced, so
 * every state here needs a live dev server that misbehaves on cue. This mounts
 * the REAL `ConsolePanel` and feeds it rows through the real ingest seam
 * (`addStructuredMessage`, the method the IPC listener calls), shaped the way
 * the main-process CDP mapper emits them, against the real theme tokens and
 * `index.css`.
 *
 * Query parameters:
 *   ?theme=daintree|bondi|…   built-in theme id
 *   ?fixture=session-collapsed one state; required
 */

const params = new URLSearchParams(window.location.search);
const themeId = params.get("theme") ?? "daintree";
const fixtureParam = params.get("fixture") ?? "session-collapsed";
const fixtureName: ConsoleFixtureName = isConsoleFixtureName(fixtureParam)
  ? fixtureParam
  : "session-collapsed";
const fixture: ConsoleStackFixture = CONSOLE_FIXTURES[fixtureName];

function seedRows(): void {
  const base = new Date(2026, 8, 24, 14, 32, 7, 118).getTime();
  const { addStructuredMessage } = useConsoleCaptureStore.getState();
  fixture.rows.forEach((row, i) => {
    addStructuredMessage({
      ...row,
      id: i + 1,
      paneId: CONSOLE_PANE_ID,
      groupDepth: 0,
      navigationGeneration: 0,
      timestamp: base + i * 1_437,
    });
  });
  flushConsoleCaptureBuffer();
}

function App() {
  const [ready, setReady] = useState(false);
  const scheme = useMemo(() => resolveAppTheme(themeId), []);
  useEffect(() => {
    seedRows();
    applyAppThemeToRoot(document.documentElement, scheme);
    document.body.style.background = "var(--color-surface-canvas)";
    document.body.style.margin = "0";
    setReady(true);
  }, [scheme]);
  if (!ready) return null;
  return (
    <TooltipProvider delayDuration={0}>
      <div className="bg-surface-canvas p-2">
        <div
          data-fixture={fixtureName}
          className="border border-overlay rounded-sm overflow-hidden"
          style={{ width: fixture.width, height: fixture.height }}
        >
          {/* A webContents id makes object arguments expandable, as in the app. */}
          <ConsolePanel paneId={CONSOLE_PANE_ID} webContentsId={1} />
        </div>
      </div>
    </TooltipProvider>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
