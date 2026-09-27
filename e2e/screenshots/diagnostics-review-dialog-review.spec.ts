/**
 * Diagnostics review dialog visual-review harness.
 *
 * Drives `diagnostics-review-dialog-preview.html`, which mounts the real
 * `DiagnosticsReviewDialogHost` and opens it by writing a collector-shaped
 * report into `useDiagnosticsReviewStore`, the way `openReview` does. Every
 * interaction below — picking a log window, ticking redactions, typing rules,
 * opening the two disclosures — goes through the dialog's own controls.
 *
 * Opt-in only, like every sibling review harness:
 *
 *   DAINTREE_SHOT_DIAGNOSTICS_REVIEW=1 DAINTREE_SHOT_DIR=/abs/out \
 *     npx playwright test --project=screenshots diagnostics-review-dialog-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_DIAGNOSTICS_REVIEW  required — any truthy value runs the capture
 *   DAINTREE_SHOT_DIR                 output directory (default artifacts/diagnostics-review-shots)
 *   DAINTREE_SHOT_THEMES              comma-separated theme sweep (default daintree,bondi,namib,redwoods)
 *
 * Output:
 *   <state>-<first theme>.png      every state, first theme
 *   <state>-<theme>.png            the theme subset in the other themes
 *   window-<first theme>.png       the whole window with the scrim
 *   narrow-<first theme>.png       a 520px window
 *   short-<first theme>.png        a 560px-tall window, everything open
 *
 * Never writes a PNG it has not verified, and counts the files itself at the end.
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

const ENABLED = !!process.env.DAINTREE_SHOT_DIAGNOSTICS_REVIEW;

const OUT_DIR = path.resolve(
  process.env.DAINTREE_SHOT_DIR ?? path.join(process.cwd(), "artifacts", "diagnostics-review-shots")
);

const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,bondi,namib,redwoods")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

const WIDTH = 1280;
const HEIGHT = 900;
const NARROW_WIDTH = 520;
const SHORT_HEIGHT = 560;
const ATTACH_TIMEOUT_MS = 30_000;

/** AppDialog puts the role on its full-window scrim; the card is its only child. */
const DIALOG = '[role="dialog"]';
const CARD = '[role="dialog"] > div';

const FREEZE_CSS = `
  ::-webkit-scrollbar { display: none !important; }
  *, *::before, *::after {
    animation-duration: 0s !important;
    animation-delay: 0s !important;
    transition-duration: 0s !important;
    transition-delay: 0s !important;
    caret-color: transparent !important;
  }
`;

test.use({ deviceScaleFactor: 2 });

const snap = makeSnap(OUT_DIR);
let server: PreviewServer | undefined;

test.beforeAll(async () => {
  if (!ENABLED) return;
  if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });
  server = await startPreviewServer();
});

test.afterAll(async () => {
  await server?.close();
});

async function settleDevServer(context: BrowserContext) {
  const page = await context.newPage();
  await stubViteHmrClient(page);
  let navigations = 0;
  page.on("framenavigated", () => navigations++);
  await page.goto(`${server!.baseURL}/diagnostics-review-dialog-preview.html`);
  // Open everything once so lazily loaded primitives are bundled before the sweep.
  for (let attempt = 0; attempt < 6; attempt++) {
    const before = navigations;
    await page.waitForTimeout(2_500);
    const dialogs = await page.locator(DIALOG).count();
    if (dialogs === 1) {
      await page
        .locator(CARD)
        .getByRole("combobox")
        .first()
        .click({ timeout: 2_000 })
        .catch(() => undefined);
      await page.keyboard.press("Escape").catch(() => undefined);
    }
    if (navigations === before && dialogs === 1) break;
  }
  await page.close();
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
    page.on("response", (response) => {
      if (response.status() >= 500) errors.push(`${response.status()} ${response.url()}`);
    });
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(`console: ${msg.text()}`);
    });
    try {
      const result = await body(page);
      if (errors.length > 0) throw new Error(`${what}: page threw: ${errors.join(" | ")}`);
      return result;
    } catch (error) {
      if (crashed && attempt === 1) {
        console.warn(`[diagnostics-review-shots] renderer crashed on ${what}; retrying once`);
        continue;
      }
      throw new Error(
        `${what}: ${String(error)}\n  page errors: ${errors.join(" | ") || "(none)"}`,
        {
          cause: error,
        }
      );
    } finally {
      await page.close().catch(() => undefined);
    }
  }
}

async function open(
  page: Page,
  fixture: string,
  theme: string,
  size: { width: number; height: number } = { width: WIDTH, height: HEIGHT }
): Promise<Locator> {
  await page.setViewportSize(size);
  await page.goto(
    `${server!.baseURL}/diagnostics-review-dialog-preview.html?theme=${theme}&fixture=${fixture}`
  );
  await page.addStyleTag({ content: FREEZE_CSS });
  const card = page.locator(CARD).first();
  await expect(card, `fixture "${fixture}" opened no dialog`).toBeVisible({
    timeout: ATTACH_TIMEOUT_MS,
  });
  await expect(card.getByRole("heading").first()).toHaveText(/\S/);
  await page.evaluate(() => document.fonts.ready);
  await page.mouse.move(0, 0);
  await page.waitForTimeout(250);
  return card;
}

/** Works for a native `<select>` and for the `ui/select` combobox alike. */
async function chooseTimeWindow(card: Locator, label: RegExp) {
  const native = card.locator("select");
  if ((await native.count()) > 0) {
    const value = await native.evaluate(
      (el, source) =>
        Array.from((el as HTMLSelectElement).options).find((o) =>
          new RegExp(source).test(o.textContent ?? "")
        )?.value,
      label.source
    );
    if (!value) throw new Error(`no time-window option matches ${label}`);
    await native.selectOption(value);
    return;
  }
  const page = card.page();
  await card.getByRole("combobox").first().click();
  await page.getByRole("option", { name: label }).click();
  await expect(page.getByRole("listbox")).toHaveCount(0);
}

async function expand(card: Locator, name: RegExp) {
  const toggle = card.getByRole("button", { name }).first();
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
}

async function fillRules(card: Locator) {
  await card.getByRole("checkbox", { name: /email/i }).click();
  await card.getByRole("checkbox", { name: /file paths/i }).click();
  await card.getByRole("textbox", { name: /^Find, rule 1/ }).fill("acme-billing");
  await card.getByRole("button", { name: /add rule/i }).click();
  await card.getByRole("textbox", { name: /^Find, rule 2/ }).fill("alexs-mbp.local");
  await card.getByRole("textbox", { name: /^Replace with, rule 2/ }).fill("[HOST]");
  await card.page().mouse.move(0, 0);
}

async function scrollBody(card: Locator, to: "bottom" | "preview" | "replacement") {
  await card.evaluate((el, where) => {
    const region = el.querySelector<HTMLElement>('[role="region"]');
    const scrollers = Array.from(el.querySelectorAll<HTMLElement>("*")).filter(
      (n) =>
        n !== region &&
        n.scrollHeight > n.clientHeight + 2 &&
        ["auto", "scroll"].includes(getComputedStyle(n).overflowY)
    );
    const body = scrollers[0];
    if (body) {
      if (where === "bottom") body.scrollTop = body.scrollHeight;
      else if (region) {
        const top = region.getBoundingClientRect().top - body.getBoundingClientRect().top;
        body.scrollTop += top - 80;
      }
    }
    if (where === "replacement" && region) {
      const mark = region.querySelector<HTMLElement>(".bg-overlay-strong");
      if (!mark) throw new Error("no highlighted replacement in the preview");
      const offset = mark.getBoundingClientRect().top - region.getBoundingClientRect().top;
      region.scrollTop += offset - 60;
    }
  }, to);
  await card.page().waitForTimeout(150);
}

type Step = (card: Locator) => Promise<void>;

const STATES: Array<{ name: string; fixture: string; step?: Step }> = [
  { name: "default", fixture: "default" },
  {
    name: "time-window-open",
    fixture: "default",
    step: async (card) => {
      const combo = card.getByRole("combobox").first();
      if ((await card.locator("select").count()) > 0) {
        // A native popup never reaches a screenshot; record the focused control instead.
        await card.page().keyboard.press("Tab");
        await combo.focus();
        return;
      }
      await combo.click();
      await expect(card.page().getByRole("listbox")).toBeVisible();
    },
  },
  {
    name: "rotated-hint",
    fixture: "rotated",
    step: async (card) => {
      await chooseTimeWindow(card, /Since updating/);
      await expect(card.getByText(/rotated out/i)).toBeVisible();
    },
  },
  { name: "rules", fixture: "default", step: fillRules },
  {
    name: "sections-open",
    fixture: "default",
    step: async (card) => {
      await expand(card, /^Sections/);
      await scrollBody(card, "bottom");
    },
  },
  {
    name: "scoped",
    fixture: "scoped",
    step: async (card) => {
      await scrollBody(card, "bottom");
    },
  },
  {
    name: "preview-open",
    fixture: "default",
    step: async (card) => {
      await expect(card.getByLabel("Report preview")).toContainText("recentEntries");
      await scrollBody(card, "preview");
    },
  },
  {
    name: "preview-redacted",
    fixture: "default",
    step: async (card) => {
      await fillRules(card);
      await expect(card.getByLabel("Report preview")).toContainText("[REDACTED]");
      await scrollBody(card, "replacement");
    },
  },
  {
    name: "focus-disclosure",
    fixture: "default",
    step: async (card) => {
      const page = card.page();
      const target = card.getByRole("button", { name: /^Sections/ }).first();
      for (let i = 0; i < 30; i++) {
        await page.keyboard.press("Tab");
        if (await target.evaluate((el) => el === document.activeElement)) return;
      }
      throw new Error("Tab never reached the Sections disclosure");
    },
  },
  { name: "saving", fixture: "saving" },
];

const THEME_SUBSET = ["default", "rules", "preview-redacted"];

async function capture(context: BrowserContext, name: string, theme: string, file: string) {
  const state = STATES.find((s) => s.name === name)!;
  return withPage(context, `${name} ${theme}`, async (page) => {
    const card = await open(page, state.fixture, theme);
    await state.step?.(card);
    await page.waitForTimeout(150);
    // The listbox of an open select portals outside the card.
    const target = name === "time-window-open" ? page.locator("[data-preview-shell]") : card;
    return snap(target, file);
  });
}

test("diagnostics review dialog — every state, every theme", async ({ context }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_DIAGNOSTICS_REVIEW is required for the capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_DIAGNOSTICS_REVIEW=1 to run the capture");

  await settleDevServer(context);
  const written: string[] = [];
  const [first, ...rest] = THEMES;

  for (const { name } of STATES) {
    written.push(await capture(context, name, first!, `${name}-${first}.png`));
  }
  for (const theme of rest) {
    for (const name of THEME_SUBSET) {
      written.push(await capture(context, name, theme, `${name}-${theme}.png`));
    }
  }

  written.push(
    await withPage(context, "window", async (page) => {
      await open(page, "default", first!);
      return snap(page.locator("[data-preview-shell]"), `window-${first}.png`);
    })
  );
  written.push(
    await withPage(context, "narrow", async (page) => {
      const card = await open(page, "default", first!, { width: NARROW_WIDTH, height: HEIGHT });
      await fillRules(card);
      return snap(card, `narrow-${first}.png`);
    })
  );
  written.push(
    await withPage(context, "short", async (page) => {
      const card = await open(page, "default", first!, { width: WIDTH, height: SHORT_HEIGHT });
      await expand(card, /^Sections/);
      await scrollBody(card, "bottom");
      return snap(page.locator("[data-preview-shell]"), `short-${first}.png`);
    })
  );

  const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  expect(onDisk.length).toBe(written.length);
  expect(onDisk.length).toBe(STATES.length + rest.length * THEME_SUBSET.length + 3);
  console.log(`[diagnostics-review-shots] ${onDisk.length} PNGs in ${OUT_DIR}`);
});
