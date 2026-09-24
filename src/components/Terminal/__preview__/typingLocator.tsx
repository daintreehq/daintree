import "./typingLocatorShims";
import { StrictMode, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { resolveAppTheme } from "@shared/theme/themes";
import { getTerminalThemeFromAppScheme } from "@shared/theme/terminal";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";
import { BASE_TERMINAL_OPTIONS, TERMINAL_SCROLLBAR_WIDTH } from "@/config/xtermConfig";
import { DEFAULT_TERMINAL_FONT_FAMILY, DEFAULT_TERMINAL_FONT_SIZE } from "@/config/terminalFont";
import {
  UI_PALETTE_ENTER_DURATION,
  UI_PALETTE_EXIT_DURATION,
  UI_TRANSIENT_HINT_DWELL_MS,
} from "@/lib/animationUtils";
import { useTypingLocatorStore } from "@/store/typingLocatorStore";
import { TypingLocator } from "../TypingLocator";
import "@/index.css";

/**
 * Standalone visual-review harness for the type-anywhere locator pill (#11134).
 *
 * The pill lives for about a second after a keystroke lands in a pane the user
 * cannot see, so nobody has ever looked at it still. This mounts the real
 * `TypingLocator` exactly where `App.tsx` does — absolutely positioned over the
 * content grid — above a grid of real xterms holding bright build output, so the
 * pill is judged against the pane headers and glyphs it actually covers.
 *
 * The seam is the store the product writes: `window.__typingLocator.show(id)`
 * pushes a fixture label through `showLocator`, the same call `useTypeAnywhere`
 * and `useInsertFileReference` make.
 *
 * `hold("all")` swallows the component's dwell/exit timers so a settled state can
 * be photographed; `hold("unmount")` lets the fade start but keeps the node.
 *
 * Query parameters:
 *   ?theme=daintree|bondi|…   built-in theme id
 *   ?layout=grid|narrow       2×2 grid at desktop width, or one column at 420px
 */

const params = new URLSearchParams(window.location.search);
const themeId = params.get("theme") ?? "daintree";
const layout = params.get("layout") === "narrow" ? "narrow" : "grid";

const realSetTimeout = window.setTimeout.bind(window);
/**
 * "all" swallows every timer from the dwell up, freezing the pill settled;
 * "unmount" lets the dwell fire but swallows the later unmount, so a stretched
 * exit can be photographed mid-fade.
 */
type HoldMode = "none" | "all" | "unmount";
let holding: HoldMode = "none";
function heldSetTimeout(handler: TimerHandler, delay?: number, ...args: unknown[]): number {
  if (typeof delay === "number") {
    if (holding === "all" && delay >= 500) return -1;
    if (holding === "unmount" && delay > UI_TRANSIENT_HINT_DWELL_MS) return -1;
  }
  return realSetTimeout(handler, delay, ...args);
}
Reflect.set(window, "setTimeout", heldSetTimeout);

/** The labels the two product callers compose, with realistic pane titles. */
const FIXTURES: Record<string, () => void> = {
  locate: () => useTypingLocatorStore.getState().showLocator("Typing into Claude"),
  task: () => useTypingLocatorStore.getState().showLocator("Typing into Fix flaky shard rebalance"),
  long: () =>
    useTypingLocatorStore
      .getState()
      .showLocator(
        "Typing into Refactor TerminalResizeController so reflow keeps the viewport anchor stable across multiple passes"
      ),
  "file-added": () =>
    useTypingLocatorStore.getState().showLocator("File reference added to Claude"),
  refused: () =>
    useTypingLocatorStore.getState().showLocator("No agent is available for a file reference"),
};

declare global {
  interface Window {
    __typingLocator: {
      show: (id: string) => void;
      clear: () => void;
      hold: (mode: HoldMode) => void;
      fixtures: string[];
      timings: { enter: number; exit: number; dwell: number };
    };
  }
}

window.__typingLocator = {
  show: (id) => {
    const fixture = FIXTURES[id];
    if (!fixture) throw new Error(`unknown typing-locator fixture: ${id}`);
    fixture();
  },
  clear: () => useTypingLocatorStore.getState().clearLocator(),
  hold: (mode) => {
    holding = mode;
  },
  fixtures: Object.keys(FIXTURES),
  timings: {
    enter: UI_PALETTE_ENTER_DURATION,
    exit: UI_PALETTE_EXIT_DURATION,
    dwell: UI_TRANSIENT_HINT_DWELL_MS,
  },
};

const ESC = "\x1b[";
const dim = (s: string) => `${ESC}2m${s}${ESC}0m`;
const red = (s: string) => `${ESC}31m${s}${ESC}0m`;
const green = (s: string) => `${ESC}32m${s}${ESC}0m`;
const yellow = (s: string) => `${ESC}33m${s}${ESC}0m`;
const cyan = (s: string) => `${ESC}36m${s}${ESC}0m`;
const bold = (s: string) => `${ESC}1m${s}${ESC}0m`;
const inverse = (s: string) => `${ESC}7m${s}${ESC}0m`;

const SUITES = [
  "src/components/Terminal/__tests__/TerminalPane.test.tsx",
  "src/services/terminal/__tests__/TerminalResizeController.test.ts",
  "src/store/__tests__/panelStore.persistence.test.ts",
  "electron/services/__tests__/WorktreeMonitor.integration.test.ts",
  "shared/utils/__tests__/agentFsm.transitions.test.ts",
];

/** Dense coloured output to the right edge — the worst case for an overlay. */
function buildLog(seed: number): string[] {
  const lines: string[] = [`${cyan("~/Projects/daintree")} ${dim("develop")} $ npm test`, ""];
  for (let i = 0; i < 60; i++) {
    const suite = SUITES[(i + seed) % SUITES.length]!;
    const ms = 40 + ((i * 37 + seed * 11) % 900);
    if ((i + seed) % 7 === 3) {
      lines.push(
        ` ${red("❯")} ${suite} ${dim(`(${12 + (i % 9)} tests | 1 failed)`)} ${yellow(`${ms}ms`)}`
      );
      lines.push(
        `     ${red("→ expected 1487 to be 1486 // Object.is equality — anchor drifted on the second reflow")}`
      );
    } else {
      lines.push(` ${green("✓")} ${suite} ${dim(`(${8 + (i % 23)} tests)`)} ${dim(`${ms}ms`)}`);
    }
    if (i % 4 === seed % 4) {
      lines.push(
        ` ${inverse(bold(" WARN "))} ${yellow("[vite] chunk size limit exceeded — dist/renderer/assets/index-3f9a2c1e.js is 612.41 kB")}`
      );
    }
  }
  return lines;
}

function XtermSurface({
  seed,
  scheme,
}: {
  seed: number;
  scheme: ReturnType<typeof resolveAppTheme>;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const background = getTerminalThemeFromAppScheme(scheme).background ?? "transparent";
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const term = new Terminal({
      ...BASE_TERMINAL_OPTIONS,
      fontSize: DEFAULT_TERMINAL_FONT_SIZE,
      fontFamily: DEFAULT_TERMINAL_FONT_FAMILY,
      theme: getTerminalThemeFromAppScheme(scheme),
      scrollback: 2000,
      cursorBlink: false,
      scrollbar: { width: TERMINAL_SCROLLBAR_WIDTH },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    fit.fit();
    term.write(buildLog(seed).join("\r\n"), () => {
      el.dataset.ready = "true";
    });
    return () => term.dispose();
  }, [seed, scheme]);
  return (
    <div
      className="w-full h-full overflow-hidden p-3"
      style={{ backgroundColor: background, contain: "strict" }}
    >
      <div ref={containerRef} data-xterm-host="" className="w-full h-full min-h-0 min-w-0" />
    </div>
  );
}

const PANES = [
  { title: "Claude", meta: "api-refactor" },
  { title: "Fix flaky shard rebalance", meta: "issue-12383" },
  { title: "Codex", meta: "develop" },
  { title: "npm run dev", meta: "develop" },
];

function Pane({
  seed,
  title,
  meta,
  scheme,
}: {
  seed: number;
  title: string;
  meta: string;
  scheme: ReturnType<typeof resolveAppTheme>;
}) {
  return (
    <div className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-[var(--radius-lg)] border border-border-default bg-surface-panel">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border-subtle bg-overlay-subtle px-3 text-xs">
        <span className="size-2 rounded-full bg-status-success" />
        <span className="truncate font-medium text-text-primary">{title}</span>
        <span className="truncate text-text-secondary">{meta}</span>
      </div>
      <div className="relative min-h-0 flex-1">
        <div className="absolute inset-0">
          <XtermSurface seed={seed} scheme={scheme} />
        </div>
      </div>
    </div>
  );
}

function App() {
  const [ready, setReady] = useState(false);
  const scheme = useMemo(() => resolveAppTheme(themeId), []);

  useEffect(() => {
    applyAppThemeToRoot(document.documentElement, scheme);
    document.body.style.background = "var(--color-surface-canvas)";
    document.body.style.margin = "0";
    void document.fonts
      .load(`${DEFAULT_TERMINAL_FONT_SIZE}px "JetBrains Mono"`)
      .finally(() => setReady(true));
  }, [scheme]);

  if (!ready) return null;

  const panes = layout === "narrow" ? PANES.slice(0, 2) : PANES;
  const size = layout === "narrow" ? { width: 420, height: 640 } : { width: 1200, height: 680 };

  return (
    <div data-preview-shell="" className="p-4">
      {/* Mirrors App.tsx: the locator is a sibling of the grid inside one relative box. */}
      <div data-locator-host="" className="relative" style={size}>
        <div
          className="grid h-full w-full gap-1 p-1"
          style={{
            gridTemplateColumns: layout === "narrow" ? "1fr" : "1fr 1fr",
            gridAutoRows: "1fr",
          }}
        >
          {panes.map((p, i) => (
            <Pane key={p.title} seed={i} title={p.title} meta={p.meta} scheme={scheme} />
          ))}
        </div>
        <TypingLocator />
      </div>
    </div>
  );
}

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>
  );
}
