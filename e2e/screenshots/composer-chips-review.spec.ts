/**
 * Composer attachment chips review harness.
 *
 * The chips a pasted image or a dropped file becomes in the agent composer,
 * their remove control, the two-step Backspace delete, and the hover card every
 * chip kind opens. None of it is reachable without a draft that already holds
 * the chips, and the hover cards only exist while a pointer rests on one, so
 * this drives the composer's own preview entry (`hybrid-input-preview.html`,
 * `?case=chips`): the real `HybridInputBar`, the real CodeMirror widgets and
 * tooltips, the real theme tokens. The image and the file go in through
 * `insertFileAttachments`, the function every drop, paste and attach-picker
 * path ends in; the token chips come from the seeded draft.
 *
 * Opt-in only: skips itself unless DAINTREE_SHOT_COMPOSER_CHIPS is set.
 *
 *   DAINTREE_SHOT_COMPOSER_CHIPS=1 DAINTREE_SHOT_DIR=/abs/out \
 *     npx playwright test --project=screenshots composer-chips-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_COMPOSER_CHIPS  required — any truthy value runs the capture
 *   DAINTREE_SHOT_DIR             required — an ABSOLUTE output directory outside the repo
 *   DAINTREE_SHOT_THEMES          themes to sweep (default daintree,namib,redwoods,bondi,svalbard,atacama)
 *
 * Every capture proves the state it names before it is written — the hover card
 * that belongs to the hovered chip is open and carries that chip's content, a
 * staged chip is the one staged, a focused remove control holds focus — and the
 * test counts the files itself at the end. Each theme also writes a JSON sidecar
 * of the painted values (remove control box, card padding, colours) so a
 * reading of the pixels can be checked against what was actually rendered.
 */

import { test, expect, type Locator, type Page } from "@playwright/test";
import { mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync } from "fs";
import path from "path";
import {
  makeSnap,
  startPreviewServer,
  stubViteHmrClient,
  type PreviewServer,
} from "../helpers/previewHarness";

const ENABLED = !!process.env.DAINTREE_SHOT_COMPOSER_CHIPS;
const OUT_DIR = process.env.DAINTREE_SHOT_DIR ?? "";
const THEMES = (
  process.env.DAINTREE_SHOT_THEMES ?? "daintree,namib,redwoods,bondi,svalbard,atacama"
)
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

// 2× so a 14px glyph, a 1px card border and the padding inside a hover card are
// judged at the size a Retina user sees them.
test.use({ deviceScaleFactor: 2 });

const FREEZE_CSS = `
  *, *::before, *::after {
    animation-duration: 0s !important;
    animation-delay: 0s !important;
    transition-duration: 0s !important;
    transition-delay: 0s !important;
  }
  .cm-cursor { display: none !important; }
`;

/** The hover cards, in the order the review reads them, with text that proves which one opened. */
const TOKEN_TOOLTIPS = [
  { key: "slash", chip: ".cm-slash-command-chip", text: "Summarize history" },
  { key: "file", chip: ".cm-file-chip", text: "src/components/Terminal/HybridInputBar.tsx" },
  { key: "diff", chip: ".cm-diff-chip", text: "staged diff" },
  { key: "terminal", chip: ".cm-terminal-chip", text: "terminal output" },
  { key: "selection", chip: ".cm-selection-chip", text: "selection" },
] as const;

let server: PreviewServer | undefined;
let snap: ReturnType<typeof makeSnap>;

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
    if (file.endsWith(".png") || file.endsWith(".json")) {
      rmSync(path.join(OUT_DIR, file), { force: true });
    }
  }
  snap = makeSnap(OUT_DIR);
  server = await startPreviewServer();
});

test.afterAll(async () => {
  await server?.close();
});

async function open(page: Page, theme: string): Promise<Locator> {
  const params = new URLSearchParams({ case: "chips", theme });
  await page.goto(`${server!.baseURL}/hybrid-input-preview.html?${params.toString()}`);
  await page.addStyleTag({ content: FREEZE_CSS });
  const sheet = page.locator('#root > div[data-preview-case="chips"]');
  await expect(sheet).toBeAttached();
  await expect(page.locator(".cm-content")).toHaveCount(1);

  // Every token chip from the draft, before anything is attached. A chip kind
  // that failed to solidify photographs as plain text, which reads as a
  // design decision rather than the harness fault it is.
  for (const { chip } of TOKEN_TOOLTIPS) {
    await expect(page.locator(chip), `${chip} never rendered`).toHaveCount(1);
  }

  const attached = await page.evaluate(() =>
    (
      window as unknown as { __composerChips: { attach: () => Promise<number> } }
    ).__composerChips.attach()
  );
  expect(attached).toBe(2);
  await expect(page.locator(".cm-image-chip")).toHaveCount(1);
  await expect(page.locator(".cm-file-drop-chip")).toHaveCount(1);
  // The thumbnail has to have decoded, or the chip and its card photograph a
  // broken-image box.
  await expect
    .poll(() =>
      page.locator(".cm-image-chip img").evaluate((img: HTMLImageElement) => img.naturalWidth)
    )
    .toBeGreaterThan(0);
  return sheet;
}

async function pointerAway(page: Page): Promise<void> {
  await page.mouse.move(2, 2);
  await expect(page.locator(".cm-tooltip-hover")).toHaveCount(0, { timeout: 3000 });
}

/** Rest the pointer on the first line box of `selector`, so a wrapped chip is hovered on its text. */
async function hoverChip(page: Page, selector: string): Promise<void> {
  const point = await page
    .locator(selector)
    .first()
    .evaluate((el) => {
      const rect = el.getClientRects()[0] ?? el.getBoundingClientRect();
      return { x: rect.left + Math.min(rect.width / 2, 40), y: rect.top + rect.height / 2 };
    });
  await page.mouse.move(point.x, point.y);
}

/** The open hover card: exactly one, with a real box, carrying `text`. */
async function proveCard(page: Page, text: string): Promise<void> {
  const card = page.locator(".cm-tooltip-hover");
  await expect(card).toHaveCount(1, { timeout: 3000 });
  await expect(card).toContainText(text);
  const box = await card.boundingBox();
  if (!box || box.width < 24 || box.height < 12) {
    throw new Error(`hover card has no real box (${JSON.stringify(box)}) — refusing to write`);
  }
}

/** Painted values for the sidecar: what the reviewer can check a reading of the pixels against. */
async function readCard(page: Page) {
  return page.locator(".cm-tooltip-hover").evaluate((wrapper) => {
    const card = wrapper.firstElementChild as HTMLElement | null;
    if (!card) return null;
    const cs = getComputedStyle(card);
    const texts = Array.from(card.querySelectorAll<HTMLElement>("p, span, div"))
      .filter((el) => el.childElementCount === 0 && el.textContent?.trim())
      .map((el) => {
        const t = getComputedStyle(el);
        return { text: el.textContent, color: t.color, fontSize: t.fontSize, font: t.fontFamily };
      });
    return {
      padding: cs.padding,
      background: cs.backgroundColor,
      border: `${cs.borderTopWidth} ${cs.borderTopStyle} ${cs.borderTopColor}`,
      radius: cs.borderTopLeftRadius,
      shadow: cs.boxShadow,
      width: card.getBoundingClientRect().width,
      texts,
    };
  });
}

async function readRemove(page: Page, chip: string) {
  return page.locator(`${chip} .cm-chip-remove`).evaluate((btn) => {
    const cs = getComputedStyle(btn);
    const r = btn.getBoundingClientRect();
    // The pointer target is the button box plus anything a pseudo-element adds.
    const before = getComputedStyle(btn, "::before");
    return {
      box: { w: r.width, h: r.height },
      opacity: cs.opacity,
      pointerEvents: cs.pointerEvents,
      color: cs.color,
      background: cs.backgroundColor,
      outline: `${cs.outlineStyle} ${cs.outlineWidth} ${cs.outlineColor}`,
      beforeInset: before.content === "none" ? null : before.inset,
      tabIndex: (btn as HTMLButtonElement).tabIndex,
      ariaHidden: btn.getAttribute("aria-hidden"),
      label: btn.getAttribute("aria-label"),
      glyph: btn.querySelector("svg") ? "svg" : btn.textContent,
    };
  });
}

test("composer attachment chips", async ({ page }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_COMPOSER_CHIPS is required for the chips capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_COMPOSER_CHIPS=1 to run the capture");
  test.setTimeout(600_000);

  await stubViteHmrClient(page);
  // A module that throws leaves `#root` empty and every later wait reads as a
  // timeout; surface the throw itself.
  page.on("pageerror", (err) => console.error(`[composer-chips-shots] page error: ${err.message}`));
  await page.setViewportSize({ width: 1000, height: 640 });
  const written: string[] = [];

  for (const theme of THEMES) {
    const facts: Record<string, unknown> = { theme };
    const sheet = await open(page, theme);

    // Rest: the keyboard in the composer with the caret after the last chip,
    // as it is the moment after a drop, and the pointer elsewhere.
    await page.locator(".cm-content").focus();
    await pointerAway(page);
    facts.restRemove = await readRemove(page, ".cm-file-drop-chip");
    // What assistive tech reads for each chip: its name, and the card's facts.
    facts.chipNames = await page.evaluate(() =>
      Array.from(document.querySelectorAll(".cm-content [role='img']")).map((el) => ({
        name: el.getAttribute("aria-label"),
        description: el.getAttribute("aria-description"),
      }))
    );
    written.push(await snap(sheet, `rest--${theme}.png`));

    // The two attachment chips under the pointer: the remove control revealed,
    // and each one's card.
    await hoverChip(page, ".cm-image-chip .cm-chip-label");
    await proveCard(page, "clipboard-20261015-143210-a1b2.png");
    facts.imageCard = await readCard(page);
    written.push(await snap(sheet, `hover-image--${theme}.png`));
    await pointerAway(page);

    await hoverChip(page, ".cm-file-drop-chip .cm-chip-label");
    await proveCard(page, "quarterly-report-q3.pdf");
    facts.fileDropCard = await readCard(page);
    facts.hoverRemove = await readRemove(page, ".cm-file-drop-chip");
    written.push(await snap(sheet, `hover-file-drop--${theme}.png`));

    // The pointer on the remove control itself.
    const remove = page.locator(".cm-file-drop-chip .cm-chip-remove");
    const rb = await remove.boundingBox();
    if (!rb) throw new Error("remove control has no box — refusing to write");
    await page.mouse.move(rb.x + rb.width / 2, rb.y + rb.height / 2);
    await expect.poll(() => remove.evaluate((el) => el.matches(":hover"))).toBe(true);
    facts.pointerOnRemove = await readRemove(page, ".cm-file-drop-chip");
    written.push(await snap(sheet, `hover-remove--${theme}.png`));
    await pointerAway(page);

    for (const { key, chip, text } of TOKEN_TOOLTIPS) {
      await hoverChip(page, chip);
      await proveCard(page, text);
      facts[`${key}Card`] = await readCard(page);
      written.push(await snap(sheet, `tooltip-${key}--${theme}.png`));
      await pointerAway(page);
    }

    // Escape dismisses an open card without moving the pointer (WCAG 1.4.13).
    await hoverChip(page, ".cm-diff-chip");
    await proveCard(page, "staged diff");
    await page.keyboard.press("Escape");
    facts.escapeDismisses = (await page.locator(".cm-tooltip-hover").count()) === 0;
    await pointerAway(page);

    // The two-step Backspace delete, the way a user reaches it: the caret at
    // the end of the draft, one Backspace to take the space the drop left
    // after the chip, a second to stage the chip — and exactly that one staged.
    await page.locator(".cm-content").focus();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.press("Backspace");
    await page.keyboard.press("Backspace");
    await expect(page.locator(".cm-file-drop-chip.cm-chip-pending-delete")).toHaveCount(1);
    await expect(page.locator(".cm-chip-pending-delete")).toHaveCount(1);
    facts.pendingRemove = await readRemove(page, ".cm-file-drop-chip");
    written.push(await snap(sheet, `pending-delete--${theme}.png`));

    // The remove control holding keyboard focus. A key first, so the focus
    // that follows is keyboard-modality and `:focus-visible` applies the way
    // it would for a keyboard user who reached it.
    await page.keyboard.press("Shift");
    const focused = await remove.evaluate((btn: HTMLButtonElement) => {
      btn.focus();
      return document.activeElement === btn;
    });
    facts.removeFocusable = focused;
    if (focused) {
      await expect.poll(() => remove.evaluate((el) => el.matches(":focus-visible"))).toBe(true);
      facts.focusRemove = await readRemove(page, ".cm-file-drop-chip");
      written.push(await snap(sheet, `focus-remove--${theme}.png`));

      // What a keyboard activation of the focused control does.
      const before = await page.locator(".cm-file-drop-chip").count();
      await page.keyboard.press("Enter");
      await page.waitForTimeout(150);
      facts.enterRemoves = (await page.locator(".cm-file-drop-chip").count()) < before;
    }

    // Where Tab goes from the composer: whether the remove control is in the
    // tab order at all.
    await open(page, theme);
    await page.evaluate(() =>
      (
        window as unknown as { __composerChips: { caretAfter: (k: string) => void } }
      ).__composerChips.caretAfter("image")
    );
    await page.keyboard.press("Tab");
    facts.tabFromComposer = await page.evaluate(() => {
      const a = document.activeElement as HTMLElement | null;
      if (!a) return "none";
      return `${a.tagName.toLowerCase()}[${a.getAttribute("aria-label") ?? a.className}]`;
    });

    writeFileSync(path.join(OUT_DIR, `facts--${theme}.json`), JSON.stringify(facts, null, 2));
    console.log(
      `[composer-chips-shots] ${theme}: focusable=${focused} tab=${facts.tabFromComposer} enterRemoves=${facts.enterRemoves} escape=${facts.escapeDismisses}`
    );
  }

  const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  expect(onDisk.length).toBe(written.length);
  console.log(`[composer-chips-shots] ${onDisk.length} PNGs in ${OUT_DIR}`);
});
