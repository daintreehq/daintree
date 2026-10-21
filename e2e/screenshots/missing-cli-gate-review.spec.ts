/**
 * Missing-CLI launch gate — visual-review harness.
 *
 * Drives `missing-cli-gate-preview.html`, which mounts the REAL
 * `MissingCliGate` inside a stand-in pane at a fixed size, once per availability
 * state, plus the sibling `MemoryPressureGate` so the two gates an agent launch
 * can stop at are judged against each other. Short and narrow panes are their
 * own states: the gate's install list has to scroll rather than clip there.
 *
 *   DAINTREE_SHOT_MISSING_CLI_GATE=1 DESIGN_CAPTURE_DIR=/abs/dir \
 *     npx playwright test --project=screenshots missing-cli-gate-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_MISSING_CLI_GATE  required — any truthy value runs the capture
 *   DESIGN_CAPTURE_DIR              output directory (default artifacts/missing-cli-gate-shots)
 *   DAINTREE_SHOT_THEMES            comma-separated sweep (default daintree,bondi,namib)
 *   DAINTREE_SHOT_ONLY              comma-separated state filter
 *
 * Output: <state>-<theme>.png. Each capture first asserts a string only that
 * state puts on screen, and the test counts the files itself at the end.
 */

import { test, expect, type Locator, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readdirSync, rmSync } from "fs";
import path from "path";
import {
  makeSnap,
  startPreviewServer,
  stubViteHmrClient,
  type PreviewServer,
} from "../helpers/previewHarness";

const ENABLED = !!process.env.DAINTREE_SHOT_MISSING_CLI_GATE;
const OUT_DIR = path.resolve(
  process.env.DESIGN_CAPTURE_DIR ?? path.join(process.cwd(), "artifacts", "missing-cli-gate-shots")
);
const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,bondi,namib")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);
const ONLY = (process.env.DAINTREE_SHOT_ONLY ?? "").split(",").filter(Boolean);
const ATTACH_TIMEOUT_MS = 30_000;

interface State {
  name: string;
  query: string;
  /** Strings only this state puts on screen. */
  shows: (string | RegExp)[];
  act?: (pane: Locator) => Promise<void>;
}

const STATES: State[] = [
  { name: "missing", query: "state=missing&os=darwin", shows: ["Claude", /npm install -g/] },
  {
    name: "missing-linux",
    query: "state=missing&os=linux",
    shows: ["Claude", /install\.sh/],
  },
  {
    name: "missing-last-path",
    query: "state=missing-last-path&os=darwin",
    shows: ["Codex", "/Users/you/.local/bin/codex"],
  },
  { name: "missing-short", query: "state=missing&os=linux&h=380", shows: ["Claude"] },
  { name: "missing-narrow", query: "state=missing&os=linux&w=360&h=720", shows: ["Claude"] },
  { name: "installed-wsl", query: "state=installed-wsl", shows: [/Ubuntu-24\.04/] },
  { name: "installed", query: "state=installed", shows: [/shell function wrapper/] },
  { name: "blocked", query: "state=blocked", shows: [/EPERM/] },
  {
    name: "blocked-long-path",
    query: "state=blocked-long-path&w=360&h=640",
    shows: [/gemini-cli/],
  },
  { name: "ready", query: "state=ready", shows: ["Claude"] },
  { name: "unauthenticated", query: "state=unauthenticated", shows: ["Codex"] },
  {
    name: "recheck-failed",
    query: "state=blocked",
    shows: [/couldn.t (re-)?check/i],
    act: async (pane) => {
      await pane.getByRole("button", { name: /check/i }).first().click();
    },
  },
  { name: "memory-pressure", query: "state=memory-pressure&h=480", shows: [/Waiting to start/] },
];

test.use({ deviceScaleFactor: 2 });
let server: PreviewServer | undefined;

test.beforeAll(async () => {
  if (!ENABLED) return;
  if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });
  server = await startPreviewServer();
});

test.afterAll(async () => {
  await server?.close();
});

async function open(page: Page, query: string, theme: string): Promise<Locator> {
  await page.setViewportSize({ width: 1000, height: 1000 });
  const url = `${server!.baseURL}/missing-cli-gate-preview.html?theme=${theme}&${query}`;
  const shell = page.locator("[data-preview-shell]");
  for (let attempt = 0; ; attempt++) {
    await page.goto(url);
    try {
      await expect(shell).toBeVisible({ timeout: ATTACH_TIMEOUT_MS });
      break;
    } catch (error) {
      if (attempt >= 2) throw new Error(`${url} never rendered`, { cause: error });
    }
  }
  await page.evaluate(() => document.fonts.ready);
  await page.mouse.move(0, 0);
  return shell;
}

test("Missing-CLI launch gate", async ({ page }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_MISSING_CLI_GATE is required for the missing-CLI gate capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_MISSING_CLI_GATE=1 to run the capture");
  test.setTimeout(5 * 60_000);

  await stubViteHmrClient(page);
  const snap = makeSnap(OUT_DIR);
  const written: string[] = [];
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));

  const states = ONLY.length ? STATES.filter((s) => ONLY.includes(s.name)) : STATES;
  for (const theme of THEMES) {
    for (const state of states) {
      const shell = await open(page, state.query, theme);
      if (state.act) await state.act(shell);
      for (const text of state.shows) {
        await expect(shell.getByText(text).first()).toBeVisible({ timeout: ATTACH_TIMEOUT_MS });
      }
      // Past the 150ms state transitions and any callout entrance.
      await page.waitForTimeout(300);
      written.push(await snap(shell, `${state.name}-${theme}.png`));
    }
  }

  expect(pageErrors, `page errors during capture:\n${pageErrors.join("\n")}`).toEqual([]);
  const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  expect(onDisk.length).toBe(written.length);
});
