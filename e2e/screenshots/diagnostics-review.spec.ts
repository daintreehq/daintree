/**
 * Diagnostics dock visual-review harness — the tabs and what each one shows.
 *
 * The dock is where someone lands when something has gone wrong, and most of
 * its states (a failed snapshot, a filter that matches nothing, two dozen
 * problems) are ones nobody holds still long enough to look at. This drives the
 * Diagnostics preview entry (`diagnostics-preview.html`): the real
 * `DiagnosticsDock` fed from fixtures through the real stores and bridge
 * method names, against the real theme tokens and `index.css`.
 *
 * Opt-in only, like every sibling review harness:
 *
 *   DAINTREE_SHOT_DIAGNOSTICS=1 npx playwright test --project=screenshots diagnostics-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_DIAGNOSTICS  required — any truthy value runs the capture
 *   DAINTREE_SHOT_DIR          output directory (default artifacts/diagnostics-shots)
 *   DAINTREE_SHOT_THEMES       comma-separated theme sweep (default: daintree,bondi,namib)
 *
 * Output:
 *   <fixture>-<first theme>.png          every fixture at the default 256px dock
 *   <fixture>-<theme>.png                the theme subset in the other themes
 *   <fixture>-<first theme>-tall.png     crowded fixtures at a 440px dock
 *
 * Never writes a PNG it has not verified: `snap()` refuses a target with no
 * real box, each fixture asserts its own tab content rendered, and the test
 * counts the files on disk rather than trusting its exit code.
 */

import { test, expect, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readdirSync, rmSync } from "fs";
import path from "path";
import {
  makeSnap,
  startPreviewServer,
  stubViteHmrClient,
  type PreviewServer,
} from "../helpers/previewHarness";

const ENABLED = !!process.env.DAINTREE_SHOT_DIAGNOSTICS;

const OUT_DIR = path.resolve(
  process.env.DAINTREE_SHOT_DIR ?? path.join(process.cwd(), "artifacts", "diagnostics-shots")
);

const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,bondi,namib")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

const WIDTH = 1200;
const DOCK_HEIGHT = 256;
const TALL_HEIGHT = 440;

/**
 * Every fixture, and what must be on screen before it is photographed. The
 * marker is a piece of that state's own content, so a tab that silently fell
 * back to a different state fails instead of producing a plausible picture.
 */
const FIXTURES: Array<{ name: string; ready: (page: Page) => Locator; settleMs?: number }> = [
  {
    name: "problems-empty",
    ready: (p) =>
      p
        .getByRole("tabpanel")
        .getByText(/problem/i)
        .first(),
  },
  {
    name: "problems-cleared",
    ready: (p) =>
      p
        .getByRole("tabpanel")
        .getByText(/problem/i)
        .first(),
  },
  { name: "problems-populated", ready: (p) => p.getByText(/could not read Username/).first() },
  { name: "problems-expanded", ready: (p) => p.getByText(/could not read Username/).first() },
  { name: "problems-crowded", ready: (p) => p.getByText(/git status timed out/).first() },
  { name: "logs-empty", ready: (p) => p.getByRole("tabpanel").getByText(/log/i).first() },
  { name: "logs-populated", ready: (p) => p.getByText(/ResizeObserver loop/).first() },
  { name: "logs-filtered", ready: (p) => p.getByText(/git fetch failed/).first() },
  {
    name: "logs-filtered-empty",
    ready: (p) => p.getByRole("tabpanel").getByText(/match/i).first(),
  },
  { name: "events-empty", ready: (p) => p.getByRole("tabpanel").getByText(/event/i).first() },
  {
    name: "events-populated",
    ready: (p) => p.getByRole("heading", { name: "agent:state-changed" }),
  },
  { name: "events-unselected", ready: (p) => p.getByPlaceholder(/search events/i) },
  {
    name: "telemetry-off",
    ready: (p) =>
      p
        .getByRole("tabpanel")
        .getByText(/preview/i)
        .first(),
  },
  { name: "telemetry-populated", ready: (p) => p.getByText("onboarding.completed").first() },
  { name: "perf-populated", ready: (p) => p.getByText("Cold boot to first paint").first() },
  { name: "perf-empty", ready: (p) => p.getByRole("tabpanel").getByText(/perf/i).first() },
  { name: "perf-error", ready: (p) => p.getByText(/EACCES/).first() },
  {
    name: "perf-no-project",
    ready: (p) =>
      p
        .getByRole("tabpanel")
        .getByText(/project/i)
        .first(),
  },
  {
    name: "whyslow-clear",
    ready: (p) =>
      p
        .getByRole("tabpanel")
        .getByText(/memory/i)
        .first(),
  },
  { name: "whyslow-pressure", ready: (p) => p.getByText(/12 active agents/).first() },
  {
    name: "whyslow-failed",
    ready: (p) =>
      p
        .getByRole("tabpanel")
        .getByText(/snapshot|couldn/i)
        .first(),
  },
  {
    name: "whyslow-stale",
    ready: (p) =>
      p
        .getByRole("tabpanel")
        .getByText(/failed|stale|ago/i)
        .first(),
    settleMs: 400,
  },
  { name: "whyslow-loading", ready: (p) => p.getByRole("tabpanel").first(), settleMs: 900 },
];

/** Themes beyond the first get the states where tone and contrast carry meaning. */
const THEME_SUBSET = [
  "problems-populated",
  "logs-populated",
  "events-populated",
  "perf-populated",
  "whyslow-pressure",
  "whyslow-stale",
];

const TALL = ["problems-crowded", "logs-populated", "events-populated", "whyslow-pressure"];

const ATTACH_TIMEOUT_MS = 30_000;

let server: PreviewServer | undefined;
const snap = makeSnap(OUT_DIR);

test.beforeAll(async () => {
  if (!ENABLED) return;
  if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });
  server = await startPreviewServer();
});

test.afterAll(async () => {
  await server?.close();
});

/**
 * Hold a page open on every tab until Vite's optimizer stops force-reloading.
 * Some primitives load lazily (Radix pieces behind the deferred loader), so a
 * warm-up on one tab leaves later tabs to discover a dependency mid-sweep —
 * the re-bundle then serves two copies of a module, and a Radix context from
 * one copy can't see the provider from the other.
 */
async function settleDevServer(context: BrowserContext) {
  const warmups = [
    "problems-expanded",
    "logs-filtered",
    "events-populated",
    "telemetry-populated",
    "perf-populated",
    "whyslow-pressure",
  ];
  for (const fixture of warmups) {
    const page = await context.newPage();
    await stubViteHmrClient(page);
    let navigations = 0;
    page.on("framenavigated", () => navigations++);
    await page.goto(`${server!.baseURL}/diagnostics-preview.html?fixture=${fixture}`);
    for (let attempt = 0; attempt < 8; attempt++) {
      const before = navigations;
      await page.waitForTimeout(2_000);
      const docks = await page.locator(".diagnostics-dock").count();
      if (navigations === before && docks === 1) break;
    }
    await page.close();
  }
}

async function withPage<T>(
  context: BrowserContext,
  what: string,
  body: (page: Page) => Promise<T>
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const page = await context.newPage();
    await stubViteHmrClient(page);
    let crashed = false;
    const errors: string[] = [];
    page.on("crash", () => {
      crashed = true;
    });
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      const result = await body(page);
      if (errors.length > 0) throw new Error(`${what}: page threw: ${errors.join(" | ")}`);
      return result;
    } catch (error) {
      if (crashed && attempt === 1) {
        console.warn(`[diagnostics-shots] renderer crashed on ${what}; retrying once`);
        continue;
      }
      throw new Error(
        `${what}: ${String(error)}\n  pageerrors: ${errors.join(" | ") || "(none)"}`,
        {
          cause: error,
        }
      );
    } finally {
      await page.close().catch(() => undefined);
    }
  }
}

async function capture(page: Page, name: string, theme: string, height: number, file: string) {
  const fixture = FIXTURES.find((f) => f.name === name)!;
  await page.setViewportSize({ width: WIDTH, height: height * 2 + 40 });
  await page.goto(
    `${server!.baseURL}/diagnostics-preview.html?fixture=${name}&theme=${theme}&height=${height}&width=${WIDTH}`
  );
  const dock = page.locator(".diagnostics-dock").first();
  await expect(dock).toBeAttached({ timeout: ATTACH_TIMEOUT_MS });
  await expect(fixture.ready(page), `${name}: state marker never rendered`).toBeVisible({
    timeout: ATTACH_TIMEOUT_MS,
  });
  if (name === "problems-expanded") {
    await page
      .getByText(/could not read Username/)
      .first()
      .click();
    await expect(page.getByText(/terminal prompts disabled/).first()).toBeVisible();
  }
  if (name === "whyslow-stale") {
    // The fixture answers the mount-time reads and fails every read from two
    // seconds on, so this refresh fails and leaves the old data on screen.
    await page.waitForTimeout(2_200);
    await page
      .getByRole("button", { name: /refresh/i })
      .first()
      .click();
    await expect(page.getByTestId("why-slow-stale-note")).toBeVisible();
  }
  await page.evaluate(() => document.fonts.ready);
  await page.mouse.move(0, 0);
  await page.waitForTimeout(350 + (fixture.settleMs ?? 0));
  // An empty state narrower than a short sentence has collapsed around its
  // inline-size container and is wrapping one word per line.
  for (const empty of await dock.locator('[class*="@container/empty-state"]').all()) {
    const emptyBox = await empty.boundingBox();
    if (emptyBox && emptyBox.width < 200) {
      throw new Error(`${name}: empty state collapsed to ${emptyBox.width}px — refusing to write`);
    }
  }
  const box = await dock.boundingBox();
  if (!box || Math.abs(box.height - height) > 2) {
    throw new Error(
      `${name}: dock is ${box?.height}px tall, expected ${height} — refusing to write`
    );
  }
  return snap(dock, file);
}

test("diagnostics dock — every tab, every state", async ({ context }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_DIAGNOSTICS is required for the diagnostics capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_DIAGNOSTICS=1 to run the capture");

  await settleDevServer(context);
  const written: string[] = [];
  const [first, ...rest] = THEMES;

  for (const { name } of FIXTURES) {
    written.push(
      await withPage(context, `${name} ${first}`, (page) =>
        capture(page, name, first!, DOCK_HEIGHT, `${name}-${first}.png`)
      )
    );
  }
  for (const theme of rest) {
    for (const name of THEME_SUBSET) {
      written.push(
        await withPage(context, `${name} ${theme}`, (page) =>
          capture(page, name, theme, DOCK_HEIGHT, `${name}-${theme}.png`)
        )
      );
    }
  }
  for (const name of TALL) {
    written.push(
      await withPage(context, `${name} tall`, (page) =>
        capture(page, name, first!, TALL_HEIGHT, `${name}-${first}-tall.png`)
      )
    );
  }

  const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  expect(onDisk.length).toBe(written.length);
  expect(onDisk.length).toBe(FIXTURES.length + rest.length * THEME_SUBSET.length + TALL.length);
  console.log(`[diagnostics-shots] ${onDisk.length} PNGs in ${OUT_DIR}`);
});
