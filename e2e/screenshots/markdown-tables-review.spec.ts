/**
 * Markdown tables visual-review harness.
 *
 * GFM tables are rendered by one shared pipeline for the file pane, the file
 * browser, the rendered diff and plugin views, and the case that decides the
 * design is a technical table wider than the pane: eight columns of
 * identifiers that cannot wrap beside a description that can. Whether that
 * table scrolls on its own, squeezes, or drags the whole document sideways is
 * only visible at real widths, so this drives the preview entry
 * (`markdown-tables-preview.html`) rather than booting Electron: the real
 * `MarkdownViewer`, `RenderedMarkdownDiff` and plugin-kit `Markdown`, the real
 * theme tokens and `index.css`.
 *
 * Opt-in only, like every sibling review harness:
 *
 *   DAINTREE_SHOT_MDTABLES=1 npx playwright test --project=screenshots markdown-tables-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_MDTABLES  required — any truthy value runs the capture
 *   DAINTREE_SHOT_DIR       output directory (default artifacts/markdown-tables-shots)
 *   DAINTREE_SHOT_THEMES    comma-separated themes for the main states (default: daintree,bondi)
 *   DAINTREE_SHOT_SWEEP     comma-separated themes for the scrolled-middle sweep
 *                           (default: a spread of both polarities; "" skips it)
 *
 * Hard rule, inherited from the siblings: never write a PNG that has not been
 * verified. `snap()` asserts the target has a real box before it writes, and
 * the test counts the files itself at the end rather than trusting the exit
 * code.
 */

import { test, expect, type Locator, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync } from "fs";
import path from "path";
import { createServer, searchForWorkspaceRoot, type ViteDevServer } from "vite";

const ENABLED = !!process.env.DAINTREE_SHOT_MDTABLES;

/** A maximized pane, where the reading measure caps the column at 48rem. */
const WIDE_WIDTH = 1100;
/** A pane in a three-way split: the pressure case for any table. */
const NARROW_WIDTH = 440;
const DIFF_WIDTH = 900;
const DIFF_NARROW_WIDTH = 520;

const OUT_DIR = path.resolve(
  process.env.DAINTREE_SHOT_DIR ?? path.join(process.cwd(), "artifacts", "markdown-tables-shots")
);

const list = (value: string) =>
  value
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);

const THEMES = list(process.env.DAINTREE_SHOT_THEMES ?? "daintree,bondi");
const SWEEP = list(
  process.env.DAINTREE_SHOT_SWEEP ??
    "daintree,namib,redwoods,highlands,svalbard,bondi,serengeti,hokkaido,table-mountain"
);

let server: ViteDevServer | undefined;
let baseURL = "";

test.beforeAll(async () => {
  // No test.skip here: `test.info()` is unavailable in a beforeAll hook, so the
  // structured-skip annotation the repo requires cannot be attached. The test
  // body carries the skip; this hook simply does no work when the flag is unset.
  if (!ENABLED) return;
  // Fresh directory per run: a leftover PNG from an earlier round read as this
  // round's output is the easiest way to review a screen that no longer exists.
  if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(path.join(OUT_DIR, "sweep"), { recursive: true });

  // `strictPort: false`: the app's own vite config sets `strictPort: true`, which
  // would otherwise win over `port: 0` and kill the harness while the app runs.
  // `fs.allow` adds the real install: a worktree's node_modules is a symlink
  // into the main checkout, outside Vite's default allow list, and without it
  // the mono font 403s and every code cell is measured in the fallback face.
  server = await createServer({
    server: {
      port: 0,
      strictPort: false,
      fs: {
        allow: [searchForWorkspaceRoot(process.cwd()), realpathSync("node_modules")],
      },
    },
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

/** Write one PNG, having proved there is something to write. */
async function snap(target: Locator, file: string): Promise<string> {
  await expect(target).toBeAttached();
  const box = await target.boundingBox();
  if (!box || box.width < 8 || box.height < 8) {
    throw new Error(`${file}: target has no real box (${JSON.stringify(box)}) — refusing to write`);
  }
  const out = path.join(OUT_DIR, file);
  await target.screenshot({ path: out });
  return out;
}

async function settle(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
  );
  // Long enough for a 150ms state transition to finish painting.
  await page.waitForTimeout(250);
}

/** Load one surface in one theme at one pane width, and settle it. */
async function open(
  page: Page,
  surface: "file" | "diff" | "diff-command" | "plugin",
  theme: string,
  width: number,
  height: number
): Promise<Locator> {
  await page.setViewportSize({ width, height });
  await page.goto(
    `${baseURL}/markdown-tables-preview.html?theme=${theme}&surface=${surface}&width=${width}`
  );
  const shell = page.locator("[data-preview-shell]").first();
  await expect(shell).toBeAttached();
  // The document is a lazy chunk and the diff can decline to render at all;
  // either way a capture without a table in it is a broken harness, not a state.
  await expect(
    page.locator("[data-preview-body] table").first(),
    `${surface} rendered no table`
  ).toBeAttached();
  // Table layout is all type metrics, so a capture before the fonts land
  // measures the fallback face.
  await page.evaluate(() => document.fonts.ready);
  await settle(page);
  return shell;
}

/**
 * Scroll the widest table to a fraction of its overflow, through whichever
 * element actually scrolls it — its own container when there is one, the whole
 * pane when the table is allowed to push the document sideways. Returns what
 * moved, so the metrics say which of the two happened.
 */
async function scrollWidest(page: Page, fraction: number): Promise<string> {
  const moved = await page.evaluate((f) => {
    const tables = [...document.querySelectorAll<HTMLTableElement>("[data-preview-body] table")];
    const widest = tables.reduce((a, b) =>
      b.querySelectorAll("th").length > a.querySelectorAll("th").length ? b : a
    );
    let el: HTMLElement | null = widest;
    while (el) {
      const overflowX = getComputedStyle(el).overflowX;
      if ((overflowX === "auto" || overflowX === "scroll") && el.scrollWidth > el.clientWidth + 1) {
        break;
      }
      el = el.parentElement;
    }
    if (!el) return "nothing (no horizontal overflow)";
    el.scrollLeft = Math.round(f * (el.scrollWidth - el.clientWidth));
    widest.scrollIntoView({ block: "nearest", inline: "nearest" });
    return el.hasAttribute("data-preview-body")
      ? "the whole pane"
      : `.${el.className.split(" ")[0]}`;
  }, fraction);
  await settle(page);
  return moved;
}

/** Bring the widest table into view vertically without touching its horizontal scroll. */
async function revealWidest(page: Page): Promise<void> {
  await page.evaluate(() => {
    const body = document.querySelector<HTMLElement>("[data-preview-body]");
    const tables = [...document.querySelectorAll<HTMLTableElement>("[data-preview-body] table")];
    const widest = tables.reduce((a, b) =>
      b.querySelectorAll("th").length > a.querySelectorAll("th").length ? b : a
    );
    if (!body) return;
    const top = widest.getBoundingClientRect().top - body.getBoundingClientRect().top;
    body.scrollTop += top - 120;
  });
  await settle(page);
}

interface Metrics {
  file: string;
  paneScrollWidth: number;
  paneClientWidth: number;
  tables: Array<{
    columns: number;
    tableWidth: number;
    containerWidth: number;
    narrowestCell: number;
    region: string | null;
    tabIndex: string | null;
    label: string | null;
  }>;
  activeElement: string;
}

async function measure(page: Page, file: string): Promise<Metrics> {
  return page.evaluate((name) => {
    const body = document.querySelector<HTMLElement>("[data-preview-body]")!;
    const tables = [...document.querySelectorAll<HTMLTableElement>("[data-preview-body] table")];
    const active = document.activeElement;
    return {
      file: name,
      paneScrollWidth: body.scrollWidth,
      paneClientWidth: body.clientWidth,
      tables: tables.map((table) => {
        const container = table.parentElement!;
        const cells = [...table.querySelectorAll<HTMLElement>("td")];
        return {
          columns: table.querySelectorAll("th").length,
          tableWidth: Math.round(table.getBoundingClientRect().width),
          containerWidth: Math.round(container.getBoundingClientRect().width),
          narrowestCell: Math.round(Math.min(...cells.map((c) => c.getBoundingClientRect().width))),
          region: container.getAttribute("role"),
          tabIndex: container.getAttribute("tabindex"),
          label: container.getAttribute("aria-label"),
        };
      }),
      activeElement: active
        ? `${active.tagName.toLowerCase()}${active.getAttribute("role") ? `[role=${active.getAttribute("role")}]` : ""}${active.getAttribute("aria-label") ? ` "${active.getAttribute("aria-label")}"` : ""}`
        : "none",
    };
  }, file);
}

test("Markdown tables — widths, scroll positions, focus, consumers and themes", async ({
  page,
}) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_MDTABLES is required for the Markdown tables capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_MDTABLES=1 to run the capture");

  const written: string[] = [];
  const metrics: Array<Metrics & { scrolled?: string }> = [];
  const shoot = async (target: Locator, file: string, scrolled?: string) => {
    written.push(await snap(target, file));
    metrics.push({ ...(await measure(page, file)), scrolled });
  };

  for (const theme of THEMES) {
    // Maximized: the reading measure holds the column at 48rem, so the small
    // table fits and the wide one cannot.
    await shoot(await open(page, "file", theme, WIDE_WIDTH, 1000), `file-wide-${theme}.png`);

    // A three-way split, both tables in view, nothing scrolled.
    await shoot(await open(page, "file", theme, NARROW_WIDTH, 1400), `file-narrow-${theme}.png`);

    const diff = await open(page, "diff", theme, DIFF_WIDTH, 1000);
    await revealWidest(page);
    await shoot(diff, `diff-${theme}.png`);

    await shoot(await open(page, "plugin", theme, NARROW_WIDTH, 520), `plugin-narrow-${theme}.png`);
  }

  // Scroll positions, focus and the narrow diff: layout questions, asked once
  // in the default theme.
  {
    const theme = THEMES[0]!;
    let shell = await open(page, "file", theme, NARROW_WIDTH, 900);
    await revealWidest(page);
    let moved = await scrollWidest(page, 0.5);
    await shoot(shell, `file-narrow-middle-${theme}.png`, moved);
    moved = await scrollWidest(page, 1);
    await shoot(shell, `file-narrow-end-${theme}.png`, moved);

    // Keyboard: Tab from the top of the document until focus reaches the wide
    // table's scroll region, or give up and photograph wherever it went.
    shell = await open(page, "file", theme, NARROW_WIDTH, 900);
    await page.locator("[data-preview-body]").evaluate((el) => {
      el.setAttribute("tabindex", "-1");
      el.focus();
    });
    let reached = "";
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press("Tab");
      reached = await page.evaluate(() => {
        const active = document.activeElement as HTMLElement | null;
        if (!active || !active.closest("[data-preview-body]")) return "";
        return active.querySelector("th:nth-child(8)") ? "wide-region" : active.tagName;
      });
      if (reached === "wide-region") break;
    }
    await settle(page);
    // Arrow keys are what the tab stop is for; one press proves it scrolls.
    if (reached === "wide-region") {
      await page.keyboard.press("ArrowRight");
      await page.keyboard.press("ArrowRight");
      await settle(page);
    }
    await shoot(shell, `file-narrow-focus-${theme}.png`, `focus reached: ${reached || "nothing"}`);

    const diffNarrow = await open(page, "diff", theme, DIFF_NARROW_WIDTH, 900);
    await revealWidest(page);
    await shoot(diffNarrow, `diff-narrow-${theme}.png`);

    // A change deep inside a code cell wider than the pane: the pair has to
    // open on the changed argument, not on the start of its cell.
    await shoot(
      await open(page, "diff-command", theme, NARROW_WIDTH, 520),
      `diff-command-narrow-${theme}.png`
    );
  }

  // One state across both polarities: the scrolled-middle table, where every
  // edge cue is showing at once. Tiled into a sheet afterwards.
  for (const theme of SWEEP) {
    const shell = await open(page, "file", theme, NARROW_WIDTH, 900);
    await revealWidest(page);
    await scrollWidest(page, 0.5);
    written.push(await snap(shell, path.join("sweep", `${theme}.png`)));
  }

  writeFileSync(path.join(OUT_DIR, "metrics.json"), JSON.stringify(metrics, null, 2));

  // Count the files ourselves. A harness that trusts its own exit code is how a
  // review ends up reasoning about screenshots that were never written.
  const onDisk = [
    ...readdirSync(OUT_DIR).filter((f) => f.endsWith(".png")),
    ...readdirSync(path.join(OUT_DIR, "sweep")).filter((f) => f.endsWith(".png")),
  ];
  expect(onDisk.length).toBe(written.length);
  expect(onDisk.length).toBe(THEMES.length * 4 + 5 + SWEEP.length);
  console.log(`[markdown-tables-shots] ${onDisk.length} PNGs in ${OUT_DIR}`);
});
