/**
 * Clickable choice and action cards visual-review harness.
 *
 * Photographs every card-shaped choice the app offers, as the current code draws
 * it, so a redesign has an honest "before": the welcome screen's quick actions
 * and nudge cards, the crash dialog's restore choices, the assistant's agent
 * chooser and starter prompts, the recipe band's empty, grid and list forms, the
 * canvas launcher's quick-action chips, the setup wizard's theme cards, the
 * Portal launchpad and the resource-environments add form. Hover and keyboard
 * focus are performed with a real pointer and real keys.
 *
 * Every surface is the shipped component mounted from fixtures by a preview page:
 *   first-run-preview.html     WelcomeScreen (?projects=, ?onboarding=, ?agents=, ?checklist=)
 *   choice-cards-preview.html  ?scene=crash|help-chooser|help-panel|launcher-quick-actions|environments
 *   recipes-preview.html       ?view=runner&fixture=suggestions|empty|three|many
 *   button-states-preview.html ?fixture=setup-wizard&first=1 (Appearance step)
 *   portal-preview.html        ?fixture=launchpad-first-run
 *
 * Opt-in only:
 *
 *   DAINTREE_SHOT_CHOICE_CARDS=1 DESIGN_CAPTURE_DIR=/abs/out \
 *     npx playwright test --project=screenshots choice-cards-review --workers=1
 *
 * Env knobs:
 *   DAINTREE_SHOT_CHOICE_CARDS  required — any truthy value runs the capture
 *   DESIGN_CAPTURE_DIR          required — an ABSOLUTE directory outside the repo
 *   DAINTREE_SHOT_THEMES        comma-separated themes (default daintree,bondi)
 *   DAINTREE_SHOT_ONLY          comma-separated state-name prefixes to capture (default all)
 *
 * Output: `{state}-{theme}.png`. Never writes a PNG it has not verified, fails on
 * any page error, and counts the files on disk at the end.
 */

import { test, expect, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync } from "fs";
import path from "path";
import { createServer, searchForWorkspaceRoot, type Plugin } from "vite";
import { stubViteHmrClient, type PreviewServer } from "../helpers/previewHarness";

const ENABLED = !!process.env.DAINTREE_SHOT_CHOICE_CARDS;
const OUT_DIR = process.env.DESIGN_CAPTURE_DIR ?? "";
const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,bondi")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);
const ONLY = (process.env.DAINTREE_SHOT_ONLY ?? "")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);
const LIGHT_THEMES = new Set(["bondi", "atacama", "svalbard"]);

const WAIT_MS = 60_000;
const PAD = 16;

test.use({ deviceScaleFactor: 2, actionTimeout: 30_000 });

// Transitions are frozen so a hover frame never lands mid-fade.
const FREEZE_CSS = `
  ::-webkit-scrollbar { display: none !important; }
  *, *::before, *::after {
    transition-duration: 0s !important;
    transition-delay: 0s !important;
    caret-color: transparent !important;
  }
`;

let server: PreviewServer | undefined;

/**
 * Modules the React Compiler's dev `critical_errors` gate refuses outright, which
 * would take down every page that imports them. `SettingsListEditor.tsx` reads
 * `focus.registerFallback` as a ref during render ("Cannot access refs during
 * render"), and `ResourceEnvironmentsSection` imports it. Production builds use
 * `panicThreshold: "none"` and ship such a module uncompiled; this does the same
 * in dev. The babel plugin skips `/node_modules/` ids (a `"use no memo"`
 * directive is not enough — the gate still fires), so the module is served under
 * a virtual id there. Its source is read verbatim; only its relative imports are
 * rewritten to the `@/` alias so they still resolve. No source file is touched.
 */
const COMPILER_OPT_OUT = ["src/components/Settings/SettingsListEditor.tsx"];
const OPT_OUT_DIR = "node_modules/.choice-cards-harness";

function compilerOptOutPlugin(root: string): Plugin {
  const real = new Map<string, string>();
  for (const file of COMPILER_OPT_OUT) {
    real.set(path.join(root, OPT_OUT_DIR, file.replaceAll("/", "__")), path.join(root, file));
  }
  const virtualOf = new Map([...real].map(([virtual, file]) => [file, virtual]));
  return {
    name: "choice-cards-compiler-opt-out",
    enforce: "pre",
    async resolveId(source, importer, options) {
      if (!importer || !/SettingsListEditor/.test(source)) return null;
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      const file = resolved ? resolved.id.split("?")[0]! : "";
      return virtualOf.get(file) ?? null;
    },
    load(id) {
      const file = real.get(id.split("?")[0]!);
      if (!file) return null;
      const alias = `@/${path.relative(path.join(root, "src"), path.dirname(file))}/`;
      return readFileSync(file, "utf8").replace(/from "\.\//g, `from "${alias}`);
    },
  };
}

/** `startPreviewServer`, plus the compiler opt-out above. */
async function startServer(): Promise<PreviewServer> {
  const root = realpathSync(process.cwd());
  const fsAllow = [searchForWorkspaceRoot(process.cwd())];
  try {
    fsAllow.push(realpathSync(path.join(process.cwd(), "node_modules")));
  } catch {
    // no node_modules to resolve — Vite will say so itself
  }
  const vite = await createServer({
    server: { port: 0, strictPort: false, fs: { allow: fsAllow } },
    logLevel: "error",
    plugins: [compilerOptOutPlugin(root)],
  });
  await vite.listen();
  const address = vite.httpServer?.address();
  if (!address || typeof address === "string") throw new Error("vite gave no TCP address");
  return { baseURL: `http://127.0.0.1:${address.port}`, close: () => vite.close() };
}

test.beforeAll(async () => {
  if (!ENABLED) return;
  if (!path.isAbsolute(OUT_DIR)) {
    throw new Error("DESIGN_CAPTURE_DIR must be an absolute directory outside the repo");
  }
  const repoRoot = realpathSync(process.cwd());
  mkdirSync(OUT_DIR, { recursive: true });
  const outReal = realpathSync(OUT_DIR);
  if (outReal === repoRoot || outReal.startsWith(repoRoot + path.sep)) {
    throw new Error(`DESIGN_CAPTURE_DIR must be outside the repo (${OUT_DIR})`);
  }
  for (const file of readdirSync(OUT_DIR)) {
    if (file.endsWith(".png")) rmSync(path.join(OUT_DIR, file));
  }
  server = await startServer();
});

test.afterAll(async () => {
  await server?.close();
});

async function settle(page: Page, ms = 300): Promise<void> {
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
  );
  await page.waitForTimeout(ms);
}

/** Park the pointer where it can hover nothing. */
async function park(page: Page): Promise<void> {
  await page.mouse.move(1, 1);
}

interface Entry {
  path: string;
  /** Proof the page mounted and its stylesheet landed. */
  ready: (page: Page) => Promise<void>;
  viewport: { width: number; height: number };
}

const previewReady = async (page: Page) => {
  await expect(page.locator("html[data-preview-ready]")).toBeAttached({ timeout: WAIT_MS });
  const failure = await page.locator("html").getAttribute("data-preview-error");
  if (failure !== null) throw new Error(`preview threw: ${failure}`);
};

const ENTRIES = {
  welcome: {
    path: "first-run-preview.html",
    viewport: { width: 1280, height: 900 },
    ready: async (page: Page) => {
      await expect(page.locator("[data-preview-shell]")).toBeAttached({ timeout: WAIT_MS });
      await expect(page.getByTestId("quick-actions")).toBeVisible({ timeout: WAIT_MS });
      // The welcome canvas fades in over 500ms.
      await page.waitForTimeout(700);
    },
  },
  gallery: {
    path: "choice-cards-preview.html",
    viewport: { width: 1000, height: 1200 },
    ready: previewReady,
  },
  buttonStates: {
    path: "button-states-preview.html",
    viewport: { width: 1000, height: 1200 },
    ready: previewReady,
  },
  recipes: {
    path: "recipes-preview.html",
    viewport: { width: 1280, height: 1400 },
    ready: async (page: Page) => {
      await expect(page.locator("[data-preview-canvas]")).toBeVisible({ timeout: WAIT_MS });
      await expect
        .poll(
          () =>
            page
              .locator(
                '[data-testid="recipe-runner-empty"], [role="option"], [data-testid="recipe-suggestion-pill"]'
              )
              .count(),
          { timeout: WAIT_MS }
        )
        .toBeGreaterThan(0);
    },
  },
  portal: {
    path: "portal-preview.html",
    viewport: { width: 1200, height: 900 },
    ready: async (page: Page) => {
      await expect(page.locator("#portal-launchpad-heading")).toBeVisible({ timeout: WAIT_MS });
    },
  },
} satisfies Record<string, Entry>;

type EntryName = keyof typeof ENTRIES;

interface State {
  name: string;
  entry: EntryName;
  query: string;
  /** Drives the page into the state and returns what to photograph. */
  run: (page: Page) => Promise<Locator>;
}

const WELCOME_NEW = "projects=0&onboarding=fresh&agents=ready";
const WELCOME_RECENTS = "projects=3&onboarding=complete&agents=pinned&checklist=dismissed";
const WELCOME_CARD = "projects=0&onboarding=skipped&agents=ready&checklist=dismissed";

async function visible(target: Locator): Promise<Locator> {
  await expect(target).toBeVisible({ timeout: WAIT_MS });
  return target;
}

const STATES: State[] = [
  // ── Welcome screen ───────────────────────────────────────────────────
  {
    name: "welcome-quick-actions-new",
    entry: "welcome",
    query: WELCOME_NEW,
    run: async (page) => {
      await expect(page.getByText("Welcome to Daintree")).toBeVisible();
      return visible(page.getByTestId("quick-actions"));
    },
  },
  {
    name: "welcome-quick-actions-recents",
    entry: "welcome",
    query: WELCOME_RECENTS,
    run: async (page) => {
      await expect(page.getByText("Helios Dashboard")).toBeVisible();
      return visible(page.getByTestId("quick-actions"));
    },
  },
  {
    name: "welcome-quick-actions-hover",
    entry: "welcome",
    query: WELCOME_NEW,
    run: async (page) => {
      const group = await visible(page.getByTestId("quick-actions"));
      await group.getByRole("button", { name: "Create project", exact: true }).hover();
      return group;
    },
  },
  {
    name: "welcome-quick-actions-focus",
    entry: "welcome",
    query: WELCOME_NEW,
    run: async (page) => {
      const group = await visible(page.getByTestId("quick-actions"));
      const card = group.getByRole("button", { name: "Create project", exact: true });
      // A key press first, so the programmatic focus that follows is keyboard
      // modality and `:focus-visible` matches as it would for a Tab.
      await page.keyboard.press("Shift");
      await card.focus();
      await expect
        .poll(() => card.evaluate((el) => el.matches(":focus-visible")), { timeout: WAIT_MS })
        .toBe(true);
      return group;
    },
  },
  {
    name: "welcome-detail-banner",
    entry: "welcome",
    query: WELCOME_NEW,
    run: async (page) => visible(page.getByTestId("agent-setup-banner")),
  },
  {
    name: "welcome-detail-card",
    entry: "welcome",
    query: WELCOME_CARD,
    run: async (page) => {
      await expect(page.getByText("Installed agents found")).toBeVisible({ timeout: WAIT_MS });
      return visible(page.getByRole("button", { name: "Dismiss welcome card" }).locator(".."));
    },
  },

  // ── Crash recovery ───────────────────────────────────────────────────
  {
    name: "crash-recovery-panels",
    entry: "gallery",
    query: "scene=crash&panels=1",
    run: async (page) => {
      const dialog = await visible(page.getByTestId("crash-recovery-dialog"));
      await expect(dialog.getByTestId("panel-list")).toBeVisible();
      await expect(
        dialog.getByRole("button", { name: /Continue without restoring/ })
      ).toBeVisible();
      // The test id sits on AppDialog's full-screen scrim; the panel is its child.
      return dialog.locator(":scope > div").first();
    },
  },
  {
    name: "crash-recovery-no-panels",
    entry: "gallery",
    query: "scene=crash&panels=0",
    run: async (page) => {
      const dialog = await visible(page.getByTestId("crash-recovery-dialog"));
      await expect(dialog.getByText("Restore previous session")).toBeVisible();
      await expect(dialog.getByTestId("panel-list")).toHaveCount(0);
      // The test id sits on AppDialog's full-screen scrim; the panel is its child.
      return dialog.locator(":scope > div").first();
    },
  },
  {
    name: "crash-recovery-report",
    entry: "gallery",
    query: "scene=crash&panels=1",
    run: async (page) => {
      const dialog = await visible(page.getByTestId("crash-recovery-dialog"));
      await page.getByTestId("details-toggle").click();
      await page.getByTestId("report-button").click();
      const submit = page.getByTestId("submit-report-button");
      await expect(submit).toBeVisible({ timeout: WAIT_MS });
      // The dialog body scrolls; bring the Submit / Cancel pair into the frame.
      await submit.scrollIntoViewIfNeeded();
      await expect(page.getByTestId("cancel-report-button")).toBeInViewport();
      await park(page);
      // The test id sits on AppDialog's full-screen scrim; the panel is its child.
      return dialog.locator(":scope > div").first();
    },
  },

  // ── Assistant panel ──────────────────────────────────────────────────
  {
    name: "help-agent-chooser",
    entry: "gallery",
    query: "scene=help-chooser",
    run: async (page) => {
      const chooser = await visible(page.getByTestId("help-agent-chooser"));
      await expect(chooser.getByRole("button")).toHaveCount(3);
      return chooser;
    },
  },
  {
    name: "help-agent-chooser-hover",
    entry: "gallery",
    query: "scene=help-chooser",
    run: async (page) => {
      const chooser = await visible(page.getByTestId("help-agent-chooser"));
      await chooser.getByTestId("help-choose-agent-codex").hover();
      return chooser;
    },
  },
  {
    name: "help-starter-prompts",
    entry: "gallery",
    query: "scene=help-panel",
    run: async (page) => {
      const start = await visible(page.getByTestId("help-start-assistant"));
      await expect(page.getByText("Or start with a question")).toBeVisible();
      await expect(
        page.getByRole("button", { name: /How do I set up a new worktree/ })
      ).toBeVisible();
      return start.locator("..");
    },
  },

  // ── Recipes band ─────────────────────────────────────────────────────
  {
    name: "recipe-empty-suggestions",
    entry: "recipes",
    query: "view=runner&fixture=suggestions",
    run: async (page) => {
      const empty = await visible(page.getByTestId("recipe-runner-empty"));
      await expect(empty.getByTestId("recipe-suggestion-pill")).toHaveCount(2);
      await expect(empty.getByText("Create your first recipe…")).toBeVisible();
      return empty;
    },
  },
  {
    name: "recipe-empty-suggestions-hover",
    entry: "recipes",
    query: "view=runner&fixture=suggestions",
    run: async (page) => {
      const empty = await visible(page.getByTestId("recipe-runner-empty"));
      await empty.getByTestId("recipe-suggestion-pill").first().hover();
      return empty;
    },
  },
  {
    name: "recipe-empty-zero",
    entry: "recipes",
    query: "view=runner&fixture=empty",
    run: async (page) => {
      const empty = await visible(page.getByTestId("recipe-runner-empty"));
      await expect(empty.getByTestId("recipe-suggestion-pill")).toHaveCount(0);
      await expect(empty.getByText("Create your first recipe…")).toBeVisible();
      return empty;
    },
  },
  {
    name: "recipe-grid-create",
    entry: "recipes",
    query: "view=runner&fixture=three",
    run: async (page) => {
      const band = await visible(page.locator("[data-preview-band]"));
      await expect(band.getByText("Create new recipe…")).toBeVisible();
      await expect(band.getByRole("combobox", { name: "Filter recipes" })).toHaveCount(0);
      return band;
    },
  },
  {
    name: "recipe-list-create",
    entry: "recipes",
    query: "view=runner&fixture=many",
    run: async (page) => {
      const band = await visible(page.locator("[data-preview-band]"));
      await expect(band.getByRole("combobox", { name: "Filter recipes" })).toBeVisible();
      await expect(band.getByText("Create new recipe…")).toBeVisible();
      return band;
    },
  },

  // ── Canvas launcher ──────────────────────────────────────────────────
  {
    name: "launcher-quick-actions",
    entry: "gallery",
    query: "scene=launcher-quick-actions",
    run: async (page) => {
      const surface = page.locator("[data-preview-surface]");
      await expect(surface.getByRole("button", { name: /Codex/ }).first()).toBeVisible();
      await expect(surface.getByRole("button", { name: /New terminal/ })).toBeVisible();
      return surface;
    },
  },
  {
    name: "launcher-quick-actions-hover",
    entry: "gallery",
    query: "scene=launcher-quick-actions",
    run: async (page) => {
      const surface = page.locator("[data-preview-surface]");
      await surface.getByRole("button", { name: /Codex/ }).first().hover();
      return surface;
    },
  },

  // ── Setup wizard: Appearance ─────────────────────────────────────────
  {
    name: "setup-theme-cards",
    entry: "buttonStates",
    query: "fixture=setup-wizard&first=1",
    run: async (page) => visible(page.getByRole("radiogroup", { name: "Theme" })),
  },
  {
    name: "setup-theme-cards-hover",
    entry: "buttonStates",
    query: "fixture=setup-wizard&first=1",
    run: async (page) => {
      const group = await visible(page.getByRole("radiogroup", { name: "Theme" }));
      await group.locator("label:has(input:not(:checked))").first().hover();
      return group;
    },
  },

  // ── Portal launchpad ─────────────────────────────────────────────────
  {
    name: "portal-launchpad",
    entry: "portal",
    query: "fixture=launchpad-first-run",
    run: async (page) => {
      const section = await visible(
        page.locator('section[aria-labelledby="portal-launchpad-heading"]')
      );
      await expect(section.getByRole("button", { name: /ChatGPT/ }).first()).toBeVisible();
      return section;
    },
  },
  {
    name: "portal-launchpad-hover",
    entry: "portal",
    query: "fixture=launchpad-first-run",
    run: async (page) => {
      const section = await visible(
        page.locator('section[aria-labelledby="portal-launchpad-heading"]')
      );
      await section
        .getByRole("button", { name: /ChatGPT/ })
        .first()
        .hover();
      return section;
    },
  },

  // ── Settings: resource environments ──────────────────────────────────
  {
    name: "settings-environments-add",
    entry: "gallery",
    query: "scene=environments",
    run: async (page) => {
      const surface = page.locator("[data-preview-surface]");
      await surface.getByRole("button", { name: "Add environment" }).first().click();
      const form = await visible(surface.getByTestId("add-environment-form"));
      await form.locator("input").fill("staging");
      await park(page);
      // The settings group holding the environment picker and the add form:
      // their innermost common ancestor (ancestors precede descendants in DOM
      // order, so the last match is the deepest).
      return surface
        .locator("div")
        .filter({ has: page.getByTestId("environment-selector-bar") })
        .filter({ has: page.getByTestId("add-environment-form") })
        .last();
    },
  },
];

/** Hold each entry open once until Vite's optimizer stops force-reloading it. */
async function warmUp(context: BrowserContext, theme: string): Promise<void> {
  const firstQuery: Record<EntryName, string> = {
    welcome: WELCOME_NEW,
    gallery: "scene=help-chooser",
    buttonStates: "fixture=setup-wizard&first=1",
    recipes: "view=runner&fixture=three",
    portal: "fixture=launchpad-first-run",
  };
  for (const name of Object.keys(ENTRIES) as EntryName[]) {
    const page = await context.newPage();
    await stubViteHmrClient(page);
    let navigations = 0;
    page.on("framenavigated", () => navigations++);
    try {
      await page.goto(
        `${server!.baseURL}/${ENTRIES[name].path}?theme=${theme}&${firstQuery[name]}`,
        {
          timeout: 180_000,
        }
      );
      for (let attempt = 0; attempt < 12; attempt++) {
        const before = navigations;
        await page.waitForTimeout(2_500);
        if (navigations === before) break;
      }
    } catch (error) {
      console.warn(`[choice-cards] warm-up of ${name} failed: ${String(error)}`);
    } finally {
      await page.close().catch(() => undefined);
    }
  }
}

async function open(page: Page, entryName: EntryName, theme: string, query: string): Promise<void> {
  const entry = ENTRIES[entryName];
  await page.setViewportSize(entry.viewport);
  await page.emulateMedia({ colorScheme: LIGHT_THEMES.has(theme) ? "light" : "dark" });
  await park(page);
  const url = `${server!.baseURL}/${entry.path}?theme=${theme}&${query}`;
  await page.goto(url, { waitUntil: "load", timeout: 120_000 });
  await page.addStyleTag({ content: FREEZE_CSS });
  await entry.ready(page);
  await settle(page, 400);
}

/** The target plus a margin, clipped from the page; the viewport grows to fit. */
async function snap(page: Page, target: Locator, file: string): Promise<string> {
  await settle(page, 200);
  let box = await target.boundingBox();
  if (!box || box.width < 20 || box.height < 20) {
    throw new Error(`${file}: capture target has no real box (${JSON.stringify(box)})`);
  }
  const vp = page.viewportSize()!;
  if (box.x + box.width + PAD > vp.width || box.y + box.height + PAD > vp.height) {
    await page.setViewportSize({
      width: Math.max(vp.width, Math.ceil(box.x + box.width + PAD * 2)),
      height: Math.max(vp.height, Math.ceil(box.y + box.height + PAD * 2)),
    });
    await settle(page, 300);
    box = await target.boundingBox();
    if (!box) throw new Error(`${file}: capture target vanished after resize`);
  }
  const now = page.viewportSize()!;
  const x = Math.max(0, box.x - PAD);
  const y = Math.max(0, box.y - PAD);
  const clip = {
    x,
    y,
    width: Math.min(now.width - x, box.width + (box.x - x) + PAD),
    height: Math.min(now.height - y, box.height + (box.y - y) + PAD),
  };
  const out = path.join(OUT_DIR, file);
  await page.screenshot({ path: out, clip });
  if (!existsSync(out)) throw new Error(`${file}: screenshot did not land`);
  return out;
}

async function capture(context: BrowserContext, state: State, theme: string): Promise<string> {
  const file = `${state.name}-${theme}.png`;
  for (let attempt = 1; ; attempt++) {
    const page = await context.newPage();
    await stubViteHmrClient(page);
    let crashed = false;
    const errors: string[] = [];
    page.on("crash", () => {
      crashed = true;
    });
    page.on("pageerror", (error) => errors.push(error.stack ?? String(error)));
    try {
      await open(page, state.entry, theme, state.query);
      const target = await state.run(page);
      if (errors.length > 0) throw new Error(`page threw: ${errors.join(" | ")}`);
      const out = await snap(page, target, file);
      if (errors.length > 0) {
        rmSync(out, { force: true });
        throw new Error(`page threw: ${errors.join(" | ")}`);
      }
      return file;
    } catch (error) {
      const retryable = crashed || /timeout|crash|Target closed/i.test(String(error));
      if (attempt === 1 && retryable) {
        console.warn(`[choice-cards] ${file}: retrying once after ${String(error).slice(0, 200)}`);
        continue;
      }
      throw new Error(`${file}: ${String(error)}`, { cause: error });
    } finally {
      await page.close().catch(() => undefined);
    }
  }
}

test("choice cards review — every state, every theme", async ({ context }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_CHOICE_CARDS is required for the choice cards capture",
  });
  test.skip(!ENABLED, "Set DAINTREE_SHOT_CHOICE_CARDS to run the choice cards capture");
  test.setTimeout(3_600_000);

  await warmUp(context, THEMES[0] ?? "daintree");

  const selected = STATES.filter(
    (s) => ONLY.length === 0 || ONLY.some((prefix) => s.name.startsWith(prefix))
  );
  const expected: string[] = [];
  for (const theme of THEMES) {
    for (const state of selected) {
      expected.push(await capture(context, state, theme));
    }
  }

  const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  for (const file of expected) expect(onDisk, `${file} missing`).toContain(file);
  expect(onDisk.length).toBe(expected.length);
  expect(onDisk.length).toBe(THEMES.length * selected.length);
  console.log(`[choice-cards] ${onDisk.length} PNGs in ${OUT_DIR}`);
});
