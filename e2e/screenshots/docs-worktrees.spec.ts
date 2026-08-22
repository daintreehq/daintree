/**
 * Documentation screenshots — Worktrees and the Review Hub.
 *
 * Five launches, because the git state each scene needs is mutually
 * exclusive: a repo stopped mid-rebase cannot also be a repo whose remote is
 * three commits ahead, and neither can be the clean multi-worktree sidebar.
 *
 * `worktrees-lifecycle-chips` is deliberately absent. The blue and purple
 * chips are computed from a linked pull request, which the forge layer
 * resolves from a live remote — there is no offline seam, so it belongs in
 * `docs-forge.spec.ts` behind the token gate rather than here.
 */

import { test, expect, type Page } from "@playwright/test";
import { execSync } from "child_process";
import zlib from "zlib";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import path from "path";
import { closeApp, type AppContext } from "../helpers/launch";
import { SEL } from "../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_LONG } from "../helpers/timeouts";
import {
  createAtlasLedgerRepo,
  attachLocalOrigin,
  advanceRemote,
  startConflictedRebase,
  DOCS_DEMO_ROOT,
} from "../helpers/docsFixtures";
import { createCapture, resetOverlays, POLISH_CSS } from "../helpers/docsCapture";
import { bootDocsApp, DOCS_WINDOW_WIDE, DIALOG_PAD } from "../helpers/docsBoot";
import { installFakeAgent, fakeAgentEnv } from "../helpers/fakeAgent";
import { launchDocsAgent, parkAgent } from "../helpers/docsAgents";
import { saveCurrentProjectSettings } from "../helpers/projectSettings";
import type { DemoRepo } from "../helpers/screenshotFixtures";

process.env.DAINTREE_DEMO_ROOT = DOCS_DEMO_ROOT;

const cap = createCapture("worktrees");

const git = (cmd: string, cwd: string) => execSync(`git ${cmd}`, { cwd, stdio: "ignore" });

test.describe.serial("Documentation Screenshots — Worktrees", () => {
  test.afterAll(() => {
    cap.writeReport();
  });

  // ---------------------------------------------------------------------------
  // Scene W1 — the sidebar and the worktree dialogs
  // ---------------------------------------------------------------------------
  test("scene-w1-sidebar", async () => {
    const repo: DemoRepo = createAtlasLedgerRepo();
    attachLocalOrigin(repo);
    // Give two branches an upstream and then move past it, so the bulk-remove
    // dialog has real "unpushed commits" warnings to show. Without an upstream
    // aheadCount is undefined and the warning row never renders.
    for (const branch of ["feature/reconciliation", "feature/multi-currency"]) {
      const wt = path.join(
        path.dirname(repo.dir),
        `${repo.slug}-worktrees`,
        branch.replace(/\//g, "-")
      );
      try {
        git(`push -u origin ${branch}`, wt);
        writeFileSync(path.join(wt, "NOTES.md"), `Progress on ${branch}\n`);
        git("add -A", wt);
        git(`commit -m "notes: progress on ${branch}"`, wt);
      } catch {
        // A branch without a worktree on disk is not fatal to the scene.
      }
    }

    const binDir = installFakeAgent(path.dirname(repo.dir));
    let ctx: AppContext | undefined;
    let profile = "";
    try {
      const booted = await bootDocsApp({
        repoDir: repo.dir,
        displayName: "Atlas Ledger",
        emoji: "📒",
        env: fakeAgentEnv(binDir),
        windowSize: DOCS_WINDOW_WIDE,
      });
      ctx = booted.ctx;
      profile = booted.userDataDir;
      const { page } = booted;

      await cap.shot("worktrees/worktrees-cross-worktree-diff", async () => {
        await resetOverlays(page);
        // The modal is sized from the window, and this diff is short — at the
        // scene's full height two thirds of the dialog is empty. Shrink for
        // the shot and restore afterwards.
        await ctx!.app.evaluate(({ BrowserWindow }) => {
          const win = BrowserWindow.getAllWindows()[0];
          win?.setSize(1600, 720);
          win?.center();
        });
        await page.waitForTimeout(T_MEDIUM);
        const card = page.locator(SEL.worktree.card("feature/reconciliation")).first();
        await card.click({ button: "right" });
        await page.getByRole("menuitem", { name: /Compare Worktrees/i }).click();
        const dialog = page.locator('[role="dialog"]').filter({ hasText: "Compare Worktrees" });
        await expect(dialog).toBeVisible({ timeout: T_LONG });
        // The right-hand picker starts empty and refuses the left-hand branch,
        // so without an explicit pick the body stays on its empty state.
        const selects = dialog.locator("select");
        if ((await selects.count()) > 1) {
          await selects.nth(1).selectOption({ index: 1 }).catch(() => {});
        }
        await page.waitForTimeout(T_MEDIUM);
        // Pick the modified file. The right-hand pane opens on "Select a file
        // to view its diff", and the shot is of the diff, not of the picker —
        // a modification shows both sides, where an add or a delete shows one.
        const modified = dialog.locator('[role="row"], li, button').filter({ hasText: "statement.ts" }).first();
        await modified.click({ timeout: 10_000 }).catch(async () => {
          await dialog.getByText("statement.ts").first().click().catch(() => {});
        });
        await expect(dialog.getByText("Select a file to view its diff")).toHaveCount(0, {
          timeout: T_LONG,
        });
        await page.waitForTimeout(T_MEDIUM);
        await cap.snapElement(
          page,
          dialog.locator("> div").first(),
          "worktrees/worktrees-cross-worktree-diff",
          DIALOG_PAD
        );
        await resetOverlays(page);
        await ctx!.app.evaluate(({ BrowserWindow }) => {
          const win = BrowserWindow.getAllWindows()[0];
          win?.setSize(1600, 1000);
          win?.center();
        });
        await page.waitForTimeout(T_MEDIUM);
      });

      await cap.shot("worktrees/overview/worktrees-overview-d3-confirm", async () => {
        await resetOverlays(page);
        await page.keyboard.press("Meta+Shift+KeyO");
        const overview = page.locator(SEL.worktree.overviewModal);
        await expect(overview).toBeVisible({ timeout: T_LONG });
        const cells = page.locator(SEL.worktree.overviewCell);
        const count = await cells.count();
        for (let i = 0; i < Math.min(count, 3); i++) {
          await cells.nth(i).click({ modifiers: ["ControlOrMeta"], position: { x: 20, y: 20 } });
        }
        await page.locator(SEL.worktree.bulkRemove).click();
        // Destructive without a preview renders as alertdialog; the visible
        // card is the child of that full-screen root.
        const confirm = page.locator('[role="alertdialog"]');
        await expect(confirm).toBeVisible({ timeout: T_LONG });
        await page.waitForTimeout(T_MEDIUM);
        await cap.snapElement(
          page,
          confirm.locator("> div").first(),
          "worktrees/overview/worktrees-overview-d3-confirm",
          DIALOG_PAD
        );
        await page.keyboard.press("Escape");
        await resetOverlays(page);
      });

      // The agent shots come last: launching one changes the sidebar for good.
      // Launch into the worktree that is about to be deleted, by id. Clicking
      // its card is not enough: the launcher targets whatever the app calls
      // the active worktree, and the delete dialog then reports "0 terminals
      // will be closed" — so nothing survives and no rescue card appears.
      const panelId = await launchDocsAgent(page, {
        branch: "bugfix/rounding-drift",
        name: "Rounding drift",
      });

      await cap.shot("worktrees/cards/worktrees-quick-state-filter", async () => {
        await resetOverlays(page);
        const bar = page.locator('[role="toolbar"][aria-label="Quick state filter"]');
        await expect(bar).toBeVisible({ timeout: T_LONG });
        await bar.locator('button[aria-label^="Working"]').first().click();
        // The framer thumb on the segmented control projects its layout, and
        // `animations: "disabled"` does not freeze a layout projection — give
        // it a beat or the capture lands mid-morph.
        await page.waitForTimeout(600);
        await bar.locator("button").last().hover();
        await page.waitForTimeout(300);
        await cap.snapElement(
          page,
          bar,
          "worktrees/cards/worktrees-quick-state-filter",
          0
        );
        await bar.locator('button[aria-label^="All"]').first().click().catch(() => {});
      });

      await cap.shot("worktrees/delete-and-recover/worktrees-deleted-worktree-card", async () => {
        await resetOverlays(page);
        // Park the agent in `waiting` first: a working agent holds the
        // countdown, and the shot is of a countdown that is running.
        await parkAgent(page, panelId);

        const card = page.locator(SEL.worktree.card("bugfix/rounding-drift")).first();
        await card.click({ button: "right" });
        await page.getByRole("menuitem", { name: /Delete worktree/i }).click();
        const confirm = page.locator('[role="alertdialog"]').first();
        await expect(confirm).toBeVisible({ timeout: T_LONG });

        // Three checkboxes, and the defaults are wrong for this shot in both
        // directions. Address them by label, not by index.
        //
        // "Close all terminals" defaults ON, which kills the very agents the
        // rescue card exists to hold. And bugfix/rounding-drift carries an
        // uncommitted edit, so without "Force delete" the deletion is refused
        // outright and the sidebar shows an error banner instead of a card.
        // The inputs are visually hidden behind styled controls, so neither
        // check() nor a label click passes Playwright's actionability gate.
        // Match on the label text in the DOM and click the input itself.
        await page.evaluate(() => {
          const dialog = document.querySelector('[role="alertdialog"]');
          if (!dialog) return;
          const want: Record<string, boolean> = {
            "Force delete": true,
            "Close all terminals": false,
          };
          for (const input of Array.from(
            dialog.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')
          )) {
            const text = input.closest("label")?.textContent ?? "";
            for (const [needle, target] of Object.entries(want)) {
              if (text.includes(needle) && input.checked !== target) input.click();
            }
          }
        });
        await page.waitForTimeout(400);

        // Forcing escalates the dialog: the button relabels to
        // "Force delete '<branch>'" and stays disabled until the branch name
        // is typed back. Fill any text input the dialog is showing.
        const typed = confirm.locator('input[type="text"], input:not([type])').first();
        if (await typed.isVisible({ timeout: 1_000 }).catch(() => false)) {
          await typed.fill("bugfix/rounding-drift");
          await page.waitForTimeout(300);
        }
        const go = confirm
          .getByRole("button", { name: /delete/i })
          .filter({ hasNotText: /cancel/i })
          .last();
        await expect(go).toBeEnabled({ timeout: T_LONG });
        await go.click();

        const rescue = page.locator("[data-deleted-worktree-id]").first();
        await expect(rescue).toBeVisible({ timeout: T_LONG });
        await page.waitForTimeout(T_SHORT);
        await cap.snapElement(
          page,
          rescue,
          "worktrees/delete-and-recover/worktrees-deleted-worktree-card",
          0
        );
      });
    } finally {
      if (ctx) await closeApp(ctx.app).catch(() => {});
      repo.cleanup();
      if (profile) rmSync(profile, { recursive: true, force: true });
    }
  });

  // ---------------------------------------------------------------------------
  // Scene R1 — the Review Hub during a conflicted rebase
  // ---------------------------------------------------------------------------
  test("scene-r1-conflicts", async () => {
    const repo: DemoRepo = createAtlasLedgerRepo();
    attachLocalOrigin(repo);
    startConflictedRebase(repo, "fix/settlement-rounding");

    let ctx: AppContext | undefined;
    let profile = "";
    try {
      const booted = await bootDocsApp({
        repoDir: repo.dir,
        displayName: "Atlas Ledger",
        emoji: "📒",
        windowSize: DOCS_WINDOW_WIDE,
      });
      ctx = booted.ctx;
      profile = booted.userDataDir;
      const { page } = booted;

      await cap.shot("review-hub/rebase-and-conflicts/review-hub-conflicts", async () => {
        await resetOverlays(page);
        // Open the hub from the main card's own context menu. The hover
        // button is not inside the card's subtree, so scoping to the card
        // finds nothing, and an unscoped `.first()` opens whichever worktree
        // happens to sort first — which is how this shot originally captured
        // a clean hub for an entirely different branch.
        const main = page.locator(SEL.worktree.mainCard).first();
        await main.click({ button: "right" });
        await page.getByRole("menuitem", { name: /Review & Commit/i }).click();
        const hub = page.locator(SEL.reviewHub.container);
        await expect(hub).toBeVisible({ timeout: T_LONG });
        // Assert the conflict itself, not merely that the hub opened. The hub
        // renders happily with no conflicts at all, and a shot of a clean
        // "Ready" panel captioned as a rebase conflict is worse than none.
        await expect(hub.getByRole("button", { name: /Take ours/i }).first()).toBeVisible({
          timeout: T_LONG,
        });
        await page.waitForTimeout(T_MEDIUM);
        await cap.snapElement(
          page,
          hub.locator("> div").first(),
          "review-hub/rebase-and-conflicts/review-hub-conflicts",
          DIALOG_PAD
        );
        await resetOverlays(page);
      });
    } finally {
      if (ctx) await closeApp(ctx.app).catch(() => {});
      repo.cleanup();
      if (profile) rmSync(profile, { recursive: true, force: true });
    }
  });

  // ---------------------------------------------------------------------------
  // Scene R2 — push confirmation, then the rejection it runs into
  // ---------------------------------------------------------------------------
  test("scene-r2-push", async () => {
    const repo: DemoRepo = createAtlasLedgerRepo();
    attachLocalOrigin(repo);
    // Three commits so the force-push dialog lists something that reads as a
    // list rather than a single line.
    advanceRemote(repo, [
      {
        file: "src/journal/ledger.ts",
        content: "// upstream: split the posting pair\n",
        message: "refactor: split the posting pair",
      },
      {
        file: "src/journal/currency.ts",
        content: "// upstream: carry currency on every posting\n",
        message: "feat: carry currency on every posting",
      },
      {
        file: "README.md",
        content: "# atlas-ledger\n\nDouble-entry ledger service.\n",
        message: "docs: trim the readme",
      },
    ]);
    // A local commit of our own, so the push is a genuine divergence.
    writeFileSync(path.join(repo.dir, "src/journal/rounding.ts"), "// round once\n");
    git("add -A", repo.dir);
    git('commit -m "fix: round once at the boundary"', repo.dir);
    writeFileSync(path.join(repo.dir, "src/journal/posting.ts"), "// local edit\n");

    let ctx: AppContext | undefined;
    let profile = "";
    try {
      const booted = await bootDocsApp({
        repoDir: repo.dir,
        displayName: "Atlas Ledger",
        emoji: "📒",
        windowSize: DOCS_WINDOW_WIDE,
      });
      ctx = booted.ctx;
      profile = booted.userDataDir;
      const { page } = booted;

      await resetOverlays(page);
      await page.locator(SEL.worktree.mainCard).first().hover();
      await page.locator('[aria-label^="Open Review &"]').first().click();
      const hub = page.locator(SEL.reviewHub.container);
      await expect(hub).toBeVisible({ timeout: T_LONG });
      await hub.locator(SEL.reviewHub.commitMessageInput).fill(
        "fix: settle in ledger currency before rounding"
      );
      await page.waitForTimeout(T_SHORT);

      await cap.shot("review-hub/commit-and-push/review-hub-push-confirm", async () => {
        await hub.locator('button:has-text("Commit & Push")').first().click();
        const confirm = page
          .locator('[role="dialog"]')
          .filter({ hasText: /push/i })
          .last();
        await expect(confirm).toBeVisible({ timeout: T_LONG });
        await page.waitForTimeout(T_MEDIUM);
        await cap.snapElement(
          page,
          confirm.locator("> div").first(),
          "review-hub/commit-and-push/review-hub-push-confirm",
          DIALOG_PAD
        );
      });

      await cap.shot("review-hub/rebase-and-conflicts/review-hub-force-push-dialog", async () => {
        // Confirming runs the push, which the diverged remote rejects; the
        // rejection banner is the route to the force-push dialog.
        await page.locator(SEL.confirmDialog.confirm).first().click();
        const force = page.getByRole("button", { name: /Force push/i }).first();
        await expect(force).toBeVisible({ timeout: T_LONG * 3 });
        await force.click();
        const dialog = page
          .locator('[role="dialog"], [role="alertdialog"]')
          .filter({ hasText: /Force push/i })
          .last();
        await expect(dialog).toBeVisible({ timeout: T_LONG });
        await page.waitForTimeout(T_MEDIUM);
        await cap.snapElement(
          page,
          dialog.locator("> div").first(),
          "review-hub/rebase-and-conflicts/review-hub-force-push-dialog",
          DIALOG_PAD
        );
        await page.keyboard.press("Escape");
      });
    } finally {
      if (ctx) await closeApp(ctx.app).catch(() => {});
      repo.cleanup();
      if (profile) rmSync(profile, { recursive: true, force: true });
    }
  });

  // ---------------------------------------------------------------------------
  // Scene R3 — the image diff's onion-skin mode
  // ---------------------------------------------------------------------------
  test("scene-r3-image-diff", async () => {
    const repo: DemoRepo = createAtlasLedgerRepo();
    attachLocalOrigin(repo);
    // Both sides must decode or the mode toggle is not rendered at all, so a
    // 1x1 placeholder is useless — these are real 480x320 PNGs.
    const asset = path.join(repo.dir, "assets/brand-mark.png");
    mkdirSync(path.dirname(asset), { recursive: true });
    // The two versions must differ in *shape*, not only in colour. Onion skin
    // cross-fades one over the other, and two flat fills blend into a third
    // flat fill — the control is visible but the effect it produces is not.
    writeMarkPng(asset, [0x2f, 0x8f, 0x6a], 90);
    git("add -A", repo.dir);
    git('commit -m "assets: add the brand mark"', repo.dir);
    writeMarkPng(asset, [0x8f, 0x5a, 0x2f], 250);

    let ctx: AppContext | undefined;
    let profile = "";
    try {
      const booted = await bootDocsApp({
        repoDir: repo.dir,
        displayName: "Atlas Ledger",
        emoji: "📒",
        windowSize: DOCS_WINDOW_WIDE,
      });
      ctx = booted.ctx;
      profile = booted.userDataDir;
      const { page } = booted;

      await cap.shot("review-hub/diff-workspace/diff-workspace-image-compare", async () => {
        await resetOverlays(page);
        await page.keyboard.press("Meta+Shift+KeyD");
        await page.waitForTimeout(T_MEDIUM);
        const row = page.getByText("brand-mark.png").first();
        await expect(row).toBeVisible({ timeout: T_LONG });
        await row.click();
        await page.waitForTimeout(T_MEDIUM);
        const onion = page.getByRole("button", { name: "Onion skin" }).first();
        await expect(onion).toBeVisible({ timeout: T_LONG });
        await onion.click();
        await page.waitForTimeout(600);
        const slider = page.locator('input[aria-label="Working tree opacity"]').first();
        if (await slider.isVisible({ timeout: T_SHORT }).catch(() => false)) {
          await slider.fill("50").catch(() => {});
        }
        await page.waitForTimeout(T_SHORT);
        const viewer = page
          .locator('[data-testid="panel-dialog"]')
          .filter({ hasText: "brand-mark.png" })
          .first();
        await cap.snapElement(
          page,
          viewer.locator("> div").first(),
          "review-hub/diff-workspace/diff-workspace-image-compare",
          DIALOG_PAD
        );
        await resetOverlays(page);
      });
    } finally {
      if (ctx) await closeApp(ctx.app).catch(() => {});
      repo.cleanup();
      if (profile) rmSync(profile, { recursive: true, force: true });
    }
  });

  // ---------------------------------------------------------------------------
  // Scene W2 — resource environments
  // ---------------------------------------------------------------------------
  test("scene-w2-resource-environments", async () => {
    const repo: DemoRepo = createAtlasLedgerRepo();
    attachLocalOrigin(repo);
    let ctx: AppContext | undefined;
    let profile = "";
    try {
      const booted = await bootDocsApp({
        repoDir: repo.dir,
        displayName: "Atlas Ledger",
        emoji: "📒",
        windowSize: DOCS_WINDOW_WIDE,
      });
      ctx = booted.ctx;
      profile = booted.userDataDir;
      const { page } = booted;

      // Seed a named environment before opening the tab. With none defined the
      // section renders its empty state — an Add environment button and a
      // variables reference card — and none of the controls the page documents
      // (selector, icon picker, ordered provision commands) exist to be shown.
      await saveCurrentProjectSettings(page, {
        resourceEnvironments: {
          "docker-sandbox": {
            icon: "Container",
            provision: [
              "docker compose -f ops/sandbox.yml up -d --wait",
              "docker compose exec -T app npm ci",
              "docker compose exec -T app npm run db:migrate",
            ],
            status: 'docker inspect -f \'{"status":"{{.State.Status}}"}\' atlas-sandbox',
            connect: "docker compose exec app bash",
            pause: ["docker compose -f ops/sandbox.yml stop"],
            resume: ["docker compose -f ops/sandbox.yml start"],
            teardown: ["docker compose -f ops/sandbox.yml down -v"],
          },
        },
        defaultWorktreeMode: "docker-sandbox",
      } as never);
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.locator(SEL.toolbar.toggleSidebar).waitFor({ state: "visible", timeout: T_LONG });
      await page.addStyleTag({ content: POLISH_CSS }).catch(() => {});
      await page.waitForTimeout(T_MEDIUM);

      await cap.shot(
        "worktrees/remote-compute/worktrees-resource-environments-settings",
        async () => {
          await resetOverlays(page);
          await page.evaluate(() => {
            window.__daintreeDispatchAction?.(
              "app.settings.openTab",
              { tab: "project:automation" },
              { source: "user" }
            );
          });
          await page.waitForTimeout(T_MEDIUM);
          // The section kept its historical anchor when the tab was renamed
          // to project:automation, so this id is the stable handle.
          const section = page.locator('[id="tab-nav-project:environments"]').first();
          await expect(section).toBeVisible({ timeout: T_LONG });
          // Align the section's top with the panel, then clamp the band to the
          // panel's own bottom. The section is far taller than the scroll
          // viewport — an element capture, or a band sized from the element
          // box, runs past what was ever rendered and pads the shot with black.
          await section.evaluate((el) => el.scrollIntoView({ block: "start" }));
          await page.waitForTimeout(T_MEDIUM);
          const secBox = await section.boundingBox();
          const shell = await page.locator("div.settings-shell").first().boundingBox();
          if (!secBox || !shell) throw new Error("resource environments have no layout");
          const top = Math.max(secBox.y - 10, shell.y + 4);
          let bottom = Math.min(secBox.y + secBox.height, shell.y + shell.height - 8);
          // Cutting through a command list reads as a rendering fault rather
          // than a fold. Pull the bottom edge back to the last "Add command"
          // that is wholly inside the band — the end of a complete group.
          const adds = await page.getByRole("button", { name: /Add command/i }).all();
          let lastWhole = 0;
          for (const add of adds) {
            const b = await add.boundingBox();
            if (b && b.y + b.height + 6 <= bottom) lastWhole = b.y + b.height + 6;
          }
          if (lastWhole > top + 200) bottom = lastWhole;
          await cap.snapBand(
            page,
            "worktrees/remote-compute/worktrees-resource-environments-settings",
            { x: secBox.x - 10, y: top, width: secBox.width + 20, height: bottom - top }
          );
          await resetOverlays(page);
        }
      );
    } finally {
      if (ctx) await closeApp(ctx.app).catch(() => {});
      repo.cleanup();
      if (profile) rmSync(profile, { recursive: true, force: true });
    }
  });
});

/**
 * Write a small "brand mark" PNG: a coloured field with an opaque bar at a
 * given x offset.
 *
 * The image diff refuses to offer its mode toggle unless both sides decode,
 * so the fixture needs real pixels rather than the 1x1 stub the generic
 * helpers ship — and the bar has to move between the two versions or onion
 * skin has nothing to show.
 */
function writeMarkPng(file: string, rgb: number[], barX: number): void {
  const width = 480;
  const height = 320;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let o = 0;
  for (let y = 0; y < height; y++) {
    raw[o++] = 0;
    for (let x = 0; x < width; x++) {
      const inBar = x >= barX && x < barX + 140 && y > 60 && y < height - 60;
      raw[o++] = inBar ? 0xf2 : rgb[0];
      raw[o++] = inBar ? 0xf5 : rgb[1];
      raw[o++] = inBar ? 0xf0 : rgb[2];
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const table: number[] = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    let crc = 0xffffffff;
    for (const b of body) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([len, body, crcBuf]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  writeFileSync(
    file,
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", ihdr),
      chunk("IDAT", zlib.deflateSync(raw)),
      chunk("IEND", Buffer.alloc(0)),
    ])
  );
}
