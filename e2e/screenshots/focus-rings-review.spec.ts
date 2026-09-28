/**
 * Focus-ring visual-review harness.
 *
 * Drives `focus-rings-preview.html`: real components, each in a
 * `[data-shot="<site-id>"]` wrapper, focused from the keyboard's point of view
 * and captured with their ring painted. Every target is reached by role, label,
 * test id or text — never by class, because classes are exactly what a
 * reviewer comparing rounds is about to change.
 *
 * Opt-in only, like every sibling review harness:
 *
 *   DAINTREE_SHOT_FOCUS_RINGS=1 DAINTREE_SHOT_DIR=/tmp/focus-rings npx playwright test --project=screenshots focus-rings-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_FOCUS_RINGS  required — any truthy value runs the capture
 *   DAINTREE_SHOT_DIR          output directory (default artifacts/focus-rings-shots)
 *   DAINTREE_SHOT_THEMES       comma-separated theme sweep (default: daintree,svalbard)
 *   DAINTREE_SHOT_ONLY         comma-separated site ids or fixture names, for iterating
 *
 * Never writes a PNG it has not verified: each capture asserts the target
 * matches `:focus-visible` before the shot, and the test counts the files.
 * `manifest.json` beside the PNGs records each site's source line and the
 * computed focus style read while the element held focus.
 */

import { test, expect, type Locator, type Page } from "@playwright/test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "fs";
import path from "path";
import { createServer, type ViteDevServer } from "vite";

const ENABLED = !!process.env.DAINTREE_SHOT_FOCUS_RINGS;

const OUT_DIR = path.resolve(
  process.env.DAINTREE_SHOT_DIR ?? path.join(process.cwd(), "artifacts", "focus-rings-shots")
);

const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,svalbard")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

type Fixture = "launcher" | "recipes" | "review" | "controls" | "overlays" | "tour";

interface Target {
  id: string;
  fixture: Fixture;
  /** Source file, then successive needles (`^` = trimmed line starts with): the last match's line is recorded. */
  source: [file: string, ...needles: string[]];
  locate: (page: Page, shot: Locator) => Locator;
  /** Interaction that brings the target into existence (opening a popover, expanding). */
  prepare?: (page: Page, shot: Locator) => Promise<void>;
  /** What to clip when the target is portaled out of its wrapper. */
  clip?: (page: Page) => Locator;
}

const PULSE = "src/components/Pulse/ProjectPulseStrip.tsx";
const RR = "src/components/Terminal/RecipeRunner";
const HUB = "src/components/Worktree/ReviewHub";
const FILTER = "src/components/Worktree/WorktreeFilterPopover.tsx";

const openShotTrigger = async (_page: Page, shot: Locator, name?: RegExp) => {
  const trigger = name
    ? shot.getByRole("button", { name })
    : shot.locator('button[aria-haspopup="dialog"]');
  await trigger.first().click();
};

const TARGETS: Target[] = [
  {
    id: "pulse-row",
    fixture: "launcher",
    source: [PULSE, "ref={stripButtonRef}"],
    locate: (_p, shot) => shot.getByRole("button", { name: /Project pulse/ }),
  },
  {
    id: "pulse-collapse",
    fixture: "launcher",
    source: [PULSE, "ref={collapseButtonRef}"],
    prepare: async (_p, shot) => {
      await shot.getByRole("button", { name: /Project pulse/ }).click();
    },
    locate: (_p, shot) => shot.getByRole("button", { name: "Collapse" }),
  },
  {
    id: "launcher-quick-action",
    fixture: "launcher",
    source: [
      "src/components/Terminal/LauncherQuickActions.tsx",
      "function QuickAction(",
      "^<button",
    ],
    locate: (_p, shot) =>
      shot.getByRole("toolbar", { name: "Quick launch" }).getByRole("button").first(),
  },
  {
    id: "resume-line",
    fixture: "launcher",
    source: ["src/components/Terminal/ResumeSessionLine.tsx", "resume(primary.session)"],
    locate: (_p, shot) => shot.getByRole("button").first(),
  },
  {
    id: "resume-launcher",
    fixture: "launcher",
    source: ["src/components/Terminal/ResumeSessionLine.tsx", "onClick={openLauncher}"],
    locate: (_p, shot) => shot.getByRole("button", { name: /more — browse/ }),
  },
  {
    id: "recipe-item-card",
    fixture: "recipes",
    source: [`${RR}/RecipeRunnerItem.tsx`, 'mode === "grid"', "^<button"],
    locate: (_p, shot) => shot.getByRole("option").first(),
  },
  {
    id: "recipe-grid-create",
    fixture: "recipes",
    source: [`${RR}/RecipeRunnerGrid.tsx`, 'id="recipe-option-create"'],
    locate: (_p, shot) => shot.getByRole("option", { name: /Create new recipe/ }),
  },
  {
    id: "recipe-manage",
    fixture: "recipes",
    source: [`${RR}/RecipeRunner.tsx`, "onClick={runner.handleManage}"],
    locate: (_p, shot) => shot.getByRole("button", { name: "Manage recipes" }),
  },
  {
    id: "recipe-item-row",
    fixture: "recipes",
    source: [`${RR}/RecipeRunnerItem.tsx`, 'mode === "grid"', "^<button", "^<button"],
    locate: (_p, shot) => shot.getByRole("option").first(),
  },
  {
    id: "recipe-list-manage",
    fixture: "recipes",
    source: [`${RR}/RecipeRunnerList.tsx`, "onClick={onManage}"],
    locate: (_p, shot) => shot.getByRole("button", { name: "Manage", exact: true }),
  },
  {
    id: "recipe-list-create",
    fixture: "recipes",
    source: [`${RR}/RecipeRunnerList.tsx`, 'id="recipe-option-create"'],
    locate: (_p, shot) => shot.getByRole("option", { name: /Create new recipe/ }),
  },
  {
    id: "recipe-empty-create",
    fixture: "recipes",
    source: [`${RR}/RecipeRunnerEmpty.tsx`, "onClick={onCreate}"],
    locate: (_p, shot) => shot.getByRole("button", { name: /Create your first recipe/ }),
  },
  {
    id: "recipe-empty-suggestion",
    fixture: "recipes",
    source: [`${RR}/RecipeRunnerEmpty.tsx`, 'data-testid="recipe-suggestion-pill"'],
    locate: (_p, shot) => shot.getByTestId("recipe-suggestion-pill").first(),
  },
  {
    id: "basebranch-row",
    fixture: "review",
    source: [`${HUB}/BaseBranchFileRow.tsx`, "onClick={onClick}"],
    locate: (_p, shot) => shot.getByRole("button").first(),
  },
  {
    id: "basebranch-badge",
    fixture: "review",
    source: [`${HUB}/BaseBranchFileRow.tsx`, "onClick={onBadgeClick}"],
    locate: (_p, shot) => shot.getByRole("button", { name: "2 unresolved review comments" }),
  },
  {
    id: "filestage-row",
    fixture: "review",
    source: [`${HUB}/FileStageRow.tsx`, "aria-label={`View diff:"],
    locate: (_p, shot) => shot.getByRole("button", { name: /^View diff: .*Legend\.tsx$/ }),
  },
  {
    id: "prchecks-trigger",
    fixture: "review",
    source: [`${HUB}/PrChecksPopover.tsx`, 'data-testid="pr-checks-trigger"'],
    locate: (_p, shot) => shot.getByTestId("pr-checks-trigger"),
  },
  {
    id: "file-decoration-badge",
    fixture: "review",
    source: ["src/components/Plugin/FileDecorationBadge.tsx", "if (url)", "^<button"],
    locate: (_p, shot) => shot.getByRole("button", { name: "2 unresolved review comments" }),
  },
  {
    id: "filechange-row",
    fixture: "review",
    source: ["src/components/Worktree/FileChangeList.tsx", 'role="button"'],
    locate: (_p, shot) => shot.getByRole("button", { name: /^Open .*Legend\.tsx$/ }),
  },
  {
    id: "diff-sidebar-row",
    fixture: "review",
    source: ["src/components/FileViewer/DiffFileSidebar.tsx", 'data-testid="diff-sidebar-file"'],
    locate: (_p, shot) => shot.getByTestId("diff-sidebar-file").nth(1),
  },
  {
    id: "canonical-button",
    fixture: "controls",
    source: ["src/components/ui/button.tsx", "cva("],
    locate: (_p, shot) => shot.getByRole("button", { name: "Save changes" }),
  },
  {
    id: "raw-button",
    fixture: "controls",
    source: ["src/components/ui/__preview__/focusRingsPreview.tsx", "Plain button"],
    locate: (_p, shot) => shot.getByRole("button", { name: "Plain button" }),
  },
  {
    id: "raw-input",
    fixture: "controls",
    source: ["src/components/ui/__preview__/focusRingsPreview.tsx", "Plain input"],
    locate: (_p, shot) => shot.getByRole("textbox", { name: "Plain input" }),
  },
  {
    id: "segmented",
    fixture: "controls",
    source: ["src/components/ui/SegmentedRadioGroup.tsx", 'role="radio"'],
    locate: (_p, shot) => shot.getByRole("radio", { name: "Light" }),
  },
  {
    id: "dock-resize-handle",
    fixture: "controls",
    source: [
      "src/components/Layout/DockPopoverResizeHandle.tsx",
      "focus-visible:-outline-offset-2",
    ],
    locate: (_p, shot) => shot.getByTestId("dock-popover-resize-handle"),
  },
  {
    id: "quick-run-toggle",
    fixture: "controls",
    source: ["src/components/Project/QuickRun.tsx", 'data-quick-run-toggle=""'],
    locate: (_p, shot) => shot.getByRole("button", { name: "Run command" }),
  },
  {
    id: "scroll-pill",
    fixture: "controls",
    source: ["src/components/ui/ScrollPill.tsx", "^<button"],
    locate: (_p, shot) => shot.getByRole("button", { name: "Scroll to bottom" }),
  },
  {
    id: "preset-color-trigger",
    fixture: "controls",
    source: [
      "src/components/Settings/PresetColorPicker.tsx",
      'data-testid="preset-color-picker-trigger"',
    ],
    locate: (_p, shot) => shot.getByTestId("preset-color-picker-trigger"),
  },
  {
    id: "preset-color-swatch",
    fixture: "controls",
    source: ["src/components/Settings/PresetColorPicker.tsx", "aria-label={`Color ${c}`}"],
    prepare: async (_p, shot) => {
      await shot.getByTestId("preset-color-picker-trigger").click();
    },
    locate: (page) =>
      page
        .getByTestId("preset-color-picker-popover")
        .getByRole("button", { name: /^Color #/ })
        .nth(1),
    clip: (page) => page.getByTestId("preset-color-picker-popover"),
  },
  {
    id: "footer-item",
    fixture: "controls",
    source: ["src/components/HelpPanel/HelpPanelFooter.tsx", 'data-footer-binding="diverged"'],
    locate: (_p, shot) => shot.locator('[data-footer-binding="diverged"]'),
  },
  {
    id: "header-chip",
    fixture: "controls",
    source: [
      "src/components/Terminal/TerminalNotifyChip.tsx",
      "<PopoverTrigger asChild>",
      "^<button",
    ],
    locate: (_p, shot) => shot.getByRole("button", { name: /Waiting on 2 terminals|notice/i }),
  },
  {
    id: "composer-control",
    fixture: "controls",
    source: ["src/components/Terminal/VoiceInputButton.tsx", "onClick={handleClick}"],
    locate: (_p, shot) => shot.getByRole("button", { name: /voice/i }),
  },
  {
    id: "filter-chip",
    fixture: "overlays",
    source: [FILTER, "aria-pressed={isActive}"],
    prepare: (page, shot) => openShotTrigger(page, shot),
    locate: (page) =>
      page
        .getByTestId("worktree-filter-popover")
        .getByRole("group", { name: "Status" })
        .getByRole("button")
        .nth(1),
    clip: (page) => page.getByTestId("worktree-filter-popover"),
  },
  {
    id: "filter-showall",
    fixture: "overlays",
    source: [FILTER, "aria-expanded={showAll}"],
    prepare: (page, shot) => openShotTrigger(page, shot),
    locate: (page) =>
      page
        .getByTestId("worktree-filter-popover")
        .getByRole("button", { name: /^\d+ (more|with no matches)$/ })
        .first(),
    clip: (page) => page.getByTestId("worktree-filter-popover"),
  },
  {
    id: "github-list-title",
    fixture: "overlays",
    source: [
      "plugins/builtin/github/renderer/components/GitHubListItem.tsx",
      "The title is the resource",
      "^<button",
    ],
    locate: (_p, shot) => shot.getByRole("button", { name: /^Chart legend overflows/ }),
  },
  {
    id: "local-commits-copy",
    fixture: "overlays",
    source: ["src/components/Layout/LocalCommitsDropdown.tsx", "aria-label={`Copy hash"],
    locate: (_p, shot) => shot.getByRole("button", { name: /^Copy hash/ }).first(),
  },
  {
    id: "env-popover-content",
    fixture: "overlays",
    source: ["src/components/Worktree/WorktreeCard/EnvironmentPopover.tsx", "<PopoverContent"],
    prepare: async (_p, shot) => {
      await shot.getByRole("button").first().click();
    },
    locate: (page) => page.getByRole("dialog", { name: /environment$/ }),
    clip: (page) => page.getByRole("dialog", { name: /environment$/ }),
  },
  {
    id: "status-dock-row",
    fixture: "overlays",
    source: ["src/components/Layout/StatusContainer.tsx", "items.map((terminal)", "^<button"],
    prepare: (page, shot) => openShotTrigger(page, shot),
    locate: (page) =>
      page.getByRole("dialog", { name: "Errored terminals" }).getByRole("button").first(),
    clip: (page) => page.getByRole("dialog", { name: "Errored terminals" }),
  },
  {
    id: "tour-chapter",
    fixture: "tour",
    source: ["src/components/Tour/TourControls.tsx", "aria-label={`Chapter ${index + 1}"],
    locate: (page) => page.getByRole("button", { name: /^Chapter 1:/ }),
  },
  {
    id: "tour-scrubber",
    fixture: "tour",
    source: ["src/components/Tour/TourControls.tsx", 'aria-label="Chapter position"'],
    locate: (page) => page.getByRole("slider", { name: "Chapter position" }),
  },
];

const ONLY = (process.env.DAINTREE_SHOT_ONLY ?? "")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);
const SELECTED = ONLY.length
  ? TARGETS.filter((t) => ONLY.includes(t.id) || ONLY.includes(t.fixture))
  : TARGETS;

interface ManifestEntry {
  siteId: string;
  source: string;
  theme: string;
  file: string;
  focus: {
    outlineStyle: string;
    outlineWidth: string;
    outlineColor: string;
    outlineOffset: string;
    boxShadow: string;
  };
}

function sourceLine(source: Target["source"]): string {
  const [file, ...needles] = source;
  const lines = readFileSync(path.join(process.cwd(), file), "utf8").split("\n");
  let index = -1;
  for (const needle of needles) {
    const matches = (line: string) =>
      needle.startsWith("^") ? line.trim().startsWith(needle.slice(1)) : line.includes(needle);
    const next = lines.findIndex((line, i) => i > index && matches(line));
    if (next === -1)
      throw new Error(`${file}: needle "${needle}" not found after line ${index + 1}`);
    index = next;
  }
  return `${file}:${index + 1}`;
}

let server: ViteDevServer | undefined;
const pageErrors: string[] = [];
let baseURL = "";

test.use({ viewport: { width: 900, height: 1000 }, deviceScaleFactor: 2 });

test.beforeAll(async () => {
  if (!ENABLED) return;
  if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });
  // In a worktree `node_modules` is a symlink out of the project root, and Vite
  // refuses to serve through it.
  const modules = realpathSync(path.join(process.cwd(), "node_modules"));
  server = await createServer({
    server: { port: 0, strictPort: false, fs: { allow: [process.cwd(), modules] } },
    logLevel: "error",
  });
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === "string") throw new Error("vite gave no TCP address");
  baseURL = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
  await server?.close();
});

async function capture(page: Page, target: Target, theme: string): Promise<ManifestEntry> {
  const label = `${target.id}--${theme}`;
  const url = `${baseURL}/focus-rings-preview.html?theme=${theme}&fixture=${target.fixture}`;
  // A cold Vite server re-optimises dependencies on first sight of a fixture's
  // imports and reloads the page mid-mount; one retry absorbs that.
  for (let attempt = 0; attempt < 2; attempt++) {
    pageErrors.length = 0;
    await page.goto(url);
    const mounted = await page
      .locator("html[data-preview-ready]")
      .waitFor({ state: "attached", timeout: 60_000 })
      .then(() => true)
      .catch(() => false);
    if (mounted) break;
  }
  await expect(
    page.locator("html[data-preview-ready]"),
    `${label}: preview never mounted — ${pageErrors.join(" | ") || "no page error"}`
  ).toBeAttached({ timeout: 60_000 });
  await page.evaluate(() => document.fonts.ready);

  const shot = page.locator(`[data-shot="${target.id}"]`);
  if (target.fixture !== "tour") {
    await expect(shot, `${label}: wrapper missing — ${pageErrors.join(" | ")}`).toBeVisible();
    await shot.scrollIntoViewIfNeeded();
  }
  if (target.prepare) {
    await target.prepare(page, shot);
    await page.waitForTimeout(350);
  }

  const el = target.locate(page, shot);
  await expect(el, `${label}: target never appeared — ${pageErrors.join(" | ")}`).toBeVisible({
    timeout: 15_000,
  });
  await el.scrollIntoViewIfNeeded();

  // Put Chromium's focus-visible heuristic in keyboard mode, then focus.
  await page.keyboard.press("Shift");
  await el.evaluate((node) => (node as HTMLElement).focus({ focusVisible: true } as FocusOptions));
  const verified = await el.evaluate(
    (node) => document.activeElement === node && node.matches(":focus-visible")
  );
  if (!verified) throw new Error(`${label}: target is not :focus-visible — refusing to write`);
  // The rings transition over 150ms.
  await page.waitForTimeout(300);

  const focus = await el.evaluate((node) => {
    const cs = getComputedStyle(node);
    return {
      outlineStyle: cs.outlineStyle,
      outlineWidth: cs.outlineWidth,
      outlineColor: cs.outlineColor,
      outlineOffset: cs.outlineOffset,
      boxShadow: cs.boxShadow,
    };
  });

  const elBox = await el.boundingBox();
  if (!elBox || elBox.width < 2 || elBox.height < 2) {
    throw new Error(`${label}: target has no real box — refusing to write`);
  }
  const frame = target.clip
    ? await target.clip(page).boundingBox()
    : target.fixture === "tour"
      ? null
      : await shot.boundingBox();
  const pad = frame ? 16 : 24;
  const base = frame ?? elBox;
  const viewport = page.viewportSize()!;
  let x0 = Math.min(base.x, elBox.x) - pad;
  let y0 = Math.min(base.y, elBox.y) - pad;
  let x1 = Math.max(base.x + base.width, elBox.x + elBox.width) + pad;
  let y1 = Math.max(base.y + base.height, elBox.y + elBox.height) + pad;
  if (!target.clip && frame) {
    // The wrapper already carries its own 24px of padding.
    x0 += pad;
    y0 += pad;
    x1 -= pad;
    y1 -= pad;
  }
  x0 = Math.max(0, x0);
  y0 = Math.max(0, y0);
  x1 = Math.min(viewport.width, x1);
  y1 = Math.min(viewport.height, y1);

  const still = await el.evaluate((node) => node.matches(":focus-visible"));
  if (!still) throw new Error(`${label}: focus moved before the capture — refusing to write`);

  const file = `${label}.png`;
  await page.screenshot({
    path: path.join(OUT_DIR, file),
    clip: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 },
  });
  return { siteId: target.id, source: sourceLine(target.source), theme, file, focus };
}

test("focus rings — every site, both themes", async ({ page }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_FOCUS_RINGS is required for the focus-ring capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_FOCUS_RINGS=1 to run the capture");

  page.on("pageerror", (error) =>
    pageErrors.push(
      `${error.message} @ ${(error.stack ?? "").split("\n").slice(1, 3).join(" <- ")}`
    )
  );
  page.on("console", (msg) => {
    if (msg.type() === "error") pageErrors.push(`console: ${msg.text().slice(0, 300)}`);
  });
  const manifest: ManifestEntry[] = [];
  const failures: string[] = [];
  for (const theme of THEMES) {
    for (const target of SELECTED) {
      try {
        manifest.push(await capture(page, target, theme));
      } catch (error) {
        failures.push(`${target.id}--${theme}: ${(error as Error).message.split("\n")[0]}`);
      }
    }
  }
  writeFileSync(path.join(OUT_DIR, "manifest.json"), JSON.stringify(manifest, null, 2));
  expect(failures, failures.join("\n")).toEqual([]);

  const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  expect(onDisk.length).toBe(manifest.length);
  expect(onDisk.length).toBe(SELECTED.length * THEMES.length);
  console.log(`[focus-rings-shots] ${onDisk.length} PNGs in ${OUT_DIR}`);
});
