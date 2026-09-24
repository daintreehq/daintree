import "./scrollPillShims";
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
  GRID_MIN_PANEL_ROWS,
  MIN_TERMINAL_WIDTH_PX,
  computeScrollRowHeight,
  pxForRows,
} from "@/lib/terminalLayout";
import { GridScrollbar, GRID_SCROLLBAR_GUTTER_PX } from "../GridScrollbar";
import "@/index.css";

/**
 * Standalone visual-review harness for the panel grid's custom scrollbar.
 *
 * Mounts the real `GridScrollbar` beside a scroll container carrying the same
 * inline layout `ContentGridDefault` gives `#panel-grid` in scroll mode — grid
 * columns, row height from `computeScrollRowHeight`, the 4px gap, the reserved
 * right gutter — filled with panes that hold real xterms, so the bar is judged
 * next to the xterm overlay scrollbar it actually sits beside.
 *
 * Stand-ins: the pane header is a quiet title row, not the real `PanelHeader`.
 * The native scrollbar is hidden inline because the app's `#panel-grid` rule is
 * id-scoped.
 *
 * Query parameters:
 *   ?theme=daintree|bondi|…   built-in theme id
 *   ?fixture=<slug>           one of FIXTURES below
 */

const params = new URLSearchParams(window.location.search);
const themeId = params.get("theme") ?? "daintree";
const fixtureSlug = params.get("fixture") ?? "top";

interface Fixture {
  slug: string;
  panes: number;
  cols: number;
  width: number;
  height: number;
  /** 0..1 of the scroll range; ignored when the grid does not scroll. */
  scroll: number;
  /** Non-scroll mode: rows stretch to fill, no gutter, no bar. */
  fit?: boolean;
  /** Quiet stand-in panes without xterms, for fleets too large to boot 100+ terminals. */
  lite?: boolean;
}

/** Mirrored as `FIXTURES` in the spec — keep the two lists in step. */
const FIXTURES: Fixture[] = [
  { slug: "top", panes: 6, cols: 2, width: 1100, height: 700, scroll: 0 },
  { slug: "middle", panes: 6, cols: 2, width: 1100, height: 700, scroll: 0.5 },
  { slug: "bottom", panes: 6, cols: 2, width: 1100, height: 700, scroll: 1 },
  { slug: "hover", panes: 6, cols: 2, width: 1100, height: 700, scroll: 0.5 },
  { slug: "drag", panes: 6, cols: 2, width: 1100, height: 700, scroll: 0.5 },
  { slug: "track-hover", panes: 6, cols: 2, width: 1100, height: 700, scroll: 0.5 },
  { slug: "pane-hover", panes: 6, cols: 2, width: 1100, height: 700, scroll: 0 },
  { slug: "tall", panes: 10, cols: 2, width: 1100, height: 1080, scroll: 0.3 },
  { slug: "fleet", panes: 36, cols: 3, width: 1300, height: 700, scroll: 0.4 },
  { slug: "min-thumb", panes: 150, cols: 3, width: 1300, height: 700, scroll: 0.6, lite: true },
  { slug: "single-column", panes: 3, cols: 1, width: 560, height: 700, scroll: 0.5 },
  { slug: "fit", panes: 4, cols: 2, width: 1100, height: 700, scroll: 0, fit: true },
];

const TITLES = [
  "Claude · issue-12383 menu rows",
  "Codex · fleet saved scopes",
  "Gemini · worktree card PR number",
  "zsh · ~/Projects/daintree",
  "Claude · terminal scroll pill",
  "OpenCode · diff viewer reflow",
];

const ESC = "\x1b[";
const dim = (s: string) => `${ESC}2m${s}${ESC}0m`;
const green = (s: string) => `${ESC}32m${s}${ESC}0m`;
const cyan = (s: string) => `${ESC}36m${s}${ESC}0m`;

function paneLog(index: number): string[] {
  const lines = [`${cyan("~/Projects/daintree")} ${dim("develop")} $ npm test`, ""];
  for (let i = 0; i < 70; i++) {
    lines.push(
      ` ${green("✓")} src/components/Terminal/__tests__/case-${index}-${i}.test.tsx ${dim(`(${8 + ((i * 7) % 23)} tests) ${40 + ((i * 37) % 900)}ms`)}`
    );
  }
  return lines;
}

function XtermPane({
  index,
  scheme,
}: {
  index: number;
  scheme: ReturnType<typeof resolveAppTheme>;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const background = getTerminalThemeFromAppScheme(scheme).background ?? "transparent";
  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const term = new Terminal({
      ...BASE_TERMINAL_OPTIONS,
      fontSize: DEFAULT_TERMINAL_FONT_SIZE,
      fontFamily: DEFAULT_TERMINAL_FONT_FAMILY,
      theme: getTerminalThemeFromAppScheme(scheme),
      scrollback: 1000,
      cursorBlink: false,
      scrollbar: { width: TERMINAL_SCROLLBAR_WIDTH },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    fit.fit();
    term.write(paneLog(index).join("\r\n"), () => {
      el.dataset.ready = "true";
    });
    return () => term.dispose();
  }, [index, scheme]);
  return (
    <div
      data-preview-pane=""
      className="flex flex-col overflow-hidden rounded-[var(--radius-lg)] border border-border-default bg-surface-panel"
      style={{ contain: "content" }}
    >
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border-subtle px-3">
        <span className="truncate text-xs text-text-secondary">
          {TITLES[index % TITLES.length]}
        </span>
      </div>
      <div className="min-h-0 flex-1 p-3" style={{ backgroundColor: background }}>
        <div ref={hostRef} data-xterm-host="" className="h-full w-full min-h-0 min-w-0" />
      </div>
    </div>
  );
}

function LitePane({ index }: { index: number }) {
  return (
    <div
      data-preview-pane=""
      className="flex flex-col overflow-hidden rounded-[var(--radius-lg)] border border-border-default bg-surface-panel"
    >
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border-subtle px-3">
        <span className="truncate text-xs text-text-secondary">
          {TITLES[index % TITLES.length]}
        </span>
      </div>
      <div className="min-h-0 flex-1 bg-surface-canvas" />
    </div>
  );
}

function GridFixture({
  fixture,
  scheme,
}: {
  fixture: Fixture;
  scheme: ReturnType<typeof resolveAppTheme>;
}) {
  const [scrollRoot, setScrollRoot] = useState<HTMLDivElement | null>(null);
  const isScrollMode = !fixture.fit;
  const rowHeight = computeScrollRowHeight(fixture.height);
  return (
    <div data-shot={fixture.slug} className="p-3">
      <div
        data-preview-frame=""
        className="relative overflow-hidden border border-border-subtle"
        style={{ width: fixture.width, height: fixture.height }}
      >
        <div
          ref={setScrollRoot}
          data-preview-grid=""
          className="h-full bg-noise p-1"
          style={{
            display: "grid",
            gridTemplateColumns: `repeat(${fixture.cols}, minmax(min(100%, ${MIN_TERMINAL_WIDTH_PX}px), 1fr))`,
            gridAutoRows: isScrollMode
              ? `${rowHeight}px`
              : `minmax(${pxForRows(GRID_MIN_PANEL_ROWS)}px, 1fr)`,
            gap: "4px",
            backgroundColor: "var(--color-grid-bg)",
            overflowX: "hidden",
            overflowY: isScrollMode ? "scroll" : "auto",
            scrollbarWidth: "none",
            paddingRight: isScrollMode ? GRID_SCROLLBAR_GUTTER_PX : undefined,
          }}
        >
          {Array.from({ length: fixture.panes }, (_, i) =>
            fixture.lite ? (
              <LitePane key={i} index={i} />
            ) : (
              <XtermPane key={i} index={i} scheme={scheme} />
            )
          )}
        </div>
        <GridScrollbar scrollRoot={scrollRoot} revision={`${fixture.panes}:${fixture.cols}`} />
      </div>
    </div>
  );
}

function App() {
  const [ready, setReady] = useState(false);
  const scheme = useMemo(() => resolveAppTheme(themeId), []);
  const fixture = FIXTURES.find((f) => f.slug === fixtureSlug);

  useEffect(() => {
    applyAppThemeToRoot(document.documentElement, scheme);
    document.body.style.background = "var(--color-surface-canvas)";
    document.body.style.margin = "0";
    void document.fonts
      .load(`${DEFAULT_TERMINAL_FONT_SIZE}px "JetBrains Mono"`)
      .finally(() => setReady(true));
  }, [scheme]);

  if (!fixture) throw new Error(`unknown fixture ${fixtureSlug}`);
  if (!ready) return null;

  return (
    <div data-preview-shell="" data-fixture-scroll={fixture.scroll}>
      <GridFixture fixture={fixture} scheme={scheme} />
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
