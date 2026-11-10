/**
 * Assistant session-cap review: the three menus that start an assistant
 * session on a named agent, with room for one more session and at the
 * six-session ceiling (#16659). The assistant header's "More actions" menu,
 * the session strip's menu one row below it, and the toolbar assistant
 * button's right-click menu each offer "New session with <agent>" rows, and
 * each has to say why those rows are parked when the ceiling is reached.
 *
 * Fake Claude and Codex CLIs sit ahead of any real one on PATH, so the
 * assistant offers both and every session is started through the real
 * `help.newSessionWithAgent` action, binding a real terminal to its lane.
 *
 *   DAINTREE_SHOT_ASSISTANT_CAP=1 DESIGN_CAPTURE_DIR=/abs/dir \
 *     ./node_modules/.bin/playwright test --project=screenshots assistant-session-cap-review --workers=1
 *
 * Env knobs:
 *   DAINTREE_SHOT_ASSISTANT_CAP  required — any truthy value runs the capture
 *   DESIGN_CAPTURE_DIR           required — output directory (never the repo)
 *   DAINTREE_SHOT_THEMES         comma-separated theme ids (default daintree,svalbard,namib)
 *   DAINTREE_SCREENSHOT_SCALE    device scale factor (default 2)
 *
 * Output: <dir>/<state>--<theme>.png. Every frame checks the menu it opened
 * shows the rows it should, enabled or parked, after its settle and before it
 * is written, and the run fails at the end if any expected file is missing.
 */

import { expect, test, type Locator, type Page } from "@playwright/test";
import { execSync } from "child_process";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { openAndOnboardProject } from "../helpers/project";
import { dismissBlockingPalette } from "../helpers/overlays";
import { setAppTheme } from "../helpers/theme";
import { dispatchAction } from "../helpers/actions";
import { installFakeAgent, fakeAgentEnv } from "../helpers/fakeAgent";
import { T_LONG } from "../helpers/timeouts";

const ENABLED = !!process.env.DAINTREE_SHOT_ASSISTANT_CAP;
const OUTPUT_DIR = process.env.DESIGN_CAPTURE_DIR
  ? path.resolve(process.env.DESIGN_CAPTURE_DIR)
  : "";
const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,svalbard,namib")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);
const SCALE = process.env.DAINTREE_SCREENSHOT_SCALE ?? "2";

const WINDOW = { width: 1440, height: 900 };
const PROJECT = "helios";
const MAX_SESSIONS = 6;
const AGENTS = ["claude", "codex"] as const;
const ASSISTANT_PANEL = 'aside[aria-label="Daintree Assistant"]';
const HEADER_MORE = '[data-testid="assistant-header-more"]';
const STRIP_PICKER = '[data-testid="assistant-session-picker"]';
const TOOLBAR_BUTTON = 'button[aria-label^="Daintree Assistant"][aria-pressed]';
const OPEN_MENU = '[role="menu"][data-state="open"]';
const AGENT_ROW = /^New session with /;
const POLISH_ID = "pw-assistant-cap-polish";
const POLISH_CSS = `
  *, *::before, *::after {
    animation-duration: 0s !important;
    animation-delay: 0s !important;
    transition-duration: 0s !important;
    transition-delay: 0s !important;
    caret-color: transparent !important;
  }
`;

/** Captured in every theme: the header and toolbar menus at the ceiling, and the strip beside them. */
const THEMED_STATES = ["header-cap", "toolbar-cap", "strip-cap"] as const;
/** Captured in the default theme only. */
const DEFAULT_STATES = ["header-room", "toolbar-room", "header-cap-keyboard"] as const;
type State = (typeof THEMED_STATES)[number] | (typeof DEFAULT_STATES)[number];
const STATES: readonly State[] = [...THEMED_STATES, ...DEFAULT_STATES];
const DEFAULT_THEME = THEMES[0] ?? "daintree";

function git(cmd: string, cwd: string): void {
  execSync(`git ${cmd}`, { cwd, stdio: "ignore" });
}

/** Own prefix: the shared e2e temp reaper never touches it. */
function createRepo(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), "acapshot-helios-"));
  git("init -b main", dir);
  git('config user.email "test@daintree.dev"', dir);
  git('config user.name "Daintree Test"', dir);
  git("config commit.gpgsign false", dir);
  writeFileSync(path.join(dir, "README.md"), "# Helios\n\nOperational dashboard.\n");
  writeFileSync(path.join(dir, ".gitignore"), ".e2e bin/\n");
  git("add -A", dir);
  git('commit -m "initial commit"', dir);
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

async function settle(page: Page, ms = 400): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
  );
  await page.waitForTimeout(ms);
}

async function polish(page: Page): Promise<void> {
  await page.evaluate(
    ({ id, css }) => {
      document.getElementById(id)?.remove();
      const style = document.createElement("style");
      style.id = id;
      style.textContent = css;
      document.head.appendChild(style);
    },
    { id: POLISH_ID, css: POLISH_CSS }
  );
}

async function parkPointer(page: Page): Promise<void> {
  const size = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
  await page.mouse.move(Math.min(160, size.w / 2), size.h - 40);
}

async function act(page: Page, id: string, args?: unknown): Promise<unknown> {
  const result = await dispatchAction(page, id, args, { source: "test" });
  if (!result.ok) throw new Error(`${id} failed: ${JSON.stringify(result.error ?? result)}`);
  return (result as { result?: unknown }).result;
}

function outFile(state: State, theme: string): string {
  return path.join(OUTPUT_DIR, `${state}--${theme}.png`);
}

async function assistantOpen(page: Page): Promise<boolean> {
  const aside = page.locator(ASSISTANT_PANEL);
  return (await aside.count()) > 0 && (await aside.getAttribute("inert")) === null;
}

async function ensureAssistantOpen(page: Page): Promise<void> {
  if (await assistantOpen(page)) return;
  await act(page, "help.togglePanel");
  await expect
    .poll(() => assistantOpen(page), { timeout: T_LONG, message: "assistant never opened" })
    .toBe(true);
  await settle(page, 800);
}

async function closeMenus(page: Page): Promise<void> {
  for (let i = 0; i < 3 && (await page.locator(OPEN_MENU).count()) > 0; i++) {
    await page.keyboard.press("Escape").catch(() => {});
    await settle(page, 200);
  }
}

/** What the app handed the platform screen reader since the last call: the announcer's first route. */
async function takeAnnouncements(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const w = window as unknown as { __capSaid?: string[] };
    const doc = document as unknown as {
      ariaNotify?: (msg: string, opts?: unknown) => void;
      __capWrapped?: boolean;
    };
    if (!doc.__capWrapped && typeof doc.ariaNotify === "function") {
      const original = doc.ariaNotify.bind(document);
      doc.ariaNotify = (msg: string, opts?: unknown) => {
        (w.__capSaid ??= []).push(msg);
        original(msg, opts);
      };
      doc.__capWrapped = true;
    }
    const said = w.__capSaid ?? [];
    w.__capSaid = [];
    return said;
  });
}

async function expectCeilingAnnounced(page: Page, expected: boolean): Promise<void> {
  const said = (await takeAnnouncements(page)).filter((m) => /maximum for one project/.test(m));
  if (said.length !== (expected ? 1 : 0)) {
    throw new Error(
      `menu opened with ${said.length} ceiling announcements, expected ${expected ? 1 : 0}`
    );
  }
}

async function openMenu(page: Page, trigger: Locator, how: "click" | "right" | "key") {
  await closeMenus(page);
  await takeAnnouncements(page);
  await trigger.waitFor({ state: "visible", timeout: T_LONG });
  if (how === "click") await trigger.click();
  else if (how === "right") await trigger.click({ button: "right" });
  else {
    await trigger.focus();
    await page.keyboard.press("Enter");
  }
  const menu = page.locator(OPEN_MENU).last();
  await menu.waitFor({ state: "visible", timeout: 8000 });
  return menu;
}

/** The lanes the strip lists, read from its menu. */
async function laneCount(page: Page): Promise<number> {
  const picker = page.locator(STRIP_PICKER);
  if ((await picker.count()) === 0) return 0;
  const menu = await openMenu(page, picker, "click");
  const count = await menu.locator('[role="menuitemradio"]').count();
  await closeMenus(page);
  return count;
}

interface RowRead {
  name: string;
  disabled: boolean;
}

async function agentRows(menu: Locator): Promise<RowRead[]> {
  return menu.locator('[role="menuitem"]').evaluateAll((items) =>
    items
      .map((el) => ({
        text: (el.textContent ?? "").trim(),
        name: el.getAttribute("aria-label") ?? (el.textContent ?? "").trim(),
        disabled: el.hasAttribute("data-disabled"),
      }))
      .filter((row) => row.text.startsWith("New session with"))
      .map(({ name, disabled }) => ({ name, disabled }))
  );
}

async function expectAgentRows(menu: Locator, disabled: boolean): Promise<void> {
  const rows = await agentRows(menu);
  if (rows.length < AGENTS.length) {
    throw new Error(`menu shows ${rows.length} "New session with" rows, expected ${AGENTS.length}`);
  }
  const wrong = rows.filter((row) => row.disabled !== disabled);
  if (wrong.length > 0) {
    throw new Error(
      `rows ${wrong.map((r) => r.name).join(", ")} are ${disabled ? "enabled" : "disabled"}`
    );
  }
  if (!rows.every((row) => AGENT_ROW.test(row.name) || row.name.length > 0)) {
    throw new Error("an agent row has no accessible name");
  }
}

/** The menu and the control that opened it, with room around both. */
async function snapMenu(
  page: Page,
  state: State,
  theme: string,
  menu: Locator,
  trigger: Locator
): Promise<void> {
  await parkPointer(page);
  await settle(page, 500);
  if (!(await menu.isVisible())) throw new Error("menu closed before the capture");
  const a = await menu.boundingBox();
  const b = await trigger.boundingBox();
  if (!a || !b) throw new Error("menu or trigger has no box");
  const view = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
  const pad = 20;
  const x = Math.max(0, Math.min(a.x, b.x) - pad);
  const y = Math.max(0, Math.min(a.y, b.y) - pad);
  const right = Math.min(view.w, Math.max(a.x + a.width, b.x + b.width) + pad);
  const bottom = Math.min(view.h, Math.max(a.y + a.height, b.y + b.height) + pad);
  await page.screenshot({
    path: outFile(state, theme),
    type: "png",
    caret: "hide",
    clip: { x, y, width: right - x, height: bottom - y },
  });
}

async function startSession(page: Page, agentId: string, expected: number): Promise<void> {
  await act(page, "help.newSessionWithAgent", { agentId });
  await expect
    .poll(() => laneCount(page), {
      timeout: T_LONG * 2,
      message: `strip never listed ${expected} sessions`,
    })
    .toBe(expected);
  await settle(page, 600);
}

/**
 * Set before any session starts: a theme that can't apply in place reloads the
 * view, and a reload brings fake-CLI lanes back empty.
 */
async function applyTheme(page: Page, theme: string): Promise<void> {
  const current = await page.locator("html").getAttribute("data-theme");
  if (current !== theme) {
    await setAppTheme(page, theme);
    await dismissBlockingPalette(page);
  }
  await polish(page);
  await settle(page, 800);
}

async function shoot(
  failures: string[],
  page: Page,
  state: State,
  theme: string,
  fn: () => Promise<void>
): Promise<void> {
  try {
    await fn();
    console.log(`[assistant-cap] wrote ${state}--${theme}`);
  } catch (error) {
    rmSync(outFile(state, theme), { force: true });
    const message = `${state}--${theme}: ${String(error).split("\n")[0]}`;
    failures.push(message);
    console.warn(`[assistant-cap] FAILED ${message}`);
  }
  await closeMenus(page);
  // Escape on the toolbar's context menu reaches the panel's escape-stack entry first.
  await ensureAssistantOpen(page).catch(() => {});
}

async function roomStates(page: Page, failures: string[]): Promise<void> {
  const theme = DEFAULT_THEME;
  await shoot(failures, page, "header-room", theme, async () => {
    const trigger = page.locator(HEADER_MORE);
    const menu = await openMenu(page, trigger, "click");
    await expectAgentRows(menu, false);
    await expectCeilingAnnounced(page, false);
    await snapMenu(page, "header-room", theme, menu, trigger);
  });
  await shoot(failures, page, "toolbar-room", theme, async () => {
    const trigger = page.locator(TOOLBAR_BUTTON).first();
    const menu = await openMenu(page, trigger, "right");
    await expectAgentRows(menu, false);
    await expectCeilingAnnounced(page, false);
    await snapMenu(page, "toolbar-room", theme, menu, trigger);
  });
}

async function capStates(page: Page, theme: string, failures: string[]): Promise<void> {
  await shoot(failures, page, "header-cap", theme, async () => {
    const trigger = page.locator(HEADER_MORE);
    const menu = await openMenu(page, trigger, "click");
    await expectAgentRows(menu, true);
    await expectCeilingAnnounced(page, true);
    await snapMenu(page, "header-cap", theme, menu, trigger);
  });
  await shoot(failures, page, "toolbar-cap", theme, async () => {
    const trigger = page.locator(TOOLBAR_BUTTON).first();
    const menu = await openMenu(page, trigger, "right");
    await expectAgentRows(menu, true);
    await expectCeilingAnnounced(page, true);
    await snapMenu(page, "toolbar-cap", theme, menu, trigger);
  });
  await shoot(failures, page, "strip-cap", theme, async () => {
    const trigger = page.locator(STRIP_PICKER);
    const menu = await openMenu(page, trigger, "click");
    await expectAgentRows(menu, true);
    await expectCeilingAnnounced(page, true);
    const radios = await menu.locator('[role="menuitemradio"]').count();
    if (radios !== MAX_SESSIONS) throw new Error(`strip lists ${radios} sessions`);
    await snapMenu(page, "strip-cap", theme, menu, trigger);
  });
  if (theme !== DEFAULT_THEME) return;
  await shoot(failures, page, "header-cap-keyboard", theme, async () => {
    const trigger = page.locator(HEADER_MORE);
    const menu = await openMenu(page, trigger, "key");
    await expectAgentRows(menu, true);
    await expectCeilingAnnounced(page, true);
    await page.keyboard.press("ArrowDown");
    await settle(page, 300);
    await snapMenu(page, "header-cap-keyboard", theme, menu, trigger);
  });
}

function expectedFiles(): string[] {
  return [
    ...THEMES.flatMap((theme) => THEMED_STATES.map((s) => `${s}--${theme}.png`)),
    ...DEFAULT_STATES.map((s) => `${s}--${DEFAULT_THEME}.png`),
  ].sort();
}

test("capture the assistant's new-session menus at the session ceiling", async () => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_ASSISTANT_CAP is required for the assistant session-cap capture",
  });
  test.skip(!ENABLED, "design capture harness — set DAINTREE_SHOT_ASSISTANT_CAP=1");
  if (!OUTPUT_DIR)
    throw new Error("DESIGN_CAPTURE_DIR must be set to a directory outside the repo");
  test.setTimeout(20 * 60_000);

  mkdirSync(OUTPUT_DIR, { recursive: true });
  const repoRoot = realpathSync(process.cwd());
  const outReal = realpathSync(OUTPUT_DIR);
  if (outReal === repoRoot || outReal.startsWith(repoRoot + path.sep)) {
    throw new Error(`DESIGN_CAPTURE_DIR must be outside the repo (${OUTPUT_DIR})`);
  }
  for (const file of readdirSync(OUTPUT_DIR)) {
    if (STATES.some((s) => file.startsWith(`${s}--`)))
      rmSync(path.join(OUTPUT_DIR, file), { force: true });
  }

  const failures: string[] = [];
  for (const theme of THEMES) {
    await captureTheme(theme, failures).catch((e) =>
      failures.push(`${theme}: ${String(e).split("\n")[0]}`)
    );
  }

  const expected = expectedFiles();
  const present = readdirSync(OUTPUT_DIR)
    .filter((f) => STATES.some((s) => f.startsWith(`${s}--`)))
    .sort();
  const missing = expected.filter((f) => !present.includes(f));
  console.log(`[assistant-cap] wrote ${present.length}/${expected.length} PNGs to ${OUTPUT_DIR}`);
  expect(failures, "state captures failed").toEqual([]);
  expect(missing, "files missing from the output directory").toEqual([]);
});

/** One launch per theme, so every theme is set before the first session starts. */
async function captureTheme(theme: string, failures: string[]): Promise<void> {
  const repo = createRepo();
  const binDir = installFakeAgent(repo.dir, { identity: "claude", perPane: true });
  installFakeAgent(repo.dir, { identity: "codex", perPane: true });
  const userDataDir = mkdtempSync(path.join(tmpdir(), "acapshot-ud-"));
  let ctx: AppContext | undefined;
  try {
    ctx = await launchApp({
      headed: false,
      userDataDir,
      screenshotScale: SCALE,
      windowSize: WINDOW,
      env: fakeAgentEnv(binDir),
      extraArgs: ["--disable-gpu", "--in-process-gpu", "--disable-breakpad", "--noerrdialogs"],
    });
    const { app } = ctx;
    const page = await openAndOnboardProject(app, ctx.window, repo.dir, PROJECT);
    await dismissBlockingPalette(page);
    await app.evaluate(({ BrowserWindow }, s) => {
      BrowserWindow.getAllWindows()[0]?.setContentSize(s.width, s.height);
    }, WINDOW);
    await settle(page, 1200);
    await applyTheme(page, theme);
    // Fake CLIs leave no conversation to capture, so a hibernated lane would come
    // back empty and count as room for a session.
    await page.evaluate(() =>
      window.electron.helpAssistant.setSettings({ idleHibernateMinutes: 0 })
    );
    await ensureAssistantOpen(page);

    // Both fake CLIs must be read as installed before the menus offer a choice.
    await expect
      .poll(
        async () => {
          const menu = await openMenu(page, page.locator(HEADER_MORE), "click");
          const rows = await agentRows(menu);
          await closeMenus(page);
          return rows.length;
        },
        { timeout: T_LONG * 2, message: "the header menu never offered both agents" }
      )
      .toBeGreaterThanOrEqual(AGENTS.length);

    for (let i = 0; i < MAX_SESSIONS - 1; i++) {
      await startSession(page, AGENTS[i % AGENTS.length]!, i + 1);
    }
    if (theme === DEFAULT_THEME) await roomStates(page, failures);
    await startSession(page, AGENTS[(MAX_SESSIONS - 1) % AGENTS.length]!, MAX_SESSIONS);
    await capStates(page, theme, failures);
  } finally {
    if (ctx?.app) await closeApp(ctx.app).catch(() => {});
    repo.cleanup();
    rmSync(userDataDir, { recursive: true, force: true });
  }
}
