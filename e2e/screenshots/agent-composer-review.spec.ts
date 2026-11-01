/**
 * The agent composer (HybridInputBar) in every state that carries design
 * weight, across themes.
 *
 * Two fake Claude panes sit side by side, so one frame shows a composer at
 * rest beside the selected one. Each state is reached the way a user reaches
 * it: a click into the terminal or the composer, typing, `/` and `@` menus,
 * Shift+Enter, Backspace onto a chip, Tab onto a control.
 *
 *   DAINTREE_SHOT_COMPOSER=1 DESIGN_CAPTURE_DIR=/tmp/shots \
 *     npx playwright test --project=screenshots agent-composer-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_COMPOSER  required — any truthy value runs the capture
 *   DESIGN_CAPTURE_DIR      required — output directory (never the repo)
 *   DAINTREE_SHOT_THEMES    comma-separated theme ids (default daintree,namib,bondi,svalbard)
 *   DAINTREE_SHOT_ONLY      comma-separated state names to capture (default all)
 *
 * Output: <dir>/<state>--<theme>.png plus a .json sidecar per frame (focus
 * owner, composer and shell boxes, menu box). Every frame is checked against
 * the state it claims to show after the settle and before it is written, and
 * the run fails if any frame is missing.
 */

import { expect, test, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import { execSync } from "child_process";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { openAndOnboardProject } from "../helpers/project";
import { dismissBlockingPalette } from "../helpers/overlays";
import { setAppTheme } from "../helpers/theme";
import { dispatchAction } from "../helpers/actions";
import {
  installFakeAgent,
  fakeAgentEnv,
  ptyWrite,
  readFakeAgentLaunchLog,
  FAKE_AGENT_READY,
} from "../helpers/fakeAgent";
import { getTerminalTextById } from "../helpers/terminal";
import { SEL } from "../helpers/selectors";
import { T_LONG } from "../helpers/timeouts";

const ENABLED = !!process.env.DAINTREE_SHOT_COMPOSER;
const OUTPUT_DIR = process.env.DESIGN_CAPTURE_DIR
  ? path.resolve(process.env.DESIGN_CAPTURE_DIR)
  : "";
const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,namib,bondi,svalbard")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);
const ONLY = (process.env.DAINTREE_SHOT_ONLY ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const THEMED_STATES = [
  "pair-terminal-focus",
  "focused-empty",
  "draft-chips",
  "multiline",
  "slash-menu",
  "file-menu",
] as const;
const DAINTREE_STATES = [
  "pane-context",
  "max-height",
  "chip-staged",
  "menu-empty",
  "attach-focus",
  "disabled",
  "disabled-draft",
  "chip-staged-literal",
  "narrow-menu",
] as const;
type State = (typeof THEMED_STATES)[number] | (typeof DAINTREE_STATES)[number];

const WIDE = { width: 1440, height: 900 };
const NARROW = { width: 900, height: 820 };
const PROJECT = "helios";
const POLISH_ID = "pw-composer-polish";
const POLISH_CSS = `
  ::-webkit-scrollbar { display: none !important; width: 0 !important; height: 0 !important; }
  *, *::before, *::after {
    animation-duration: 0s !important;
    animation-delay: 0s !important;
    transition-duration: 0s !important;
    transition-delay: 0s !important;
  }
  .cm-cursorLayer { opacity: 1 !important; animation: none !important; }
`;

const MOD = process.platform === "darwin" ? "Meta" : "Control";

function wanted(state: State): boolean {
  return ONLY.length === 0 || ONLY.includes(state);
}

function git(cmd: string, cwd: string): void {
  execSync(`git ${cmd}`, { cwd, stdio: "ignore" });
}

/** Own prefix: the shared e2e temp reaper and pre-launch hygiene never touch it. */
function createRepo(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), "pwshot-composer-"));
  git("init -b main", dir);
  git('config user.email "test@daintree.dev"', dir);
  git('config user.name "Daintree Test"', dir);
  git("config commit.gpgsign false", dir);
  const files: Record<string, string> = {
    "README.md": "# Helios\n\nOperational dashboard.\n",
    "package.json": '{ "name": "helios", "private": true }\n',
    "src/auth/tokenRefresh.ts": "export const REFRESH_SKEW_MS = 30_000;\n",
    "src/auth/tokenRefresh.test.ts": "// refresh tests\n",
    "src/auth/session.ts": "export {};\n",
    "src/auth/sessionStore.ts": "export {};\n",
    "src/api/client.ts": "export {};\n",
    "src/api/retryPolicy.ts": "export {};\n",
    "src/panes/toolbar.tsx": "export {};\n",
    "src/panes/stepper.tsx": "export {};\n",
    "docs/architecture/auth-token-lifecycle.md": "# Token lifecycle\n",
  };
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), body);
  }
  writeFileSync(path.join(dir, ".gitignore"), ".e2e bin/\n");
  git("add -A", dir);
  git('commit -m "initial commit"', dir);
  // An uncommitted change so `@diff` has something to name.
  writeFileSync(
    path.join(dir, "src/auth/tokenRefresh.ts"),
    "export const REFRESH_SKEW_MS = 45_000;\n"
  );
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

async function act(page: Page, id: string, args?: unknown): Promise<unknown> {
  const result = await dispatchAction(page, id, args, { source: "test" });
  if (!result.ok) throw new Error(`${id} failed: ${JSON.stringify(result.error ?? result)}`);
  return (result as { result?: unknown }).result;
}

async function settle(page: Page, ms = 350): Promise<void> {
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
  await page.mouse.move(4, 300);
}

async function setWindowSize(
  app: ElectronApplication,
  page: Page,
  size: { width: number; height: number }
): Promise<void> {
  await app.evaluate(({ BrowserWindow }, s) => {
    BrowserWindow.getAllWindows()[0]?.setContentSize(s.width, s.height);
  }, size);
  await expect
    .poll(() => page.evaluate(() => window.innerWidth), { timeout: T_LONG })
    .toBe(size.width);
  await settle(page, 600);
}

async function worktreeId(page: Page): Promise<string> {
  let id: string | undefined;
  await expect
    .poll(
      async () => {
        id = await page.evaluate(() => {
          const w = window as unknown as {
            __DAINTREE_E2E_WORKTREES__?: () => Array<{ id: string; isMainWorktree?: boolean }>;
          };
          const list = w.__DAINTREE_E2E_WORKTREES__?.() ?? [];
          return (list.find((t) => t.isMainWorktree) ?? list[0])?.id;
        });
        return id ?? null;
      },
      { timeout: T_LONG, message: "no worktree listed" }
    )
    .not.toBeNull();
  return id!;
}

async function launchAgent(page: Page, binDir: string, wt: string): Promise<string> {
  const before = readFakeAgentLaunchLog(binDir).filter((l) => l.paneId).length;
  await act(page, "agent.launch", { agentId: "claude", location: "grid", worktreeId: wt });
  await expect
    .poll(() => readFakeAgentLaunchLog(binDir).filter((l) => l.paneId).length, {
      timeout: T_LONG * 2,
      message: "fake agent never started",
    })
    .toBe(before + 1);
  const paneId = readFakeAgentLaunchLog(binDir).filter((l) => l.paneId)[before].paneId!;
  await expect
    .poll(() => getTerminalTextById(page, paneId), { timeout: T_LONG })
    .toContain("Enter to confirm");
  if (!(await ptyWrite(page, paneId, "\r"))) throw new Error("terminal.write unavailable");
  await expect
    .poll(() => getTerminalTextById(page, paneId), { timeout: T_LONG })
    .toContain(FAKE_AGENT_READY);
  return paneId;
}

interface Panes {
  a: string;
  b: string;
}

const pane = (page: Page, id: string): Locator => page.locator(`[data-panel-id="${id}"]`);
const composer = (page: Page, id: string): Locator =>
  pane(page, id).locator("[data-hybrid-input-root]").first();
const editor = (page: Page, id: string): Locator => composer(page, id).locator(".cm-content");
const menu = (page: Page, id: string): Locator =>
  composer(page, id).locator("[data-autocomplete-menu]");

async function clearDraft(page: Page, id: string): Promise<void> {
  const ed = editor(page, id);
  // A press on the `❯`, the way a user enters a composer: it selects the pane
  // and hands the editor the keyboard. Not the editor's own box, which past the
  // height cap runs under the clip, and not a programmatic focus, which leaves
  // the pane unselected.
  await composer(page, id).locator("[data-composer-marker]").click();
  await expect
    .poll(() =>
      page.evaluate(
        (pid) => !!document.activeElement?.closest(`[data-hybrid-input-root="${pid}"] .cm-content`),
        id
      )
    )
    .toBe(true);
  await page.keyboard.press(`${MOD}+A`);
  await page.keyboard.press("Backspace");
  await expect(ed.locator(".cm-placeholder")).toBeVisible({ timeout: 5000 });
}

async function focusTerminal(page: Page, id: string): Promise<void> {
  // A click on the terminal hands the keyboard to the composer (the pane's
  // home surface), so move it the way the keybinding does.
  await editor(page, id).click({ force: true });
  await act(page, "terminal.toggleInputSurface");
  await expect
    .poll(
      () =>
        page.evaluate(
          (pid) =>
            !!document.activeElement?.closest(`[data-panel-id="${pid}"] .xterm`) &&
            !document.activeElement?.closest("[data-hybrid-input-root]"),
          id
        ),
      { message: "keyboard never reached the terminal" }
    )
    .toBe(true);
}

async function typeDraft(page: Page, id: string, text: string): Promise<void> {
  await clearDraft(page, id);
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) await page.keyboard.press("Shift+Enter");
    await page.keyboard.type(lines[i], { delay: 4 });
  }
}

type Box = { x: number; y: number; width: number; height: number };

async function snap(
  page: Page,
  state: State,
  theme: string,
  targets: Locator[],
  opts: { padX?: number; padTop?: number; padBottom?: number } = {}
): Promise<void> {
  await settle(page);
  const boxes: Box[] = [];
  for (const target of targets) {
    const box = await target.boundingBox();
    if (!box || box.width < 4 || box.height < 4) {
      throw new Error(`${state}: crop target has no real box (${JSON.stringify(box)})`);
    }
    boxes.push(box);
  }
  const padX = opts.padX ?? 12;
  const view = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
  const left = Math.max(0, Math.min(...boxes.map((b) => b.x)) - padX);
  const top = Math.max(0, Math.min(...boxes.map((b) => b.y)) - (opts.padTop ?? 12));
  const bottom = Math.min(
    view.h,
    Math.max(...boxes.map((b) => b.y + b.height)) + (opts.padBottom ?? 12)
  );
  const right = Math.min(view.w, Math.max(...boxes.map((b) => b.x + b.width)) + padX);
  const sidecar = await page.evaluate(() => {
    const rect = (el: Element | null) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return {
        x: Math.round(r.x),
        y: Math.round(r.y),
        w: Math.round(r.width),
        h: Math.round(r.height),
      };
    };
    const ae = document.activeElement as HTMLElement | null;
    return {
      activeElement: ae
        ? `${ae.tagName.toLowerCase()}${ae.className ? "." + String(ae.className).split(" ").join(".") : ""}${ae.getAttribute("aria-label") ? `[${ae.getAttribute("aria-label")}]` : ""}`
        : null,
      composers: Array.from(document.querySelectorAll("[data-hybrid-input-root]")).map((root) => ({
        id: root.getAttribute("data-hybrid-input-root"),
        root: rect(root),
        shell: rect(
          root.querySelector("[data-composer-state], [data-voice-active], [data-fleet-armed]")
        ),
        state:
          root.querySelector("[data-composer-state]")?.getAttribute("data-composer-state") ?? null,
        menu: rect(root.querySelector("[data-autocomplete-menu]")),
      })),
    };
  });
  writeFileSync(path.join(OUTPUT_DIR, `${state}--${theme}.json`), JSON.stringify(sidecar, null, 2));
  await page.screenshot({
    path: path.join(OUTPUT_DIR, `${state}--${theme}.png`),
    type: "png",
    animations: "disabled",
    clip: { x: left, y: top, width: right - left, height: bottom - top },
  });
}

async function expectComposerFocused(page: Page, id: string): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(
        (pid) => !!document.activeElement?.closest(`[data-hybrid-input-root="${pid}"] .cm-content`),
        id
      )
    )
    .toBe(true);
}

// ---------------------------------------------------------------------------
// States

const CHIP_DRAFT =
  "Check @diff against @src/auth/tokenRefresh.ts, then read @terminal and explain why the skew changed";

async function themedStates(page: Page, panes: Panes, theme: string): Promise<void> {
  const { a, b } = panes;
  const both = [composer(page, a), composer(page, b)];

  if (wanted("pair-terminal-focus")) {
    await clearDraft(page, a);
    await clearDraft(page, b);
    await focusTerminal(page, a);
    await parkPointer(page);
    await expect(composer(page, a).locator("[data-composer-state]")).toHaveAttribute(
      "data-composer-state",
      "selected"
    );
    await expect(composer(page, b).locator("[data-composer-state]")).toHaveAttribute(
      "data-composer-state",
      "rest"
    );
    await snap(page, "pair-terminal-focus", theme, both, { padTop: 80 });
  }

  if (wanted("focused-empty")) {
    await clearDraft(page, a);
    await parkPointer(page);
    await expectComposerFocused(page, a);
    await snap(page, "focused-empty", theme, both, { padTop: 80 });
  }

  if (wanted("draft-chips")) {
    await typeDraft(page, a, CHIP_DRAFT);
    await parkPointer(page);
    await settle(page, 500);
    const chips = composer(page, a).locator(".cm-diff-chip, .cm-terminal-chip, .cm-file-chip");
    await expect.poll(() => chips.count(), { timeout: 5000 }).toBeGreaterThanOrEqual(3);
    await expectComposerFocused(page, a);
    await snap(page, "draft-chips", theme, [composer(page, a)], { padTop: 60 });
  }

  if (wanted("multiline")) {
    await typeDraft(
      page,
      a,
      "Refresh tokens fail when the clock skews past 30s.\nReproduce it with the fake clock in tokenRefresh.test.ts,\nthen fix the skew check and keep the retry policy as it is."
    );
    await parkPointer(page);
    await expect.poll(() => editor(page, a).locator(".cm-line").count()).toBe(3);
    await snap(page, "multiline", theme, [composer(page, a)], { padTop: 60 });
  }

  if (wanted("slash-menu")) {
    await typeDraft(page, a, "/");
    await expect(menu(page, a)).toBeVisible({ timeout: 8000 });
    await expect
      .poll(() => menu(page, a).locator('[role="option"]:not([data-autocomplete-band])').count(), {
        timeout: 8000,
      })
      .toBeGreaterThan(2);
    await page.keyboard.press("ArrowDown");
    await parkPointer(page);
    await snap(page, "slash-menu", theme, [composer(page, a), menu(page, a)], { padTop: 16 });
  }

  if (wanted("file-menu")) {
    await typeDraft(page, a, "Look at @src/au");
    await expect(menu(page, a)).toBeVisible({ timeout: 8000 });
    await expect
      .poll(() => menu(page, a).locator('[role="option"][aria-selected]').count(), {
        timeout: 10000,
      })
      .toBeGreaterThan(1);
    await parkPointer(page);
    await snap(page, "file-menu", theme, [composer(page, a), menu(page, a)], { padTop: 16 });
  }

  await clearDraft(page, a);
}

async function daintreeStates(app: ElectronApplication, page: Page, panes: Panes): Promise<void> {
  const theme = "daintree";
  const { a } = panes;

  if (wanted("pane-context")) {
    await typeDraft(page, a, "Fix the flaky refresh test and run it three times");
    await parkPointer(page);
    await snap(page, "pane-context", theme, [pane(page, a)], { padTop: 4, padBottom: 4, padX: 4 });
  }

  if (wanted("max-height")) {
    const long = Array.from(
      { length: 12 },
      (_, i) => `Step ${i + 1}: check the refresh path for case ${i + 1} and note what it returns`
    ).join("\n");
    await typeDraft(page, a, long);
    await parkPointer(page);
    await snap(page, "max-height", theme, [composer(page, a)], { padTop: 40 });
  }

  if (wanted("chip-staged")) {
    // The space closes the menu and settles the chip; the first Backspace
    // takes the space, the second stages the chip.
    await typeDraft(page, a, "Summarise @diff ");
    await page.keyboard.press("Backspace");
    await page.keyboard.press("Backspace");
    await expect(composer(page, a).locator(".cm-chip-pending-delete")).toHaveCount(1, {
      timeout: 5000,
    });
    await parkPointer(page);
    await snap(page, "chip-staged", theme, [composer(page, a)], { padTop: 40 });
  }

  if (wanted("menu-empty")) {
    await typeDraft(page, a, "@zzqqxx");
    await expect(menu(page, a)).toBeVisible({ timeout: 8000 });
    await expect(menu(page, a)).toContainText(/No files match|No matches/, { timeout: 10000 });
    await parkPointer(page);
    await snap(page, "menu-empty", theme, [composer(page, a), menu(page, a)], { padTop: 16 });
  }

  if (wanted("attach-focus")) {
    await typeDraft(page, a, "Attach the failing trace");
    await page.keyboard.press("Tab");
    await expect
      .poll(() =>
        page.evaluate(
          (pid) =>
            document.activeElement?.closest(`[data-hybrid-input-root="${pid}"]`) !== null &&
            document.activeElement?.tagName === "BUTTON",
          a
        )
      )
      .toBe(true);
    await parkPointer(page);
    await snap(page, "attach-focus", theme, [composer(page, a)], { padTop: 40 });
  }

  if (wanted("disabled")) {
    await clearDraft(page, a);
    await act(page, "terminal.toggleInputLock", { terminalId: a });
    await settle(page, 500);
    await expect(composer(page, a).locator("[aria-disabled=true]").first()).toBeAttached();
    await parkPointer(page);
    await snap(page, "disabled", theme, [composer(page, a), composer(page, panes.b)], {
      padTop: 60,
    });
    await act(page, "terminal.toggleInputLock", { terminalId: a });
    await settle(page, 500);
  }

  if (wanted("disabled-draft")) {
    await typeDraft(page, a, "Rerun the refresh tests three times");
    await act(page, "terminal.toggleInputLock", { terminalId: a });
    await settle(page, 500);
    await expect(composer(page, a).locator("[data-disabled-caption]")).toBeVisible();
    await parkPointer(page);
    await snap(page, "disabled-draft", theme, [composer(page, a)], { padTop: 40 });
    await act(page, "terminal.toggleInputLock", { terminalId: a });
    await settle(page, 500);
  }

  if (wanted("chip-staged-literal")) {
    // As with the pill: the space settles the reference, the first Backspace
    // takes the space, the second stages it.
    await typeDraft(page, a, "Read @src/auth/session.ts ");
    await page.keyboard.press("Backspace");
    await page.keyboard.press("Backspace");
    await expect(composer(page, a).locator(".cm-file-chip.cm-chip-pending-delete")).toHaveCount(1, {
      timeout: 5000,
    });
    await parkPointer(page);
    await snap(page, "chip-staged-literal", theme, [composer(page, a)], { padTop: 40 });
  }

  if (wanted("narrow-menu")) {
    await setWindowSize(app, page, NARROW);
    await typeDraft(page, a, "Compare @src/api/");
    await expect(menu(page, a)).toBeVisible({ timeout: 8000 });
    await expect
      .poll(() => menu(page, a).locator('[role="option"][aria-selected]').count(), {
        timeout: 10000,
      })
      .toBeGreaterThan(0);
    await parkPointer(page);
    await snap(page, "narrow-menu", theme, [pane(page, a), menu(page, a)], { padTop: 4 });
    await setWindowSize(app, page, WIDE);
  }

  await clearDraft(page, a);
}

function expectedFiles(): string[] {
  const out: string[] = [];
  for (const theme of THEMES)
    for (const s of THEMED_STATES)
      if (wanted(s)) out.push(`${s}--${theme}.png`, `${s}--${theme}.json`);
  if (THEMES.includes("daintree"))
    for (const s of DAINTREE_STATES)
      if (wanted(s)) out.push(`${s}--daintree.png`, `${s}--daintree.json`);
  return out.sort();
}

async function switchTheme(page: Page, theme: string): Promise<void> {
  const current = await page.locator("html").getAttribute("data-theme");
  if (current === theme) return;
  await page.evaluate(async (id) => {
    await window.electron.appTheme.setColorScheme(id);
  }, theme);
  const live = await expect
    .poll(() => page.locator("html").getAttribute("data-theme"), { timeout: 8000 })
    .toBe(theme)
    .then(() => true)
    .catch(() => false);
  if (!live) {
    await setAppTheme(page, theme);
    await dismissBlockingPalette(page);
  }
  await polish(page);
  await settle(page, 1200);
}

test.describe("agent composer review", () => {
  test.skip(!ENABLED, "design capture harness — set DAINTREE_SHOT_COMPOSER=1");
  test.setTimeout(30 * 60_000);

  test("captures the composer across states and themes", async () => {
    if (!OUTPUT_DIR)
      throw new Error("DESIGN_CAPTURE_DIR must be set to a directory outside the repo");
    mkdirSync(OUTPUT_DIR, { recursive: true });
    const repoRoot = realpathSync(process.cwd());
    const outReal = realpathSync(OUTPUT_DIR);
    if (outReal === repoRoot || outReal.startsWith(repoRoot + path.sep)) {
      throw new Error(`DESIGN_CAPTURE_DIR must be outside the repo (${OUTPUT_DIR})`);
    }
    // Only the frames this run will write, so a DAINTREE_SHOT_ONLY pass keeps the rest.
    const expectedAtStart = new Set(expectedFiles());
    for (const file of readdirSync(OUTPUT_DIR)) {
      if (expectedAtStart.has(file)) rmSync(path.join(OUTPUT_DIR, file), { force: true });
    }

    const repo = createRepo();
    const binDir = installFakeAgent(repo.dir, { perPane: true });
    let ctx: AppContext | undefined;
    const failures: string[] = [];
    try {
      ctx = await launchApp({
        windowSize: WIDE,
        screenshotScale: "2",
        env: fakeAgentEnv(binDir),
        extraArgs: ["--disable-breakpad", "--noerrdialogs"],
      });
      const page = await openAndOnboardProject(ctx.app, ctx.window, repo.dir, PROJECT);
      await dismissBlockingPalette(page);
      await page.locator(SEL.worktree.mainCard).waitFor({ state: "visible", timeout: T_LONG });
      await setWindowSize(ctx.app, page, WIDE);
      await polish(page);

      const wt = await worktreeId(page);
      const a = await launchAgent(page, binDir, wt);
      const b = await launchAgent(page, binDir, wt);
      await act(page, "terminal.rename", { terminalId: a, name: "fix flaky auth token refresh" });
      await act(page, "terminal.rename", { terminalId: b, name: "ci cache warmup" });
      await composer(page, a).waitFor({ state: "visible", timeout: T_LONG });
      await composer(page, b).waitFor({ state: "visible", timeout: T_LONG });
      await settle(page, 1500);
      const panes = { a, b };

      for (const theme of THEMES) {
        try {
          await switchTheme(page, theme);
          await themedStates(page, panes, theme);
          if (theme === "daintree") await daintreeStates(ctx.app, page, panes);
        } catch (error) {
          failures.push(`${theme}: ${String(error).split("\n").slice(0, 6).join(" | ")}`);
        }
      }

      const expected = expectedFiles();
      const present = readdirSync(OUTPUT_DIR)
        .filter((f) => expectedAtStart.has(f))
        .sort();
      const missing = expected.filter((f) => !present.includes(f));
      console.log(
        `[agent-composer] wrote ${present.filter((f) => f.endsWith(".png")).length}/${expected.filter((f) => f.endsWith(".png")).length} PNGs to ${OUTPUT_DIR}`
      );
      expect(failures, "state captures failed").toEqual([]);
      expect(missing, "files missing from the output directory").toEqual([]);
    } finally {
      if (ctx?.app) await closeApp(ctx.app).catch(() => {});
      repo.cleanup();
    }
  });
});
