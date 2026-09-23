/**
 * Collapsed worktree row — alarm pill visual-review harness.
 *
 * The pill is a 10px glyph in a toned wash on a one-line row, so almost every
 * judgement about it is a pixel judgement: whether the three silhouettes read
 * apart at size, whether the amber wash survives a light theme, what is left
 * once forced colours take the wash away. This drives the preview entry
 * (`worktree-alarm-pill-preview.html`), which mounts the REAL collapsed
 * `WorktreeHeader` — the alarm is derived by the header from worktree fields,
 * exactly as in the app — beside `CollapsedSessionIndicators` and the row
 * toolbar, under the real theme tokens.
 *
 * Opt-in only, like every sibling review harness:
 *
 *   DAINTREE_SHOT_ALARM_PILL=1 npx playwright test --project=screenshots worktree-alarm-pill-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_ALARM_PILL  required — any truthy value runs the capture
 *   DAINTREE_SHOT_DIR         output directory (default artifacts/alarm-pill-shots)
 *   DAINTREE_SHOT_THEMES      comma-separated theme sweep (default: every built-in)
 *
 * Never writes a PNG it has not verified: `snap()` asserts a real box, the
 * tooltip shots assert the tooltip's text, and the test counts the files itself.
 */

import { test, expect, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "fs";
import path from "path";
import { startPreviewServer, stubViteHmrClient, makeSnap } from "../helpers/previewHarness";

// 2x, so a 10px glyph can be judged as a shape rather than a smudge.
test.use({ deviceScaleFactor: 2 });

const ENABLED = !!process.env.DAINTREE_SHOT_ALARM_PILL;

const OUT_DIR = path.resolve(
  process.env.DAINTREE_SHOT_DIR ?? path.join(process.cwd(), "artifacts", "alarm-pill-shots")
);

/**
 * Every built-in theme. Copied rather than imported from the card harness:
 * importing a spec file registers its test in this run too.
 */
const ALL_THEMES = [
  "arashiyama",
  "atacama",
  "bali",
  "bondi",
  "daintree",
  "fiordland",
  "galapagos",
  "highlands",
  "hokkaido",
  "movile",
  "namib",
  "redwoods",
  "serengeti",
  "svalbard",
  "table-mountain",
];

const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? ALL_THEMES.join(","))
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

/** One dark and one light theme carry the per-state shots. */
const FOCUS_THEMES = ["daintree", "bondi"];

/** Mirrors the rows in the preview entry, which cannot be imported under Node. */
const TOOLTIP_ROWS = [
  { row: "behind", text: "Behind" },
  { row: "auth-failed", text: "Auth failed" },
  { row: "ci-failed", text: "CI failed" },
] as const;

let server: Awaited<ReturnType<typeof startPreviewServer>> | undefined;
let baseURL = "";
let snap: ReturnType<typeof makeSnap>;

test.beforeAll(async () => {
  if (!ENABLED) return;
  if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });
  server = await startPreviewServer();
  baseURL = server.baseURL;
  snap = makeSnap(OUT_DIR);
});

test.afterAll(async () => {
  await server?.close();
});

async function open(
  page: Page,
  fixture: "list" | "matrix",
  theme: string,
  opts: { width?: number; reveal?: string } = {}
) {
  await stubViteHmrClient(page);
  await page.setViewportSize({ width: 520, height: 420 });
  const q = new URLSearchParams({ theme, fixture });
  if (opts.width) q.set("width", String(opts.width));
  if (opts.reveal) q.set("reveal", opts.reveal);
  // The pointer survives navigation; park it so a previous hover does not ride in.
  await page.mouse.move(0, 0);
  await page.goto(`${baseURL}/worktree-alarm-pill-preview.html?${q}`);
  const card = page.locator("[data-preview-card]");
  await expect(card, `fixture "${fixture}" rendered nothing`).toBeVisible();
  // Six alarmed rows in the list (the quiet row has none), six cells in the matrix.
  await expect(page.getByTestId("collapsed-alarm-pill")).toHaveCount(6);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(250);
  return card;
}

interface ContrastRow {
  theme: string;
  kind: string;
  active: boolean;
  glyphOnWash: number;
  glyphOnRow: number;
  washOnRow: number;
}

/**
 * Composite every ancestor's background onto a 1x1 canvas, in paint order, and
 * read back the pixel — the one method that handles `color-mix()`, `oklab()`
 * and alpha without re-implementing CSS colour. Then WCAG relative luminance.
 */
async function measureContrast(page: Page, theme: string): Promise<ContrastRow[]> {
  const rows = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    const paint = (colors: string[]) => {
      ctx.globalCompositeOperation = "source-over";
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, 1, 1);
      for (const c of colors) {
        ctx.fillStyle = c;
        ctx.fillRect(0, 0, 1, 1);
      }
      const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
      return [r!, g!, b!] as const;
    };
    const lum = ([r, g, b]: readonly number[]) => {
      const f = (v: number) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * f(r!) + 0.7152 * f(g!) + 0.0722 * f(b!);
    };
    const ratio = (a: readonly number[], b: readonly number[]) => {
      const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
      return Math.round(((hi! + 0.05) / (lo! + 0.05)) * 100) / 100;
    };
    const backgrounds = (el: Element) => {
      const stack: string[] = [];
      for (let n: Element | null = el; n; n = n.parentElement) {
        stack.unshift(getComputedStyle(n).backgroundColor);
      }
      return stack;
    };
    return Array.from(document.querySelectorAll('[data-testid="collapsed-alarm-pill"]')).map(
      (pill) => {
        const row = pill.closest("[data-preview-row]")!;
        const washStack = backgrounds(pill);
        const rowStack = backgrounds(row);
        const glyph = paint([...washStack, getComputedStyle(pill.querySelector("svg")!).color]);
        const wash = paint(washStack);
        const rowBg = paint(rowStack);
        return {
          kind: pill.getAttribute("data-alarm-kind") ?? "",
          active: row.getAttribute("data-active") === "true",
          glyphOnWash: ratio(glyph, wash),
          glyphOnRow: ratio(glyph, rowBg),
          washOnRow: ratio(wash, rowBg),
        };
      }
    );
  });
  return rows.map((r) => ({ theme, ...r }));
}

test("Collapsed worktree row alarm pill — kinds, tones, modes and themes", async ({ page }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_ALARM_PILL is required for the alarm pill capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_ALARM_PILL=1 to run the capture");

  const written: string[] = [];
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));

  // Theme sweep: the row list and the kind x tone matrix in every theme, plus
  // the glyph's measured contrast against its wash and against the row. A 10px
  // stroke's anti-aliasing makes a pixel sample of the PNG meaningless, so the
  // numbers come from the painted colours instead.
  const contrast: ContrastRow[] = [];
  for (const theme of THEMES) {
    written.push(await snap(await open(page, "list", theme), `list-${theme}.png`));
    contrast.push(...(await measureContrast(page, theme)));
    written.push(await snap(await open(page, "matrix", theme), `matrix-${theme}.png`));
  }
  writeFileSync(path.join(OUT_DIR, "contrast.json"), JSON.stringify(contrast, null, 2));

  for (const theme of FOCUS_THEMES) {
    // Tooltip open on each kind. The tooltip is portaled, so the frame is the
    // viewport; its text is asserted before anything is written.
    for (const { row, text } of TOOLTIP_ROWS) {
      await open(page, "list", theme);
      const pill = page.locator(`[data-preview-row="${row}"]`).getByTestId("collapsed-alarm-pill");
      await pill.hover();
      const tip = page.getByRole("tooltip");
      await expect(tip, `${row}: tooltip never opened`).toContainText(text);
      await page.waitForTimeout(150);
      const file = `tooltip-${row}-${theme}.png`;
      await page.screenshot({ path: path.join(OUT_DIR, file) });
      written.push(file);
    }

    // Keyboard reveal: the row's select button has focus-visible, so the
    // tooltip opens with the pointer nowhere near the mark. The pointer is
    // parked at the origin by `open()`, so an open tooltip here can only have
    // come from the reveal.
    for (const { row, text } of TOOLTIP_ROWS) {
      await open(page, "list", theme, { reveal: row });
      await expect(page.getByRole("tooltip"), `${row}: keyboard reveal never opened`).toContainText(
        text
      );
      await page.waitForTimeout(150);
      const file = `reveal-${row}-${theme}.png`;
      await page.screenshot({ path: path.join(OUT_DIR, file) });
      written.push(file);
    }

    // The narrowest sidebar, where the pill competes with truncation.
    written.push(
      await snap(await open(page, "list", theme, { width: 240 }), `list-${theme}-narrow.png`)
    );

    // prefers-contrast: more (the macOS half) and forced-colors (the Windows half).
    await page.emulateMedia({ contrast: "more" });
    written.push(await snap(await open(page, "list", theme), `list-${theme}-contrast-more.png`));
    written.push(
      await snap(await open(page, "matrix", theme), `matrix-${theme}-contrast-more.png`)
    );
    await page.emulateMedia({ contrast: "no-preference", forcedColors: "active" });
    written.push(await snap(await open(page, "list", theme), `list-${theme}-forced-colors.png`));
    written.push(
      await snap(await open(page, "matrix", theme), `matrix-${theme}-forced-colors.png`)
    );
    await page.emulateMedia({ forcedColors: "none" });
  }

  expect(pageErrors, `preview page threw: ${pageErrors.join(" | ")}`).toEqual([]);

  const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  expect(onDisk.length).toBe(written.length);
  console.log(`[alarm-pill-shots] ${onDisk.length} PNGs in ${OUT_DIR}`);
});
