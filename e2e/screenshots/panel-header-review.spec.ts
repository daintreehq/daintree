/**
 * Panel header visual-review harness.
 *
 * The header sits on every pane in the app, and the states that decide its design —
 * the pane you are typing into beside the ones that will mirror you, a broadcast that
 * failed on one pane, Zen mode over three busy panes, a rename in progress — are states
 * the grid arranges, not states a component can be asked for. Reaching them in the
 * real app means building a workspace around each one.
 *
 * So this drives the header's own preview entry (`panel-header-preview.html`) rather
 * than booting Electron: the real `ContentPanel` and `PanelHeader`, the real theme
 * tokens, the real `index.css`, from fixtures that name each state and seed the stores
 * the pane reads. The states no fixture can express — hover, keyboard focus, an open
 * menu, an armed restart, an inline rename — are driven here with a real pointer and
 * real keys.
 *
 * Opt-in only: skips itself unless DAINTREE_SHOT_PANELHEADER is set.
 *
 *   DAINTREE_SHOT_PANELHEADER=1 DAINTREE_SHOT_DIR=/abs/out \
 *     npx playwright test --project=screenshots panel-header-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_PANELHEADER  required — any truthy value runs the capture
 *   DAINTREE_SHOT_DIR          required — an ABSOLUTE output directory outside the repo.
 *                              Deliberately no default: a committed spec with an in-repo
 *                              fallback is how PNGs end up in a working tree.
 *   DAINTREE_SHOT_THEMES       themes for the per-state captures (default daintree,bondi,namib)
 *   DAINTREE_SHOT_SWEEP        "0" skips the all-themes contact sheets (default on)
 *
 * Hard rule, inherited from the sibling harnesses: never write a PNG that has not been
 * verified. Every capture asserts the state it means to show is on screen first, and
 * the test counts the files itself at the end rather than trusting the exit code.
 */

import { test, expect, type Locator, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync } from "fs";
import path from "path";
import { createServer, type ViteDevServer } from "vite";
import { BUILT_IN_THEME_SOURCES } from "@shared/theme/builtInThemeSources";
import {
  FIXTURES,
  FIXTURE_NAMES,
  type FixtureName,
} from "../../src/components/Panel/__preview__/fixtures";

const ENABLED = !!process.env.DAINTREE_SHOT_PANELHEADER;
const OUT_DIR = process.env.DAINTREE_SHOT_DIR ?? "";
const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,bondi,namib")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);
const SWEEP = process.env.DAINTREE_SHOT_SWEEP !== "0";
const ALL_THEMES = BUILT_IN_THEME_SOURCES.map((t) => t.id);

// 2× so a 32px bar's glyphs, 2px stripe and 1px edges are judged at the size a Retina
// user sees them; at 1× the details this harness exists to show round away.
test.use({ deviceScaleFactor: 2 });

/** The header element itself — the `data-pane-chrome` hook PanelHeader stamps on its root. */
const HEADER = "[data-pane-chrome]";

let server: ViteDevServer | undefined;
let baseURL = "";

test.beforeAll(async () => {
  if (!ENABLED) return;
  if (!path.isAbsolute(OUT_DIR)) {
    throw new Error("DAINTREE_SHOT_DIR must be an absolute directory outside the repo");
  }
  // Fresh directory per run: a leftover PNG from an earlier round read as this round's
  // output is the single easiest way to review a screen that no longer exists.
  if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });

  // `strictPort: false` so the harness can run beside a live `npm run dev` — the
  // project config pins 5173 with strictPort, and a port collision surfaces as
  // `element(s) not found`, which reads exactly like a render bug.
  //
  // `fs.allow` names the REAL node_modules: a worktree symlinks it to the main checkout,
  // and Vite resolves the fonts through the link to a path outside the project root,
  // which its serving allow-list refuses. A capture measured in the fallback face is
  // the wrong picture.
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

/**
 * Serve an inert `@vite/client` so no page in this sweep opens an HMR socket. Chromium
 * throttles repeated WebSocket handshakes to one host until the client gives up and
 * falls into a blob-URL SharedWorker that the dev CSP refuses — after which every load
 * mounts blank. `updateStyle` stays real: in dev every CSS import is a JS module that
 * calls it, so a no-op there renders the whole page unstyled. See the session-tabs
 * harness for the full chain.
 */
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

/**
 * Freeze motion so a capture is the settled state, not a frame of a transition. The
 * caret is left alone: the rename capture wants to show one.
 */
const FREEZE_CSS = `
  ::-webkit-scrollbar { display: none !important; }
  *, *::before, *::after {
    animation-duration: 0s !important;
    animation-delay: 0s !important;
    transition-duration: 0s !important;
    transition-delay: 0s !important;
  }
`;

/**
 * Write one PNG, having proved there is something to write. Throws rather than writing
 * when the target is not really on screen.
 */
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

/** A page-region capture for states that spill out of the pane — an open menu. */
async function snapRegion(
  page: Page,
  anchor: Locator,
  extraHeight: number,
  file: string
): Promise<string> {
  const box = await anchor.boundingBox();
  if (!box) throw new Error(`${file}: anchor has no box — refusing to write`);
  const out = path.join(OUT_DIR, file);
  await page.screenshot({
    path: out,
    clip: { x: box.x, y: box.y, width: box.width, height: box.height + extraHeight },
  });
  return out;
}

/**
 * The width contract under pressure: the title never collapses below a few
 * characters, and nothing in the identity group is allowed to reach the controls.
 * Both were true failures in the first capture, so both are proved on every run.
 */
async function proveTitleSurvives(header: Locator): Promise<void> {
  const title = header.getByRole("button", { name: /title:/ });
  const titleBox = await title.boundingBox();
  if (!titleBox || titleBox.width < 30) {
    throw new Error(`title collapsed to ${titleBox?.width ?? 0}px — refusing to write`);
  }
  const more = header.getByRole("button", { name: "More panel actions" });
  await expect(more).toBeVisible();
  const moreBox = (await more.boundingBox())!;
  // The badge may be in the DOM but hidden by the compact container query —
  // then it has no box and there is nothing to overlap.
  const badge = header.locator('[aria-label^="Branch:"]');
  const badgeBox = (await badge.count()) > 0 ? await badge.boundingBox() : null;
  if (badgeBox) {
    if (badgeBox.x + badgeBox.width > moreBox.x) {
      throw new Error("branch badge overlaps the More-actions trigger — refusing to write");
    }
  }
}

/**
 * What proves each state is actually on screen. The default is the pane title in the
 * header; states whose header shows something else name their own proof. A relabel
 * fails loudly here — which is the right sensitivity for a design harness.
 */
async function proveState(page: Page, name: FixtureName, header: Locator): Promise<void> {
  const fixture = FIXTURES[name];
  const timeout = 10_000;
  switch (name) {
    case "tabs":
    case "tabs-overflow":
      // Parked (overflowed) tabs are `visibility: hidden`, which drops them from
      // the accessibility tree; they are still rendered and still counted.
      await expect(header.getByRole("tab", { includeHidden: true })).toHaveCount(
        (fixture.tabs ?? []).length,
        { timeout }
      );
      if (name === "tabs-overflow") {
        await expect(header.getByTestId("panel-tabs-overflow")).toBeVisible({ timeout });
      }
      return;
    case "maximized-stats":
      await expect(header.getByText("Background")).toBeVisible({ timeout });
      await expect(header.getByText("working")).toBeVisible({ timeout });
      await expect(header.getByText("waiting")).toBeVisible({ timeout });
      return;
    case "follower":
      await expect(header).toHaveAttribute("data-fleet-follower", "true", { timeout });
      await expect(header.getByTestId("panel-armed-broadcast-indicator")).toBeVisible({
        timeout,
      });
      break;
    case "selected-primary":
      await expect(header).toHaveAttribute("data-selected", "true", { timeout });
      break;
    case "preview-hover":
      await expect(header).toHaveAttribute("data-fleet-previewed", "true", { timeout });
      break;
    case "fleet-failed":
      await expect(header.getByTestId("panel-fleet-failure-dot")).toBeVisible({ timeout });
      break;
    case "hibernated":
      await expect(header.getByTestId("terminal-hibernated-badge")).toBeVisible({ timeout });
      break;
    // `completed-cost` and `completed-no-changes` prove only the title: through
    // ContentPanel a completed agent's display state coerces to `waiting`
    // (getTerminalAgentDisplayState rule 3), so the settled trace those fixtures
    // describe is what the metadata row would show, not what it does. The capture
    // shows the real thing; the gap is the review's to weigh.
    case "exited-plain":
      await expect(header.getByText("[exit 1]")).toBeVisible({ timeout });
      break;
    case "dense-metadata":
      await expect(header.getByText("feature/auth-redirect")).toBeVisible({ timeout });
      await expect(header.getByText("queued")).toBeVisible({ timeout });
      await proveTitleSurvives(header);
      break;
    case "long-title-narrow":
      await proveTitleSurvives(header);
      break;
    case "status-slot":
      await expect(header.getByRole("status", { name: /Output paused/ })).toBeVisible({ timeout });
      break;
    case "command-pill":
      await expect(header.getByText("npm run build")).toBeVisible({ timeout });
      break;
    case "waiting-blocked":
      // The frame cue is debounced 800ms in useDockBlockedState; wait for it.
      await expect(page.locator(`[data-panel-id].panel-state-waiting`)).toBeAttached({ timeout });
      break;
    case "plugin-missing":
      await expect(page.getByRole("region", { name: "Plugin unavailable" })).toBeVisible({
        timeout,
      });
      break;
    case "dock":
      await expect(header.getByTestId("panel-move-to-grid")).toBeVisible({ timeout });
      break;
    default:
      break;
  }
  // Every non-tab state shows the title somewhere in the header, editing aside.
  await expect(header.getByText(fixture.title, { exact: false }).first()).toBeAttached({
    timeout,
  });
}

/** Load one fixture in one theme and settle it. */
async function open(
  page: Page,
  fixture: FixtureName | null,
  theme: string
): Promise<{ pane: Locator; header: Locator }> {
  await page.setViewportSize({ width: 1240, height: 720 });
  const url = `${baseURL}/panel-header-preview.html?theme=${theme}${fixture ? `&fixture=${fixture}` : ""}`;
  const pane = page.locator("[data-preview-pane]").first();
  const timeout = 30_000;
  try {
    await page.goto(url);
    await expect(pane).toBeAttached({ timeout });
  } catch {
    console.warn(
      `[panel-header-shots] first mount of ${fixture ?? "sheet"}/${theme} failed; retrying once`
    );
    await page.goto("about:blank");
    await page.goto(url, { waitUntil: "load" });
    await expect(pane).toBeAttached({ timeout });
  }
  const header = page.locator(HEADER).first();
  await expect(header).toBeAttached({ timeout });
  // Mounted is not styled: `flex` comes from a Tailwind utility, so its presence proves
  // the stylesheet landed.
  await expect(header).toHaveCSS("display", "flex");
  await page.addStyleTag({ content: FREEZE_CSS });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(250);
  return { pane, header };
}

/** Tab until focus lands inside `target`; a fixed press count silently lands elsewhere. */
async function tabTo(page: Page, target: Locator, label: string): Promise<void> {
  await page.mouse.move(0, 0);
  for (let i = 0; i < 16; i += 1) {
    await page.keyboard.press("Tab");
    if (
      await target.evaluate(
        (el) => el === document.activeElement || el.contains(document.activeElement)
      )
    ) {
      return;
    }
  }
  throw new Error(`focus never reached ${label} — refusing to write`);
}

test("panel header — states, interactions and themes", async ({ page }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_PANELHEADER is required for the panel-header capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_PANELHEADER=1 to run the capture");
  test.setTimeout(600_000);

  await stubViteHmrClient(page);
  const written: string[] = [];

  // Every state, alone, in the review themes.
  for (const theme of THEMES) {
    for (const name of FIXTURE_NAMES) {
      const { pane, header } = await open(page, name, theme);
      await proveState(page, name, header);
      written.push(await snap(pane, `${name}--${theme}.png`));
    }
  }

  // The pointer, keyboard and overlay states no fixture can express. First review
  // theme only — these are interaction questions, not palette ones.
  {
    const theme = THEMES[0]!;

    // Hover over the title bar reveals the "duplicate as tab" control.
    {
      const { pane, header } = await open(page, "focused-working", theme);
      await proveState(page, "focused-working", header);
      await header.getByText("Claude: fix flaky auth tests").hover();
      await page.waitForTimeout(200);
      await expect(
        header.getByRole("button", { name: "Duplicate panel as new tab" })
      ).toBeVisible();
      written.push(await snap(pane, `focused-working--${theme}--hover-header.png`));

      // Hover on the close control.
      await header.getByTestId("panel-close").hover();
      await page.waitForTimeout(200);
      written.push(await snap(pane, `focused-working--${theme}--hover-close.png`));

      // Hover on the maximize control.
      await header.getByRole("button", { name: "Maximize" }).hover();
      await page.waitForTimeout(200);
      written.push(await snap(pane, `focused-working--${theme}--hover-maximize.png`));
    }

    // Keyboard focus on the title (rename affordance) and on the close button, through
    // real Tab presses so `:focus-visible` actually paints.
    {
      const { pane, header } = await open(page, "focused-working", theme);
      await proveState(page, "focused-working", header);
      const title = header.getByRole("button", { name: /Agent title/ });
      await tabTo(page, title, "the title");
      await page.waitForTimeout(150);
      written.push(await snap(pane, `focused-working--${theme}--focus-title.png`));

      // The controls are one toolbar: Tab lands on its entry control, arrows
      // move within it. Close is reached with the arrows, and the capture
      // proves the roving stop actually moved.
      const toolbar = header.getByRole("toolbar", { name: "Panel controls" });
      await tabTo(page, toolbar, "the controls toolbar");
      await page.waitForTimeout(150);
      written.push(await snap(pane, `focused-working--${theme}--focus-more.png`));

      const close = header.getByTestId("panel-close");
      for (let i = 0; i < 6; i += 1) {
        if (await close.evaluate((el) => el === document.activeElement)) break;
        await page.keyboard.press("ArrowRight");
      }
      if (!(await close.evaluate((el) => el === document.activeElement))) {
        throw new Error("arrows never reached the close control — refusing to write");
      }
      await page.waitForTimeout(150);
      written.push(await snap(pane, `focused-working--${theme}--focus-close.png`));
    }

    // Inline rename, started with F2 on the focused title.
    {
      const { pane, header } = await open(page, "focused-working", theme);
      await proveState(page, "focused-working", header);
      const title = header.getByRole("button", { name: /Agent title/ });
      await tabTo(page, title, "the title");
      // The field must take the title's box exactly: whatever sits after the
      // title (the duplicate control, revealed by the header holding focus)
      // must not move when editing starts.
      const neighbour = header.getByRole("button", { name: "Duplicate panel as new tab" });
      const before = (await neighbour.boundingBox())!;
      await page.keyboard.press("F2");
      const input = header.getByRole("textbox", { name: "Edit agent title" });
      await expect(input).toBeVisible();
      await page.waitForTimeout(300);
      const after = (await neighbour.boundingBox())!;
      if (Math.abs(after.x - before.x) > 0.5) {
        throw new Error(
          `entering rename moved the next control by ${after.x - before.x}px — refusing to write`
        );
      }
      written.push(await snap(pane, `focused-working--${theme}--title-editing.png`));
    }

    // The overflow menu, idle and then with an armed restart counting down.
    {
      const { pane, header } = await open(page, "focused-working", theme);
      await proveState(page, "focused-working", header);
      await header.getByRole("button", { name: "More panel actions" }).click();
      const menu = page.getByRole("menu");
      await expect(menu).toBeVisible();
      await expect(page.getByTestId("panel-restart")).toBeVisible();
      await page.waitForTimeout(200);
      written.push(await snapRegion(page, pane, 320, `focused-working--${theme}--menu-open.png`));

      await page.getByTestId("panel-restart").click();
      const confirm = page.getByTestId("panel-restart-confirm");
      await expect(confirm).toBeVisible();
      await expect(confirm).toContainText("Confirm restart");
      await page.waitForTimeout(100);
      written.push(
        await snapRegion(page, pane, 320, `focused-working--${theme}--armed-restart.png`)
      );
    }

    // A tab under the cursor reveals its close control.
    {
      const { pane, header } = await open(page, "tabs", theme);
      await proveState(page, "tabs", header);
      await header.getByRole("tab", { name: /write funnel tests/ }).hover();
      await page.waitForTimeout(200);
      written.push(await snap(pane, `tabs--${theme}--hover-inactive-tab.png`));
    }

    // Focus on a tab through real Tab presses — the ring inside the strip.
    {
      const { pane, header } = await open(page, "tabs", theme);
      await proveState(page, "tabs", header);
      const strip = header.getByRole("tablist");
      await tabTo(page, strip, "the tab strip");
      await page.waitForTimeout(150);
      written.push(await snap(pane, `tabs--${theme}--focus-tab.png`));
    }

    // The hidden-tabs menu.
    {
      const { pane, header } = await open(page, "tabs-overflow", theme);
      await proveState(page, "tabs-overflow", header);
      await header.getByTestId("panel-tabs-overflow").click();
      await expect(page.getByRole("menu")).toBeVisible();
      await page.waitForTimeout(200);
      written.push(await snapRegion(page, pane, 200, `tabs-overflow--${theme}--menu-open.png`));
    }
  }

  // Every theme, one contact sheet each. Theme-specific collapse is real and only a
  // sweep finds it.
  if (SWEEP) {
    for (const theme of ALL_THEMES) {
      await open(page, null, theme);
      const sheet = page.locator("#root > div").first();
      await expect(page.locator("[data-preview-pane]")).toHaveCount(FIXTURE_NAMES.length);
      // `index.css` pins the document to the viewport, so a sheet taller than it
      // never scrolls into an element screenshot — size the viewport to the sheet.
      const height = await sheet.evaluate((el) => Math.ceil(el.getBoundingClientRect().height));
      await page.setViewportSize({ width: 1240, height: Math.min(height + 32, 6000) });
      await page.waitForTimeout(400);
      written.push(await snap(sheet, `sheet--${theme}.png`));
    }
  }

  // Count the files ourselves. A harness that trusts its own exit code is how a review
  // ends up reasoning about screenshots that were never written.
  const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  expect(onDisk.length).toBe(written.length);
  expect(onDisk.length).toBeGreaterThanOrEqual(THEMES.length * FIXTURE_NAMES.length);
  console.log(`[panel-header-shots] ${onDisk.length} PNGs in ${OUT_DIR}`);
});
