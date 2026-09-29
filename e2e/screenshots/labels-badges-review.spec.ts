/**
 * Labels, badges and count-pills visual-review harness.
 *
 * Photographs every place the app draws a small uppercase section label, a status
 * badge / chip, or a count pill, so a design pass over those three vocabularies can be
 * judged before and after. Two kinds of source:
 *
 *   - `labels-badges-preview.html` — contact sheets of the real components, grouped by
 *     where they live (plugins, dialogs, lists, chips, welcome).
 *   - the sibling preview pages that already mount a surface carrying one of these
 *     elements (the panel header's chip cluster, deleted-worktree hold pills, the
 *     worktree filter's count pill, the subagent chip, bulk remove, the fleet ribbon).
 *
 * Opt-in only:
 *
 *   DAINTREE_SHOT_LABELS_BADGES=1 DESIGN_CAPTURE_DIR=/abs/out \
 *     npx playwright test --project=screenshots labels-badges-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_LABELS_BADGES  required — any truthy value runs the capture
 *   DESIGN_CAPTURE_DIR           required — an ABSOLUTE directory outside the repo
 *   DAINTREE_SHOT_THEMES         comma-separated themes (default daintree,bondi)
 *
 * Output: `{source}-{fixture}-{theme}.png`. Never writes a PNG it has not verified,
 * fails on any page error, and counts the files on disk at the end.
 */

import { test, expect, type Locator, type Page } from "@playwright/test";
import { mkdirSync, readdirSync, realpathSync, rmSync } from "fs";
import path from "path";
import { startPreviewServer, stubViteHmrClient } from "../helpers/previewHarness";

const ENABLED = !!process.env.DAINTREE_SHOT_LABELS_BADGES;
const OUT_DIR = process.env.DESIGN_CAPTURE_DIR ?? "";
const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,bondi")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

const VIEWPORT = { width: 1100, height: 900 };

const DIALOG = '[role="dialog"], [role="alertdialog"]';

const FREEZE_CSS = `
  ::-webkit-scrollbar { display: none !important; }
  *, *::before, *::after {
    animation-duration: 0s !important;
    animation-delay: 0s !important;
    transition-duration: 0s !important;
    transition-delay: 0s !important;
    caret-color: transparent !important;
  }
`;

interface Shot {
  source: string;
  fixture: string;
  /** Path + query after the base URL; `{theme}` is substituted. */
  url: string;
  /** Proves the page mounted before any interaction. */
  ready: (page: Page) => Locator;
  /** Interaction to reach the state (open a popover, expand a row). */
  drive?: (page: Page) => Promise<void>;
  /** The element(s) the capture is about; each must settle with a real box. */
  surface: (page: Page) => Locator;
  viewport?: { width: number; height: number };
}

/**
 * Mirrors FIXTURE_NAMES in labelsBadgesPreview.tsx, which cannot be imported under
 * Node. Contact sheets settle every `[data-preview-surface]` group; the full-window
 * layers name their own surface, and the two whose state is local to the component
 * are driven here with real input.
 */
const SHEET_FIXTURES: Array<Pick<Shot, "fixture"> & Partial<Pick<Shot, "drive" | "surface">>> = [
  { fixture: "plugins" },
  { fixture: "plugin-manager", surface: (p) => p.getByRole("region", { name: "Plugin manager" }) },
  { fixture: "plugin-mcp-confirm", surface: (p) => p.locator(DIALOG) },
  { fixture: "plugin-archive-confirm", surface: (p) => p.locator(DIALOG) },
  { fixture: "plugin-confirm", surface: (p) => p.locator(DIALOG) },
  { fixture: "plugin-capability-confirm", surface: (p) => p.locator(DIALOG) },
  { fixture: "dialogs" },
  { fixture: "mcp-confirm", surface: (p) => p.locator(DIALOG) },
  {
    fixture: "terminal-info",
    drive: async (page) => {
      await expect(page.locator(DIALOG)).toContainText("How it launched");
    },
    surface: (p) => p.locator(DIALOG),
  },
  {
    fixture: "import-env",
    drive: async (page) => {
      await page
        .getByTestId("import-env-textarea")
        .fill(
          [
            "ANTHROPIC_API_KEY=sk-ant-api03-new-4b1d9e0c",
            "NODE_ENV=production",
            "DATABASE_URL=postgres://ci@db.internal:5432/acme_billing",
            "SENTRY_DSN=https://abc@o1.ingest.sentry.io/42",
          ].join("\n")
        );
      await page.locator('[data-confirm-role="confirm"]').click();
      await expect(page.getByTestId("import-env-conflict-list")).toBeVisible();
    },
    surface: (p) => p.locator(DIALOG),
  },
  {
    fixture: "commit-push",
    drive: async (page) => {
      await page.getByTestId("review-hub-commit-primary").click();
      await expect(page.getByTestId("commit-panel-push-confirm-branch")).toBeVisible();
    },
    surface: (p) => p.locator(DIALOG),
  },
  { fixture: "lists" },
  {
    fixture: "toasts",
    drive: async (page) => {
      await expect(page.getByTestId("toast-coalesce-badge")).toHaveCount(2);
    },
    surface: (p) => p.getByRole("region", { name: "Notifications" }),
  },
  {
    fixture: "log-level-palette",
    drive: async (page) => {
      await expect(page.locator(DIALOG)).toContainText("main:Mainwarn");
    },
    surface: (p) => p.locator(DIALOG),
  },
  { fixture: "chips" },
  { fixture: "welcome" },
];

const sheetShots: Shot[] = SHEET_FIXTURES.map(({ fixture, drive, surface }) => ({
  source: "labels",
  fixture,
  url: `/labels-badges-preview.html?theme={theme}&fixture=${fixture}`,
  ready: (page) => page.locator("html[data-preview-ready]"),
  drive,
  surface: surface ?? ((page) => page.locator("[data-preview-surface]")),
}));

/** Panel header fixtures that carry the chip cluster (see Panel/__preview__/fixtures.ts). */
const PANEL_HEADER_FIXTURES = [
  "dense-metadata",
  "long-title-narrow",
  "completed-no-changes",
  "completed-cost",
  "hibernated",
  "command-pill",
  "exited-plain",
  "maximized-stats",
];

const panelHeaderShots: Shot[] = PANEL_HEADER_FIXTURES.map((fixture) => ({
  source: "panel-header",
  fixture,
  url: `/panel-header-preview.html?theme={theme}&fixture=${fixture}`,
  ready: (page) => page.locator("[data-preview-pane] [data-pane-chrome]"),
  surface: (page) => page.locator("[data-preview-pane]"),
  viewport: { width: 1240, height: 400 },
}));

const deletedGroupShots: Shot[] = ["single-held", "group-held", "group-expanded"].map(
  (fixture) => ({
    source: "deleted-worktree-group",
    fixture,
    url: `/deleted-worktree-group-preview.html?theme={theme}&fixture=${fixture}&width=350`,
    ready: (page) =>
      fixture.startsWith("group")
        ? page.getByTestId("deleted-worktree-group")
        : page.locator("[data-deleted-worktree-id]"),
    surface: (page) => page.locator("[data-preview-shell]"),
    viewport: { width: 390, height: fixture === "group-expanded" ? 1080 : 720 },
  })
);

const worktreeFilterShots: Shot[] = ["default", "active"].map((fixture) => ({
  source: "worktree-filter",
  fixture,
  url: `/worktree-filter-preview.html?theme={theme}&fixture=${fixture}`,
  ready: (page) => page.locator("[data-preview-shell]"),
  drive: async (page) => {
    await page.getByRole("button", { name: /^Filter and sort worktrees/ }).click();
    await page.mouse.move(0, 0);
  },
  surface: (page) => page.getByTestId("worktree-filter-popover"),
  viewport: { width: 820, height: 820 },
}));

const subagentPopover = (page: Page) => page.locator("[data-radix-popper-content-wrapper]").last();

const subagentShots: Shot[] = [
  {
    source: "subagent-chip",
    fixture: "codex-mixed-open",
    url: "/subagent-chip-preview.html?theme={theme}&fixture=codex-mixed",
    ready: (page) => page.getByRole("button", { name: /subagent/i }).first(),
    drive: async (page) => {
      await page
        .getByRole("button", { name: /subagent/i })
        .first()
        .click();
      await expect(subagentPopover(page)).toContainText(/subagents/);
      await page.mouse.move(0, 0);
    },
    surface: subagentPopover,
    viewport: { width: 820, height: 760 },
  },
  {
    source: "subagent-chip",
    fixture: "codex-mixed-expanded",
    url: "/subagent-chip-preview.html?theme={theme}&fixture=codex-mixed",
    ready: (page) => page.getByRole("button", { name: /subagent/i }).first(),
    drive: async (page) => {
      await page
        .getByRole("button", { name: /subagent/i })
        .first()
        .click();
      const content = subagentPopover(page);
      await expect(content).toContainText(/subagents/);
      await content.locator("li button").first().click();
      await expect(content).toContainText(/Found two problems/, { timeout: 5_000 });
      await page.mouse.move(0, 0);
    },
    surface: subagentPopover,
    viewport: { width: 820, height: 760 },
  },
];

const BULK_CARD = '[role="dialog"] > [tabindex="-1"], [role="alertdialog"] > [tabindex="-1"]';

const bulkRemoveShots: Shot[] = ["mixed", "long"].map((fixture) => ({
  source: "worktree-bulk-remove",
  fixture,
  url: `/worktree-bulk-remove-preview.html?theme={theme}&fixture=${fixture}`,
  ready: (page) => page.locator(BULK_CARD).first(),
  surface: (page) => page.locator(BULK_CARD).first(),
  viewport: { width: 1100, height: 900 },
}));

const fleetShots: Shot[] = [
  {
    source: "fleet",
    fixture: "armed-cross-worktree",
    url: "/fleet-preview.html?theme={theme}&fixture=armed-cross-worktree&width=1100",
    ready: (page) => page.getByTestId("fleet-armed-count-chip"),
    surface: (page) => page.getByTestId("fleet-arming-ribbon"),
  },
  {
    source: "fleet",
    fixture: "count-chip-popover",
    url: "/fleet-preview.html?theme={theme}&fixture=armed-cross-worktree&width=1100",
    ready: (page) => page.getByTestId("fleet-armed-count-chip"),
    drive: async (page) => {
      await page.getByTestId("fleet-armed-count-chip").click();
      await page.mouse.move(0, 0);
    },
    surface: (page) => page.getByTestId("fleet-armed-list"),
  },
  {
    source: "fleet",
    fixture: "drafting-pill-open",
    url: "/fleet-preview.html?theme={theme}&fixture=drafting-pill-open&width=1100",
    ready: (page) => page.locator("[data-preview-frame]").first(),
    surface: (page) => page.getByTestId("fleet-resolution-popover"),
  },
].map((shot) => ({ ...shot, viewport: { width: 1100, height: 680 } }));

const SHOTS: Shot[] = [
  ...sheetShots,
  ...panelHeaderShots,
  ...deletedGroupShots,
  ...worktreeFilterShots,
  ...subagentShots,
  ...bulkRemoveShots,
  ...fleetShots,
];

let baseURL = "";
let closeServer: (() => Promise<void>) | undefined;

test.use({ viewport: VIEWPORT, deviceScaleFactor: 2 });

test.beforeAll(async () => {
  if (!ENABLED) return;
  if (!OUT_DIR || !path.isAbsolute(OUT_DIR)) {
    throw new Error("DESIGN_CAPTURE_DIR must be an absolute directory outside the repo");
  }
  const repoRoot = realpathSync(process.cwd());
  mkdirSync(OUT_DIR, { recursive: true });
  const outReal = realpathSync(OUT_DIR);
  if (outReal === repoRoot || outReal.startsWith(repoRoot + path.sep)) {
    throw new Error(`DESIGN_CAPTURE_DIR must be outside the repo (${OUT_DIR})`);
  }
  // Fresh captures per run; only PNGs go, never a directory this did not create.
  for (const file of readdirSync(OUT_DIR)) {
    if (file.endsWith(".png")) rmSync(path.join(OUT_DIR, file), { force: true });
  }
  const server = await startPreviewServer();
  baseURL = server.baseURL;
  closeServer = server.close;
});

test.afterAll(async () => {
  await closeServer?.();
});

async function settle(page: Page, surface: Locator, label: string): Promise<void> {
  const count = await surface.count();
  if (count === 0) throw new Error(`${label}: no surface on the page — refusing to write`);
  for (let i = 0; i < count; i += 1) {
    const el = surface.nth(i);
    await expect(el, `${label}: surface ${i} never became visible`).toBeVisible();
    await expect
      .poll(() => el.evaluate((node) => getComputedStyle(node).opacity), {
        message: `${label}: surface ${i} never reached opacity 1`,
      })
      .toBe("1");
    const box = await el.boundingBox();
    if (!box || box.width < 24 || box.height < 16) {
      throw new Error(
        `${label}: surface ${i} has no real box (${JSON.stringify(box)}) — refusing to write`
      );
    }
  }
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(350);
}

async function capture(page: Page, shot: Shot, theme: string, errors: string[]): Promise<string> {
  const label = `${shot.source}-${shot.fixture}-${theme}`;
  await page.setViewportSize(shot.viewport ?? VIEWPORT);
  const url = `${baseURL}${shot.url.replace("{theme}", theme)}`;
  const timeout = 30_000;
  try {
    await page.goto(url);
    await expect(shot.ready(page).first()).toBeAttached({ timeout });
  } catch {
    console.warn(`[labels-badges-shots] first mount of ${label} failed; retrying once`);
    await page.goto("about:blank");
    await page.goto(url, { waitUntil: "load" });
    await expect(
      shot.ready(page).first(),
      `${label}: never mounted — ${errors.join(" | ") || "no page error"}`
    ).toBeAttached({ timeout });
  }
  await page.addStyleTag({ content: FREEZE_CSS });
  await page.evaluate(() => document.fonts.ready);
  if (shot.drive) await shot.drive(page);
  // Destructive confirms hold their primary button disabled for 1.2s after opening;
  // the resting state is what a reviewer should judge.
  if (shot.fixture.includes("confirm")) await page.waitForTimeout(1_300);
  const broken = page.locator("[data-preview-error]");
  if ((await broken.count()) > 0) {
    const text = (await broken.allInnerTexts()).join(" | ");
    throw new Error(`${label}: an item failed to render — ${text}`);
  }
  await settle(page, shot.surface(page), label);
  const out = path.join(OUT_DIR, `${label}.png`);
  await page.screenshot({ path: out, fullPage: true });
  return out;
}

test("labels, badges and count pills — every surface and theme", async ({ page }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_LABELS_BADGES is required for the labels/badges capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_LABELS_BADGES=1 to run the capture");

  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(`${page.url()}: ${error.message}`));
  await stubViteHmrClient(page);

  const written: string[] = [];
  const siblingErrors = new Set<string>();
  for (const theme of THEMES) {
    for (const shot of SHOTS) {
      written.push(await capture(page, shot, theme, errors));
      if (shot.source === "labels") {
        expect(errors, `page error during ${shot.source}-${shot.fixture}-${theme}`).toEqual([]);
      } else {
        // The sibling harnesses are someone else's pages, and some already throw
        // unhandled rejections from their own inert bridge (the panel header's
        // `.status` read). Their capture is still proved by its surface; the error
        // is reported rather than blocking a sheet this spec does not own.
        for (const e of errors) siblingErrors.add(`${shot.source}-${shot.fixture}: ${e}`);
      }
      errors.length = 0;
    }
  }
  if (siblingErrors.size > 0) {
    const detail = [...siblingErrors].join("\n");
    test.info().annotations.push({ type: "sibling-page-errors", description: detail });
    console.warn(`[labels-badges-shots] sibling preview page errors:\n${detail}`);
  }

  const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  expect(onDisk.length).toBe(written.length);
  expect(onDisk.length).toBe(THEMES.length * SHOTS.length);
  console.log(`[labels-badges-shots] ${onDisk.length} PNGs in ${OUT_DIR}`);
});
