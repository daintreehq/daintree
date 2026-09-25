/**
 * Avatar visual-review harness.
 *
 * An avatar's interesting states — a picture that 404s, a provider that sends no
 * URL, a request that never answers, a non-square upload — are ones a real session
 * reaches rarely and never on demand. So this drives `avatar-preview.html`, which
 * mounts the REAL `Avatar` at every size a caller uses, plus the real surfaces that
 * render one (the issue hover card, the new-worktree assign row) against the real
 * theme tokens and `index.css`.
 *
 *   DAINTREE_SHOT_AVATAR=1 npx playwright test --project=screenshots avatar-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_AVATAR   required — any truthy value runs the capture
 *   DAINTREE_SHOT_DIR      output directory (default artifacts/avatar-shots)
 *   DAINTREE_SHOT_THEMES   comma-separated sweep (default daintree,bondi,namib)
 *
 * Never writes a PNG it has not verified: each section must be attached with a real
 * box, the loaded and failed avatars must have settled into their end state, and the
 * test counts the files itself at the end.
 */

import { test, expect, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readdirSync, rmSync } from "fs";
import path from "path";
import { makeSnap, startPreviewServer, stubViteHmrClient } from "../helpers/previewHarness";

const ENABLED = !!process.env.DAINTREE_SHOT_AVATAR;

const OUT_DIR = path.resolve(
  process.env.DAINTREE_SHOT_DIR ?? path.join(process.cwd(), "artifacts", "avatar-shots")
);

const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,bondi,namib")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

const SECTIONS = ["matrix", "hovercard-single", "hovercard-many", "list-rail", "assign-row"];

/** Sections also captured with `forced-colors: active`, in the first theme only. */
const FORCED_COLORS_SECTIONS = ["matrix", "hovercard-many"];

test.use({ deviceScaleFactor: 2 });

let server: Awaited<ReturnType<typeof startPreviewServer>> | undefined;
let baseURL = "";

test.beforeAll(async () => {
  if (!ENABLED) return;
  if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });
  server = await startPreviewServer();
  baseURL = server.baseURL;
});

test.afterAll(async () => {
  await server?.close();
});

const TINTS = ["#4a6b8a", "#8a5a4a", "#4a8a6b", "#6b4a8a", "#8a7a4a", "#4a7f8a"];

/** `ok-*` square picture, `wide-*` 2:1 picture, `broken-*` 404, `slow-*` never answers. */
async function routeAvatars(page: Page): Promise<void> {
  await page.route("https://avatars.githubusercontent.com/**", (route) => {
    const login = new URL(route.request().url()).pathname.slice(1);
    if (login.startsWith("slow-")) return; // left pending for the life of the page
    if (login.startsWith("broken-")) return route.fulfill({ status: 404, body: "" });
    let hash = 0;
    for (const ch of login) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
    const fill = TINTS[hash % TINTS.length];
    const body = login.startsWith("wide-")
      ? `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="32"><rect width="64" height="32" fill="${fill}"/><circle cx="32" cy="12" r="6" fill="#dfe8ee"/><ellipse cx="32" cy="29" rx="11" ry="9" fill="#dfe8ee"/></svg>`
      : `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="${fill}"/><circle cx="16" cy="12" r="6" fill="#dfe8ee"/><ellipse cx="16" cy="29" rx="11" ry="9" fill="#dfe8ee"/></svg>`;
    return route.fulfill({ status: 200, contentType: "image/svg+xml", body });
  });
}

async function open(page: Page, theme: string): Promise<void> {
  await stubViteHmrClient(page);
  await routeAvatars(page);
  await page.setViewportSize({ width: 900, height: 1400 });
  const url = `${baseURL}/avatar-preview.html?theme=${theme}`;
  const shell = page.locator("[data-preview-shell]");
  for (let attempt = 0; ; attempt++) {
    await page.goto(url);
    try {
      await expect(shell).toBeAttached({ timeout: attempt === 0 ? 15_000 : 30_000 });
      break;
    } catch (error) {
      if (attempt >= 2) throw new Error(`theme "${theme}" rendered no shell`, { cause: error });
    }
  }
  await page.evaluate(() => document.fonts.ready);
  // Every picture that can settle has settled: loaded ones decoded, failed ones gone.
  await expect
    .poll(
      () =>
        page.evaluate(() =>
          Array.from(document.images)
            .filter((img) => !img.src.includes("slow-"))
            .every((img) => img.complete)
        ),
      { timeout: 10_000 }
    )
    .toBe(true);
  // Only `Avatar` is held to this: a caller that hand-rolls an <img> keeps its broken
  // one, and photographing that is the point.
  await expect(page.locator('[data-shot="matrix"] img[src*="broken-"]')).toHaveCount(0);
  await expect(page.locator('[data-shot^="hovercard"] img[src*="broken-"]')).toHaveCount(0);
  await expect(page.locator('img[src*="ok-avery"]').first()).toBeVisible();
  await page.mouse.move(0, 0);
  await page.waitForTimeout(600);
}

test("Avatar — states, surfaces and themes", async ({ page }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_AVATAR is required for the avatar capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_AVATAR=1 to run the capture");
  test.setTimeout(5 * 60_000);

  const snap = makeSnap(OUT_DIR);
  const written: string[] = [];
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));

  let expected = 0;
  for (const [i, theme] of THEMES.entries()) {
    await open(page, theme);
    for (const section of SECTIONS) {
      expected++;
      written.push(await snap(page.locator(`[data-shot="${section}"]`), `${section}-${theme}.png`));
    }
    if (i === 0) {
      await page.emulateMedia({ forcedColors: "active" });
      await page.waitForTimeout(300);
      for (const section of FORCED_COLORS_SECTIONS) {
        expected++;
        written.push(
          await snap(page.locator(`[data-shot="${section}"]`), `forced-${section}-${theme}.png`)
        );
      }
      await page.emulateMedia({ forcedColors: "none" });
    }
  }

  expect(pageErrors, `page errors during capture:\n${pageErrors.join("\n")}`).toEqual([]);
  const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  expect(onDisk.length).toBe(written.length);
  expect(written.length).toBe(expected);
});
