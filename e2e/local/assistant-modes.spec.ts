import { test, expect, type Page } from "@playwright/test";
import path from "node:path";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { createFixtureRepo } from "../helpers/fixtures";
import { openAndOnboardProject } from "../helpers/project";
import { openSettings } from "../helpers/panels";
import { SEL } from "../helpers/selectors";
import { T_LONG, T_MEDIUM } from "../helpers/timeouts";
import { assertFreshBuild } from "./freshBuild";

/**
 * The assistant driven through the states a user actually moves between, against the
 * REAL engine and the REAL backend.
 *
 * Local only, in no npm script or workflow. The fake-engine suite
 * (e2e/full/panels/assistant-native-panel.spec.ts) proves each behaviour against a
 * byte-exact event stream and is what gates CI. This is the other half: it proves the
 * panel survives being USED — themes changed under it, the font resized mid-turn, a
 * session restarted, the sidebar dragged narrow, a turn interrupted and another one
 * started on top of it. Those are the paths a scripted single-turn test never walks,
 * and they are where a panel that passes every unit test still falls over.
 *
 * Every state is screenshotted, so what it proves can also be LOOKED at.
 *
 * Run:
 *   npm run build && npx playwright test --project=local assistant-modes
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.resolve(HERE, "../screenshots/local/modes");
const BACKEND = process.env.DAINTREE_BACKEND_URL ?? "http://127.0.0.1:8473";

let ctx: AppContext;
let fixtureDir: string;
let fixtureCleanup: (() => void) | undefined;

test.beforeAll(() => {
  // Before anything else: a stale dist/ makes every result below a statement about the
  // previous build. See freshBuild.ts.
  assertFreshBuild();
  mkdirSync(SHOTS, { recursive: true });
});

test.beforeEach(async () => {
  const { dir, cleanup } = createFixtureRepo({ name: "assistant-modes" });
  fixtureDir = dir;
  fixtureCleanup = cleanup;
  ctx = await launchApp({
    env: {
      DAINTREE_BACKEND_URL: BACKEND,
      DAINTREE_ASSISTANT_TIER: "system",
      DAINTREE_ASSISTANT_DEBUG_LOG: "1",
    },
  });
  ctx.window = await openAndOnboardProject(ctx.app, ctx.window, fixtureDir, "Assistant Modes");
});

test.afterEach(async () => {
  if (ctx?.app) await closeApp(ctx.app);
  fixtureCleanup?.();
});

async function openAssistant(window: Page) {
  const toggle = window
    .getByRole("toolbar", { name: "Main toolbar" })
    .getByRole("button", { name: "Daintree Assistant", exact: true });
  await expect(toggle).toBeVisible({ timeout: T_LONG });
  if ((await toggle.getAttribute("aria-pressed")) !== "true") await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true", { timeout: T_LONG });
  const panel = window.locator("#daintree-assistant-panel");
  await expect(panel).toBeVisible({ timeout: T_LONG });
  await expect(panel.getByText("Connected", { exact: true })).toBeVisible({ timeout: T_LONG });
  return panel;
}

/** See assistant-parity.spec.ts — `insertText` silently drops multi-line data. */
async function say(window: Page, text: string) {
  const input = window.locator("#daintree-assistant-panel .cm-content");
  await expect(input).toBeVisible({ timeout: T_LONG });
  await input.click();
  await input.evaluate((el, value) => {
    const data = new DataTransfer();
    data.setData("text/plain", value);
    el.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true })
    );
  }, text);
  await window.keyboard.press("Enter");
}

/**
 * Changes the theme the way a user does — through the theme palette.
 *
 * Not by writing localStorage: that is read at hydration, so it changes the theme the
 * app STARTS in and says nothing about a swap under a live panel, which is the thing
 * being tested here.
 */
async function switchTheme(window: Page, name: string) {
  const mod = process.platform === "darwin" ? "Meta" : "Control";
  await window.locator("body").click({ position: { x: 5, y: 5 } });
  await window.keyboard.press(`${mod}+K`);
  await window.waitForTimeout(150);
  await window.keyboard.press(`${mod}+t`);
  const dialog = window.locator(SEL.themePalette.dialog);
  await expect(dialog).toBeVisible({ timeout: T_MEDIUM });
  await window.locator(SEL.themePalette.searchInput).fill(name);
  const option = window.locator(SEL.themePalette.options).first();
  await expect(option).toBeVisible({ timeout: T_MEDIUM });
  await option.click();
  await expect(dialog).not.toBeVisible({ timeout: T_MEDIUM });
  // Theme variables cascade on the next frame; the screenshot below must not race it.
  await window.waitForTimeout(500);
}

/** Prose currently on screen, as one string. */
async function transcript(window: Page): Promise<string> {
  const blocks = await window.locator("#daintree-assistant-panel .assistant-prose").allInnerTexts();
  return blocks.join("\n").trim();
}

async function waitForAnswer(window: Page, timeout = 120_000) {
  // Any prose at all. A floor of 40 characters asserted the model was VERBOSE — and a
  // prompt like "Reply with exactly: FIRST" is answered correctly in five.
  await expect.poll(async () => (await transcript(window)).length, { timeout }).toBeGreaterThan(0);

  // Then wait for the turn to actually SETTLE.
  //
  // Not by watching the spinner: the panel deliberately shows none during
  // `tool_running`, where the activity rows carry the liveness instead. So "no spinner"
  // is true in the middle of a tool call, and every test that treated it as settled was
  // free to change the theme, resize the font or send the next prompt while real work
  // was still in flight.
  //
  // The Stop control is the honest signal — it exists exactly while there is something
  // to stop.
  await expect
    .poll(
      () =>
        window
          .locator("#daintree-assistant-panel")
          .getByRole("button", { name: "Stop", exact: true })
          .count(),
      { timeout }
    )
    .toBe(0);
}

test("survives a theme change mid-conversation", async () => {
  test.setTimeout(6 * 60 * 1000);
  const { window } = ctx;
  const panel = await openAssistant(window);

  await say(window, "In one short sentence, what is a git worktree?");
  await waitForAnswer(window);
  await panel.screenshot({ path: path.join(SHOTS, "theme-01-daintree.png") });

  // The panel paints its ground from the TERMINAL theme, read at render time. A theme
  // swap that left it on the old colours would put a dark pane beside light terminals.
  for (const theme of ["Bondi", "Namib", "Redwoods"]) {
    await switchTheme(window, theme);
    await panel.screenshot({ path: path.join(SHOTS, `theme-02-${theme.toLowerCase()}.png`) });

    // Whatever the theme, the prose must be legible against the ground behind it.
    const contrastOk = await panel.evaluate((el) => {
      const prose = el.querySelector<HTMLElement>(".assistant-prose");
      const surface = el.querySelector<HTMLElement>(".assistant-panel");
      if (!prose || !surface) return null;
      const parse = (c: string) => {
        const m = /rgba?\(([^)]+)\)/.exec(c);
        return m
          ? m[1]!
              .split(",")
              .slice(0, 3)
              .map((n) => Number(n.trim()))
          : null;
      };
      const lum = (rgb: number[]) => {
        const [r, g, b] = rgb.map((v) => {
          const s = v / 255;
          return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
        }) as [number, number, number];
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      };
      const fg = parse(getComputedStyle(prose).color);
      const bg = parse(getComputedStyle(surface).backgroundColor);
      if (!fg || !bg) return null;
      const [a, b] = [lum(fg), lum(bg)].sort((x, y) => y - x) as [number, number];
      return (a + 0.05) / (b + 0.05);
    });
    expect(contrastOk, `no contrast reading in ${theme}`).not.toBeNull();
    // 4.5:1 is the body-text floor. The panel is prose on a terminal ground, and a
    // theme that reads fine in an xterm can still land under the floor here because
    // the panel is not using the terminal's own foreground for every element.
    expect(contrastOk!, `prose fails the contrast floor in ${theme}`).toBeGreaterThan(4.5);
  }

  // And the conversation is still there — a theme change is not a session change.
  expect((await transcript(window)).length).toBeGreaterThan(0);
});

test("survives a font-size change mid-conversation", async () => {
  test.setTimeout(6 * 60 * 1000);
  const { window } = ctx;
  const panel = await openAssistant(window);

  await say(window, "In two short sentences, what is a git worktree?");
  await waitForAnswer(window);
  const before = await transcript(window);

  const surface = panel.locator(".assistant-panel");
  const size = () => surface.evaluate((el) => Number.parseFloat(getComputedStyle(el).fontSize));
  const was = await size();

  await openSettings(window);
  await window.locator(`${SEL.settings.navSidebar} button`, { hasText: "Appearance" }).click();
  await window
    .locator(`${SEL.settings.subtabNav} button[role="tab"]`, { hasText: "Terminal" })
    .click();
  const input = window.locator(SEL.settings.fontSizeInput);
  await expect(input).toBeVisible({ timeout: T_MEDIUM });
  await input.fill("17");
  await input.blur();
  await expect(window.locator("text=Current: 17px")).toBeVisible({ timeout: T_MEDIUM });
  await window.keyboard.press("Escape");

  await expect.poll(size, { timeout: T_MEDIUM }).toBe(17);
  expect(await size()).not.toBe(was);
  // The transcript survives a resize. It is re-laid-out, not re-rendered from nothing.
  expect(await transcript(window)).toBe(before);
  await panel.screenshot({ path: path.join(SHOTS, "font-17px.png") });

  // Back down, and it follows in both directions.
  await openSettings(window);
  await window.locator(`${SEL.settings.navSidebar} button`, { hasText: "Appearance" }).click();
  await window
    .locator(`${SEL.settings.subtabNav} button[role="tab"]`, { hasText: "Terminal" })
    .click();
  await window.locator(SEL.settings.fontSizeInput).fill("11");
  await window.locator(SEL.settings.fontSizeInput).blur();
  await window.keyboard.press("Escape");
  await expect.poll(size, { timeout: T_MEDIUM }).toBe(11);
  await panel.screenshot({ path: path.join(SHOTS, "font-11px.png") });
});

test("survives being dragged narrow, and never scrolls sideways", async () => {
  test.setTimeout(6 * 60 * 1000);
  const { window } = ctx;
  const panel = await openAssistant(window);

  // Content with the things that overflow: a long path, a long URL, a table, code.
  await say(
    window,
    "Reply with exactly this and nothing else: a markdown table with two columns " +
      "(Path, Note) and one row where Path is " +
      "`/Users/someone/Projects/very/deeply/nested/directory/structure/file.tsx`, " +
      "then a fenced code block containing that same path, then a sentence containing " +
      "the URL https://example.com/a/very/long/path/that/will/not/fit/in/a/sidebar?q=1"
  );
  await waitForAnswer(window);

  // The stressors actually RENDERED. Without this the model could refuse, or answer in
  // one short line, and a panel with nothing wide in it trivially does not overflow —
  // so the layout assertions below would pass having measured nothing.
  const prose = panel.locator(".assistant-prose");
  await expect(prose.locator("table"), "no table rendered").toHaveCount(1);
  await expect(prose.locator("pre"), "no code block rendered").toHaveCount(1);
  await expect(prose.locator('a[href*="example.com"]'), "no link rendered").toHaveCount(1);
  await expect(prose.getByText(/deeply\/nested\/directory/).first()).toBeVisible();

  // Resized by dragging the real separator. Its own rect is read from the DOM rather
  // than through `boundingBox()`, which returns null for a zero-width hit target.
  const grip = await panel
    .locator('[aria-label="Resize Daintree Assistant panel"]')
    .evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });

  // `viewportSize()` is null for an Electron page — it has a real window, not an
  // emulated viewport — so the width comes from the page itself.
  const pageWidth = await window.evaluate(() => window.innerWidth);

  for (const width of [520, 380, 300]) {
    await window.mouse.move(grip.x, grip.y);
    await window.mouse.down();
    await window.mouse.move(pageWidth - width, grip.y, { steps: 12 });
    await window.mouse.up();
    await window.waitForTimeout(500);
    await panel.screenshot({ path: path.join(SHOTS, `narrow-${width}.png`) });

    const overflow = await panel.evaluate((el) => {
      let worst = 0;
      let culprit = "";
      for (const node of el.querySelectorAll<HTMLElement>("*")) {
        const style = getComputedStyle(node);
        // An element with its OWN horizontal scroller is doing the right thing — code
        // blocks and tables are supposed to scroll inside themselves rather than force
        // the sidebar to.
        if (style.overflowX === "auto" || style.overflowX === "scroll") continue;
        const over = node.scrollWidth - node.clientWidth;
        if (over > worst) {
          worst = over;
          culprit = `${node.tagName}.${node.className}`.slice(0, 90);
        }
      }
      return { worst, culprit };
    });
    expect(
      overflow.worst,
      `at ${width}px something overflows by ${overflow.worst}px: ${overflow.culprit}`
    ).toBeLessThanOrEqual(1);
  }
});

test("a second turn lands cleanly on top of a finished one", async () => {
  test.setTimeout(6 * 60 * 1000);
  const { window } = ctx;
  const panel = await openAssistant(window);

  await say(window, "Reply with exactly: FIRST");
  await waitForAnswer(window);
  await say(window, "Reply with exactly: SECOND");
  await expect
    .poll(async () => (await transcript(window)).includes("SECOND"), { timeout: 120_000 })
    .toBe(true);

  const text = await transcript(window);
  // BOTH answers are present, in order, once each. A transcript that replaced the
  // first answer, or repeated it, is the failure this catches.
  expect(text).toContain("FIRST");
  expect(text.indexOf("FIRST")).toBeLessThan(text.indexOf("SECOND"));
  expect(text.match(/FIRST/g)?.length ?? 0).toBe(1);
  await panel.screenshot({ path: path.join(SHOTS, "two-turns.png") });
});

test("a new session starts empty and still works", async () => {
  test.setTimeout(6 * 60 * 1000);
  const { window } = ctx;
  const panel = await openAssistant(window);

  await say(window, "Reply with exactly: BEFORE");
  await waitForAnswer(window);
  expect(await transcript(window)).toContain("BEFORE");

  // "+ New session" is the native equivalent of respawning the PTY. It must leave a
  // fresh surface AND a working engine — a restart that clears the screen and then
  // cannot answer is the worse of the two failures, and the quieter one.
  await panel.getByRole("button", { name: "Start new session" }).click();
  await expect.poll(() => transcript(window), { timeout: T_LONG }).toBe("");
  await panel.screenshot({ path: path.join(SHOTS, "new-session-empty.png") });

  await expect(panel.getByText("Connected", { exact: true })).toBeVisible({ timeout: T_LONG });
  await say(window, "Reply with exactly: AFTER");
  await expect
    .poll(async () => (await transcript(window)).includes("AFTER"), { timeout: 120_000 })
    .toBe(true);
  expect(await transcript(window)).not.toContain("BEFORE");
  await panel.screenshot({ path: path.join(SHOTS, "new-session-answered.png") });
});

test("closing and reopening the panel keeps the conversation", async () => {
  test.setTimeout(6 * 60 * 1000);
  const { window } = ctx;
  const panel = await openAssistant(window);

  await say(window, "Reply with exactly: KEEPME");
  await waitForAnswer(window);

  const toggle = window
    .getByRole("toolbar", { name: "Main toolbar" })
    .getByRole("button", { name: "Daintree Assistant", exact: true });
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "false", { timeout: T_MEDIUM });
  await window.waitForTimeout(500);
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true", { timeout: T_MEDIUM });

  // Dismissing the sidebar is not ending the conversation. The arm survives close and
  // reopen deliberately — otherwise glancing away costs you the session.
  await expect.poll(() => transcript(window), { timeout: T_LONG }).toContain("KEEPME");
  await panel.screenshot({ path: path.join(SHOTS, "reopened.png") });
});
