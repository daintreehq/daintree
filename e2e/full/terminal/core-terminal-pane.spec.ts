import { test, expect, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "http";
import { tmpdir } from "os";
import path from "path";
import { fileURLToPath } from "url";
import { launchApp, closeApp, type AppContext } from "../../helpers/launch";
import { createFixtureRepo } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import {
  getTerminalDimensions,
  getTerminalSelection,
  getTerminalText,
  getTerminalViewport,
  runTerminalCommand,
  typeTerminalCommand,
  openTerminalContextMenu,
  clickTerminalContextMenuItem,
  triggerTerminalLink,
  waitForTerminalReady,
  waitForTerminalText,
  waitForTerminalTextIgnoringLineBreaks,
} from "../../helpers/terminal";
import {
  copyFullContextFromToolbar,
  expectToolbarButtonReachable,
  getDockPanelCount,
  getFirstGridPanel,
  getGridPanelCount,
  getGridPanelIds,
  getPanelById,
  openTerminal,
} from "../../helpers/panels";
import { spawnTerminalAndVerify } from "../../helpers/workflows";
import { expectTerminalFocused } from "../../helpers/focus";
import { dismissBlockingPalette } from "../../helpers/overlays";
import { getPtyPid, isPidAlive } from "../../helpers/stress";
import { SEL } from "../../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_LONG } from "../../helpers/timeouts";

let ctx: AppContext;
let fixtureDir: string;
let fixtureCleanup: (() => void) | undefined;
let server: Server | undefined;
let port = 0;

type TerminalScrollState = {
  viewportY: number;
  baseY: number;
  rows: number;
  isUserScrolledBack: boolean;
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A context-menu item by its source label, matched case-sensitively. The
 * accessible name also carries the shortcut, so only the start is anchored.
 */
function menuItem(page: Page, label: string): Locator {
  return page.getByRole("menuitem", { name: new RegExp(`^${escapeRegExp(label)}\\b`) });
}

async function panelIdOf(panel: Locator): Promise<string> {
  const id = await panel.getAttribute("data-panel-id");
  if (!id) throw new Error("panel has no data-panel-id");
  return id;
}

/**
 * Bring the group back to an empty grid through the real close path: pull any
 * docked panels back, close every grid panel from its header, and prove both
 * the grid and the dock are empty before the next test starts.
 */
async function resetPanes(page: Page): Promise<void> {
  await dismissBlockingPalette(page);
  await page.keyboard.press("Escape").catch(() => undefined);
  await expect(page.locator('[role="dialog"], [role="alertdialog"]')).toHaveCount(0, {
    timeout: T_SHORT,
  });

  const dock = page.locator(SEL.dock.container);
  for (let i = 0; i < 10 && (await getDockPanelCount(page)) > 0; i++) {
    const before = await getDockPanelCount(page);
    await dock.locator('button[aria-label*="move to grid"]').first().dblclick();
    await expect.poll(() => getDockPanelCount(page), { timeout: T_MEDIUM }).toBeLessThan(before);
  }

  for (let i = 0; i < 20 && (await getGridPanelCount(page)) > 0; i++) {
    const signature = (await getGridPanelIds(page)).join(",");
    await getFirstGridPanel(page).locator(SEL.panel.close).first().click({ force: true });
    await expect
      .poll(async () => (await getGridPanelIds(page)).join(","), { timeout: T_MEDIUM })
      .not.toBe(signature);
  }

  await expect.poll(() => getGridPanelCount(page), { timeout: T_MEDIUM }).toBe(0);
  await expect.poll(() => getDockPanelCount(page), { timeout: T_MEDIUM }).toBe(0);
}

async function readClipboardText(app: ElectronApplication): Promise<string> {
  return app.evaluate(({ clipboard }) => clipboard.readText());
}

/**
 * The path Copy Context put on the clipboard. The bundle is written to a file
 * and the clipboard carries a file reference in the platform's native shape
 * (electron/ipc/handlers/copyTree.ts), so read that shape back.
 */
async function readCopiedContextPath(app: ElectronApplication): Promise<string | null> {
  const raw = await app.evaluate(({ clipboard }) => {
    if (process.platform === "darwin") {
      const xml = clipboard.readBuffer("NSFilenamesPboardType").toString("utf8");
      const match = /<string>([^<]*)<\/string>/.exec(xml);
      return match ? match[1] : null;
    }
    if (process.platform === "win32") return clipboard.readText() || null;
    return clipboard.readBuffer("text/uri-list").toString("utf8").trim() || null;
  });
  if (!raw) return null;
  const unescaped = raw
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
  return unescaped.startsWith("file://") ? fileURLToPath(unescaped) : unescaped;
}

async function getScrollState(page: Page, panelId: string): Promise<TerminalScrollState | null> {
  return page.evaluate((id) => {
    const hook = (
      window as unknown as {
        __daintreeGetTerminalScrollState?: (panelId: string) => TerminalScrollState | null;
      }
    ).__daintreeGetTerminalScrollState;
    return hook?.(id) ?? null;
  }, panelId);
}

/** Buffer row index of the first line that reads exactly `text`. */
async function findBufferRow(panel: Locator, text: string): Promise<number> {
  const rows = (await getTerminalText(panel)).split("\n");
  return rows.findIndex((row) => row.trim() === text);
}

/** Whether the viewport currently shows the buffer row holding `text`. */
async function viewportShowsRow(page: Page, panel: Locator, text: string): Promise<string> {
  const state = await getScrollState(page, await panelIdOf(panel));
  const row = await findBufferRow(panel, text);
  if (!state || row < 0) return `missing state=${JSON.stringify(state)} row=${row}`;
  const visible = row >= state.viewportY && row < state.viewportY + state.rows;
  return visible ? "visible" : `off-screen row=${row} state=${JSON.stringify(state)}`;
}

async function focusXterm(page: Page, panel: Locator): Promise<void> {
  await dismissBlockingPalette(page);
  await panel.locator(".xterm-screen").click();
  await expectTerminalFocused(panel);
}

async function openFindViaEvent(page: Page, panel: Locator): Promise<void> {
  await focusXterm(page, panel);
  await page.evaluate(() =>
    globalThis.window.dispatchEvent(new CustomEvent("daintree:find-in-panel"))
  );
  await expect(panel.locator(SEL.terminal.searchInput)).toBeVisible({ timeout: T_MEDIUM });
}

const FOUND_STATUS = /^(?:\d+ of \d+\+?|\d+\+? matches|Found)$/;

/**
 * A raw stdin recorder: enables bracketed paste, puts the TTY in raw mode so no
 * line discipline or readline rewrites what arrives, and appends every byte to
 * the file named by its first argument. A lone Enter ends it.
 */
const STDIN_RECORDER_SOURCE = `const fs = require("fs");
const out = process.argv[2];
fs.writeFileSync(out, "");
process.stdin.setRawMode(true);
process.stdin.on("data", (chunk) => {
  if (chunk.length === 1 && chunk[0] === 0x0d) {
    process.stdout.write("\\x1b[?2004l");
    process.stdin.setRawMode(false);
    // Exit from the write callback: TTY writes are asynchronous on Windows.
    process.stdout.write("RECORDER_DONE\\n", () => process.exit(0));
    process.stdin.pause();
    return;
  }
  fs.appendFileSync(out, chunk);
});
process.stdout.write("\\x1b[?2004h");
process.stdout.write("RECORDER_READY\\n");
`;

const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";

async function focusXtermInput(panel: Locator): Promise<void> {
  const input = panel.locator(".xterm-helper-textarea");
  await expect
    .poll(
      async () => {
        await input.focus().catch(() => undefined);
        return input.evaluate((el) => el === document.activeElement).catch(() => false);
      },
      { timeout: T_SHORT, message: "xterm input should hold keyboard focus" }
    )
    .toBe(true);
}

/**
 * Right-click the pane to open its menu. Unlike openTerminalContextMenu this
 * never presses Escape first, which would reach a raw-mode program as a byte.
 */
async function rightClickPane(page: Page, panel: Locator): Promise<void> {
  const screen = panel.locator(SEL.terminal.xtermRows);
  const box = await screen.boundingBox();
  if (!box) throw new Error("terminal screen has no bounding box");
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: "right" });
  await expect(page.locator(SEL.contextMenu.content)).toBeVisible({ timeout: T_SHORT });
}

async function clickMenuItem(page: Page, label: string): Promise<void> {
  await menuItem(page, label).first().click();
  await expect(page.locator(SEL.contextMenu.content)).not.toBeVisible({ timeout: T_SHORT });
}

/** Page coordinates of the visible row that reads exactly `text`, a few cells in. */
async function visibleRowPoint(
  page: Page,
  panel: Locator,
  text: string
): Promise<{ x: number; y: number }> {
  const panelId = await panelIdOf(panel);
  const viewport = await getTerminalViewport(page, panelId);
  const dims = await getTerminalDimensions(panel);
  const box = await panel.locator(SEL.terminal.xtermRows).boundingBox();
  if (!viewport || !dims || !box) throw new Error("terminal geometry unavailable");
  const row = viewport.lines.findIndex((line) => line.trim() === text);
  expect(row, `"${text}" should be a visible row in:\n${viewport.text}`).toBeGreaterThanOrEqual(0);
  return {
    x: box.x + (box.width / dims.cols) * 2.5,
    y: box.y + (box.height / dims.rows) * (row + 0.5),
  };
}

/**
 * Negative dwell: `read()` must keep returning `expected` for `ms`. The check
 * only passes once the window has elapsed with the value unchanged, and the
 * recorded file is append-only, so a byte that lands mid-window fails it.
 */
async function expectUnchangedFor(
  read: () => string,
  expected: string,
  ms: number,
  message: string
): Promise<void> {
  const start = Date.now();
  await expect(async () => {
    expect(JSON.stringify(read()), message).toBe(JSON.stringify(expected));
    expect(Date.now() - start).toBeGreaterThanOrEqual(ms);
  }).toPass({ timeout: ms + T_SHORT, intervals: [100] });
}

test.describe("Core: Terminal pane", () => {
  test.beforeAll(async () => {
    server = createServer((_req: IncomingMessage, res: ServerResponse) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html><body><h1>Link Test</h1></body></html>");
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
    const addr = server.address();
    port = typeof addr === "object" && addr ? addr.port : 0;

    ({ dir: fixtureDir, cleanup: fixtureCleanup } = createFixtureRepo({
      name: "terminal-pane",
      withMultipleFiles: true,
    }));
    ctx = await launchApp();
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, fixtureDir, "Terminal Pane");
    await expect(ctx.window.locator("[data-worktree-branch]").first()).toBeVisible({
      timeout: T_LONG,
    });
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    server?.close();
    fixtureCleanup?.();
  });

  // ── Context menu ─────────────────────────────────────────

  test.describe("Context menu", () => {
    let panel: Locator;

    test.beforeEach(async () => {
      await resetPanes(ctx.window);
      panel = await spawnTerminalAndVerify(ctx.window);
      await runTerminalCommand(ctx.window, panel, "echo CONTEXT_MENU_TEST");
      await waitForTerminalText(panel, "CONTEXT_MENU_TEST", T_LONG);
    });

    test("right-click opens the menu with the terminal items and Escape closes it", async () => {
      const { window } = ctx;
      await openTerminalContextMenu(panel);

      const menu = window.locator(SEL.contextMenu.content);
      await expect(menu).toBeVisible({ timeout: T_SHORT });

      for (const name of [
        "Copy",
        "Paste",
        "Restart terminal",
        "Rename terminal",
        "Kill terminal",
      ]) {
        await expect(menuItem(window, name)).toBeVisible({ timeout: T_SHORT });
      }

      await window.keyboard.press("Escape");
      await expect(menu).not.toBeVisible({ timeout: T_SHORT });
    });

    test("Copy is disabled when no text is selected", async () => {
      const { window } = ctx;
      await openTerminalContextMenu(panel);

      const copyItem = menuItem(window, "Copy");
      await expect(copyItem).toBeVisible({ timeout: T_SHORT });
      await expect(copyItem).toHaveAttribute("data-disabled", { timeout: T_SHORT });

      await window.keyboard.press("Escape");
    });

    test("Rename terminal opens the title editor and renames the pane", async () => {
      const { window } = ctx;
      const panelId = await panelIdOf(panel);

      await window.evaluate(() => {
        const target = globalThis.window as Window & {
          __daintreeTerminalRenameEvents?: unknown[];
        };
        target.__daintreeTerminalRenameEvents = [];
        globalThis.window.addEventListener(
          "daintree:rename-terminal",
          (event) => {
            target.__daintreeTerminalRenameEvents?.push((event as CustomEvent).detail);
          },
          { once: true }
        );
      });

      await openTerminalContextMenu(panel);
      await clickTerminalContextMenuItem(panel, "Rename terminal");

      await expect(window.locator(SEL.contextMenu.content)).not.toBeVisible({ timeout: T_SHORT });
      await expect
        .poll(
          () =>
            window.evaluate(
              () =>
                (
                  globalThis.window as Window & {
                    __daintreeTerminalRenameEvents?: Array<{ id?: string }>;
                  }
                ).__daintreeTerminalRenameEvents?.at(0)?.id ?? null
            ),
          { timeout: T_SHORT }
        )
        .toBe(panelId);

      const titleInput = panel.locator('input[aria-label="Edit terminal title"]').first();
      await expect(titleInput).toBeVisible({ timeout: T_SHORT });
      await titleInput.fill("Renamed From Menu");
      await window.keyboard.press("Enter");
      await expect(panel.locator('[role="button"][aria-label*="Renamed From Menu"]')).toBeVisible({
        timeout: T_SHORT,
      });
    });
  });

  // ── Typed input ──────────────────────────────────────────

  test.describe("Typed input", () => {
    let scratchDir: string;
    let recorderScript: string;
    let pagerFile: string;

    test.beforeAll(() => {
      scratchDir = mkdtempSync(path.join(tmpdir(), "daintree-typed-input-"));
      recorderScript = path.join(scratchDir, "stdin-recorder.cjs");
      writeFileSync(recorderScript, STDIN_RECORDER_SOURCE);
      pagerFile = path.join(scratchDir, "pager-input.txt");
      writeFileSync(
        pagerFile,
        Array.from({ length: 300 }, (_, i) => `LESS_LINE_${String(i + 1).padStart(3, "0")}`).join(
          "\n"
        ) + "\n"
      );
    });

    test.afterAll(() => {
      if (scratchDir) rmSync(scratchDir, { recursive: true, force: true });
    });

    test.beforeEach(async () => {
      await resetPanes(ctx.window);
    });

    test("typed keys, copy, bracketed paste, input lock, restart and clear cross the PTY", async () => {
      const { app, window } = ctx;
      const mac = process.platform === "darwin";
      const nonce = Date.now().toString(36);
      const panel = await spawnTerminalAndVerify(window);
      const panelId = await panelIdOf(panel);
      const typedMarker = `TYPED_${nonce}`;

      await test.step("a typed command runs in the shell", async () => {
        // Assembled at runtime so the echoed command line cannot satisfy it.
        await typeTerminalCommand(window, panelId, `node -e "console.log('TYPED_' + '${nonce}')"`, {
          expectOutput: typedMarker,
          timeout: T_LONG,
        });
      });

      await test.step("selecting the output row and copying puts exactly it on the clipboard", async () => {
        await app.evaluate(({ clipboard }) => clipboard.clear());
        await expect.poll(() => readClipboardText(app), { timeout: T_SHORT }).toBe("");

        const point = await visibleRowPoint(window, panel, typedMarker);
        await window.mouse.click(point.x, point.y, { clickCount: 3 });
        await expect
          .poll(() => getTerminalSelection(panel), {
            timeout: T_SHORT,
            message: "triple-click should select the output row",
          })
          .toBe(typedMarker);

        if (!mac) {
          await focusXtermInput(panel);
          await window.keyboard.press("Control+Shift+C");
          await expect
            .poll(() => readClipboardText(app), {
              timeout: T_MEDIUM,
              message: "Ctrl+Shift+C should copy the selection to the system clipboard",
            })
            .toBe(typedMarker);
          await app.evaluate(({ clipboard }) => clipboard.clear());
          await expect.poll(() => readClipboardText(app), { timeout: T_SHORT }).toBe("");
        }

        await window.mouse.click(point.x, point.y, { button: "right" });
        const copyItem = menuItem(window, "Copy").first();
        await expect(copyItem).toBeVisible({ timeout: T_SHORT });
        await expect(copyItem).not.toHaveAttribute("data-disabled", { timeout: T_SHORT });
        await clickMenuItem(window, "Copy");
        await expect
          .poll(() => readClipboardText(app), {
            timeout: T_MEDIUM,
            message: "context-menu Copy should put the selected row on the system clipboard",
          })
          .toBe(typedMarker);
      });

      const recordPath = path.join(scratchDir, `stdin-${nonce}.bin`);
      const readRecorded = (): string =>
        existsSync(recordPath) ? readFileSync(recordPath, "utf8") : "";
      const pasteText = `pasted ${nonce}`;
      const wrapped = `${BRACKETED_PASTE_START}${pasteText}${BRACKETED_PASTE_END}`;
      // Menu Paste everywhere, plus Ctrl+Shift+V off macOS.
      const pastedBytes = mac ? wrapped : wrapped + wrapped;

      await test.step("paste into a program that enabled bracketed paste arrives wrapped", async () => {
        // Launching the recorder is setup; what it receives is the subject.
        await runTerminalCommand(window, panel, `node "${recorderScript}" "${recordPath}"`);
        await waitForTerminalText(panel, "RECORDER_READY", T_LONG);
        await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), pasteText);

        await rightClickPane(window, panel);
        await clickMenuItem(window, "Paste");
        await expect
          .poll(() => JSON.stringify(readRecorded()), {
            timeout: T_MEDIUM,
            message: "context-menu Paste should deliver the clipboard inside paste brackets",
          })
          .toBe(JSON.stringify(wrapped));

        if (!mac) {
          await focusXtermInput(panel);
          await window.keyboard.press("Control+Shift+V");
          await expect
            .poll(() => JSON.stringify(readRecorded()), {
              timeout: T_MEDIUM,
              message: "Ctrl+Shift+V should deliver the clipboard inside paste brackets",
            })
            .toBe(JSON.stringify(wrapped + wrapped));
        }
      });

      await test.step("locked input keeps keys and pastes out of the PTY until unlocked", async () => {
        const beforeLock = pastedBytes;
        expect(JSON.stringify(readRecorded()), "no late paste bytes before locking").toBe(
          JSON.stringify(beforeLock)
        );

        await rightClickPane(window, panel);
        await clickMenuItem(window, "Lock input");
        await rightClickPane(window, panel);
        await expect(menuItem(window, "Unlock input")).toBeVisible({ timeout: T_SHORT });
        await clickMenuItem(window, "Paste");

        await focusXtermInput(panel);
        await window.keyboard.type("locked", { delay: 15 });
        if (!mac) await window.keyboard.press("Control+Shift+V");
        await expectUnchangedFor(
          readRecorded,
          beforeLock,
          1_000,
          "nothing typed or pasted while input is locked may reach the PTY"
        );

        await rightClickPane(window, panel);
        await clickMenuItem(window, "Unlock input");
        await typeTerminalCommand(window, panelId, "open", { submit: false });
        // Keys reach the PTY in order, so exact equality also proves none of the
        // locked-phase input was queued and released by the unlock.
        await expect
          .poll(() => JSON.stringify(readRecorded()), {
            timeout: T_MEDIUM,
            message: "typing should reach the PTY again once input is unlocked",
          })
          .toBe(JSON.stringify(`${beforeLock}open`));

        await window.keyboard.press("Enter");
        await waitForTerminalText(panel, "RECORDER_DONE", T_LONG);
        expect(JSON.stringify(readRecorded()), "the finished recording").toBe(
          JSON.stringify(`${beforeLock}open`)
        );
      });

      await test.step("restart from the menu replaces the shell and starts a fresh buffer", async () => {
        const pidBefore = await getPtyPid(window, panel);
        await rightClickPane(window, panel);
        await clickMenuItem(window, "Restart terminal");
        await expect(window.getByRole("alertdialog")).toHaveCount(0);

        let pidAfter = 0;
        await expect
          .poll(
            async () => {
              pidAfter = await getPtyPid(window, panel).catch(() => 0);
              return pidAfter > 0 && pidAfter !== pidBefore;
            },
            { timeout: T_LONG, message: "Restart should spawn a replacement shell" }
          )
          .toBe(true);
        expect(isPidAlive(pidAfter), `replacement shell ${pidAfter} should be running`).toBe(true);
        await expect
          .poll(() => isPidAlive(pidBefore), {
            timeout: T_LONG,
            message: `old shell ${pidBefore} should be gone`,
          })
          .toBe(false);
        // The restarted pane has a fresh buffer, so any text is the new shell's
        // prompt: typed input is sent once and must not race shell startup.
        await waitForTerminalReady(window, panel, T_LONG);

        await typeTerminalCommand(
          window,
          panelId,
          `node -e "console.log('RESTARTED_' + '${nonce}')"`,
          { expectOutput: `RESTARTED_${nonce}`, timeout: T_LONG }
        );
        const buffer = await getTerminalText(panel);
        expect(buffer, "the restarted pane should not carry the old buffer").not.toContain(
          typedMarker
        );
        expect(buffer).not.toContain("RECORDER_DONE");
      });

      await test.step("typed clear empties the viewport", async () => {
        const clearMarker = `BEFORE_CLEAR_${nonce}`;
        await typeTerminalCommand(
          window,
          panelId,
          `node -e "console.log('BEFORE_CLEAR_' + '${nonce}')"`,
          { expectOutput: clearMarker, timeout: T_LONG }
        );
        const viewportState = async (): Promise<string> => {
          const viewport = await getTerminalViewport(window, panelId);
          if (!viewport) return "no viewport";
          return viewport.text.includes(clearMarker) ? `visible:\n${viewport.text}` : "cleared";
        };
        await expect.poll(viewportState, { timeout: T_SHORT }).toMatch(/^visible:/);

        await typeTerminalCommand(window, panelId, "clear");
        await expect
          .poll(viewportState, {
            timeout: T_MEDIUM,
            message: "clear should leave no earlier output on screen",
          })
          .toBe("cleared");
      });
    });

    test("less runs on the alternate screen and quitting restores the shell's screen", async () => {
      if (process.platform === "win32") {
        test.info().annotations.push({
          type: "platform-skip",
          description: "less is a POSIX pager; Windows shells have no alternate-screen pager",
        });
        test.skip(true, "less is a POSIX pager; Windows shells have no alternate-screen pager");
      }
      const { window } = ctx;
      const nonce = Date.now().toString(36);
      const panel = await spawnTerminalAndVerify(window);
      const panelId = await panelIdOf(panel);
      const primaryMarker = `PRIMARY_${nonce}`;
      const viewportText = async (): Promise<string> =>
        (await getTerminalViewport(window, panelId))?.text ?? "no viewport";

      await typeTerminalCommand(window, panelId, `node -e "console.log('PRIMARY_' + '${nonce}')"`, {
        expectOutput: primaryMarker,
        timeout: T_LONG,
      });
      await expect.poll(viewportText, { timeout: T_SHORT }).toContain(primaryMarker);

      // An inherited LESS=-X would keep less off the alternate screen.
      await typeTerminalCommand(window, panelId, `LESS= less "${pagerFile}"`);
      await expect
        .poll(viewportText, { timeout: T_LONG, message: "less should draw the file's first page" })
        .toContain("LESS_LINE_001");
      expect(await viewportText()).not.toContain(primaryMarker);

      await window.keyboard.press("q");
      await expect
        .poll(viewportText, {
          timeout: T_MEDIUM,
          message: "quitting less should bring back the shell's screen",
        })
        .toContain(primaryMarker);
      expect(await viewportText()).not.toContain("LESS_LINE_001");
    });
  });

  // ── Search ───────────────────────────────────────────────

  test.describe("Search", () => {
    let panel: Locator;

    test.beforeEach(async () => {
      await resetPanes(ctx.window);
      panel = await spawnTerminalAndVerify(ctx.window);
      // Markers are assembled at runtime so the echoed command line never
      // contains them: the only matches are the printed lines.
      await runTerminalCommand(
        ctx.window,
        panel,
        "node -e \"console.log('SEARCH_' + 'SENTINEL_XYZ'); console.log('Case' + 'Mark_Upper'); for (const i of [1,2,3]) console.log('item' + i + '_found')\""
      );
      await waitForTerminalText(panel, "item3_found", T_LONG);
    });

    test("Cmd+F opens find, reports matches and misses, and Escape closes it", async () => {
      const { window } = ctx;
      const input = panel.locator(SEL.terminal.searchInput);
      const status = panel.locator(SEL.terminal.searchStatus);

      await focusXterm(window, panel);
      await window.keyboard.press(process.platform === "darwin" ? "Meta+F" : "Control+F");
      await expect(input).toBeVisible({ timeout: T_MEDIUM });

      await input.fill("SEARCH_SENTINEL_XYZ");
      await expect(status).toHaveText(FOUND_STATUS, { timeout: T_SHORT });
      await expect(status).toHaveText("1 of 1", { timeout: T_SHORT });

      await input.fill("ZZZNOMATCHZZZ");
      await expect(status).toHaveText("No matches", { timeout: T_SHORT });

      await input.focus();
      await window.keyboard.press("Escape");
      await expect(input).not.toBeVisible({ timeout: T_SHORT });
    });

    test("the close button closes a re-opened find bar", async () => {
      const input = panel.locator(SEL.terminal.searchInput);
      await openFindViaEvent(ctx.window, panel);
      await panel.locator(SEL.terminal.searchClose).click();
      await expect(input).not.toBeVisible({ timeout: T_SHORT });
    });

    test("case sensitivity toggle changes search behavior", async () => {
      const { window } = ctx;
      const input = panel.locator(SEL.terminal.searchInput);
      const status = panel.locator(SEL.terminal.searchStatus);
      const caseToggle = panel.locator(SEL.terminal.searchCaseToggle);

      await test.step("Open search bar in focused terminal", async () => {
        await openFindViaEvent(window, panel);
        await expect(caseToggle).toHaveAttribute("aria-pressed", "false");
      });

      await test.step("Case-insensitive search matches mixed-case text", async () => {
        await input.fill("casemark_upper");
        await expect(status).toHaveText(FOUND_STATUS, { timeout: T_SHORT });
      });

      await test.step("Enable case-sensitive mode and verify lowercase no longer matches", async () => {
        await caseToggle.click();
        await expect(caseToggle).toHaveAttribute("aria-pressed", "true");
        // Toggle-triggered re-searches can debounce slower than typed input.
        await expect(status).toHaveText("No matches", { timeout: T_MEDIUM });
      });

      await test.step("Exact-case query still matches with case-sensitive mode on", async () => {
        await input.fill("CaseMark_Upper");
        await expect(status).toHaveText(FOUND_STATUS, { timeout: T_SHORT });
      });

      await test.step("Disable case-sensitive mode and close search", async () => {
        await caseToggle.click();
        await expect(caseToggle).toHaveAttribute("aria-pressed", "false");
        await window.keyboard.press("Escape");
        await expect(input).not.toBeVisible({ timeout: T_SHORT });
      });
    });

    test("regex toggle matches patterns and detects invalid regex", async () => {
      const { window } = ctx;
      const input = panel.locator(SEL.terminal.searchInput);
      const status = panel.locator(SEL.terminal.searchStatus);
      const regexToggle = panel.locator(SEL.terminal.searchRegexToggle);

      await test.step("Open search bar in focused terminal", async () => {
        await openFindViaEvent(window, panel);
        await expect(regexToggle).toHaveAttribute("aria-pressed", "false");
      });

      await test.step("Enable regex and verify pattern matches", async () => {
        await regexToggle.click();
        await expect(regexToggle).toHaveAttribute("aria-pressed", "true");
        await input.fill("item\\d+_found");
        await expect(status).toHaveText(FOUND_STATUS, { timeout: T_SHORT });
        await expect(status).toHaveText(/^\d+ of 3$/, { timeout: T_SHORT });
      });

      await test.step("Disable regex and verify literal pattern no longer matches", async () => {
        await regexToggle.click();
        await expect(regexToggle).toHaveAttribute("aria-pressed", "false");
        await expect(status).toHaveText("No matches", { timeout: T_MEDIUM });
      });

      await test.step("Re-enable regex with invalid pattern and verify error status", async () => {
        await regexToggle.click();
        await input.fill("[broken");
        await expect(status).toHaveText("Invalid regex", { timeout: T_SHORT });
      });

      await test.step("Disable regex and close search", async () => {
        await regexToggle.click();
        await window.keyboard.press("Escape");
        await expect(input).not.toBeVisible({ timeout: T_SHORT });
      });
    });

    test("next and previous buttons cycle through matches", async () => {
      const { window } = ctx;
      const input = panel.locator(SEL.terminal.searchInput);
      const status = panel.locator(SEL.terminal.searchStatus);
      const nextBtn = panel.locator(SEL.terminal.searchNext);
      const prevBtn = panel.locator(SEL.terminal.searchPrevious);
      // The "N of M" ordinal is what cycling actually moves; assert the index
      // changes rather than only that some match exists.
      const ordinalRegex = /^(\d+) of \d+\+?$/;

      const ordinal = async (): Promise<number> => {
        const text = (await status.textContent()) ?? "";
        const m = ordinalRegex.exec(text.trim());
        if (!m) throw new Error(`Search status is not an ordinal counter: "${text}"`);
        return Number(m[1]);
      };

      await test.step("Open search bar and seed query with multiple matches", async () => {
        await openFindViaEvent(window, panel);
        await input.fill("_found");
        await expect(status).toHaveText(ordinalRegex, { timeout: T_MEDIUM });
      });

      await test.step("Click Next and verify the match ordinal advances", async () => {
        const startIndex = await ordinal();
        await nextBtn.click();
        await expect.poll(async () => ordinal(), { timeout: T_MEDIUM }).not.toBe(startIndex);

        const afterFirst = await ordinal();
        await nextBtn.click();
        await expect.poll(async () => ordinal(), { timeout: T_MEDIUM }).not.toBe(afterFirst);
      });

      await test.step("Click Previous and verify the match ordinal moves back", async () => {
        const startIndex = await ordinal();
        await prevBtn.click();
        await expect.poll(async () => ordinal(), { timeout: T_MEDIUM }).not.toBe(startIndex);
      });

      await test.step("Close search via Escape", async () => {
        await window.keyboard.press("Escape");
        await expect(input).not.toBeVisible({ timeout: T_SHORT });
      });
    });

    test("Shift+PageUp and Shift+PageDown move the viewport through scrollback", async () => {
      const { window } = ctx;
      const panelId = await panelIdOf(panel);

      await test.step("Fill the scrollback well past one screen", async () => {
        await runTerminalCommand(
          window,
          panel,
          "node -e \"console.log('SCROLLBACK_' + 'TOP'); for(let i=1;i<=198;i++) console.log(i); console.log('SCROLLBACK_' + 'BOTTOM')\""
        );
        await waitForTerminalText(panel, "SCROLLBACK_BOTTOM", T_LONG);
        await expect
          .poll(() => viewportShowsRow(window, panel, "SCROLLBACK_BOTTOM"), { timeout: T_MEDIUM })
          .toBe("visible");
      });

      await test.step("Scrolling to the top brings the first line into view", async () => {
        await focusXterm(window, panel);
        for (let i = 0; i < 15; i++) {
          await window.keyboard.press("Shift+PageUp");
        }
        await waitForTerminalText(panel, "SCROLLBACK_TOP", T_MEDIUM);
        await expect
          .poll(async () => (await getScrollState(window, panelId))?.isUserScrolledBack, {
            timeout: T_MEDIUM,
          })
          .toBe(true);
        await expect
          .poll(() => viewportShowsRow(window, panel, "SCROLLBACK_TOP"), { timeout: T_MEDIUM })
          .toBe("visible");
        expect(await viewportShowsRow(window, panel, "SCROLLBACK_BOTTOM")).not.toBe("visible");
      });

      await test.step("Scrolling back down returns to the live bottom", async () => {
        for (let i = 0; i < 15; i++) {
          await window.keyboard.press("Shift+PageDown");
        }
        await waitForTerminalText(panel, "SCROLLBACK_BOTTOM", T_MEDIUM);
        await expect
          .poll(
            async () => {
              const state = await getScrollState(window, panelId);
              return state ? state.viewportY === state.baseY && !state.isUserScrolledBack : null;
            },
            { timeout: T_MEDIUM }
          )
          .toBe(true);
        await expect
          .poll(() => viewportShowsRow(window, panel, "SCROLLBACK_BOTTOM"), { timeout: T_MEDIUM })
          .toBe("visible");
        expect(await viewportShowsRow(window, panel, "SCROLLBACK_TOP")).not.toBe("visible");
      });
    });
  });

  // ── Links ────────────────────────────────────────────────

  test.describe.serial("Links", () => {
    const url = () => `http://127.0.0.1:${port}/test-page`;
    const browserPanels = () =>
      ctx.window.locator(SEL.panel.gridPanel).filter({
        has: ctx.window.locator(SEL.browser.addressBar),
      });
    const terminalPanel = () =>
      ctx.window
        .locator(SEL.panel.gridPanel)
        .filter({ hasNot: ctx.window.locator(SEL.browser.addressBar) })
        .first();

    test.beforeAll(async () => {
      await resetPanes(ctx.window);
    });

    test("echo localhost URL appears in terminal buffer", async () => {
      const { window } = ctx;
      await openTerminal(window);
      const panel = window.locator(SEL.panel.gridPanel).first();
      await expect(panel).toBeVisible({ timeout: T_LONG });

      await runTerminalCommand(window, panel, `node -e "console.log('${url()}')"`);
      await waitForTerminalText(panel, url());
    });

    test("Cmd+click localhost URL opens browser panel", async () => {
      const result = await triggerTerminalLink(terminalPanel(), url());
      expect(result).toBe("ok");

      await expect(browserPanels()).toBeVisible({ timeout: T_LONG });
      const addressBar = browserPanels().locator(SEL.browser.addressBar);
      await expect(addressBar).toHaveValue(/127\.0\.0\.1/, { timeout: T_LONG });
      await expect(addressBar).toHaveValue(/test-page/, { timeout: T_SHORT });
    });

    test("a second link reuses the existing browser panel", async () => {
      const { window } = ctx;
      const panelCountBefore = await getGridPanelCount(window);
      const browser = browserPanels();
      const addressBar = browser.locator(SEL.browser.addressBar);

      // Select the terminal first so the reuse branch has something to change:
      // it re-selects the existing browser pane, while a new panel would take
      // the selection itself. That selection is the sync point for the count.
      await focusXterm(window, terminalPanel());
      await expect(terminalPanel()).toHaveClass(/\bterminal-selected\b/, { timeout: T_MEDIUM });
      await expect(browser).not.toHaveClass(/\bterminal-selected\b/);

      expect(await triggerTerminalLink(terminalPanel(), url())).toBe("ok");
      await expect(browser).toHaveClass(/\bterminal-selected\b/, { timeout: T_MEDIUM });

      expect(await getGridPanelCount(window)).toBe(panelCountBefore);
      await expect(browserPanels()).toHaveCount(1);
      await expect(addressBar).toHaveValue(/test-page/, { timeout: T_SHORT });
    });
  });

  // ── Panels ───────────────────────────────────────────────

  test.describe("Panels", () => {
    test.beforeEach(async () => {
      await resetPanes(ctx.window);
    });

    test("terminal lifecycle: open, run, maximize, dock, restore, close", async () => {
      const { window } = ctx;

      await test.step("open terminal via toolbar button", async () => {
        await openTerminal(window);
        await expect(getFirstGridPanel(window)).toBeVisible({ timeout: T_LONG });
      });

      await test.step("run command and verify output", async () => {
        const panel = getFirstGridPanel(window);
        await runTerminalCommand(window, panel, "node -e \"console.log('DAINTREE_E2E_OK')\"");
        await waitForTerminalText(panel, "DAINTREE_E2E_OK", T_LONG);
      });

      await test.step("maximize and unmaximize panel", async () => {
        const panel = getFirstGridPanel(window);
        await panel.locator('[aria-label*="Maximize"]').first().click();
        const restoreBtn = window.locator(SEL.panel.restore).first();
        await expect(restoreBtn).toBeVisible({ timeout: T_SHORT });
        await restoreBtn.click();
        await expect(restoreBtn).not.toBeVisible({ timeout: T_SHORT });
      });

      await test.step("minimize to dock and restore", async () => {
        const panel = getFirstGridPanel(window);
        const minimizeBtn = panel.locator(SEL.panel.minimize).first();
        await expect(minimizeBtn).toBeVisible({ timeout: T_SHORT });
        await minimizeBtn.click();

        await expect(panel).not.toBeVisible({ timeout: T_SHORT });
        await expect.poll(() => getGridPanelCount(window), { timeout: T_MEDIUM }).toBe(0);

        const dock = window.locator(SEL.dock.container);
        await expect(dock).toBeVisible({ timeout: T_SHORT });
        await dock.locator('button[aria-label*="move to grid"]').first().dblclick();
        await expect(getFirstGridPanel(window)).toBeVisible({ timeout: T_MEDIUM });
      });

      await test.step("close terminal session", async () => {
        await getFirstGridPanel(window).locator(SEL.panel.close).click();
        await expect.poll(() => getGridPanelCount(window), { timeout: T_MEDIUM }).toBe(0);
      });
    });

    // Regression: xterm #5893 / #9812. The DOM renderer emits negative inline
    // letter-spacing on emoji spans (OffscreenCanvas mismeasures them); our
    // src/index.css override clamps only those to 0 while sparing positive
    // corrections and spans outside .xterm-rows. Inject probe spans and read the
    // computed cascade synchronously so re-renders can't race the assertion.
    test("clamps negative letter-spacing only inside xterm rows", async () => {
      const { window } = ctx;
      await spawnTerminalAndVerify(window);
      const rows = window.locator(".xterm-rows").first();
      await expect(rows).toBeVisible({ timeout: T_MEDIUM });

      const computed = await rows.evaluate((rowsEl) => {
        const make = (parent: Element, value: string) => {
          const span = document.createElement("span");
          span.style.letterSpacing = value;
          span.textContent = "x";
          parent.appendChild(span);
          const result = getComputedStyle(span).letterSpacing;
          parent.removeChild(span);
          return result;
        };
        return {
          negativeInside: make(rowsEl, "-5.5px"),
          positiveInside: make(rowsEl, "0.5px"),
          negativeOutside: make(document.body, "-5.5px"),
        };
      });

      const normalizeZeroLetterSpacing = (value: string) => (value === "normal" ? "0px" : value);
      expect(normalizeZeroLetterSpacing(computed.negativeInside)).toBe("0px");
      expect(computed.positiveInside).toBe("0.5px");
      expect(computed.negativeOutside).toBe("-5.5px");
    });

    test("rename terminal by editing title", async () => {
      const { window } = ctx;
      const panel = await spawnTerminalAndVerify(window);
      const titleBtn = panel.locator('[role="button"][aria-label*="Terminal title"]').first();
      await expect(titleBtn).toBeVisible({ timeout: T_MEDIUM });

      try {
        await titleBtn.dblclick({ force: true, timeout: T_SHORT });
      } catch {
        await titleBtn.click({ force: true });
        await window.keyboard.press("Enter");
      }

      const titleInput = panel.locator('input[aria-label="Edit terminal title"]').first();
      await expect(titleInput).toBeVisible({ timeout: T_SHORT });
      await titleInput.fill("My Custom Terminal");
      await window.keyboard.press("Enter");

      await expect(panel.locator('[role="button"][aria-label*="My Custom Terminal"]')).toBeVisible({
        timeout: T_SHORT,
      });
    });

    test("duplicate as tab, restart, then close every tab", async () => {
      const { window } = ctx;

      await test.step("open terminal via toolbar", async () => {
        await openTerminal(window);
        await expect(getFirstGridPanel(window)).toBeVisible({ timeout: T_LONG });
        // Linux CI shard 2/4 of full-terminal has shown a state where two grid
        // panels exist after a single openTerminal click — surface the leak
        // here rather than inside the duplicate-tab assertion below.
        await expect.poll(() => getGridPanelCount(window), { timeout: T_MEDIUM }).toBe(1);
      });

      await test.step("duplicate terminal as new tab", async () => {
        const panel = getFirstGridPanel(window);
        await panel.locator(SEL.panel.duplicate).first().click({ force: true, timeout: T_MEDIUM });

        const tabList = panel.locator(SEL.panel.tabList);
        await expect(tabList).toBeVisible({ timeout: T_MEDIUM });
        await expect(tabList.locator(SEL.panel.tab)).toHaveCount(2, { timeout: T_MEDIUM });
        await expect.poll(() => getGridPanelCount(window), { timeout: T_MEDIUM }).toBe(1);
      });

      await test.step("restart terminal session respawns the PTY", async () => {
        // The duplicate's PTY spawns after its tab renders; wait for every tab's
        // shell before pinning the active pane, so the pid read cannot race it.
        const tabIds = await getFirstGridPanel(window)
          .locator(SEL.panel.tabList)
          .locator(SEL.panel.tab)
          .evaluateAll((els) => els.map((el) => el.getAttribute("data-tab-id") ?? ""));
        expect(tabIds.filter(Boolean)).toHaveLength(2);
        for (const id of tabIds) {
          await expect
            .poll(
              () =>
                window.evaluate(
                  (terminalId) =>
                    globalThis.window.electron.terminal
                      .getInfo(terminalId)
                      .then((info) => info?.ptyPid ?? 0)
                      .catch(() => 0),
                  id
                ),
              { timeout: T_LONG }
            )
            .toBeGreaterThan(0);
        }
        const [activeId] = await getGridPanelIds(window);
        expect(activeId).toBeTruthy();
        const panel = getPanelById(window, activeId!);
        const pidBefore = await getPtyPid(window, panel);

        await panel.hover();
        await panel.locator(SEL.panel.overflowMenu).first().click();

        // A plain shell restarts on the first click; only a working agent asks.
        const restartBtn = window.locator(SEL.panel.restart).first();
        await expect(restartBtn).toBeVisible({ timeout: T_SHORT });
        await restartBtn.click();
        await expect(window.getByRole("alertdialog")).toHaveCount(0);
        await expect(panel).toBeVisible({ timeout: T_LONG });

        let pidAfter = 0;
        await expect
          .poll(
            async () => {
              pidAfter = await getPtyPid(window, panel).catch(() => 0);
              return pidAfter > 0 && pidAfter !== pidBefore;
            },
            { timeout: T_LONG, message: "Restart should spawn a replacement shell" }
          )
          .toBe(true);
        expect(isPidAlive(pidAfter), `replacement shell ${pidAfter} should be running`).toBe(true);
        await expect.poll(() => isPidAlive(pidBefore), { timeout: T_LONG }).toBe(false);
        // Typed input is sent once; wait for the new shell to draw before typing.
        await waitForTerminalReady(window, panel, T_LONG);

        // Typed, because restart locks input while it respawns: the replacement
        // shell has to take real keystrokes. The echoed command line cannot
        // satisfy the marker; only the new shell running it can.
        await typeTerminalCommand(
          window,
          activeId!,
          "node -e \"console.log('RESTARTED_' + (20 + 22))\"",
          {
            expectOutput: "RESTARTED_42",
            timeout: T_LONG,
          }
        );
      });

      await test.step("close all tabs leaves empty grid", async () => {
        for (let i = 0; i < 4 && (await getGridPanelCount(window)) > 0; i++) {
          const signature = (await getGridPanelIds(window)).join(",");
          await getFirstGridPanel(window).locator(SEL.panel.close).first().click({ force: true });
          await expect
            .poll(async () => (await getGridPanelIds(window)).join(","), { timeout: T_MEDIUM })
            .not.toBe(signature);
        }
        await expect.poll(() => getGridPanelCount(window), { timeout: T_MEDIUM }).toBe(0);
      });
    });

    test("multi-panel grid and dock: dock two, restore one, close all", async () => {
      const { window } = ctx;
      const dock = window.locator(SEL.dock.container);

      await test.step("open 3 terminals via toolbar", async () => {
        for (let i = 1; i <= 3; i++) {
          await openTerminal(window);
          await expect.poll(() => getGridPanelCount(window), { timeout: T_LONG }).toBe(i);
        }
        await expect.poll(() => getGridPanelCount(window), { timeout: T_LONG }).toBe(3);
      });

      await test.step("grid shows 3 panels simultaneously", async () => {
        const panels = window.locator(SEL.panel.gridPanel);
        await expect(panels).toHaveCount(3, { timeout: T_MEDIUM });
        for (let i = 0; i < 3; i++) {
          await expect(panels.nth(i)).toBeVisible({ timeout: T_MEDIUM });
        }
      });

      await test.step("minimize first panel to dock", async () => {
        const minimizeBtn = getFirstGridPanel(window).locator(SEL.panel.minimize).first();
        await expect(minimizeBtn).toBeVisible({ timeout: T_SHORT });
        await minimizeBtn.click();
        await expect.poll(() => getGridPanelCount(window), { timeout: T_MEDIUM }).toBe(2);
        await expect(dock).toBeVisible({ timeout: T_SHORT });
      });

      await test.step("minimize second panel to dock", async () => {
        const minimizeBtn = getFirstGridPanel(window).locator(SEL.panel.minimize).first();
        await expect(minimizeBtn).toBeVisible({ timeout: T_SHORT });
        await minimizeBtn.click();
        await expect.poll(() => getGridPanelCount(window), { timeout: T_MEDIUM }).toBe(1);
      });

      await test.step("dock has 2 items, grid has 1", async () => {
        expect(await getGridPanelCount(window)).toBe(1);
        expect(await dock.locator("button").count()).toBeGreaterThanOrEqual(2);
        await expect.poll(() => getDockPanelCount(window), { timeout: T_MEDIUM }).toBe(2);
      });

      await test.step("restore one panel from dock", async () => {
        await dock.locator('button[aria-label*="move to grid"]').first().dblclick();
        await expect.poll(() => getGridPanelCount(window), { timeout: T_MEDIUM }).toBe(2);
        await expect.poll(() => getDockPanelCount(window), { timeout: T_MEDIUM }).toBe(1);
      });

      await test.step("close all panels leaves empty grid", async () => {
        let count = await getGridPanelCount(window);
        while (count > 0) {
          await getFirstGridPanel(window).locator(SEL.panel.close).first().click({ force: true });
          await expect.poll(() => getGridPanelCount(window), { timeout: T_MEDIUM }).toBe(count - 1);
          count--;
        }
        expect(await getGridPanelCount(window)).toBe(0);
      });
    });

    test("Copy Context puts a file reference to the generated bundle on the clipboard", async () => {
      const { app, window } = ctx;

      await expectToolbarButtonReachable(window, SEL.toolbar.copyContext, T_MEDIUM);

      // `clear()` rather than `writeText("")` — writing empty text still
      // installs a text format, so the reset would satisfy the check itself.
      await app.evaluate(({ clipboard }) => clipboard.clear());
      await expect
        .poll(() => app.evaluate(({ clipboard }) => clipboard.availableFormats().length), {
          timeout: T_SHORT,
          message: "Clipboard should start empty so the copy below is what is read back",
        })
        .toBe(0);

      // The trigger opens a recents menu (#11733); the helper follows through
      // to its "Copy full context" row.
      await copyFullContextFromToolbar(window, T_MEDIUM);
      await expectToolbarButtonReachable(window, SEL.toolbar.copyContext, T_LONG);

      await expect
        .poll(() => app.evaluate(({ clipboard }) => clipboard.availableFormats().length), {
          timeout: T_LONG,
          message: "Clipboard should have content after copy",
        })
        .toBeGreaterThan(0);

      let copiedPath: string | null = null;
      await expect
        .poll(
          async () => {
            copiedPath = await readCopiedContextPath(app);
            return copiedPath !== null && existsSync(copiedPath);
          },
          { timeout: T_LONG, message: "Clipboard should reference the generated context file" }
        )
        .toBe(true);

      const bundle = readFileSync(copiedPath!, "utf8");
      expect(bundle).toContain("index.ts");
      expect(bundle).toContain("utils.ts");
      expect(bundle).toContain("README.md");
    });
  });

  // ── Context injection ────────────────────────────────────

  test.describe("Context injection", () => {
    type CopyTreeGenerateResult = {
      error?: string;
      filePath?: string;
      outputBytes?: number;
      content?: string;
      fileCount?: number;
    };

    async function getActiveWorktreeId(window: Page): Promise<string> {
      const res = await window.evaluate(() =>
        (
          window as unknown as {
            __daintreeDispatchAction: (
              id: string
            ) => Promise<{ result?: { activeWorktreeId?: string } }>;
          }
        ).__daintreeDispatchAction("actions.getContext")
      );
      return res?.result?.activeWorktreeId ?? "";
    }

    test.beforeEach(async () => {
      await resetPanes(ctx.window);
      await expect
        .poll(() => getActiveWorktreeId(ctx.window), {
          timeout: T_LONG,
          message: "Active worktree ID should be available",
        })
        .toBeTruthy();
    });

    test("generated content contains expected fixture files and excludes .git", async () => {
      const { window } = ctx;
      const wtId = await getActiveWorktreeId(window);

      // Opt in to the inline head — the default now writes the bundle to a
      // file and returns only its path (#11528).
      const result = await window.evaluate(
        async (id: string) =>
          (await (
            window as unknown as {
              electron: {
                copyTree: { generate: (id: string, opts: undefined, inline: boolean) => unknown };
              };
            }
          ).electron.copyTree.generate(id, undefined, true)) as CopyTreeGenerateResult,
        wtId
      );

      expect(result?.error).toBeFalsy();
      expect(result?.filePath).toBeTruthy();
      expect(result?.outputBytes).toBeGreaterThan(100);
      expect(result?.content?.length).toBeGreaterThan(100);
      expect(result?.fileCount).toBeGreaterThanOrEqual(4);

      const content = result.content ?? "";
      expect(content).toContain("index.ts");
      expect(content).toContain("utils.ts");
      expect(content).toContain("README.md");
      expect(content).toContain("package.json");
      expect(content).not.toContain(".git/");
      expect(content).not.toContain(".git\\");
    });

    test("injecting context writes content to terminal buffer", async () => {
      const { window } = ctx;
      const wtId = await getActiveWorktreeId(window);

      const panel = await spawnTerminalAndVerify(window);
      const panelId = await panelIdOf(panel);
      await expect
        .poll(
          async () => {
            const terminals = await window.evaluate(() =>
              (
                window as unknown as {
                  electron: { terminal: { getAllTerminals: () => Promise<Array<{ id: string }>> } };
                }
              ).electron.terminal.getAllTerminals()
            );
            return terminals.some((terminal) => terminal.id === panelId);
          },
          { timeout: T_LONG, message: "Terminal should be registered before context injection" }
        )
        .toBe(true);

      const injectResult = await window.evaluate(
        async (args: { terminalId: string; worktreeId: string }) =>
          (await (
            window as unknown as {
              electron: {
                copyTree: {
                  injectToTerminal: (terminalId: string, worktreeId: string) => unknown;
                };
              };
            }
          ).electron.copyTree.injectToTerminal(args.terminalId, args.worktreeId)) as {
            error?: string;
          },
        { terminalId: panelId, worktreeId: wtId }
      );
      expect(injectResult?.error).toBeFalsy();

      await waitForTerminalTextIgnoringLineBreaks(
        getPanelById(window, panelId),
        "index.ts",
        T_LONG
      );
    });
  });

  // ── Scratchpad (#12835) — last, because it narrows the terminal ──

  test.describe.serial("Scratchpad (#12835)", () => {
    let panel: Locator;

    async function capture(target: Locator, name: string) {
      const testInfo = test.info();
      await expect(target).toBeVisible();
      const path = testInfo.outputPath(`${name}.png`);
      await target.screenshot({ path, animations: "disabled", caret: "hide" });
      await testInfo.attach(name, { path, contentType: "image/png" });
    }

    async function openScratchpadFromMenu(page: Page, pane: Locator): Promise<void> {
      await pane.getByRole("button", { name: "More panel actions" }).click();
      await page.getByRole("menuitem", { name: "Show scratchpad" }).click();
      // The menu's exit animation keeps a focus scope alive that swallows the
      // next keystrokes; wait for the portal to unmount before typing anywhere.
      await expect(page.locator('[role="menu"]')).toHaveCount(0, { timeout: T_SHORT });
    }

    test.beforeAll(async () => {
      await resetPanes(ctx.window);
      panel = await spawnTerminalAndVerify(ctx.window);
    });

    test("opens from the overflow menu beside the terminal without taking focus", async () => {
      const { window } = ctx;
      const scratchpad = panel.getByTestId("terminal-scratchpad");
      await expect(scratchpad).toHaveCount(0);

      const before = await getTerminalDimensions(panel);
      expect(before).not.toBeNull();

      await openScratchpadFromMenu(window, panel);

      await expect(scratchpad).toBeVisible({ timeout: T_MEDIUM });
      const editor = panel.getByTestId("terminal-scratchpad-editor");
      await expect(editor).toHaveValue("");
      await expect(editor).not.toBeFocused();

      // The terminal gives up the column's width rather than sitting under it.
      await expect
        .poll(async () => (await getTerminalDimensions(panel))?.cols ?? 0, { timeout: T_LONG })
        .toBeLessThan(before!.cols);

      await capture(panel, "01-scratchpad-open-empty");
    });

    test("takes typing only when clicked into, and gives the terminal its keys back", async () => {
      const { window } = ctx;
      const editor = panel.getByTestId("terminal-scratchpad-editor");
      const notes = "## Next\n- [ ] check CI\n- run `npm test`";

      await editor.click();
      await expect(editor).toBeFocused();
      await window.keyboard.type(notes);
      await expect(editor).toHaveValue(notes);
      expect(await getTerminalText(panel)).not.toContain("check CI");

      await panel.locator(".xterm-screen").click();
      await expectTerminalFocused(panel);
      await window.keyboard.type("echo scratchpad-keys-ok");
      await window.keyboard.press("Enter");
      await waitForTerminalText(panel, "scratchpad-keys-ok", T_LONG);
      await expect(editor).toHaveValue(notes);

      await capture(panel, "02-scratchpad-with-notes");
    });

    test("resizes from its left edge", async () => {
      const { window } = ctx;
      const scratchpad = panel.getByTestId("terminal-scratchpad");
      const grip = panel.getByTestId("terminal-scratchpad-resize");
      const start = await scratchpad.boundingBox();
      const gripBox = await grip.boundingBox();
      expect(start).not.toBeNull();
      expect(gripBox).not.toBeNull();

      const x = gripBox!.x + gripBox!.width / 2;
      const y = gripBox!.y + gripBox!.height / 2;
      await window.mouse.move(x, y);
      await window.mouse.down();
      await window.mouse.move(x - 80, y, { steps: 8 });
      await window.mouse.up();

      await expect
        .poll(async () => (await scratchpad.boundingBox())?.width ?? 0, { timeout: T_SHORT })
        .toBeGreaterThan(start!.width + 40);

      await capture(panel, "03-scratchpad-resized");
    });

    test("toggles from a header control and expands back as it was", async () => {
      const scratchpad = panel.getByTestId("terminal-scratchpad");
      const width = (await scratchpad.boundingBox())!.width;
      const editor = panel.getByTestId("terminal-scratchpad-editor");
      const notes = await editor.inputValue();

      const toggle = panel.getByTestId("panel-toggle-scratchpad");
      await expect(toggle).toHaveAttribute("aria-label", "Hide scratchpad");

      await panel.getByTestId("terminal-scratchpad-collapse").click();
      await expect(scratchpad).toHaveCount(0);
      await expect(toggle).toHaveAttribute("aria-label", "Show scratchpad");

      await capture(panel, "04-scratchpad-collapsed");

      await toggle.click();
      await expect(scratchpad).toBeVisible();
      await expect(editor).toHaveValue(notes);
      await expect(editor).not.toBeFocused();
      expect(Math.abs((await scratchpad.boundingBox())!.width - width)).toBeLessThan(2);
      await expect(toggle).toHaveAttribute("aria-label", "Hide scratchpad");

      await toggle.click();
      await expect(scratchpad).toHaveCount(0);
      await toggle.click();
      await expect(scratchpad).toBeVisible();
    });

    test("leaves nothing behind when closed empty, and the menu brings it back", async () => {
      const { window } = ctx;
      const editor = panel.getByTestId("terminal-scratchpad-editor");

      await editor.fill("");
      await expect(panel.getByTestId("panel-toggle-scratchpad")).toHaveCount(0);
      await panel.getByTestId("terminal-scratchpad-collapse").click();

      await expect(panel.getByTestId("terminal-scratchpad")).toHaveCount(0);
      await expect(panel.getByTestId("panel-toggle-scratchpad")).toHaveCount(0);

      await capture(panel, "05-scratchpad-closed");

      await openScratchpadFromMenu(window, panel);
      await expect(panel.getByTestId("terminal-scratchpad")).toBeVisible();
      await expect(editor).toHaveValue("");
    });

    test("keeps the caret when a click in the notes is what selects the pane", async () => {
      const { window } = ctx;
      const other = await spawnTerminalAndVerify(window);
      await other.locator(".xterm-screen").click();
      await expectTerminalFocused(other);

      const editor = panel.getByTestId("terminal-scratchpad-editor");
      await editor.click();
      // The pane's own focus handoff runs a frame after selection; let two
      // frames pass so the notes are judged after it, not before.
      await window.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
          )
      );
      await expect(editor).toBeFocused();
      await window.keyboard.type("still here");
      await expect(editor).toHaveValue("still here");
      expect(await getTerminalText(panel)).not.toContain("still here");
    });
  });
});
