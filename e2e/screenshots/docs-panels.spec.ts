/**
 * Documentation screenshots — panels: terminals, the File Browser, the File
 * Viewer, QuickRun, Portal and Browser panels.
 *
 * Two scenes. The panel surfaces all want one project with a fake agent and a
 * dirty working tree; Portal and the Browser panel want a fresh profile, since
 * approving a host persists into project settings and the banner never
 * reappears afterwards.
 */

import { test, expect, type Page } from "@playwright/test";
import { execSync } from "child_process";
import zlib from "zlib";
import { mkdirSync, rmSync, statSync, writeFileSync } from "fs";
import path from "path";
import { closeApp, type AppContext } from "../helpers/launch";
import { SEL } from "../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_LONG } from "../helpers/timeouts";
import { createAtlasLedgerRepo, attachLocalOrigin, DOCS_DEMO_ROOT } from "../helpers/docsFixtures";
import { createCapture, resetOverlays } from "../helpers/docsCapture";
import { bootDocsApp, DOCS_WINDOW_WIDE, DIALOG_PAD } from "../helpers/docsBoot";
import { installFakeAgent, fakeAgentEnv } from "../helpers/fakeAgent";
import { launchDocsAgent } from "../helpers/docsAgents";
import { openBrowser } from "../helpers/panels";
import type { DemoRepo } from "../helpers/screenshotFixtures";

process.env.DAINTREE_DEMO_ROOT = DOCS_DEMO_ROOT;

const cap = createCapture("panels");

async function dispatch(page: Page, id: string, payload?: unknown): Promise<unknown> {
  const out = await page.evaluate(
    async (args) => {
      const fn = (
        window as unknown as {
          __daintreeDispatchAction?: (
            id: string,
            p: unknown,
            o: { source: string }
          ) => Promise<unknown>;
        }
      ).__daintreeDispatchAction;
      if (!fn) throw new Error("action dispatch bridge unavailable");
      return fn(args.id, args.payload, { source: "user" });
    },
    { id, payload }
  );
  await page.waitForTimeout(T_SHORT);
  return out;
}

test.describe.serial("Documentation Screenshots — Panels", () => {
  test.afterAll(() => {
    cap.writeReport();
  });

  // ---------------------------------------------------------------------------
  // Scene N1 — terminals, file browser, file viewer, QuickRun
  // ---------------------------------------------------------------------------
  test("scene-n1-panels", async () => {
    const repo: DemoRepo = createAtlasLedgerRepo();
    attachLocalOrigin(repo);
    // A PDF and an image for the media grid.
    mkdirSync(path.join(repo.dir, "docs"), { recursive: true });
    writeLedgerSpecPdf(path.join(repo.dir, "docs/ledger-spec.pdf"));

    // An image for the media grid to sit beside the PDF, encoded here rather
    // than pasted as a base64 literal: the viewer decodes it, and a stub that
    // fails to decode renders "File no longer exists" instead of a picture.
    mkdirSync(path.join(repo.dir, "assets"), { recursive: true });
    writeSolidPng(path.join(repo.dir, "assets/brand-mark.png"), 640, 400, [0x2f, 0x8f, 0x6a]);
    execSync("git add -A && git commit -m 'docs: add the ledger spec and brand mark'", {
      cwd: repo.dir,
      stdio: "ignore",
    });

    // Dirty the tree AFTER that commit. Doing it before meant the `git add -A`
    // above swept the very changes this scene needs into the commit, leaving a
    // clean tree and a File Browser with no "Changed files" summary at all.
    writeFileSync(
      path.join(repo.dir, "src/journal/posting.ts"),
      "// settle in the ledger currency before rounding\nexport const ROUNDING = 2;\n"
    );
    writeFileSync(path.join(repo.dir, "src/journal/scratch-notes.md"), "# working notes\n");

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

      /**
       * Open the File Browser the way the empty-grid launcher does. The
       * keyboard route alone is unreliable here — the launcher chip is the
       * path the rest of the suite already proves.
       */
      const openFileBrowser = async () => {
        await resetOverlays(page);
        const existing = page.locator('[data-panel-id^="file-browser"]').first();
        if (await existing.isVisible({ timeout: 750 }).catch(() => false)) return existing;
        const chip = page.locator('[aria-label="Browse files"]').first();
        if (await chip.isVisible({ timeout: T_SHORT }).catch(() => false)) {
          await chip.click();
        } else {
          await page.keyboard.press("Meta+Alt+KeyF");
        }
        await page.waitForTimeout(T_LONG);
        // File Browser panels carry a `file-browser-` id prefix. "The last
        // grid panel" is not the same thing once the scene has opened others,
        // and it is not even reliable on the first open.
        const panel = page.locator('[data-panel-id^="file-browser"]').first();
        await expect(panel).toBeVisible({ timeout: T_LONG });
        return panel;
      };

      await cap.shot("terminals-and-panels/file-browser/file-browser-changed-files", async () => {
        const browser = await openFileBrowser();
        // With nothing selected the browser answers "what changed", which is
        // the whole point of the shot — so do not click a row.
        //
        // Gate on the panel, not on the "Changed files" heading: the heading
        // is inside a scroll region and can be present-but-not-visible, which
        // failed the shot on a panel that had rendered perfectly.
        await expect(browser).toContainText("Changed files", { timeout: T_LONG });
        await page.waitForTimeout(T_MEDIUM);
        await cap.snapElement(
          page,
          browser,
          "terminals-and-panels/file-browser/file-browser-changed-files",
          12
        );
      });

      // One agent, and exactly one: "Insert file reference" targets the agent
      // you last spoke to, and is disabled when there is no unambiguous one.
      const agentId = await launchDocsAgent(page, { name: "Reconciliation review" });

      await cap.shot("terminals-and-panels/file-browser/file-browser-insert-reference", async () => {
        const browser = await openFileBrowser();
        // The tree opens collapsed, so the file has to be walked to. Match on
        // the treeitem's aria-label, not its text: a folder holding changes
        // renders as "srcContains modified changesM", which no exact text
        // match will ever hit.
        for (const folder of ["src", "journal"]) {
          const dir = browser.locator(`[role="treeitem"][aria-label="${folder}"]`).first();
          await expect(dir).toBeVisible({ timeout: T_LONG });
          await dir.click();
          await page.waitForTimeout(T_SHORT);
        }
        const row = browser.locator('[role="treeitem"][aria-label="posting.ts"]').first();
        await expect(row).toBeVisible({ timeout: T_LONG });
        await row.click();
        await page.waitForTimeout(T_SHORT);
        await row.click({ button: "right" });
        await expect(
          page.getByRole("menuitem", { name: /Insert file reference/i })
        ).toBeVisible({ timeout: T_LONG });
        await page.waitForTimeout(T_SHORT);
        await cap.snapWindow(
          page,
          "terminals-and-panels/file-browser/file-browser-insert-reference"
        );
        await page.keyboard.press("Escape");
      });

      await cap.shot("terminals-and-panels/terminals/terminals-terminal-info", async () => {
        await resetOverlays(page);
        const panel = page.locator(`[data-panel-id="${agentId}"]`);
        await panel.locator('[data-pane-chrome], header').first().click({ button: "right" });
        // Lowercase "info" — the menu item is "View terminal info", not
        // "View Terminal Info".
        await page.getByRole("menuitem", { name: /View terminal info/i }).click();
        const dlg = page
          .locator('[role="dialog"], [data-testid="panel-dialog"]')
          .filter({ hasText: /Session Metadata|Spawn Command/i })
          .first();
        await expect(dlg).toBeVisible({ timeout: T_LONG });
        await page.waitForTimeout(T_MEDIUM);
        await cap.snapElement(
          page,
          dlg.locator("> div").first(),
          "terminals-and-panels/terminals/terminals-terminal-info",
          DIALOG_PAD
        );
        await resetOverlays(page);
      });

      await cap.shot("terminals-and-panels/quickrun/quickrun-panel", async () => {
        await resetOverlays(page);
        const input = page.locator(SEL.sidebar.aside).getByPlaceholder(/Execute command/i).first();
        await expect(input).toBeVisible({ timeout: T_LONG });
        await input.click();
        await input.fill("npm run ");
        await page.waitForTimeout(T_MEDIUM);
        const box = await input.boundingBox();
        if (!box) throw new Error("QuickRun input has no layout");
        // The suggestion list opens *above* the input (`bottom-full`) and dies
        // the moment focus leaves, so the band has to reach upward and nothing
        // may be clicked in between.
        const top = Math.max(0, box.y - 240);
        await cap.snapBand(page, "terminals-and-panels/quickrun/quickrun-panel", {
          x: Math.max(0, box.x - 12),
          y: top,
          width: box.width + 24,
          height: box.y + box.height + 12 - top,
        });
        await page.keyboard.press("Escape");
      });

      await cap.shot("terminals-and-panels/file-viewer/file-viewer-dialog-promote", async () => {
        await resetOverlays(page);
        // Dispatch the action rather than clicking a terminal link: the link
        // helper sends a metaKey click, which routes to a different action.
        await dispatch(page, "file.view", {
          path: path.join(repo.dir, "README.md"),
        });
        const dlg = page
          .locator('[data-testid="panel-dialog"]')
          .filter({ hasText: /README/i })
          .first();
        await expect(dlg).toBeVisible({ timeout: T_LONG });
        await expect(dlg.getByText("Open as panel")).toBeVisible({ timeout: T_MEDIUM });
        await page.waitForTimeout(T_MEDIUM);
        await cap.snapElement(
          page,
          dlg.locator("> div").first(),
          "terminals-and-panels/file-viewer/file-viewer-dialog-promote",
          DIALOG_PAD
        );
        await resetOverlays(page);
      });

      await cap.shot("terminals-and-panels/file-viewer/file-viewer-media-grid", async () => {
        await resetOverlays(page);
        // `file.view` opens a dialog whatever `location` says; the dialog's
        // own "Open as panel" button is what promotes it into the grid. The
        // first attempt at this shot passed `location: "grid"`, got two
        // dialogs, and captured one of them over a dimmed workspace — which
        // is the state the section immediately above already illustrates.
        const promote = async (file: string) => {
          await dispatch(page, "file.view", { path: path.join(repo.dir, file) });
          const dlg = page
            .locator('[data-testid="panel-dialog"]')
            .filter({ hasText: path.basename(file) })
            .first();
          await expect(dlg).toBeVisible({ timeout: T_LONG });
          await dlg.getByText("Open as panel").first().click();
          await page.waitForTimeout(T_MEDIUM);
        };
        // A Markdown viewer beside the image, not the PDF.
        //
        // The PDF pane renders as a flat dark rectangle in this build — with a
        // hand-built PDF and with a genuinely well-formed one from cupsfilter
        // alike, and after a six-second settle. Chromium's PDF viewer needs
        // the plugin enabled on the host webPreferences, so this looks like an
        // app-side gap rather than a fixture problem. Capturing a blank pane
        // and captioning it "a PDF" would be worse than capturing what the
        // viewer actually does.
        await promote("README.md");
        await promote("assets/brand-mark.png");
        // Both viewers must be real grid panels. Not an exact count: earlier
        // shots in this scene leave a File Browser open too.
        expect(await page.locator(SEL.panel.gridPanel).count()).toBeGreaterThanOrEqual(2);
        await expect(page.getByText("README.md").first()).toBeVisible({ timeout: T_LONG });
        await expect(page.getByText("brand-mark.png").first()).toBeVisible({ timeout: T_LONG });
        await page.waitForTimeout(T_MEDIUM);
        await cap.snapWindow(page, "terminals-and-panels/file-viewer/file-viewer-media-grid");
      });

    } finally {
      if (ctx) await closeApp(ctx.app).catch(() => {});
      repo.cleanup();
      if (profile) rmSync(profile, { recursive: true, force: true });
    }
  });

  // ---------------------------------------------------------------------------
  // Scene N2 — Portal and the Browser panel's host approval
  // ---------------------------------------------------------------------------
  test("scene-n2-portal", async () => {
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

      await cap.shot("portal-browser/portal-launchpad", async () => {
        await resetOverlays(page);
        await dispatch(page, "portal.toggle");
        const portal = page.locator('aside[aria-label="Portal"]');
        await expect(portal).toBeVisible({ timeout: T_LONG });
        await page.waitForTimeout(T_MEDIUM);
        // The rail runs the full height of the window and its list is short,
        // so an element capture is more than half empty. End the band just
        // below the last row.
        const railBox = await portal.boundingBox();
        const rows = await portal.locator("button, a").all();
        let lastBottom = 0;
        for (const row of rows) {
          const b = await row.boundingBox();
          if (b) lastBottom = Math.max(lastBottom, b.y + b.height);
        }
        if (!railBox) throw new Error("portal rail has no layout");
        const railHeight = lastBottom > railBox.y ? lastBottom - railBox.y + 16 : railBox.height;
        await cap.snapBand(page, "portal-browser/portal-launchpad", {
          x: railBox.x,
          y: railBox.y,
          width: railBox.width,
          height: Math.min(railHeight, railBox.height),
        });
        await dispatch(page, "portal.toggle");
      });

    } finally {
      if (ctx) await closeApp(ctx.app).catch(() => {});
      repo.cleanup();
      if (profile) rmSync(profile, { recursive: true, force: true });
    }
  });

  // ---------------------------------------------------------------------------
  // Scene N3 — two states that need a workspace nothing else has touched
  //
  // Both kept failing at the end of a long scene for the same reason: they
  // measure a panel, and by then the panel was one of half a dozen the earlier
  // shots had opened, closed and re-opened. A fresh boot is cheaper than
  // making each of them defensive about the other seven.
  // ---------------------------------------------------------------------------
  test("scene-n3-clean", async () => {
    const repo: DemoRepo = createAtlasLedgerRepo();
    attachLocalOrigin(repo);
    const binDir = installFakeAgent(path.dirname(repo.dir));
    let ctx: AppContext | undefined;
    let profile = "";
    try {
      const booted = await bootDocsApp({
        repoDir: repo.dir,
        displayName: "Atlas Ledger",
        emoji: "\u{1F4D2}",
        env: fakeAgentEnv(binDir),
        windowSize: DOCS_WINDOW_WIDE,
      });
      ctx = booted.ctx;
      profile = booted.userDataDir;
      const { page } = booted;

      await cap.shot("terminals-and-panels/terminals-and-panels-tabs", async () => {
        await launchDocsAgent(page, { name: "Reconciliation review" });
        const panel = page.locator(`${SEL.panel.gridPanel}:has([data-pane-chrome])`).first();
        await expect(panel).toBeVisible({ timeout: T_LONG });
        const chrome = panel.locator("[data-pane-chrome]").first();
        // Tabs are several sessions in ONE pane. Launching more agents makes
        // more panes, each with a one-tab header — which is how this first
        // captured a header carrying a single tab and no overflow at all.
        for (let i = 0; i < 3; i++) {
          await chrome.hover();
          await page.waitForTimeout(250);
          await panel
            .locator('[aria-label="Duplicate panel as new tab"]')
            .first()
            .click({ timeout: 15_000 });
          await page.waitForTimeout(T_MEDIUM);
        }
        await page.waitForTimeout(T_MEDIUM);
        await cap.snapElement(page, chrome, "terminals-and-panels/terminals-and-panels-tabs", 8);
      });

    } finally {
      if (ctx) await closeApp(ctx.app).catch(() => {});
      repo.cleanup();
      if (profile) rmSync(profile, { recursive: true, force: true });
    }
  });

  // ---------------------------------------------------------------------------
  // Scene N4 — the host-approval banner, alone
  //
  // It needs a workspace with exactly one panel in it. Sharing a scene with
  // the tab-bar staging left four agent tabs in the grid, and the browser
  // panel this measures was no longer the one the locator found.
  // ---------------------------------------------------------------------------
  test("scene-n4-host-approval", async () => {
    const repo: DemoRepo = createAtlasLedgerRepo();
    attachLocalOrigin(repo);
    let ctx: AppContext | undefined;
    let profile = "";
    try {
      const booted = await bootDocsApp({
        repoDir: repo.dir,
        displayName: "Atlas Ledger",
        emoji: "\u{1F4D2}",
        windowSize: DOCS_WINDOW_WIDE,
      });
      ctx = booted.ctx;
      profile = booted.userDataDir;
      const { page } = booted;

      await cap.shot("portal-browser/browser-panels/browser-panels-host-approval", async () => {
        await resetOverlays(page);
        // A host approved by an earlier scene in this profile would suppress
        // the prompt outright, and the failure would look like a timing bug.
        await page.evaluate(() => {
          window.__daintreeDispatchAction?.(
            "project.saveSettings",
            { browserAllowedHosts: [] },
            { source: "user" }
          );
        });
        await openBrowser(page);
        const panel = page
          .locator(SEL.panel.gridPanel)
          .filter({ has: page.locator(SEL.browser.addressBar) })
          .first();
        await expect(panel).toBeVisible({ timeout: T_LONG });
        const bar = panel.locator(SEL.browser.addressBar);
        await bar.click();
        await bar.fill("");
        // Note the field eats the scheme as you type: this lands as
        // "//staging.atlas-ledger.dev:3000", which normalizes back to http on
        // submit. Asserting on the full typed string would never pass.
        await bar.fill("http://staging.atlas-ledger.dev:3000");
        await expect(bar).toHaveValue(/staging\.atlas-ledger\.dev/, { timeout: T_MEDIUM });
        // Press on the input, not on the page. A page-level Enter was landing
        // somewhere else entirely — the panel stayed on its default
        // localhost:3000 and no prompt was ever raised.
        await bar.press("Enter");
        // The banner is up within half a second and stays; give it a beat
        // rather than racing the first paint.
        await page.waitForTimeout(1500);
        // Gate on the banner's own Allow button, inside the panel.
        //
        // An `[aria-live="assertive"]` match is NOT sufficient: the app also
        // renders a visually-hidden announcer carrying the same sentence, so
        // `toBeVisible()` passed against an off-screen node while the visible
        // banner had already gone — and the shot shipped showing the panel's
        // original localhost URL and no banner at all.
        //
        // The host must be genuinely public-looking. `.internal`, `.local`,
        // `.test`, `.localhost`, `localhost` and every RFC1918 range are
        // implicitly allowed and never prompt.
        // Assert the banner's text inside the panel's own subtree. An
        // `[aria-live="assertive"]` match is not sufficient — the app renders
        // a visually-hidden announcer carrying the same sentence, so
        // toBeVisible() passed against an off-screen node and the shot
        // shipped with no banner in it. A role-based match on the Allow
        // control does not resolve either; the text is the reliable handle.
        await expect(panel).toContainText("Allow browser panel to load", {
          timeout: T_LONG * 2,
        });
        await expect(panel).toContainText("staging.atlas-ledger.dev", { timeout: T_MEDIUM });
        // Single-node handle, immune to the text being split across spans.
        await expect(panel.locator('[aria-label="Dismiss host approval"]')).toBeVisible({
          timeout: T_MEDIUM,
        });
        const box = await panel.boundingBox();
        if (!box) throw new Error("browser panel has no layout");
        await cap.snapBand(page, "portal-browser/browser-panels/browser-panels-host-approval", {
          x: box.x,
          y: box.y,
          width: box.width,
          height: 190,
        });
      });
    } finally {
      if (ctx) await closeApp(ctx.app).catch(() => {});
      repo.cleanup();
      if (profile) rmSync(profile, { recursive: true, force: true });
    }
  });
});

/** A real, decodable solid-colour PNG. */
function writeSolidPng(file: string, width: number, height: number, rgb: number[]): void {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let o = 0;
  for (let y = 0; y < height; y++) {
    raw[o++] = 0;
    for (let x = 0; x < width; x++) {
      raw[o++] = rgb[0];
      raw[o++] = rgb[1];
      raw[o++] = rgb[2];
    }
  }
  const table: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
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

/**
 * A real PDF for the media-grid shot.
 *
 * Hand-rolling one does not work: Chromium's viewer wants a valid cross
 * reference table and a `startxref`, and an almost-correct file opens as an
 * empty black pane — which is how this shot first shipped with no PDF in it.
 * macOS ships `cupsfilter`, which produces a genuinely well-formed document
 * from plain text, so the fixture uses that and skips the pane rather than
 * fake it where the tool is missing.
 */
function writeLedgerSpecPdf(file: string): boolean {
  const txt = `${file}.txt`;
  writeFileSync(
    txt,
    "Atlas Ledger\n\nReconciliation specification\n\n" +
      "1. Postings are immutable.\n" +
      "2. Corrections reference the original.\n" +
      "3. Balances are currency-safe.\n"
  );
  try {
    execSync(`cupsfilter -i text/plain -m application/pdf ${JSON.stringify(txt)} > ${JSON.stringify(file)}`,
      { stdio: "ignore", timeout: 60_000 });
    rmSync(txt, { force: true });
    return statSync(file).size > 1000;
  } catch {
    rmSync(txt, { force: true });
    rmSync(file, { force: true });
    return false;
  }
}
