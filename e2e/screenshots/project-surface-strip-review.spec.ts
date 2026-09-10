/**
 * Project-surface strip visual-review harness.
 *
 * Drives `ProjectSurfaceFrame` — the host chrome Daintree keeps above a project
 * plugin's `emptyCanvas` surface — through every state that carries design
 * weight, and writes a PNG of the canvas for each.
 *
 * This strip only exists when a project-local plugin claims the empty-canvas
 * slot, so it can only be judged in that context: it is thin host chrome framing
 * someone else's full-bleed view, and the question it has to answer is whether
 * it stays subordinate to the content below it. The first-show consent notice is
 * the same story at a different scale — it renders once, stacked on a 32px bar,
 * and its proportion against that bar is the whole design problem.
 *
 * Sibling of `canvas-home-review.spec.ts`, which owns the stock canvas this
 * strip switches back to.
 *
 * NOT covered, both for the same reason — the state cannot be reached from the
 * renderer, so a capture of it would have to be staged rather than driven:
 *
 *   - A plugin view that fails to load. That path replaces the region with the
 *     host's own error content and never renders the strip's surface half, so it
 *     is a different surface.
 *   - The failed-save banner. It needs `plugin.setProjectSurfaceChoice` to
 *     reject, and the bridge is a contextBridge object: neither assignment nor
 *     `defineProperty` takes, and every route that does not go through the
 *     bridge stages the banner into a shape the app cannot actually reach. It is
 *     reviewed from source, and owned by
 *     `src/components/Plugin/__tests__/ProjectSurfaceFrame.test.tsx`.
 *
 * Opt-in only: skips itself unless DAINTREE_SHOT_THEME is set, so neither the
 * marketing screenshots workflow nor a bare `--project=screenshots` runs it.
 *
 *   DAINTREE_SHOT_THEME=daintree npx playwright test --project=screenshots project-surface-strip-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_THEME  required — theme id to render (e.g. daintree, bondi)
 *   DAINTREE_SHOT_DIR    optional absolute output dir (default artifacts/…)
 *   DAINTREE_SHOT_TAG    optional suffix to keep before/after rounds side by side
 *   DAINTREE_SHOT_ONLY   comma-separated step filter (see STEPS below)
 *   DAINTREE_SCREENSHOT_SCALE  device scale factor (default 2)
 *
 * Output: <dir>/<theme>/<NN-slug>[-tag].png plus a `-strip` tight crop of the
 * chrome itself for each full-canvas shot (gitignored).
 */

import { expect, test, type Page } from "@playwright/test";
import { createHash } from "crypto";
import { mkdirSync, rmSync, existsSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { openAndOnboardProject } from "../helpers/project";
import { dismissBlockingPalette } from "../helpers/overlays";
import { setAppTheme } from "../helpers/theme";
import { createFixtureRepo, type FixtureRepo } from "../helpers/fixtures";
import { SEL } from "../helpers/selectors";
import { T_LONG } from "../helpers/timeouts";

const THEME = process.env.DAINTREE_SHOT_THEME ?? "";
const TAG = process.env.DAINTREE_SHOT_TAG ? `-${process.env.DAINTREE_SHOT_TAG}` : "";
const SCALE = process.env.DAINTREE_SCREENSHOT_SCALE ?? "2";
const OUTPUT_DIR = path.join(
  process.env.DAINTREE_SHOT_DIR ?? path.resolve(process.cwd(), "artifacts", "surface-strip-shots"),
  THEME || "unset"
);

const CANVAS = "#panel-grid";
const STRIP = '[data-testid="project-surface-strip"]';
const FRAME = '[data-testid="project-surface-frame"]';

const WIDE = { width: 1680, height: 1050 };

const PLUGIN_ID = "acme.mission-control";

/**
 * Every shot this harness owes, in capture order. Kept as data rather than
 * spelled only inside the steps so the run can count what actually landed on
 * disk against what was promised — an exit code alone has never been evidence
 * that a capture harness produced anything.
 */
const STEPS = [
  { name: "first-show", slug: "01-first-show" },
  { name: "rest", slug: "02-rest-surface" },
  { name: "stock", slug: "03-stock-launcher" },
  { name: "focus", slug: "04-focus-switch" },
  { name: "narrow", slug: "05-narrow" },
  { name: "long-name", slug: "06-long-name" },
  { name: "narrow-long-name", slug: "07-narrow-long-name" },
  { name: "forced-colors", slug: "08-forced-colors" },
  { name: "contrast-more", slug: "09-contrast-more" },
  { name: "narrow-notice", slug: "10-narrow-notice" },
] as const;

// Freeze animations and hide carets so captures are deterministic. The segment
// thumb slides between segments on every switch, and a mid-transition frame
// reads as a misaligned control that isn't.
const POLISH_CSS = `
  ::-webkit-scrollbar { display: none !important; width: 0 !important; height: 0 !important; }
  *, *::before, *::after {
    animation-duration: 0s !important;
    animation-delay: 0s !important;
    transition-duration: 0s !important;
    transition-delay: 0s !important;
    caret-color: transparent !important;
  }
`;

/**
 * A project-local plugin claiming the empty-canvas slot.
 *
 * The panel deliberately draws its own full-bleed content AND pins a toolbar
 * into its top-right corner. That corner is the documented hazard this strip
 * exists to stay out of, and a fixture whose plugin draws nothing there would
 * photograph a collision that cannot happen. `panelName` is a parameter because
 * the switch's first segment carries it, and a name that always fits hides the
 * truncation the 32-char cap is for.
 */
function writeSurfacePlugin(projectDir: string, panelName: string): void {
  const root = path.join(projectDir, ".daintree", "plugins", PLUGIN_ID);
  mkdirSync(path.join(root, "dist"), { recursive: true });
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ type: "module", private: true }));
  writeFileSync(
    path.join(root, "plugin.json"),
    JSON.stringify(
      {
        name: PLUGIN_ID,
        version: "0.1.0",
        scope: "project",
        displayName: "Mission Control",
        description: "The project's own canvas.",
        main: "dist/index.js",
        engines: { daintree: ">=0.11.0" },
        capabilities: [],
        contributes: {
          panels: [
            {
              id: "overview",
              name: panelName,
              iconId: "monitor-play",
              color: "var(--theme-category-rose)",
              hasPty: false,
              canRestart: false,
              canConvert: false,
              showInPalette: true,
            },
          ],
          views: [{ id: "overview", componentPath: "dist/panel.js", location: "panel" }],
          surfaces: { emptyCanvas: { viewId: "overview" } },
        },
      },
      null,
      2
    )
  );
  writeFileSync(
    path.join(root, "dist/index.js"),
    "export async function activate() { return () => {}; }"
  );
  // Plain ESM, no build step: the view loader takes the module as written.
  writeFileSync(
    path.join(root, "dist/panel.js"),
    `
    import { createElement as h } from "react";
    const card = (title, meta, tone) =>
      h("div", {
        key: title,
        style: {
          border: "1px solid rgba(128,128,128,0.22)", borderRadius: 10, padding: "14px 16px",
          display: "flex", flexDirection: "column", gap: 8, minHeight: 96,
          background: "rgba(128,128,128,0.06)",
        },
      },
        h("div", { style: { fontSize: 13, fontWeight: 600, opacity: 0.92 } }, title),
        h("div", { style: { fontSize: 11, opacity: 0.55 } }, meta),
        h("div", { style: { marginTop: "auto", height: 4, borderRadius: 2, background: tone } })
      );
    export default function Panel() {
      return h("div", {
        "data-testid": "plugin-surface",
        style: { position: "absolute", inset: 0, display: "flex", flexDirection: "column", overflow: "hidden" },
      },
        h("div", {
          style: {
            display: "flex", alignItems: "center", justifyContent: "space-between",
            padding: "18px 24px 10px",
          },
        },
          h("div", { style: { fontSize: 20, fontWeight: 600 } }, "Mission Control"),
          h("div", { style: { display: "flex", gap: 8 } },
            h("button", { type: "button", style: { fontSize: 12, padding: "5px 10px", borderRadius: 6, border: "1px solid rgba(128,128,128,0.28)", background: "transparent", color: "inherit" } }, "Refresh"),
            h("button", { type: "button", style: { fontSize: 12, padding: "5px 10px", borderRadius: 6, border: "1px solid rgba(128,128,128,0.28)", background: "transparent", color: "inherit" } }, "New run")
          )
        ),
        h("div", {
          style: {
            display: "grid", gap: 12, padding: "6px 24px 24px",
            gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", overflow: "auto",
          },
        },
          card("Device flow refresh", "staged · 3 gates green", "rgba(110,190,130,0.8)"),
          card("Retry backoff jitter", "drafting · 1 gate red", "rgba(220,150,90,0.8)"),
          card("Pulse heatmap alignment", "final · shipped", "rgba(120,160,220,0.8)"),
          card("Palette density pass", "staged · 2 gates green", "rgba(110,190,130,0.8)"),
          card("Worktree rail spacing", "drafting", "rgba(150,150,150,0.6)"),
          card("Forced-colors sweep", "queued", "rgba(150,150,150,0.6)")
        )
      );
    }
  `
  );
}

async function settle(page: Page, ms = 350): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
  );
  await page.waitForTimeout(ms);
}

/**
 * Wait until the plugin's panel kind is registered.
 *
 * A project plugin is discovered, activated and registered out of process, and
 * the surface claim is only published once its view has a resolvable panel
 * kind behind it. None of that is instant, and until it lands the region draws
 * the stock canvas — which is a perfectly plausible screenshot of the wrong
 * thing. So gate on the kind, not on a timeout.
 */
async function waitForPluginKind(page: Page): Promise<void> {
  await expect
    .poll(
      async () =>
        (await page.evaluate(() => window.electron.plugin.getPanelKinds())).some((kind) =>
          kind.extensionId?.includes(PLUGIN_ID)
        ),
      { timeout: 90_000, message: `${PLUGIN_ID} never registered its panel kind` }
    )
    .toBe(true);
}

/**
 * Wait for the frame to be what the canvas region is drawing. The frame's own
 * testid is the marker: the strip is inside it, and the stock canvas renders
 * neither, so this distinguishes "the plugin claimed the slot" from "the claim
 * has not arrived yet" — which look identical if you wait on the canvas alone.
 */
async function waitForFrame(page: Page): Promise<void> {
  await page.locator(CANVAS).waitFor({ state: "visible", timeout: T_LONG });
  await waitForPluginKind(page);
  await page.locator(FRAME).waitFor({ state: "visible", timeout: T_LONG });
  await page.locator(STRIP).waitFor({ state: "visible", timeout: T_LONG });
  await settle(page, 600);
}

async function reload(page: Page): Promise<void> {
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator(SEL.toolbar.toggleSidebar).waitFor({ state: "visible", timeout: T_LONG });
  await page.addStyleTag({ content: POLISH_CSS }).catch(() => {});
  await dismissBlockingPalette(page);
  await waitForFrame(page);
}

/**
 * Clip to the canvas region — the box the frame is handed and has to compose
 * within. Judging the strip needs the content under it in shot: its whole job
 * is to stay quieter than that content, which an element-tight crop of the
 * strip alone cannot show. A second tight crop of the strip goes out beside it
 * for the detail the wide shot loses.
 *
 * Throws when a file did not land. A harness that writes a success artifact it
 * has not verified is worse than one that fails.
 */
async function snap(page: Page, slug: string): Promise<void> {
  await settle(page);
  const box = await page.locator(CANVAS).first().boundingBox();
  if (!box) throw new Error(`no bounding box for ${CANVAS}`);
  const file = path.join(OUTPUT_DIR, `${slug}${TAG}.png`);
  await page.screenshot({
    path: file,
    type: "png",
    animations: "disabled",
    caret: "hide",
    clip: { x: box.x, y: box.y, width: box.width, height: box.height },
  });
  if (!existsSync(file)) throw new Error(`screenshot did not land at ${file}`);

  const strip = await page.locator(STRIP).first().boundingBox();
  if (strip) {
    // Two strip heights of context below the chrome: enough to read the seam
    // between host and plugin, which is where visual weight is actually judged.
    const stripFile = path.join(OUTPUT_DIR, `${slug}${TAG}-strip.png`);
    await page.screenshot({
      path: stripFile,
      type: "png",
      animations: "disabled",
      caret: "hide",
      clip: {
        x: box.x,
        y: strip.y,
        width: box.width,
        height: Math.min(strip.height * 6, box.y + box.height - strip.y),
      },
    });
    if (!existsSync(stripFile)) throw new Error(`strip crop did not land at ${stripFile}`);
  }
}

/** Answer the first-show question through the store's own seam. */
async function setChoice(page: Page, choice: "surface" | "stock" | null): Promise<void> {
  await page.evaluate(async (next) => {
    await window.electron.plugin.setProjectSurfaceChoice("emptyCanvas", next);
  }, choice);
  await settle(page, 500);
}

/**
 * Assert which half of the switch is showing before photographing it.
 *
 * The duplicate-hash check at the end catches a step that drove nothing at all,
 * but not a step that drove the WRONG thing: a capture of the stock launcher
 * when the plugin's surface was meant to be up differs from every other frame,
 * so it sails through the hash check and looks entirely plausible on disk. This
 * caught exactly that — three states silently captured against the stock canvas
 * because a stub never took.
 */
async function expectShowing(page: Page, mode: "surface" | "stock"): Promise<void> {
  const pressed = await page
    .locator(`${STRIP} button[aria-pressed="true"]`)
    .first()
    .textContent()
    .catch(() => null);
  if (pressed === null) throw new Error(`no pressed segment in the strip (wanted ${mode})`);
  const isStock = pressed.trim() === "Launcher";
  const showing = isStock ? "stock" : "surface";
  if (showing !== mode) throw new Error(`strip is showing "${showing}", wanted "${mode}"`);
}

const ONLY = (process.env.DAINTREE_SHOT_ONLY ?? "").split(",").filter(Boolean);
const stepFailures: string[] = [];

/**
 * Run a capture step. A failure never stops the remaining shots — one missing
 * state should not cost the whole sweep — but it IS recorded, and the test
 * fails at the end.
 */
async function step(name: string, fn: () => Promise<void>): Promise<void> {
  if (ONLY.length > 0 && !ONLY.includes(name)) return;
  try {
    await fn();
  } catch (error) {
    const detail = String(error).split("\n")[0];
    console.warn(`[surface-strip-shots] step "${name}" FAILED:`, detail);
    stepFailures.push(`${name}: ${detail}`);
  }
}

test("project surface strip review — host chrome above a plugin's canvas", async () => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_THEME is required for the project-surface-strip capture",
  });
  test.skip(!THEME, "Set DAINTREE_SHOT_THEME to run the project-surface-strip capture");
  // Nine states, each with a settle, and two of them reload the whole app to
  // pick up a rewritten manifest. Plugin activation alone can take most of a
  // minute on a loaded machine.
  test.setTimeout(600_000);

  mkdirSync(OUTPUT_DIR, { recursive: true });
  let repo: FixtureRepo | undefined;
  // Prefix deliberately avoids "daintree-e2e" — launchApp's pre-launch hygiene
  // pkills that pattern, and parallel theme captures would SIGKILL each other.
  const userDataDir = mkdtempSync(path.join(tmpdir(), "daintree-stripshot-"));

  let ctx: AppContext | undefined;
  try {
    repo = createFixtureRepo({ name: "mission-control" });
    writeSurfacePlugin(repo.dir, "Videos");

    ctx = await launchApp({
      userDataDir,
      screenshotScale: SCALE,
      windowSize: WIDE,
      extraArgs: ["--disable-gpu", "--in-process-gpu", "--disable-breakpad", "--noerrdialogs"],
    });

    const page = await openAndOnboardProject(ctx.app, ctx.window, repo.dir, "Mission Control");
    // Project plugins are trust-gated and load for nobody until the project is
    // trusted. Without this the region draws the stock canvas forever and every
    // capture is a picture of the surface this harness is not about.
    await page.evaluate(() => window.electron.plugin.setProjectPluginTrust("enabled"));
    await setAppTheme(page, THEME);
    await page.addStyleTag({ content: POLISH_CSS }).catch(() => {});
    await dismissBlockingPalette(page);
    await waitForFrame(page);
    await dismissBlockingPalette(page);

    // 1. The first-show consent notice, unanswered. This is what a project sees
    // exactly once, and it is the state the strip is stacked under.
    await step("first-show", async () => {
      await expectShowing(page, "surface");
      await snap(page, "01-first-show");
    });

    // 2. Answered "keep it": the strip at rest over the plugin's canvas. The
    // state every subsequent session of this project opens in, and the one the
    // strip is actually judged on.
    await step("rest", async () => {
      await setChoice(page, "surface");
      await waitForFrame(page);
      await expectShowing(page, "surface");
      await snap(page, "02-rest-surface");
    });

    // 3. Switched back to the stock launcher. The strip loses its status text
    // and its palette entry here, because the canvas below carries both — so
    // this is where the chrome is at its emptiest and any leftover weight shows.
    await step("stock", async () => {
      await setChoice(page, "stock");
      await settle(page, 700);
      await expectShowing(page, "stock");
      await snap(page, "03-stock-launcher");
      await setChoice(page, "surface");
      await waitForFrame(page);
    });

    // 4. Keyboard focus on the switch. This region is reached by keyboard as
    // often as by pointer and the ring is the only thing that says where you
    // landed. Tabbed, never `.focus()`: Chromium only sets `:focus-visible` for
    // keyboard-driven focus, so a programmatic focus photographs the rest state
    // and calls it a focus ring.
    await step("focus", async () => {
      await page.locator(CANVAS).click({ position: { x: 8, y: 8 } });
      let reached = false;
      for (let press = 0; press < 40 && !reached; press++) {
        await page.keyboard.press("Tab");
        reached = await page
          .locator(`${STRIP} button`)
          .first()
          .evaluate((el) => el === document.activeElement)
          .catch(() => false);
      }
      if (!reached) throw new Error("Tab never reached the strip's first control");
      await settle(page, 300);
      await expectShowing(page, "surface");
      await snap(page, "04-focus-switch");
      await page.keyboard.press("Escape").catch(() => {});
      await settle(page, 200);
    });

    // 5. A narrow canvas. Everything in the strip competes for one row, so this
    // is where the status text and the palette entry either survive or clip.
    await step("narrow", async () => {
      await page.setViewportSize({ width: 900, height: WIDE.height });
      await settle(page, 900);
      await expectShowing(page, "surface");
      await snap(page, "05-narrow");
      await page.setViewportSize(WIDE);
      await settle(page, 600);
    });

    // 6. A panel name at the 32-character cap. The manifest sets no length
    // limit, and the segment carrying the name is half of the way back.
    await step("long-name", async () => {
      writeSurfacePlugin(repo!.dir, "Mission Control — Slate, Gates & Final Artifacts");
      await reload(page);
      await expectShowing(page, "surface");
      await snap(page, "06-long-name");
      writeSurfacePlugin(repo!.dir, "Videos");
      await reload(page);
    });

    // 7. The combination, which is the only state where the width guard is
    // actually load-bearing: a name at the character cap AND a window too narrow
    // to hold it. Either alone fits, so either alone proves nothing — the cap
    // bounds characters, not rendered width, and it is this pairing that decides
    // whether the Launcher segment, the way back, survives.
    await step("narrow-long-name", async () => {
      writeSurfacePlugin(repo!.dir, "Mission Control — Slate, Gates & Final Artifacts");
      await reload(page);
      await page.setViewportSize({ width: 720, height: WIDE.height });
      await settle(page, 900);
      await expectShowing(page, "surface");
      // The way back has to still be there, and still be pressable.
      const launcher = page.locator(`${STRIP} button`).nth(1);
      const box = await launcher.boundingBox();
      if (!box || box.width < 8)
        throw new Error("the Launcher segment was squeezed out of the row");
      await snap(page, "07-narrow-long-name");
      await page.setViewportSize(WIDE);
      await settle(page, 600);
      writeSurfacePlugin(repo!.dir, "Videos");
      await reload(page);
    });

    // 8-9. The two accessibility media modes. `forced-colors: active` throws the
    // theme's tokens away and redraws from system keywords — the segment thumb
    // is a background fill, which is exactly what does not survive there — and
    // `prefers-contrast: more` swaps in the high-contrast block.
    await step("forced-colors", async () => {
      await expectShowing(page, "surface");
      await page.emulateMedia({ forcedColors: "active" });
      await settle(page, 600);
      await snap(page, "08-forced-colors");
      await page.emulateMedia({ forcedColors: "none" });
      await settle(page, 400);
    });

    await step("contrast-more", async () => {
      await expectShowing(page, "surface");
      await page.emulateMedia({ contrast: "more" });
      await settle(page, 600);
      await snap(page, "09-contrast-more");
      await page.emulateMedia({ contrast: "no-preference" });
      await settle(page, 400);
    });

    // 10. The first-show question, unanswered, at a narrow width, with a long
    // plugin name. This is the notice's worst case and the only state where its
    // wrap behaviour is load-bearing: the question and both answers cannot share
    // one line here, and the two ways to lose are overflowing the answers
    // off-canvas or truncating the question away to a bare plugin name. Every
    // other capture answers the question long before it gets narrow, so without
    // this step the row's hardest moment is never photographed.
    await step("narrow-notice", async () => {
      writeSurfacePlugin(repo!.dir, "Mission Control — Slate, Gates & Final Artifacts");
      await reload(page);
      await setChoice(page, null);
      await page.setViewportSize({ width: 720, height: WIDE.height });
      await settle(page, 900);
      await waitForFrame(page);
      // Addressed by role, not a testid: the notice is an `InlineStatusBanner`,
      // whose props are a closed set — `role="status"` IS its handle. Scoped to
      // a direct child of the frame, because the running app has several other
      // live regions and a bare role lookup matches all of them.
      const notice = page.locator(`${FRAME} > [role="status"]`);
      await notice.waitFor({ state: "visible", timeout: T_LONG });
      // Both answers still have to be on screen and pressable. Overflowing them
      // off the canvas is the failure this state exists to catch, and it looks
      // perfectly fine in a screenshot cropped to the canvas.
      const canvas = await page.locator(CANVAS).first().boundingBox();
      for (const label of ["Keep it", "Use the launcher"]) {
        const box = await notice.getByRole("button", { name: label }).boundingBox();
        if (!box || !canvas) throw new Error(`no box for the ${label} answer`);
        if (box.x < canvas.x || box.x + box.width > canvas.x + canvas.width + 1) {
          throw new Error(`the ${label} answer overflowed the canvas`);
        }
      }
      await snap(page, "10-narrow-notice");
      await page.setViewportSize(WIDE);
      await settle(page, 600);
    });

    // Count what landed against what was promised. The exit code says only that
    // no step threw; this says the sweep actually produced its artifacts.
    const expected = STEPS.filter((s) => ONLY.length === 0 || ONLY.includes(s.name)).map(
      (s) => `${s.slug}${TAG}.png`
    );
    const present = new Set(readdirSync(OUTPUT_DIR));
    const missing = expected.filter((f) => !present.has(f));

    // Two states that render byte-identically mean one of them never actually
    // happened — a step that drove nothing still writes a perfectly plausible
    // PNG of the state before it, which is the worst artifact a capture harness
    // can produce. Same-viewport states only: a resize changes every pixel, so
    // cross-size pairs can never collide and would only add noise.
    const SAME_VIEWPORT = expected.filter((f) => !/^(0[57]|10)-/.test(f));
    const byHash = new Map<string, string[]>();
    for (const file of SAME_VIEWPORT) {
      if (!present.has(file)) continue;
      const hash = createHash("sha256")
        .update(readFileSync(path.join(OUTPUT_DIR, file)))
        .digest("hex");
      byHash.set(hash, [...(byHash.get(hash) ?? []), file]);
    }
    const duplicates = [...byHash.values()].filter((files) => files.length > 1);

    expect(stepFailures, `surface-strip capture steps failed in "${THEME}"`).toEqual([]);
    expect(missing, `surface-strip captures missing from ${OUTPUT_DIR}`).toEqual([]);
    expect(duplicates, `identical surface-strip captures — a step drove nothing`).toEqual([]);
  } finally {
    if (ctx?.app) await closeApp(ctx.app);
    repo?.cleanup();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});
