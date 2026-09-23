import "./scrollPillShims";
import { StrictMode, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { resolveAppTheme } from "@shared/theme/themes";
import { getTerminalThemeFromAppScheme } from "@shared/theme/terminal";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";
import { cn } from "@/lib/utils";
import { BASE_TERMINAL_OPTIONS, TERMINAL_SCROLLBAR_WIDTH } from "@/config/xtermConfig";
import { DEFAULT_TERMINAL_FONT_FAMILY, DEFAULT_TERMINAL_FONT_SIZE } from "@/config/terminalFont";
import { terminalInstanceService } from "@/services/TerminalInstanceService";
import { usePanelStore } from "@/store/panelStore";
import { useFleetArmingStore } from "@/store/fleetArmingStore";
import type { PtyPanelData } from "@shared/types/panel";
import { FleetDraftingPill } from "@/components/Fleet/FleetDraftingPill";
import { ScrollIndicator } from "@/components/Worktree/ScrollIndicator";
import { TerminalScrollIndicator } from "../TerminalScrollIndicator";
import "@/index.css";

/**
 * Standalone visual-review harness for the terminal's "New output below" pill.
 *
 * The pill only exists while a pane is scrolled back AND output has landed
 * below — a state nobody photographs on purpose, and one that lasts until the
 * next wheel tick. This mounts the real `TerminalScrollIndicator` over a real
 * xterm (same options, same theme mapping, same padded wrapper as
 * `XtermAdapter`) holding a scrolled-back build log, so the pill is judged
 * against the glyphs, colours and overlay scrollbar it actually covers.
 *
 * The unseen-output seam is the terminal service's own: its three read
 * methods are pointed at a fixed "scrolled back, 40 unseen" snapshot, so the
 * component's real `useUnseenOutput` path decides visibility.
 *
 * The sidebar rows mount the real worktree `ScrollIndicator`, which shares the
 * `ScrollPill` chrome — a change to the primitive has to be judged on both.
 *
 * Stand-ins: the pane header and the hybrid input bar are quiet blocks, and the
 * sidebar cards are text rows at the card's type sizes.
 *
 * Query parameters:
 *   ?theme=daintree|bondi|…   built-in theme id
 */

const params = new URLSearchParams(window.location.search);
const themeId = params.get("theme") ?? "daintree";

const UNSEEN = { isUserScrolledBack: true, unseen: 40 };
Object.assign(terminalInstanceService, {
  subscribeUnseenOutput: () => () => {},
  getUnseenOutputSnapshot: () => UNSEEN,
  getLastWheelAt: () => 0,
  resumeAutoScroll: () => {},
  focus: () => {},
});

function fleetPane(id: string): PtyPanelData {
  return {
    id,
    title: id,
    kind: "terminal",
    cwd: "/Users/dev/Projects/daintree",
    cols: 120,
    rows: 40,
    detectedAgentId: "claude",
    worktreeId: "wt-main",
    projectId: "proj",
    location: "grid",
    agentState: "working",
    hasPty: true,
  } as PtyPanelData;
}

const FLEET_IDS = ["fleet-1", "fleet-2", "fleet-3"];
usePanelStore.setState({
  panelsById: Object.fromEntries(FLEET_IDS.map((id) => [id, fleetPane(id)])),
  panelIds: FLEET_IDS,
  focusedId: "fleet-1",
});
useFleetArmingStore.getState().armIds(FLEET_IDS);

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
  "src/components/Worktree/__tests__/WorktreeCard.render.test.tsx",
  "shared/utils/__tests__/agentFsm.transitions.test.ts",
];

/** A scrolled-back vitest run: long lines to the right edge, colour, a failure block. */
function buildLog(bright: boolean): string[] {
  const lines: string[] = [`${cyan("~/Projects/daintree")} ${dim("develop")} $ npm test`, ""];
  for (let i = 0; i < 90; i++) {
    const suite = SUITES[i % SUITES.length]!;
    const ms = 40 + ((i * 37) % 900);
    if (i % 17 === 9) {
      lines.push(
        ` ${red("❯")} ${suite} ${dim(`(${12 + (i % 9)} tests | 1 failed)`)} ${yellow(`${ms}ms`)}`
      );
      lines.push(
        `   ${red("×")} restores the viewport anchor after a reflow that shrinks the grid by more than one column ${dim(`${ms}ms`)}`
      );
      lines.push(
        `     ${red("→ expected 1487 to be 1486 // Object.is equality — the anchor drifted one row on the second reflow pass")}`
      );
    } else {
      lines.push(` ${green("✓")} ${suite} ${dim(`(${8 + (i % 23)} tests)`)} ${dim(`${ms}ms`)}`);
    }
    if (bright && i % 3 === 0) {
      lines.push(
        ` ${inverse(bold(" WARN "))} ${yellow("[vite] chunk size limit exceeded — dist/renderer/assets/TerminalInstanceService-3f9a2c1e.js is 612.41 kB after minification")}`
      );
    }
  }
  return lines;
}

interface Fixture {
  slug: string;
  width: number;
  height: number;
  /** Agent pane with the hybrid input bar under the viewport. */
  inputBar?: boolean;
  fleet?: boolean;
  bright?: boolean;
}

/** Mirrored as `TERMINAL_STATES` in the spec — keep the two lists in step. */
const TERMINAL_FIXTURES: Fixture[] = [
  { slug: "rest", width: 760, height: 360, inputBar: true },
  { slug: "shell", width: 760, height: 360 },
  { slug: "fleet", width: 760, height: 360, inputBar: true, fleet: true },
  { slug: "bright", width: 760, height: 360, inputBar: true, bright: true },
  { slug: "narrow", width: 360, height: 300, inputBar: true },
  { slug: "hover", width: 760, height: 360, inputBar: true },
  { slug: "focus", width: 760, height: 360, inputBar: true },
];

function XtermSurface({
  bright,
  background,
  scheme,
}: {
  bright: boolean;
  background: string;
  scheme: ReturnType<typeof resolveAppTheme>;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
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
    const rows = term.rows;
    term.write(buildLog(bright).join("\r\n"), () => {
      term.scrollLines(-(rows + 20));
      el.dataset.ready = "true";
    });
    return () => term.dispose();
  }, [bright, scheme]);
  return (
    <div
      className="w-full h-full text-text-primary overflow-hidden pl-3 pt-3 pb-3 pr-3"
      style={{ backgroundColor: background, contain: "strict" }}
    >
      <div ref={containerRef} data-xterm-host="" className="w-full h-full min-h-0 min-w-0" />
    </div>
  );
}

function TerminalRow({
  fixture,
  scheme,
}: {
  fixture: Fixture;
  scheme: ReturnType<typeof resolveAppTheme>;
}) {
  const background = getTerminalThemeFromAppScheme(scheme).background ?? "transparent";
  return (
    <div data-shot={fixture.slug} className="flex flex-col gap-1 p-3">
      <div className="font-mono text-2xs text-text-muted">{fixture.slug}</div>
      <div
        data-preview-pane=""
        className="flex flex-col overflow-hidden rounded-[var(--radius-lg)] border border-border-default bg-surface-panel"
        style={{ width: fixture.width, height: fixture.height }}
      >
        <div
          aria-hidden="true"
          className="flex h-8 shrink-0 items-center gap-2 border-b border-border-subtle px-3"
        >
          <div className="h-2 w-40 rounded-full bg-overlay-soft" />
        </div>
        <div className="flex-1 min-h-0 bg-surface-canvas flex flex-col">
          <div className="flex-1 relative min-h-0">
            <div className="absolute inset-0">
              <XtermSurface
                bright={fixture.bright ?? false}
                background={background}
                scheme={scheme}
              />
            </div>
            <TerminalScrollIndicator terminalId={`preview-${fixture.slug}`} />
            {fixture.fleet && (
              <div className="absolute inset-0 z-30 pointer-events-none overflow-hidden flex items-end justify-start pb-1.5 pl-[14px]">
                <div className="pointer-events-auto">
                  <FleetDraftingPill />
                </div>
              </div>
            )}
          </div>
          {fixture.inputBar && (
            <div
              aria-hidden="true"
              className="shrink-0 border-t border-border-subtle p-2"
              style={{ backgroundColor: background }}
            >
              <div className="h-8 rounded-[var(--radius-md)] border border-border-default bg-surface-input" />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const CARDS = [
  ["daintree", "develop", "3 sessions · 2 working"],
  ["issue-12383", "bugfix/issue-12383-menu-rows-show-keyboard-focus", "1 session · waiting"],
  ["issue-12381", "bugfix/issue-12381-worktree-card-shows-pr-number", "6 files changed"],
  ["design-terminal-scroll-pill", "design/terminal-scroll-pill", "2 sessions · idle"],
  ["feature-fleet-scopes", "feature/fleet-saved-scopes-predicate-filter", "12 files changed"],
];

/** Mirrored as `SIDEBAR_STATES` in the spec. */
const SIDEBAR_FIXTURES = [
  { slug: "sidebar-below", direction: "below" as const, count: 4 },
  { slug: "sidebar-above", direction: "above" as const, count: 12 },
];

function SidebarRow({
  slug,
  direction,
  count,
}: {
  slug: string;
  direction: "above" | "below";
  count: number;
}) {
  return (
    <div data-shot={slug} className="flex flex-col gap-1 p-3">
      <div className="font-mono text-2xs text-text-muted">{slug}</div>
      <div
        data-preview-pane=""
        className="relative overflow-hidden border border-border-subtle"
        style={{ width: 260, height: 220, background: "var(--color-surface-sidebar)" }}
      >
        <div className="flex flex-col">
          {CARDS.map(([name, branch, meta]) => (
            <div key={name} className="border-b border-divider py-2 pl-4 pr-4">
              <div className="truncate text-sm font-medium text-text-primary">{name}</div>
              <div className="truncate font-mono text-xs text-text-secondary">{branch}</div>
              <div className="truncate text-xs text-text-secondary">{meta}</div>
            </div>
          ))}
        </div>
        <ScrollIndicator direction={direction} count={count} onClick={() => {}} />
      </div>
    </div>
  );
}

function App() {
  const [ready, setReady] = useState(false);
  const scheme = useMemo(() => resolveAppTheme(themeId), []);

  useEffect(() => {
    applyAppThemeToRoot(document.documentElement, scheme);
    for (const el of [document.documentElement, document.body]) {
      el.style.height = "auto";
      el.style.overflow = "visible";
    }
    document.body.style.background = "var(--color-surface-canvas)";
    document.body.style.margin = "0";
    // xterm measures its cell once, at open — a fallback face there would size
    // every row wrong and put the pill over the wrong glyphs.
    void document.fonts
      .load(`${DEFAULT_TERMINAL_FONT_SIZE}px "JetBrains Mono"`)
      .finally(() => setReady(true));
  }, [scheme]);

  if (!ready) return null;

  return (
    <div data-preview-shell="" className={cn("flex flex-col py-2")}>
      {TERMINAL_FIXTURES.map((fixture) => (
        <TerminalRow key={fixture.slug} fixture={fixture} scheme={scheme} />
      ))}
      {SIDEBAR_FIXTURES.map((f) => (
        <SidebarRow key={f.slug} {...f} />
      ))}
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
