/**
 * Assistant panel visual-review harness — the whole rail, not one row of it.
 *
 * The native assistant is meant to read as a sibling of the terminal panes beside it:
 * one monospace face, at the terminal's own size, flush down a single left gutter. That
 * is a judgement about SPACING and RHYTHM across a whole column, and it is invisible in
 * the code — every individual padding looks reasonable on its own, and it is only the
 * accumulated stack of them that reads as a chat app rather than a terminal. So this
 * captures the full panel per state rather than cropping to a component, which is what
 * separates it from `assistant-tool-group-review.spec.ts` next door.
 *
 * Like that sibling it drives the panel's own preview entry (`assistant-preview.html`)
 * rather than booting Electron: the same React tree, the same `--assistant-*` palette
 * resolution, the same reducer output, from states captured off the real transport.
 *
 *   DESIGN_CAPTURE=1 npx playwright test --project=screenshots assistant-panel-review
 *
 * Env knobs:
 *   DESIGN_CAPTURE       required — any truthy value runs the capture
 *   DESIGN_CAPTURE_DIR   required — output directory, OUTSIDE the repo (no default, on
 *                        purpose: an in-repo fallback outlives the run and one blanket
 *                        `git add` puts a hundred PNGs in the history)
 *   DESIGN_CAPTURE_THEMES comma-separated theme sweep (default: daintree,bondi,namib)
 *   DESIGN_CAPTURE_WIDTH  rail width in px (default 400 — the real docked width)
 *
 * Hard rule, inherited from every sibling harness: never write a PNG that has not been
 * verified. `snap()` proves the target is attached with a real box before it writes and
 * throws otherwise, each state asserts a marker that only IT renders, and the test
 * counts the files itself at the end rather than trusting the exit code.
 */

import { test, expect, type Browser, type Locator, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readdirSync, rmSync } from "fs";
import path from "path";
import { createServer, type ViteDevServer } from "vite";

const ENABLED = !!process.env.DESIGN_CAPTURE;

/** The panel's real docked width, so line breaks land where they land in the product. */
const PANEL_WIDTH = Number(process.env.DESIGN_CAPTURE_WIDTH) || 400;

const THEMES = (process.env.DESIGN_CAPTURE_THEMES ?? "daintree,bondi,namib")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

/**
 * The states that carry design weight, and the marker that proves each one rendered.
 *
 * `empty` is the subject the review opens on — it is what a user sees before they have
 * typed anything, and it is the state that currently departs furthest from the terminal
 * the panel sits beside. The rest exist so a change cannot tighten the welcome block by
 * quietly breaking a populated transcript.
 *
 * `autoApprove` forces the permission banner on: it is a session setting rather than an
 * engine frame, so no captured state carries it, and it is the row directly above the
 * welcome block for most real users.
 */
const STATES = [
  { name: "empty", marker: "text=Put agents to work", autoApprove: true, what: "welcome / MOTD" },
  { name: "streaming", marker: ".assistant-prose", what: "mid-answer, caret live" },
  { name: "toolBatch", marker: ".assistant-prose", what: "settled turn with a tool group" },
  { name: "asyncWork", marker: ".assistant-prose", what: "handed off, still running" },
  { name: "degraded", marker: ".assistant-prose", what: "a failed call" },
  { name: "approvalTyped", marker: "text=Needs your approval", what: "gating approval card" },
  { name: "question", marker: "text=Daintree needs an answer", what: "question sheet" },
  { name: "turnError", marker: "text=The model provider is unavailable.", what: "the turn broke" },
  { name: "prose", marker: ".assistant-prose", what: "one of every prose element" },
] as const;

let server: ViteDevServer | undefined;
let baseURL = "";
let outDir = "";

test.beforeAll(async () => {
  // No test.skip here: `test.info()` is not available in a beforeAll hook, so the
  // structured-skip annotation the repo requires cannot be attached. The test body
  // carries the skip; this hook simply does no work when the flag is unset.
  if (!ENABLED) return;
  const requested = process.env.DESIGN_CAPTURE_DIR;
  if (!requested) {
    throw new Error("DESIGN_CAPTURE_DIR must be set to a directory outside the repo");
  }
  outDir = path.resolve(requested);
  if (outDir.startsWith(path.resolve(process.cwd()) + path.sep)) {
    throw new Error(`DESIGN_CAPTURE_DIR must be outside the repo — got ${outDir}`);
  }
  // Fresh directory per run: a leftover PNG from an earlier round read as this round's
  // output is the single easiest way to review a screen that no longer exists.
  if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  server = await createServer({ server: { port: 0 }, logLevel: "error" });
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === "string") throw new Error("vite gave no TCP address");
  baseURL = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
  await server?.close();
});

/**
 * Write one PNG, having proved there is something to write. Throws rather than writing
 * when the target is not really on screen, which is what keeps a green run from
 * producing a blank picture.
 */
async function snap(target: Locator, file: string): Promise<void> {
  await expect(target).toBeAttached();
  const box = await target.boundingBox();
  if (!box || box.width < 8 || box.height < 8) {
    throw new Error(`${file}: target has no real box (${JSON.stringify(box)}) — refusing to write`);
  }
  await target.screenshot({ path: path.join(outDir, file) });
}

/**
 * Load one fixture in one theme and settle it, on a page of its own.
 *
 * A page PER STATE, rather than one page navigated round the sweep: driving all
 * twenty-seven captures through a single page wedged reproducibly at about the
 * twentieth navigation, after which `#root` stayed empty for every remaining state and
 * the run died thirty seconds later with no error to explain it. The preview mounts the
 * real theme store, the real worktree provider and the whole app stylesheet on every
 * load, and nothing tears that down between navigations. A fresh page costs about a
 * second and removes the whole class of problem.
 */
async function open(page: Page, state: (typeof STATES)[number], theme: string): Promise<Locator> {
  await page.setViewportSize({ width: PANEL_WIDTH + 40, height: 1000 });
  const auto = state.autoApprove ? "&autoApprove=1" : "";
  await page.goto(
    `${baseURL}/assistant-preview.html?theme=${theme}&fixture=${state.name}&width=${PANEL_WIDTH}${auto}`
  );
  const panel = page.locator("#root > div").first();
  await expect(panel, `${state.name}/${theme}: the preview rendered nothing`).toBeAttached({
    timeout: 30_000,
  });
  // The panel paints its own surface and the fonts drive every measurement in it, so a
  // capture taken before they land measures the fallback face — which is precisely the
  // measurement a spacing review must not make.
  await page.evaluate(() => document.fonts.ready);
  // The marker is what proves the FIXTURE rendered, not merely that React mounted. A
  // blank panel is attached and has a box; only this separates it from a real state.
  await expect(page.locator(state.marker).first()).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(300);
  return panel;
}

test("assistant panel — every state that carries design weight, across themes", async ({
  browser,
}: {
  browser: Browser;
}) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DESIGN_CAPTURE is required for the assistant panel capture",
  });
  test.skip(!ENABLED, "design capture harness — set DESIGN_CAPTURE=1");

  for (const theme of THEMES) {
    for (const state of STATES) {
      const page = await browser.newPage();
      try {
        const panel = await open(page, state, theme);
        await snap(panel, `assistant--${state.name}--${theme}.png`);
      } finally {
        await page.close();
      }
    }
  }

  // Count the outputs rather than trusting the exit code. A harness that quietly writes
  // the wrong number of files sends a whole review off reasoning about a screen that
  // does not exist.
  const written = readdirSync(outDir).filter((f) => f.endsWith(".png"));
  expect(written.length, `expected ${STATES.length * THEMES.length} PNGs in ${outDir}`).toBe(
    STATES.length * THEMES.length
  );
});
