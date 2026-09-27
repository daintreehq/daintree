/**
 * Composer autocomplete menu visual-review harness.
 *
 * The menu only exists while a `/`, `@` or `$` token sits under the caret, its
 * rows come from three async providers, and its loading and stale states last a
 * debounce window. This drives its preview entry (`autocomplete-menu-preview.html`)
 * instead: the real `AutocompleteMenu` fed fixture rows, above the real
 * `HybridInputBar` holding the matching draft, under the real theme tokens.
 *
 * Opt-in only:
 *
 *   DAINTREE_SHOT_AUTOCOMPLETE=1 DAINTREE_SHOT_DIR=/abs/out \
 *     npx playwright test --project=screenshots autocomplete-menu-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_AUTOCOMPLETE  required — any truthy value runs the capture
 *   DAINTREE_SHOT_DIR           required — an ABSOLUTE directory outside the repo
 *   DAINTREE_SHOT_THEMES        full-sweep themes (default daintree,bondi)
 *   DAINTREE_SHOT_SPOT_THEMES   themes for the palette-sensitive cases only
 *                               (default namib,svalbard)
 *
 * Never writes a PNG it has not verified: each capture proves the menu rendered
 * the state it names — the row count, the loading or empty line, the stale
 * dimming, the hover tooltip — and the test counts the files itself.
 */

import { test, expect, type Page } from "@playwright/test";
import { mkdirSync, readdirSync, realpathSync, rmSync } from "fs";
import path from "path";
import { createServer, type ViteDevServer } from "vite";
import {
  MENU_CASES,
  TRIGGER_COPY,
} from "../../src/components/Terminal/__preview__/autocompleteMenuFixtures";

const ENABLED = !!process.env.DAINTREE_SHOT_AUTOCOMPLETE;
const OUT_DIR = process.env.DAINTREE_SHOT_DIR ?? "";
const parseList = (value: string | undefined, fallback: string) =>
  (value ?? fallback)
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
const THEMES = parseList(process.env.DAINTREE_SHOT_THEMES, "daintree,bondi");
const SPOT_THEMES = parseList(process.env.DAINTREE_SHOT_SPOT_THEMES, "namib,svalbard");
const CASES = Object.keys(MENU_CASES);
/** The cases whose colour relationships move most between themes. */
const SPOT_CASES = ["commands-run", "capabilities", "files-stale"];

test.use({ deviceScaleFactor: 2, viewport: { width: 700, height: 620 } });

let server: ViteDevServer | undefined;
let baseURL = "";

test.beforeAll(async () => {
  if (!ENABLED) return;
  if (!path.isAbsolute(OUT_DIR)) {
    throw new Error("DAINTREE_SHOT_DIR must be an absolute directory outside the repo");
  }
  const repoRoot = realpathSync(process.cwd());
  mkdirSync(OUT_DIR, { recursive: true });
  const outReal = realpathSync(OUT_DIR);
  if (outReal === repoRoot || outReal.startsWith(repoRoot + path.sep)) {
    throw new Error(`DAINTREE_SHOT_DIR must be outside the repo (${OUT_DIR})`);
  }
  for (const file of readdirSync(OUT_DIR)) {
    if (file.endsWith(".png")) rmSync(path.join(OUT_DIR, file), { force: true });
  }
  // A worktree symlinks node_modules out of the project root, and Vite refuses
  // to serve the bundled fonts through it unless the real path is allowed.
  server = await createServer({
    server: {
      port: 0,
      strictPort: false,
      fs: { allow: [process.cwd(), realpathSync(path.join(process.cwd(), "node_modules"))] },
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

/** Inert HMR client, as in the sibling harnesses: repeated sockets end in a blank mount. */
async function stubViteHmrClient(page: Page): Promise<void> {
  await page.route("**/@vite/client", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/javascript",
      body: [
        "const noop = () => {};",
        "export const createHotContext = () => ({ accept: noop, acceptExports: noop, dispose: noop, prune: noop, decline: noop, invalidate: noop, on: noop, off: noop, send: noop, data: {} });",
        "export const injectQuery = (u) => u;",
        "const sheets = new Map();",
        "export function updateStyle(id, content) {",
        "  let style = sheets.get(id);",
        "  if (!style) {",
        "    style = document.createElement('style');",
        "    style.setAttribute('type', 'text/css');",
        "    style.setAttribute('data-vite-dev-id', id);",
        "    style.textContent = content;",
        "    document.head.appendChild(style);",
        "    sheets.set(id, style);",
        "  } else {",
        "    style.textContent = content;",
        "  }",
        "}",
        "export function removeStyle(id) {",
        "  const style = sheets.get(id);",
        "  if (style) { document.head.removeChild(style); sheets.delete(id); }",
        "}",
      ].join("\n"),
    })
  );
}

const FREEZE_CSS = `
  *, *::before, *::after {
    animation-duration: 0s !important;
    animation-delay: 0s !important;
    transition-duration: 0s !important;
    transition-delay: 0s !important;
    caret-color: transparent !important;
  }
`;

async function capture(page: Page, caseName: string, theme: string): Promise<string> {
  const spec = MENU_CASES[caseName]!;
  await page.goto(`${baseURL}/autocomplete-menu-preview.html?case=${caseName}&theme=${theme}`);
  await page.addStyleTag({ content: FREEZE_CSS });
  const shell = page.locator("[data-preview-shell]");
  await expect(shell, `${caseName}: preview did not mount`).toBeAttached();
  await expect(page.locator(".cm-content"), `${caseName}: composer has no editor`).toHaveCount(1);

  const menu = page.locator("[data-autocomplete-menu]");
  await expect(menu, `${caseName}: menu did not render`).toBeVisible();
  await expect.poll(() => menu.evaluate((el) => getComputedStyle(el).opacity)).toBe("1");

  const options = menu.getByRole("option");
  await expect(options, `${caseName}: wrong row count`).toHaveCount(spec.items.length);
  if (spec.items.length > 0) {
    await expect(
      menu.getByRole("listbox", { name: TRIGGER_COPY[spec.trigger].ariaLabel })
    ).toBeVisible();
    await expect(options.nth(spec.selectedIndex)).toHaveAttribute("aria-selected", "true");
  }
  if (spec.isLoading) {
    await expect(menu, `${caseName}: no loading line`).toContainText(/Searching/);
  }
  if (!spec.isLoading && spec.items.length === 0) {
    await expect(menu, `${caseName}: no empty line`).toContainText(/match/);
  }
  if (spec.stale) {
    await expect(options.first()).toHaveAttribute("aria-disabled", "true");
  }
  if (spec.hoverIndex !== undefined) {
    const hovered = options.nth(spec.hoverIndex);
    await hovered.hover();
    await expect
      .poll(() => hovered.evaluate((el) => el.matches(":hover")), `${caseName}: row not hovered`)
      .toBe(true);
    // Pointer rest must not raise anything over the neighbouring rows.
    await page.waitForTimeout(400);
    await expect(page.getByRole("tooltip")).toHaveCount(0);
  }

  await page.evaluate(() => document.fonts.ready);
  const box = await shell.boundingBox();
  if (!box || box.width < 100 || box.height < 100) {
    throw new Error(`${caseName}: shell has no real box — refusing to write`);
  }
  const out = path.join(OUT_DIR, `autocomplete--${caseName}--${theme}.png`);
  // The whole viewport, not the shell's box: a hover tooltip portals to the
  // body and can land outside the pane, and it is the thing that case is about.
  await page.screenshot({ path: out });
  return out;
}

test("composer autocomplete menu review", async ({ page }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_AUTOCOMPLETE is required for the autocomplete capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_AUTOCOMPLETE=1 to run the capture");
  test.setTimeout(240_000);

  await stubViteHmrClient(page);
  const written: string[] = [];
  for (const theme of THEMES) {
    for (const c of CASES) written.push(await capture(page, c, theme));
  }
  for (const theme of SPOT_THEMES) {
    for (const c of SPOT_CASES) written.push(await capture(page, c, theme));
  }

  const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  expect(onDisk.length).toBe(written.length);
  expect(onDisk.length).toBe(THEMES.length * CASES.length + SPOT_THEMES.length * SPOT_CASES.length);
  console.log(`[autocomplete-shots] ${onDisk.length} PNGs in ${OUT_DIR}`);
});
