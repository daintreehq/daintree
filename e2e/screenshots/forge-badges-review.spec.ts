/**
 * Worktree card issue / PR badge + hover card visual-review harness.
 *
 * The hover card's interesting states — a fetch that never answers, a missing
 * token, an active rate limit, PR detection paused, five assignees and twenty-five
 * labels, the cold-number gap — are ones a real session reaches rarely and never
 * on demand. So this drives the badges' own preview entry
 * (`forge-badges-preview.html`), which mounts the REAL `IssueBadge` and `PRBadge`
 * against the real theme tokens and `index.css`, with the bridge serving fixture
 * tooltip data.
 *
 *   DAINTREE_SHOT_FORGEBADGES=1 npx playwright test --project=screenshots forge-badges-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_FORGEBADGES  required — any truthy value runs the capture
 *   DAINTREE_SHOT_DIR          output directory (default artifacts/forge-badge-shots)
 *   DAINTREE_SHOT_THEMES       comma-separated sweep (default daintree,bondi,namib);
 *                              the first theme gets every state, the rest a subset
 *
 * Never writes a PNG it has not verified: every hover shot asserts the hover card
 * is on screen with the fixture's expected text before the frame is written, and
 * the test counts the files itself at the end.
 */

import { test, expect, type Locator, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readdirSync, rmSync } from "fs";
import path from "path";
import { startPreviewServer, stubViteHmrClient } from "../helpers/previewHarness";

const ENABLED = !!process.env.DAINTREE_SHOT_FORGEBADGES;

const OUT_DIR = path.resolve(
  process.env.DAINTREE_SHOT_DIR ?? path.join(process.cwd(), "artifacts", "forge-badge-shots")
);

const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,bondi,namib")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

type Target = "headline" | "secondary-pr" | "secondary-issue";

interface Shot {
  name: string;
  fixture: string;
  /** Badge to hover (or focus); omitted = the card at rest. */
  target?: Target;
  via?: "hover" | "keyboard";
  /** Text the hover card must show before the frame is written. */
  expect?: RegExp;
  /** Extra settle, for the Doherty-gated skeleton. */
  waitMs?: number;
  /** Capture before the 400ms cold-number gate opens. */
  early?: boolean;
  /** Also captured in the secondary themes. */
  sweep?: boolean;
}

const SHOTS: Shot[] = [
  { name: "rest-issue-card", fixture: "issue-card", sweep: true },
  { name: "rest-issue-card-inactive", fixture: "issue-card-inactive" },
  { name: "rest-pr-card", fixture: "pr-card", sweep: true },
  { name: "rest-cold-gap-early", fixture: "cold-gap", early: true },
  { name: "rest-cold-gap-late", fixture: "cold-gap" },
  { name: "rest-no-token", fixture: "no-token" },
  { name: "rest-rate-limited", fixture: "rate-limited" },
  { name: "rest-pr-paused", fixture: "pr-paused" },
  {
    name: "hover-issue-full",
    fixture: "issue-card",
    target: "headline",
    expect: /Retry-After header/,
    sweep: true,
  },
  {
    name: "hover-pr-open",
    fixture: "issue-card",
    target: "secondary-pr",
    expect: /jittered backoff/,
    sweep: true,
  },
  {
    name: "focus-issue-full",
    fixture: "issue-card",
    target: "headline",
    via: "keyboard",
    expect: /Retry-After header/,
  },
  { name: "hover-pr-draft", fixture: "pr-card-draft", target: "headline", expect: /Draft/i },
  {
    name: "hover-pr-merged",
    fixture: "pr-card-merged",
    target: "headline",
    expect: /merged/i,
    sweep: true,
  },
  { name: "hover-pr-closed", fixture: "pr-card-closed", target: "headline", expect: /closed/i },
  {
    name: "hover-issue-secondary",
    fixture: "pr-card",
    target: "secondary-issue",
    expect: /Retry-After header/,
  },
  {
    name: "hover-issue-crowded",
    fixture: "issue-crowded",
    target: "headline",
    expect: /inspector panel/,
    sweep: true,
  },
  { name: "hover-loading", fixture: "loading", target: "headline", waitMs: 1200 },
  { name: "hover-error", fixture: "error", target: "headline", expect: /issue/i },
  { name: "hover-pr-error", fixture: "error", target: "secondary-pr", expect: /PR|pull request/i },
  {
    name: "hover-no-token",
    fixture: "no-token",
    target: "headline",
    expect: /token/i,
    sweep: true,
  },
  {
    name: "hover-rate-limited",
    fixture: "rate-limited",
    target: "headline",
    expect: /rate limit/i,
  },
  {
    name: "hover-rate-limited-error",
    fixture: "rate-limited-error",
    target: "headline",
    expect: /rate limit/i,
  },
  { name: "hover-pr-paused", fixture: "pr-paused", target: "secondary-pr", expect: /paused/i },
];

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

const AVATAR_TINTS = ["#4a6b8a", "#8a5a4a", "#4a8a6b", "#6b4a8a", "#8a7a4a", "#4a7f8a"];

/** Generated avatars for the fixture's avatar host. */
async function routeAvatars(page: Page): Promise<void> {
  await page.route("https://avatars.githubusercontent.com/**", (route) => {
    const login = new URL(route.request().url()).pathname.slice(1);
    let hash = 0;
    for (const ch of login) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
    const fill = AVATAR_TINTS[hash % AVATAR_TINTS.length];
    return route.fulfill({
      status: 200,
      contentType: "image/svg+xml",
      body: `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="${fill}"/><circle cx="16" cy="12" r="6" fill="#dfe8ee"/><ellipse cx="16" cy="29" rx="11" ry="9" fill="#dfe8ee"/></svg>`,
    });
  });
}

async function open(
  page: Page,
  fixture: string,
  theme: string,
  freezeTimers = false
): Promise<Locator> {
  await stubViteHmrClient(page);
  if (freezeTimers) {
    // Paused before the page loads, so the 400ms cold-number gate never opens.
    await page.clock.install();
    await page.clock.pauseAt(Date.now() + 1_000);
  }
  await routeAvatars(page);
  await page.mouse.move(0, 0);
  await page.setViewportSize({ width: 760, height: 560 });
  const url = `${baseURL}/forge-badges-preview.html?theme=${theme}&fixture=${fixture}`;
  const shell = page.locator("[data-preview-shell]");
  // The first load after a dependency change can answer 504 "Outdated Optimize
  // Dep" while Vite re-optimises (the cache is shared by every worktree that
  // symlinks node_modules); one reload after it settles is enough.
  for (let attempt = 0; ; attempt++) {
    await page.goto(url);
    try {
      await expect(shell).toBeAttached({ timeout: attempt === 0 ? 15_000 : 30_000 });
      break;
    } catch (error) {
      if (attempt >= 2) throw new Error(`fixture "${fixture}" rendered no shell: ${String(error)}`);
    }
  }
  await expect(shell.locator('[data-shot="headline"] button')).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  return shell;
}

/** The shell plus the open hover card, as one clip. */
async function snapUnion(page: Page, shell: Locator, card: Locator | null, file: string) {
  const a = await shell.boundingBox();
  if (!a || a.width < 8 || a.height < 8) throw new Error(`${file}: shell has no real box`);
  let box = a;
  if (card) {
    const b = await card.boundingBox();
    if (!b || b.width < 8 || b.height < 8) throw new Error(`${file}: hover card has no real box`);
    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    box = {
      x,
      y,
      width: Math.max(a.x + a.width, b.x + b.width) - x,
      height: Math.max(a.y + a.height, b.y + b.height) - y,
    };
  }
  const pad = 12;
  const out = path.join(OUT_DIR, file);
  await page.screenshot({
    path: out,
    clip: {
      x: Math.max(0, box.x - pad),
      y: Math.max(0, box.y - pad),
      width: box.width + pad * 2,
      height: box.height + pad * 2,
    },
  });
  return out;
}

test("Forge badges — states and themes", async ({ page, browser }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_FORGEBADGES is required for the forge badge capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_FORGEBADGES=1 to run the capture");
  test.setTimeout(10 * 60_000);

  const written: string[] = [];
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));

  let expected = 0;
  for (const [i, theme] of THEMES.entries()) {
    for (const shot of SHOTS) {
      if (i > 0 && !shot.sweep) continue;
      expected++;
      const file = `${shot.name}-${theme}.png`;
      if (shot.early) {
        // The fake clock is context-wide and can't be uninstalled, so the frozen
        // capture gets a context of its own.
        const frozenContext = await browser.newContext({ deviceScaleFactor: 2 });
        const frozen = await frozenContext.newPage();
        frozen.on("pageerror", (e) => pageErrors.push(e.message));
        try {
          const shell = await open(frozen, shot.fixture, theme, true);
          const text = await shell.locator('[data-shot="headline"]').innerText();
          // The product behaviour under review, not a harness fault: record it
          // and photograph what actually renders inside the gate.
          if (text.includes("#4821")) console.warn(`[forge-badges] ${file}: #NNN inside the gate`);
          written.push(await snapUnion(frozen, shell, null, file));
        } finally {
          await frozenContext.close();
        }
        continue;
      }
      const shell = await open(page, shot.fixture, theme);

      if (!shot.target) {
        await page.waitForTimeout(700);
        if (shot.fixture === "cold-gap") {
          await expect(shell.locator('[data-shot="headline"]')).toContainText("#4821");
        }
        written.push(await snapUnion(page, shell, null, file));
        continue;
      }

      const trigger = shell.locator(`[data-shot="${shot.target}"] button`).first();
      if (shot.via === "keyboard") {
        // A keypress first, so the programmatic focus lands as :focus-visible.
        await page.keyboard.press("Shift");
        await trigger.focus();
      } else {
        await trigger.hover();
      }
      const card = page.locator("[data-radix-popper-content-wrapper]").first();
      await expect(card, `${file}: hover card never opened`).toBeVisible({ timeout: 3000 });
      if (shot.expect) await expect(card).toContainText(shot.expect);
      await page.waitForTimeout(shot.waitMs ?? 350);
      written.push(await snapUnion(page, shell, card, file));
    }
  }

  expect(pageErrors, `page errors during capture:\n${pageErrors.join("\n")}`).toEqual([]);
  const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  expect(onDisk.length).toBe(written.length);
  expect(written.length).toBe(expected);
});
