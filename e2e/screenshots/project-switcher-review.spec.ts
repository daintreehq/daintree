/**
 * Project switcher visual-review harness.
 *
 * Mounts `project-switcher-preview.html` — the real `ProjectSwitcherPalette` fed
 * from fixtures — and writes one PNG per state per theme: browse, the anchored
 * dropdown, search, no match, empty, folded bands, plus the three layered states
 * a pointer opens on top of browse (a row's context menu, the Other band's sort
 * menu and a scratch's inline rename).
 *
 *   DAINTREE_SHOT_PROJECTSWITCHER=1 DAINTREE_SHOT_DIR=/abs/out \
 *     ./node_modules/.bin/playwright test --project=screenshots project-switcher-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_PROJECTSWITCHER  required — any truthy value runs the capture
 *   DAINTREE_SHOT_DIR              required — absolute output directory outside the repo
 *   DAINTREE_SHOT_THEMES           themes to sweep (default: daintree,bondi)
 *   DAINTREE_SHOT_ONLY             comma-separated state filter
 *
 * Output: <state>--<theme>.png. A frame is written only after its state is
 * verified, and the run counts the files on disk against the plan.
 */

import { test, expect, type Locator, type Page } from "@playwright/test";
import { mkdirSync, readdirSync, realpathSync, rmSync } from "fs";
import path from "path";
import {
  startPreviewServer,
  stubViteHmrClient,
  type PreviewServer,
} from "../helpers/previewHarness";

const ENABLED = !!process.env.DAINTREE_SHOT_PROJECTSWITCHER;
const OUT_DIR = path.resolve(process.env.DAINTREE_SHOT_DIR ?? "");

const parseList = (value: string | undefined, fallback: string) =>
  (value ?? fallback)
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
const THEMES = parseList(process.env.DAINTREE_SHOT_THEMES, "daintree,bondi");
const ONLY = process.env.DAINTREE_SHOT_ONLY ? parseList(process.env.DAINTREE_SHOT_ONLY, "") : null;

const PALETTE = '[role="dialog"][aria-label="Project switcher"]';

interface State {
  slug: string;
  fixture: string;
  /** Drives the page into the state and throws if it did not get there. */
  enter: (page: Page) => Promise<void>;
}

const listbox = (page: Page) => page.locator("#project-list");

const STATES: State[] = [
  {
    slug: "browse",
    fixture: "browse",
    enter: async (page) => {
      await expect(listbox(page).getByRole("option").first()).toBeVisible();
      await expect(page.getByTestId("scratch-create-button")).toBeVisible();
    },
  },
  {
    slug: "dropdown",
    fixture: "dropdown",
    enter: async (page) => {
      await expect(page.getByTestId("project-switcher-palette")).toBeVisible();
      await expect(listbox(page).getByRole("option").first()).toBeVisible();
    },
  },
  {
    slug: "search",
    fixture: "search",
    enter: async (page) => {
      await expect(listbox(page).getByRole("option")).toHaveCount(5);
    },
  },
  {
    slug: "nomatch",
    fixture: "nomatch",
    enter: async (page) => {
      await expect(page.getByTestId("project-empty-state")).toBeVisible();
    },
  },
  {
    slug: "empty",
    fixture: "empty",
    enter: async (page) => {
      await expect(page.getByTestId("project-empty-state")).toBeVisible();
    },
  },
  {
    slug: "collapsed",
    fixture: "collapsed",
    enter: async (page) => {
      await expect(page.getByTestId("band-collapse-toggle-other")).toHaveAttribute(
        "aria-expanded",
        "false"
      );
    },
  },
  {
    slug: "row-menu",
    fixture: "browse",
    enter: async (page) => {
      await listbox(page).locator("#project-option-backend").click({ button: "right" });
      await expect(page.getByRole("menu")).toBeVisible();
    },
  },
  {
    slug: "row-menu-kbd",
    fixture: "dropdown-menu",
    enter: async (page) => {
      await page.getByRole("combobox", { name: "Search workspaces" }).focus();
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Shift+F10");
      await expect(page.getByRole("menu")).toBeVisible();
    },
  },
  {
    slug: "sort-menu",
    fixture: "browse",
    enter: async (page) => {
      await page.getByTestId("other-projects-sort-trigger").click();
      await expect(page.getByRole("menu")).toBeVisible();
    },
  },
  {
    slug: "groups",
    fixture: "groups",
    enter: async (page) => {
      await expect(page.getByTestId("band-collapse-toggle-group-crisp")).toHaveAttribute(
        "aria-expanded",
        "false"
      );
      await expect(page.getByTestId("empty-group-hint")).toBeVisible();
    },
  },
  {
    slug: "groups-search",
    fixture: "groups-search",
    enter: async (page) => {
      await expect(listbox(page).getByRole("option")).toHaveCount(2);
    },
  },
  {
    slug: "group-menu",
    fixture: "groups",
    enter: async (page) => {
      await page.getByTestId("band-group-menu-group-daintree").click();
      await expect(page.getByRole("menuitem", { name: "Rename group…" })).toBeVisible();
    },
  },
  {
    slug: "move-to-group",
    fixture: "groups",
    enter: async (page) => {
      await listbox(page).locator("#project-option-strongtyped").click({ button: "right" });
      await page.getByTestId("project-move-to-group").hover();
      await expect(page.getByRole("menuitemradio", { name: "Crisp Vector" })).toBeVisible();
    },
  },
  {
    slug: "new-group",
    fixture: "new-group",
    enter: async (page) => {
      await expect(page.getByTestId("project-group-name-input")).toBeFocused();
    },
  },
  {
    slug: "scratch-rename",
    fixture: "browse",
    enter: async (page) => {
      await page.getByRole("option", { name: /Try Vite 9/ }).click({ button: "right" });
      await page.getByRole("menuitem", { name: "Rename scratch" }).click();
      await expect(page.getByTestId("scratch-rename-input")).toBeFocused();
    },
  },
];

let server: PreviewServer | undefined;

test.beforeAll(async () => {
  if (!ENABLED) return;
  if (!process.env.DAINTREE_SHOT_DIR || !path.isAbsolute(OUT_DIR)) {
    throw new Error("DAINTREE_SHOT_DIR must be an absolute directory outside the repo");
  }
  const repoRoot = realpathSync(process.cwd());
  mkdirSync(OUT_DIR, { recursive: true });
  const outReal = realpathSync(OUT_DIR);
  if (outReal === repoRoot || outReal.startsWith(repoRoot + path.sep)) {
    throw new Error(`DAINTREE_SHOT_DIR must be outside the repo (${OUT_DIR})`);
  }
  const owned = new RegExp(`^(?:${STATES.map((s) => s.slug).join("|")})--.+\\.png$`);
  for (const file of readdirSync(OUT_DIR)) {
    if (owned.test(file)) rmSync(path.join(OUT_DIR, file));
  }
  server = await startPreviewServer();
});

test.afterAll(async () => {
  await server?.close();
});

const POLISH_CSS = `
  *, *::before, *::after {
    transition-duration: 0s !important;
    transition-delay: 0s !important;
    animation-duration: 0s !important;
    animation-delay: 0s !important;
    caret-color: transparent !important;
  }
`;

async function load(page: Page, fixture: string, theme: string): Promise<void> {
  const url = `${server!.baseURL}/project-switcher-preview.html?state=${fixture}&theme=${theme}`;
  // The optimizer can re-bundle after the first page opens and reload it into a
  // blank document; one fresh navigation after a quiet wait gets past it.
  for (let attempt = 0; ; attempt++) {
    await page.goto(url, { waitUntil: "load" });
    await page.addStyleTag({ content: POLISH_CSS });
    try {
      await expect(
        page.locator(`${PALETTE}, [data-testid="project-switcher-palette"]`)
      ).toBeVisible({ timeout: 15_000 });
      break;
    } catch (error) {
      if (attempt >= 2) throw error;
      await page.waitForTimeout(2_000); // e2e-wait: ok — optimizer re-bundle settle
    }
  }
  await page.mouse.move(2, 2);
}

/** Union of the palette and any menu layered on it, padded. */
async function frame(page: Page): Promise<{ x: number; y: number; width: number; height: number }> {
  const targets: Locator[] = [
    page.locator(PALETTE),
    page.getByTestId("project-switcher-palette"),
    page.getByRole("menu"),
    page.getByRole("alertdialog"),
    page.locator('[role="dialog"]:not([aria-label="Project switcher"])'),
  ];
  const boxes = [];
  for (const target of targets) {
    for (const el of await target.all()) {
      if (!(await el.isVisible())) continue;
      const box = await el.boundingBox();
      if (box && box.width > 8 && box.height > 8) boxes.push(box);
    }
  }
  if (boxes.length === 0) throw new Error("no palette box — refusing to write");
  const pad = 16;
  const vp = page.viewportSize()!;
  const x = Math.max(0, Math.min(...boxes.map((b) => b.x)) - pad);
  const y = Math.max(0, Math.min(...boxes.map((b) => b.y)) - pad);
  const right = Math.min(vp.width, Math.max(...boxes.map((b) => b.x + b.width)) + pad);
  const bottom = Math.min(vp.height, Math.max(...boxes.map((b) => b.y + b.height)) + pad);
  return { x, y, width: right - x, height: bottom - y };
}

test("project switcher — every state", async ({ page }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_PROJECTSWITCHER is required for the project switcher capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_PROJECTSWITCHER=1 to run the capture");
  test.setTimeout(900_000);

  await stubViteHmrClient(page);
  await page.setViewportSize({ width: 1280, height: 1000 });
  page.setDefaultTimeout(30_000);
  page.on("pageerror", (error) => console.log(`[project-switcher] pageerror: ${error.message}`));

  const states = STATES.filter((s) => !ONLY || ONLY.includes(s.slug));
  const written: string[] = [];

  for (const theme of THEMES) {
    for (const state of states) {
      await load(page, state.fixture, theme);
      await state.enter(page);
      await page.waitForTimeout(150); // e2e-wait: ok — layered menu settle
      const out = path.join(OUT_DIR, `${state.slug}--${theme}.png`);
      await page.screenshot({ path: out, clip: await frame(page) });
      written.push(out);
    }
  }

  const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  const expected = states.length * THEMES.length;
  const missing = written.filter((f) => !onDisk.includes(path.basename(f)));
  if (written.length !== expected || missing.length > 0) {
    throw new Error(`wrote ${written.length}/${expected}, missing ${missing.join(", ")}`);
  }
});
