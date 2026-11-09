/**
 * README showcase capture.
 *
 * Boots the real app on a believable project ("Atlas Ledger", a TypeScript
 * payments ledger with five feature worktrees), runs four agent CLIs side by
 * side across those worktrees as one fleet, and writes the hero screenshot for
 * every built-in theme plus three feature stills, each in its own theme. The
 * agents are small fake CLIs that draw a pre-authored session in each real
 * CLI's style and drive Daintree's own agent-state detection (OSC 9;4
 * heartbeat and the registry's patterns), so the states on screen are the ones
 * the app observed, not painted on.
 *
 * Opt-in only, like its siblings:
 *
 *   DAINTREE_README_SHOTS=1 DAINTREE_CAPTURE_DIR=/abs/out \
 *     npx playwright test --project=screenshots readme-showcase --workers=1
 *
 * Iteration knobs: DAINTREE_README_THEMES (comma list of hero themes) and
 * DAINTREE_README_FEATURES (comma list of feature slugs, or "none").
 *
 * Output: hero-<themeId>.png for every built-in theme, pilot-fiordland.png,
 * worktree-overview-arashiyama.png, canopy-redwoods.png, review-hub-hokkaido.png
 * and manifest.json. The Canopy still reads with the small reader model that
 * ships with Daintree, which the build fetches (`npm run fetch:canopy-model`).
 * The run fails if any expected PNG is missing or the wrong size, if a hero was
 * captured with an agent in a state other than the one it was staged for, or
 * if a feature still never reached its surface.
 */

import { test, expect } from "@playwright/test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { BUILT_IN_APP_SCHEMES } from "../../shared/theme/index.js";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { openAndOnboardProject } from "../helpers/project";
import { dismissBlockingPalette } from "../helpers/overlays";
import { setAppTheme } from "../helpers/theme";
import { SEL } from "../helpers/selectors";
import { T_LONG } from "../helpers/timeouts";
import {
  WINDOW,
  STAGED,
  WORKTREES,
  HERO,
  createFixture,
  settle,
  polish,
  act,
  worktreeIdFor,
  ensureWindowSize,
  paneStates,
  statesMatch,
  stageFleet,
  ensureZoom,
  fleetFits,
  parkPointer,
} from "../helpers/atlasLedgerShowcase";

const ENABLED = process.env.DAINTREE_README_SHOTS === "1";
const OUT = process.env.DAINTREE_CAPTURE_DIR ?? "";
const SCALE = "2";
const ONLY_THEMES = (process.env.DAINTREE_README_THEMES ?? "")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);
// DAINTREE_README_THEMES narrows an iteration run; a full run covers every built-in theme.
const THEME_IDS = BUILT_IN_APP_SCHEMES.map((scheme) => scheme.id).filter(
  (id) => ONLY_THEMES.length === 0 || ONLY_THEMES.includes(id)
);
/** Feature stills, each in its own theme so the README tours both. Capture order. */
const FEATURE_SHOTS = [
  "pilot-fiordland",
  "worktree-overview-arashiyama",
  // After Pilot, so the parked deps run is in the inbox too.
  "canopy-redwoods",
  // Last: it docks the Claude pane to give the hub and its diff the grid.
  "review-hub-hokkaido",
] as const;
type FeatureShot = (typeof FEATURE_SHOTS)[number];
const ONLY_FEATURES = (process.env.DAINTREE_README_FEATURES ?? "")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);
// DAINTREE_README_FEATURES narrows an iteration run ("none" skips them all).
const FEATURES: FeatureShot[] = FEATURE_SHOTS.filter(
  (slug) => ONLY_FEATURES.length === 0 || ONLY_FEATURES.includes(slug)
);
const themeOf = (slug: FeatureShot): string => slug.slice(slug.lastIndexOf("-") + 1);


// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

test("readme showcase — hero per theme and review hub", async () => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_README_SHOTS=1 is required for the README showcase capture",
  });
  test.skip(!ENABLED, "Set DAINTREE_README_SHOTS=1 to capture the README showcase");
  if (!OUT || !path.isAbsolute(OUT)) {
    throw new Error("DAINTREE_CAPTURE_DIR must be an absolute path outside the repo");
  }
  if (path.resolve(OUT).startsWith(path.resolve(process.cwd()) + path.sep)) {
    throw new Error(`DAINTREE_CAPTURE_DIR must be outside the repo: ${OUT}`);
  }

  const expected = [...THEME_IDS.map((id) => `hero-${id}`), ...FEATURES];
  mkdirSync(OUT, { recursive: true });
  for (const slug of expected) rmSync(path.join(OUT, `${slug}.png`), { force: true });
  rmSync(path.join(OUT, "manifest.json"), { force: true });

  const failures = new Map<string, string>();
  const observed: Record<string, Record<string, string | null>> = {};
  const fixture = createFixture();
  const userDataDir = mkdtempSync(path.join(tmpdir(), "atlas-readme-userdata-"));
  let ctx: AppContext | undefined;

  try {
    ctx = await launchApp({
      userDataDir,
      homeDir: fixture.home,
      screenshotScale: SCALE,
      windowSize: WINDOW,
      env: {
        PATH: `${fixture.bin}${path.delimiter}${process.env.PATH ?? ""}`,
        DAINTREE_CLI_PATH_PREPEND: fixture.bin,
        DAINTREE_IDENTITY_DEBUG_PASS: "1",
      },
      extraArgs: ["--disable-gpu", "--in-process-gpu", "--disable-breakpad", "--noerrdialogs"],
    });
    const page = await openAndOnboardProject(ctx.app, ctx.window, fixture.repo, "Atlas Ledger");
    await page.evaluate(async () => {
      const cur = await window.electron.project.getCurrent();
      if (cur?.id)
        await window.electron.project.update(cur.id, { emoji: "📒", name: "Atlas Ledger" });
    });
    await ensureWindowSize(page, ctx.app);
    // Fleet panes are input-locked (typing broadcasts), so their composers
    // would each read "Input locked"; the CLIs' own prompts carry the frame.
    await page.evaluate(() => window.electron.terminalConfig.setHybridInputEnabled(false));
    await setAppTheme(page, "daintree");
    await polish(page);
    await dismissBlockingPalette(page).catch(() => {});
    await page.locator(SEL.worktree.mainCard).waitFor({ state: "visible", timeout: T_LONG });

    // Launch each agent in its own worktree.
    const ids: Record<string, string> = {};
    for (const agent of HERO) {
      const worktreeId = await worktreeIdFor(page, agent.branch);
      const launched = await act<{ terminalId: string }>(page, "agent.launch", {
        agentId: agent.agentId,
        worktreeId,
        location: "grid",
        force: true,
        focusPolicy: "preserve",
      });
      if (!launched?.terminalId)
        throw new Error(`agent.launch ${agent.agentId} returned no terminal`);
      ids[agent.key] = launched.terminalId;
      await expect
        .poll(() => existsSync(path.join(fixture.state, `${agent.key}.pid`)), {
          timeout: T_LONG * 2,
          message: `${agent.command} never started`,
        })
        .toBe(true);
    }

    const stageAndWait = async (label: string): Promise<boolean> => {
      await stageFleet(page, ids);
      const deadline = Date.now() + 60_000;
      let states = await paneStates(page, ids);
      while (!statesMatch(states) && Date.now() < deadline) {
        await page.waitForTimeout(500);
        states = await paneStates(page, ids);
      }
      observed[label] = states;
      return statesMatch(states);
    };

    const shoot = async (slug: string): Promise<void> => {
      await parkPointer(page);
      await settle(page, 1200);
      const file = path.join(OUT, `${slug}.png`);
      // Raw CDP, not page.screenshot(): with the view zoomed out, Playwright
      // scales its capture by the zoom a second time and paints a shrunken
      // frame into a black canvas.
      const cdp = await page.context().newCDPSession(page);
      try {
        const { data } = (await cdp.send("Page.captureScreenshot", { format: "png" })) as {
          data: string;
        };
        const png = Buffer.from(data, "base64");
        const width = png.readUInt32BE(16);
        const height = png.readUInt32BE(20);
        const want = { width: WINDOW.width * Number(SCALE), height: WINDOW.height * Number(SCALE) };
        if (width !== want.width || height !== want.height) {
          failures.set(
            slug,
            `capture is ${width}x${height}, expected ${want.width}x${want.height}`
          );
        }
        writeFileSync(file, png);
      } finally {
        await cdp.detach().catch(() => {});
      }
      if (!existsSync(file) || statSync(file).size < 50_000) {
        failures.set(slug, "capture missing or implausibly small");
      }
    };

    for (const themeId of THEME_IDS) {
      const slug = `hero-${themeId}`;
      try {
        await setAppTheme(page, themeId);
        await polish(page);
        await dismissBlockingPalette(page).catch(() => {});
        await ensureZoom(page);
        const ok = await stageAndWait(slug);
        await settle(page, 600);
        const fits = await fleetFits(page);
        await shoot(slug);
        if (!ok) failures.set(slug, `agent states off-script: ${JSON.stringify(observed[slug])}`);
        else if (!fits) failures.set(slug, "fleet grid overflows: bottom panes are cut off");
        console.log(
          `[readme] ${slug} ${ok ? "ok" : "STATES OFF"} ${JSON.stringify(observed[slug])}`
        );
      } catch (error) {
        failures.set(slug, String(error).slice(0, 300));
        console.warn(`[readme] ${slug} failed:`, String(error).slice(0, 300));
      }
    }

    // ---- Feature stills -------------------------------------------------
    const escape = async (times = 3) => {
      for (let i = 0; i < times; i++) {
        await page.keyboard.press("Escape").catch(() => {});
        await page.waitForTimeout(150);
      }
    };
    const enterTheme = async (themeId: string, zoomed: boolean) => {
      await setAppTheme(page, themeId);
      await polish(page);
      await dismissBlockingPalette(page).catch(() => {});
      if (zoomed) await ensureZoom(page);
      else await act(page, "window.zoomReset").catch(() => {});
      await settle(page, 600);
    };
    const backToFleet = async (themeId: string, zoomed = true) => {
      await enterTheme(themeId, zoomed);
      const ok = await stageAndWait(`backdrop-${themeId}`);
      if (!ok)
        console.warn(
          `[readme] backdrop for ${themeId} off-script`,
          observed[`backdrop-${themeId}`]
        );
    };
    const featureSteps: Record<FeatureShot, () => Promise<boolean>> = {
      "pilot-fiordland": async () => {
        // A fifth agent, asked a question and parked by the user, so Pilot
        // shows the parked band beside working, waiting and finished.
        const deps = STAGED.find((a) => a.key === "claude-deps")!;
        if (!ids[deps.key]) {
          const launched = await act<{ terminalId: string }>(page, "agent.launch", {
            agentId: deps.agentId,
            worktreeId: await worktreeIdFor(page, deps.branch),
            location: "grid",
            force: true,
            focusPolicy: "preserve",
          });
          ids[deps.key] = launched.terminalId;
          await expect
            .poll(() => existsSync(path.join(fixture.state, `${deps.key}.pid`)), {
              timeout: T_LONG * 2,
            })
            .toBe(true);
          await page.waitForTimeout(7000);
          let parked = false;
          for (let i = 0; i < 20 && !parked; i++) {
            parked = await page
              .evaluate(
                (id) =>
                  window.electron.fleet
                    .parkRun(id, { note: "Decide after Thursday's infra sync" })
                    .then(() => true)
                    .catch(() => false),
                ids[deps.key]!
              )
              .catch(() => false);
            if (!parked) await page.waitForTimeout(1000);
          }
          if (!parked) throw new Error("could not park the deps run");
        }
        await backToFleet("fiordland", false);
        await act(page, "pilot.toggle");
        const dialog = page.locator('[role="dialog"][aria-label="All agents"]');
        await dialog.waitFor({ state: "visible", timeout: T_LONG });
        await expect
          .poll(() => dialog.getByTestId("pilot-row").count(), { timeout: T_LONG })
          .toBeGreaterThanOrEqual(STAGED.length);
        await settle(page, 1200);
        return (await dialog.getByTestId("pilot-row").count()) >= STAGED.length;
      },
      "review-hub-hokkaido": async () => {
        await enterTheme("hokkaido", false);
        await act(page, "fleet.scope.exit").catch(() => {});
        await act(page, "terminal.disarmAll").catch(() => {});
        const worktreeId = await worktreeIdFor(page, "feature/settlement-export");
        await act(page, "worktree.select", { worktreeId });
        await settle(page, 800);
        const content = page.locator('[data-testid="review-hub-content"]');
        const hubInGrid = page.locator(
          `${SEL.panel.gridPanel}:has([data-testid="review-hub-content"])`
        );
        if ((await hubInGrid.count()) === 0) {
          await act(page, "worktree.openReviewHub", { worktreeId });
          await page
            .locator(SEL.reviewHub.container)
            .waitFor({ state: "visible", timeout: 15_000 });
          await settle(page, 800);
          await page
            .locator(`${SEL.reviewHub.container} [data-testid="panel-dialog-open-as-panel"]`)
            .first()
            .click();
          await hubInGrid.first().waitFor({ state: "visible", timeout: T_LONG });
        }
        await content.first().waitFor({ state: "visible", timeout: T_LONG });
        await settle(page, 1200);
        const message = hubInGrid.locator(SEL.reviewHub.commitMessageInput).first();
        await message.fill(
          "feat(export): stream settlement CSV grouped by merchant\n\nAdds net_minor and a /v1/settlements/export.csv route."
        );
        if ((await page.locator(SEL.panel.gridPanel).count()) < 3) {
          await hubInGrid
            .locator(SEL.reviewHub.fileDiffButton("src/export/settlement.ts"))
            .first()
            .click();
          const dialog = page.locator('[data-testid="panel-dialog"]').last();
          await dialog.waitFor({ state: "visible", timeout: T_LONG });
          await settle(page, 600);
          await dialog.locator('[data-testid="panel-dialog-open-as-panel"]').first().click();
          await expect
            .poll(() => page.locator(SEL.panel.gridPanel).count(), { timeout: T_LONG })
            .toBeGreaterThanOrEqual(3);
        }
        // Two of three files marked viewed, so the still shows review in progress.
        for (const file of ["src/api/routes/settlements.ts", "test/export/settlement.test.ts"]) {
          const toggle = hubInGrid.locator(`[aria-label="Mark ${file} as viewed"]`).first();
          if (await toggle.isVisible().catch(() => false)) await toggle.click().catch(() => {});
        }
        const diffPanel = page
          .locator(SEL.panel.gridPanel)
          .filter({ hasNot: page.locator('[data-testid="review-hub-content"]') })
          .filter({ hasText: "settlement.ts" })
          .first();
        // Dock the agent so the hub and its diff share the grid side by side.
        const claudePane = page.locator(`[data-panel-id="${ids.claude}"]`);
        if (await claudePane.isVisible().catch(() => false)) {
          await claudePane
            .locator(SEL.panel.minimize)
            .first()
            .click()
            .catch(() => {});
        }
        await settle(page, 1500);
        return (
          (await hubInGrid.count()) === 1 &&
          (await diffPanel.isVisible().catch(() => false)) &&
          (await message.inputValue()).length > 0
        );
      },
      "canopy-redwoods": async () => {
        // On by default; set anyway, in case the profile turned it off.
        await page.evaluate(() => window.electron.canopy.setMode("on"));
        await backToFleet("redwoods", false);
        await act(page, "canopy.toggle");
        const dialog = page.locator('[data-testid="canopy-dialog"]');
        await dialog.waitFor({ state: "visible", timeout: T_LONG });
        const cards = dialog.locator("[data-canopy-list] [data-canopy-card]");
        await expect.poll(() => cards.count(), { timeout: 90_000 }).toBeGreaterThanOrEqual(4);
        // Every card read and ranked off its own screen, not just listed.
        await expect
          .poll(
            () =>
              cards.evaluateAll((all) =>
                all.every((card) => (card as HTMLElement).dataset.priority !== undefined)
              ),
            { timeout: 180_000, intervals: [1000] }
          )
          .toBe(true);
        await settle(page, 2000);
        return (await cards.count()) >= 4;
      },
      "worktree-overview-arashiyama": async () => {
        await backToFleet("arashiyama", false);
        await act(page, "worktree.overview.open");
        const modal = page.locator(SEL.worktree.overviewModal);
        await modal.waitFor({ state: "visible", timeout: T_LONG });
        await expect
          .poll(() => modal.locator("[data-worktree-overview-cell]").count(), { timeout: T_LONG })
          .toBeGreaterThanOrEqual(WORKTREES.length);
        await settle(page, 1500);
        return (await modal.locator("[data-worktree-overview-cell]").count()) >= WORKTREES.length;
      },
    };

    for (const slug of FEATURES) {
      try {
        await escape();
        const ok = await featureSteps[slug]();
        await shoot(slug);
        if (!ok) failures.set(slug, "surface not reached");
        console.log(`[readme] ${slug} ${ok ? "ok" : "SURFACE MISSING"} (${themeOf(slug)})`);
      } catch (error) {
        failures.set(slug, String(error).slice(0, 300));
        console.warn(`[readme] ${slug} failed:`, String(error).slice(0, 300));
      }
      await escape();
    }
  } finally {
    if (ctx?.app) await closeApp(ctx.app);
    fixture.cleanup();
    rmSync(userDataDir, { recursive: true, force: true });
  }

  const present: string[] = [];
  const missing: string[] = [];
  for (const slug of expected) {
    const file = path.join(OUT, `${slug}.png`);
    (existsSync(file) && statSync(file).size > 50_000 ? present : missing).push(slug);
  }
  writeFileSync(
    path.join(OUT, "manifest.json"),
    JSON.stringify(
      {
        capturedAt: new Date().toISOString(),
        window: WINDOW,
        scale: SCALE,
        themes: THEME_IDS,
        agents: STAGED.map((a) => ({ agent: a.agentId, branch: a.branch, expect: a.expect })),
        expected: expected.length,
        present,
        missing,
        observedStates: observed,
        failures: Object.fromEntries(failures),
      },
      null,
      2
    ) + "\n"
  );
  if (missing.length > 0 || failures.size > 0) {
    throw new Error(
      `[readme] ${present.length}/${expected.length} captured; missing: ${missing.join(", ") || "none"}; ` +
        `failures: ${[...failures].map(([k, v]) => `${k}: ${v}`).join(" | ") || "none"}`
    );
  }
  console.log(`[readme] verified ${present.length}/${expected.length} captures in ${OUT}`);
});
