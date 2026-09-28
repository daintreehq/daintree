/**
 * Highlighted-row language, across every list family.
 *
 * The app marks "the row Enter (or a click) will act on" in palettes, pickers,
 * the composer's autocomplete and Radix menus. Those families drifted: some drew
 * a fill, some a fill plus a leading rail, and some let the pointer paint a
 * second, lighter row beside the keyboard cursor. The only way to judge whether
 * they now speak one language is to put the same three interactions through all
 * of them in one sweep:
 *
 *   kbd            pointer parked off the list, cursor moved with the arrow keys
 *   pointer        pointer resting on a row further down
 *   pointer-kbd    pointer still resting there, then one arrow press — the frame
 *                  where a list that tracks hover separately lights two rows
 *   contrast       the pointer state under `prefers-contrast: more` (first theme only)
 *   forced         the pointer state under `forced-colors: active` (first theme only)
 *
 * Every surface is the real component in its existing `*-preview.html` entry,
 * except the project switcher and the plain dropdown menu, which live in
 * `row-highlight-preview.html`.
 *
 *   DAINTREE_SHOT_ROWHIGHLIGHT=1 DAINTREE_SHOT_DIR=/abs/out \
 *     ./node_modules/.bin/playwright test --project=screenshots row-highlight-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_ROWHIGHLIGHT  required — any truthy value runs the capture
 *   DAINTREE_SHOT_DIR           required — absolute output directory outside the repo
 *   DAINTREE_SHOT_THEMES        themes to sweep (default: daintree,bondi)
 *   DAINTREE_SHOT_ONLY          comma-separated surface filter
 *
 * Output: <surface>--<state>--<theme>.png plus a <same>.json sidecar naming the
 * rows that carry the highlight fill. A frame is written only after its state is
 * verified, and the run counts the files on disk against the plan.
 */

import { test, expect, type Locator, type Page } from "@playwright/test";
import { mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync } from "fs";
import path from "path";
import {
  startPreviewServer,
  stubViteHmrClient,
  type PreviewServer,
} from "../helpers/previewHarness";

const ENABLED = !!process.env.DAINTREE_SHOT_ROWHIGHLIGHT;
const OUT_DIR = path.resolve(process.env.DAINTREE_SHOT_DIR ?? "");

const parseList = (value: string | undefined, fallback: string) =>
  (value ?? fallback)
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
const THEMES = parseList(process.env.DAINTREE_SHOT_THEMES, "daintree,bondi");
const ONLY = process.env.DAINTREE_SHOT_ONLY ? parseList(process.env.DAINTREE_SHOT_ONLY, "") : null;

interface Surface {
  slug: string;
  url: (theme: string) => string;
  /** Brings the list up and returns the element that holds its rows. */
  open: (page: Page) => Promise<Locator>;
  /** The row selector inside the list. */
  row: string;
  /** Which row index the pointer rests on. */
  pointerRow: number;
  /** False where the preview pins the cursor from a fixture, so arrows cannot move it. */
  arrows: boolean;
}

const listbox = (page: Page) => page.getByRole("listbox").first();

const SURFACES: Surface[] = [
  {
    slug: "subject-picker",
    url: (t) => `/settings-subject-picker-preview.html?page=agents&subject=general&theme=${t}`,
    open: async (page) => {
      await page.locator("[data-preview-frame] button[aria-haspopup]").first().click();
      await expect(listbox(page)).toBeVisible();
      return listbox(page);
    },
    row: '[role="option"]',
    pointerRow: 3,
    arrows: true,
  },
  {
    slug: "autocomplete",
    url: (t) => `/autocomplete-menu-preview.html?case=commands-run&theme=${t}`,
    open: async (page) => {
      await expect(listbox(page)).toBeVisible();
      return listbox(page);
    },
    row: '[role="option"]',
    pointerRow: 2,
    arrows: false,
  },
  {
    slug: "resume-sessions",
    url: (t) => `/resume-sessions-preview.html?fixture=populated&theme=${t}`,
    open: async (page) => {
      const dialog = page.locator('[role="dialog"][aria-label="Resume session"]');
      await expect(dialog.getByRole("option").first()).toBeVisible();
      return dialog;
    },
    row: '[role="option"]',
    pointerRow: 2,
    arrows: true,
  },
  {
    slug: "command-picker",
    url: (t) => `/command-picker-preview.html?theme=${t}`,
    open: async (page) => {
      const dialog = page.locator('[role="dialog"][aria-label="Command picker"]');
      await expect(dialog.locator("[data-command-id]").first()).toBeVisible();
      return dialog;
    },
    // Command rows only: the category band labels are inert options too.
    row: '[role="option"][data-command-id]',
    pointerRow: 1,
    arrows: true,
  },
  {
    slug: "launcher",
    url: (t) => `/launcher-preview.html?theme=${t}`,
    open: async (page) => {
      await page.locator('[data-preview-toolbar] button[aria-label^="Launcher"]').click();
      await expect
        .poll(() => page.locator('[role="option"]').count(), { timeout: 8000 })
        .toBeGreaterThan(3);
      return listbox(page);
    },
    row: '[role="option"]',
    pointerRow: 3,
    arrows: true,
  },
  {
    slug: "project-switcher",
    url: (t) => `/row-highlight-preview.html?surface=project-switcher&theme=${t}`,
    open: async (page) => {
      await expect(listbox(page).getByRole("option").first()).toBeVisible();
      return listbox(page);
    },
    row: '[role="option"]',
    pointerRow: 3,
    arrows: true,
  },
  {
    slug: "menu",
    url: (t) => `/row-highlight-preview.html?surface=menu&theme=${t}`,
    open: async (page) => {
      const menu = page.getByRole("menu");
      await expect(menu).toBeVisible();
      return menu;
    },
    row: '[role="menuitem"]',
    pointerRow: 3,
    arrows: true,
  },
];

test.use({ deviceScaleFactor: 2, viewport: { width: 1100, height: 820 } });

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
  // Only this harness's own frames and sidecars — a shared review directory can
  // hold other captures that must survive a re-run.
  const owned = new RegExp(`^(?:${SURFACES.map((s) => s.slug).join("|")})--.+\\.(?:png|json)$`);
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
    caret-color: transparent !important;
  }
`;

async function load(page: Page, surface: Surface, theme: string): Promise<Locator> {
  const url = `${server!.baseURL}${surface.url(theme)}`;
  // The optimizer can re-bundle after the first page opens and reload it into a
  // blank document; one fresh navigation after a quiet wait gets past it.
  for (let attempt = 0; ; attempt++) {
    console.log(`[row-highlight] load ${surface.slug} ${theme} attempt ${attempt}`);
    await page.goto(url, { waitUntil: "load" });
    try {
      await page.addStyleTag({ content: POLISH_CSS });
      await page.evaluate(() => document.fonts.ready);
      await page.mouse.move(1, 1);
      const list = await surface.open(page);
      await page.waitForTimeout(300);
      return list;
    } catch (error) {
      console.log(`[row-highlight] ${surface.slug}: ${String(error).split("\n")[0]}`);
      if (attempt >= 2) throw error;
      await page.waitForTimeout(1500);
    }
  }
}

/**
 * The rows that currently paint a background — the thing the owner sees as
 * "highlighted" — read from computed style rather than from attributes, so a
 * CSS `:hover` fill counts even though no attribute says it is there.
 */
async function litRows(list: Locator, rowSelector: string) {
  return list.evaluate((root, sel) => {
    // An outline painted in the surface's own colour is a layout reservation,
    // not a mark — forced colours uses exactly that to hide one.
    const probe = document.createElement("div");
    probe.style.color = "Canvas";
    document.body.appendChild(probe);
    const canvas = getComputedStyle(probe).color;
    probe.remove();
    const rows = Array.from(root.querySelectorAll<HTMLElement>(sel));
    return rows
      .map((row, index) => {
        const bg = getComputedStyle(row).backgroundColor;
        const before = getComputedStyle(row, "::before");
        const rail =
          before.content !== "none" &&
          before.content !== "normal" &&
          Number(before.opacity) > 0 &&
          before.backgroundColor !== "rgba(0, 0, 0, 0)" &&
          parseFloat(before.width) > 0;
        const style = getComputedStyle(row);
        const outline =
          style.outlineStyle !== "none" &&
          parseFloat(style.outlineWidth) > 0 &&
          style.outlineColor !== canvas &&
          style.outlineColor !== "rgba(0, 0, 0, 0)"
            ? `${style.outlineWidth} ${style.outlineColor}`
            : null;
        return {
          index,
          text: (row.textContent ?? "").trim().slice(0, 40),
          bg,
          rail,
          outline,
          selected:
            row.getAttribute("aria-selected") === "true" || row.hasAttribute("data-highlighted"),
        };
      })
      .filter(
        (r) => (r.bg !== "rgba(0, 0, 0, 0)" && r.bg !== "transparent") || r.rail || r.outline
      );
  }, rowSelector);
}

async function shoot(
  page: Page,
  list: Locator,
  surface: Surface,
  state: string,
  theme: string,
  written: string[]
): Promise<void> {
  const box = await list.boundingBox();
  if (!box || box.width < 80 || box.height < 40) {
    throw new Error(`${surface.slug}/${state}: list has no real box — refusing to write`);
  }
  const lit = await litRows(list, surface.row);
  if (lit.length === 0) {
    throw new Error(`${surface.slug}/${state}: no row is highlighted — refusing to write`);
  }
  const pad = 20;
  const vp = page.viewportSize()!;
  const x = Math.max(0, box.x - pad);
  const y = Math.max(0, box.y - pad);
  const clip = {
    x,
    y,
    width: Math.min(vp.width - x, box.width + pad * 2),
    height: Math.min(vp.height - y, Math.min(box.height, 520) + pad * 2),
  };
  const base = `${surface.slug}--${state}--${theme}`;
  const out = path.join(OUT_DIR, `${base}.png`);
  await page.screenshot({ path: out, clip });
  writeFileSync(path.join(OUT_DIR, `${base}.json`), JSON.stringify({ lit }, null, 2));
  written.push(out);
}

async function restPointerOn(page: Page, list: Locator, surface: Surface): Promise<void> {
  const target = list.locator(surface.row).nth(surface.pointerRow);
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  if (!box) throw new Error(`${surface.slug}: pointer row ${surface.pointerRow} has no box`);
  // Two moves so a pointermove (not only a pointerenter) reaches the row.
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 - 2);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(150);
}

test("highlighted-row language — every list family", async ({ page }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_ROWHIGHLIGHT is required for the row highlight capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_ROWHIGHLIGHT=1 to run the capture");
  test.setTimeout(1_500_000);

  await stubViteHmrClient(page);
  page.setDefaultTimeout(30_000);
  page.setDefaultNavigationTimeout(60_000);
  page.on("pageerror", (error) => console.log(`[row-highlight] pageerror: ${error.message}`));

  const surfaces = SURFACES.filter((s) => !ONLY || ONLY.includes(s.slug));
  const written: string[] = [];
  let planned = 0;

  for (const surface of surfaces) {
    await load(page, surface, THEMES[0]!);
  }

  for (const theme of THEMES) {
    for (const surface of surfaces) {
      let list = await load(page, surface, theme);
      if (surface.arrows) {
        await page.keyboard.press("ArrowDown");
        await page.keyboard.press("ArrowDown");
        await page.waitForTimeout(150);
      }
      await shoot(page, list, surface, "kbd", theme, written);

      list = await load(page, surface, theme);
      await restPointerOn(page, list, surface);
      await shoot(page, list, surface, "pointer", theme, written);

      if (surface.arrows) {
        await page.keyboard.press("ArrowDown");
        await page.waitForTimeout(150);
      }
      await shoot(page, list, surface, "pointer-kbd", theme, written);
      planned += 3;
    }
  }

  // The two increased-contrast modes, where the highlight stops being a fill
  // alone and gains an outline. One theme is enough: the modes, not the
  // palettes, are what is under test.
  for (const [state, media] of [
    ["contrast", { contrast: "more" }],
    ["forced", { forcedColors: "active" }],
  ] as const) {
    await page.emulateMedia(media);
    for (const surface of surfaces) {
      const list = await load(page, surface, THEMES[0]!);
      await restPointerOn(page, list, surface);
      // Exactly one outlined row, and it is the highlighted one. Written to
      // the sidecar either way, but a frame that outlines the wrong rows (or
      // every row) is refused rather than captured as if it were the design.
      const lit = await litRows(list, surface.row);
      const outlined = lit.filter((r) => r.outline);
      if (outlined.length !== 1 || !outlined[0]!.selected) {
        throw new Error(
          `${surface.slug}/${state}: expected only the highlighted row outlined, got ${JSON.stringify(outlined.map((r) => r.text))}`
        );
      }
      await shoot(page, list, surface, state, THEMES[0]!, written);
      planned += 1;
    }
    await page.emulateMedia({ contrast: null, forcedColors: null });
  }

  const onDisk = readdirSync(OUT_DIR).filter(
    (f) => f.endsWith(".png") && surfaces.some((s) => f.startsWith(`${s.slug}--`))
  );
  expect(written.length).toBe(planned);
  expect(onDisk.length).toBe(planned);
  console.log(`[row-highlight] ${onDisk.length} PNGs in ${OUT_DIR}`);
});
