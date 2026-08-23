import { test, expect } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../../helpers/launch";
import { createFixtureRepo } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import { runTerminalCommand, waitForTerminalText } from "../../helpers/terminal";
import { getFirstGridPanel, openTerminal } from "../../helpers/panels";
import { T_LONG } from "../../helpers/timeouts";

/**
 * Text selection in a pane whose application has claimed the mouse.
 *
 * Every agent CLI that draws a full-screen interface turns on mouse tracking, and the
 * moment it does, xterm hands the pointer to the application: press-and-drag becomes a
 * mouse report and there is no selection left to copy. Reading and quoting what an agent
 * just printed is the most common thing anyone does with these panes, and it silently
 * stopped working as soon as the agent painted — with nothing on screen to say so and no
 * discoverable way to get it back.
 *
 * `mouseEventsRequireAlt` (`src/config/xtermConfig.ts`) inverts that: a plain drag always
 * selects, and Alt/Option + drag sends the mouse report. This pins BOTH halves, because
 * only having both makes it a trade rather than a regression in the other direction.
 */

let ctx: AppContext;
let fixtureDir: string;
let fixtureCleanup: (() => void) | undefined;

/** DECSET 1002: button-event tracking — what a TUI turns on to receive drags. */
const ENABLE_MOUSE_TRACKING = String.raw`printf '\033[?1002h'`;

const MARKER = "SELECTABLE_UNDER_MOUSE_TRACKING";

/** The panel's id, which every terminal test bridge is keyed on. */
async function panelIdOf(panel: ReturnType<typeof getFirstGridPanel>): Promise<string> {
  const id = await panel.evaluate(
    (el) => el.closest("[data-panel-id]")?.getAttribute("data-panel-id") ?? ""
  );
  if (!id) throw new Error("the grid panel has no data-panel-id");
  return id;
}

/**
 * The pane's live mouse-tracking mode, or `null` when the bridge is not installed.
 *
 * Read from the live `Terminal` rather than inferred from what was typed: the setup
 * writes an escape to the PTY and has no way of knowing when it comes back and is
 * parsed, and a drag sent before then tests the case that was never broken.
 */
async function mouseTrackingMode(
  window: AppContext["window"],
  panelId: string
): Promise<string | null> {
  return window.evaluate((id) => {
    const fn = (window as unknown as Record<string, unknown>).__daintreeGetTerminalForE2E;
    if (typeof fn !== "function") return null;
    const term = fn(id) as { modes?: { mouseTrackingMode?: string } } | null;
    return term?.modes?.mouseTrackingMode ?? null;
  }, panelId);
}

async function selection(window: AppContext["window"], panelId: string): Promise<string> {
  return window.evaluate((id) => {
    const fn = (window as unknown as Record<string, unknown>).__daintreeGetTerminalSelection;
    return typeof fn === "function" ? (fn(id) as string) : "";
  }, panelId);
}

/**
 * Drags across the row holding `MARKER`.
 *
 * Coordinates come from the rendered row's own client rect rather than the panel's box:
 * the marker sits on one line of a full-height pane, so anything derived from the pane
 * lands on empty rows below the prompt and the press never starts on a cell.
 */
async function dragAcrossMarker(
  window: AppContext["window"],
  modifier: "none" | "alt"
): Promise<void> {
  const rect = await window.evaluate((marker) => {
    const rows = document.querySelectorAll(".xterm-rows > div");
    for (const row of rows) {
      if (row.textContent?.includes(marker)) {
        const box = row.getBoundingClientRect();
        return { x: box.x, y: box.y + box.height / 2, w: box.width };
      }
    }
    return null;
  }, MARKER);
  if (!rect) throw new Error(`no rendered row contains ${MARKER}`);

  if (modifier === "alt") await window.keyboard.down("Alt");
  try {
    await window.mouse.move(rect.x + 2, rect.y);
    await window.mouse.down();
    await window.mouse.move(rect.x + rect.w / 2, rect.y, { steps: 10 });
    await window.mouse.move(rect.x + rect.w - 2, rect.y, { steps: 10 });
    await window.mouse.up();
  } finally {
    if (modifier === "alt") await window.keyboard.up("Alt");
  }
}

test.describe.serial("Core: Terminal selection under application mouse tracking", () => {
  test.beforeAll(async () => {
    ({ dir: fixtureDir, cleanup: fixtureCleanup } = createFixtureRepo({
      name: "terminal-mouse-selection",
    }));
    ctx = await launchApp();
    ctx.window = await openAndOnboardProject(
      ctx.app,
      ctx.window,
      fixtureDir,
      "Mouse Selection Test"
    );
    await openTerminal(ctx.window);
    const panel = getFirstGridPanel(ctx.window);
    await expect(panel).toBeVisible({ timeout: T_LONG });

    await runTerminalCommand(ctx.window, panel, `echo ${MARKER}`);
    await waitForTerminalText(panel, MARKER, T_LONG);
    // Claim the mouse the way a TUI does, AFTER the marker is on screen so the row
    // being dragged is ordinary output rather than something an app is repainting.
    await runTerminalCommand(ctx.window, panel, ENABLE_MOUSE_TRACKING);
    // Wait for the MODE, not for a fixed interval. A settle long enough on an idle
    // machine is not long enough on a loaded one: the escape has to reach the PTY, come
    // back, and be parsed, and this flaked when another Playwright project was running
    // beside it — the drag then went out under no tracking at all, which is the case
    // that was never broken.
    const trackingPanelId = await panelIdOf(panel);
    await expect
      .poll(() => mouseTrackingMode(ctx.window, trackingPanelId), { timeout: T_LONG })
      .not.toBe("none");
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    fixtureCleanup?.();
  });

  test("a plain drag selects text even while the application owns the mouse", async () => {
    const { window } = ctx;
    const panel = getFirstGridPanel(window);
    const panelId = await panelIdOf(panel);

    await dragAcrossMarker(window, "none");
    expect(await selection(window, panelId)).toContain(MARKER);
  });

  test("Alt+drag hands the mouse back to the application instead of selecting", async () => {
    const { window } = ctx;
    const panel = getFirstGridPanel(window);
    const panelId = await panelIdOf(panel);

    // Collect everything xterm sends UPSTREAM during the gesture. Asserting only that no
    // selection appeared would pass just as happily if the press had been swallowed
    // somewhere before xterm — which is a real failure mode here, since an unfocused
    // pane suppresses its activation click (`shouldSuppressUnfocusedClick`). The mouse
    // report is the positive evidence that the application actually received the drag.
    await window.evaluate((id) => {
      const w = window as unknown as Record<string, unknown>;
      const fn = w.__daintreeGetTerminalForE2E;
      if (typeof fn !== "function") throw new Error("no terminal bridge");
      const term = fn(id) as {
        clearSelection: () => void;
        onData: (cb: (data: string) => void) => unknown;
        onBinary: (cb: (data: string) => void) => unknown;
      };
      term.clearSelection();
      const seen: string[] = [];
      w.__mouseReports = seen;
      // BOTH channels. xterm routes a mouse report through `onData` only for SGR
      // (`?1006`); the legacy default encoding goes out as `onBinary`, and watching just
      // the first makes the test fail against exactly the applications that use the
      // second. (Daintree itself forwards only `onData` to the PTY, so those reports
      // currently stop at the renderer — a separate, pre-existing gap this test does not
      // depend on, since it observes xterm's own event rather than the PTY.)
      term.onData((data: string) => seen.push(data));
      term.onBinary((data: string) => seen.push(data));
    }, panelId);
    expect(await selection(window, panelId)).toBe("");

    await dragAcrossMarker(window, "alt");

    expect(await selection(window, panelId)).toBe("");
    const reports = await window.evaluate(
      () => ((window as unknown as Record<string, unknown>).__mouseReports as string[]) ?? []
    );
    // SGR (`CSI < … M/m`) or the legacy X10 form (`CSI M`), depending on what the
    // application negotiated. Either proves the press was reported rather than eaten.
    // Substring tests rather than regexes: a literal ESC inside a regex is a lint error
    // (`no-control-regex`), and there is no pattern here worth the escape anyway.
    const ESC = "\u001b";
    expect(
      reports.some((d) => d.includes(`${ESC}[<`) || d.includes(`${ESC}[M`)),
      `no mouse report reached the application (got ${JSON.stringify(reports)})`
    ).toBe(true);
  });
});
