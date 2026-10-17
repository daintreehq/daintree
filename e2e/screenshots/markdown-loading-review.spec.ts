/**
 * Markdown loading-swap visual-review harness.
 *
 * `MarkdownViewer` shows a skeleton while the lazy document chunk loads, and the
 * rendered document replaces it in the same box. Whether that swap moves
 * anything — the inset, the reading column, the first line — is only visible by
 * putting the two frames side by side at the same coordinates, and the
 * placeholder is only on screen for the first rendered open of a session. So
 * this drives `markdown-loading-preview.html` and holds the one module request
 * for `MarkdownDocument.tsx` open: photograph the placeholder, release the
 * request, photograph the document, and record where each one's first line sits.
 *
 * Opt-in only, like every sibling review harness:
 *
 *   DAINTREE_SHOT_MDLOADING=1 npx playwright test --project=screenshots markdown-loading-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_MDLOADING  required — any truthy value runs the capture
 *   DAINTREE_SHOT_DIR        output directory (default artifacts/markdown-loading-shots)
 *
 * Reduced motion is emulated so the bones are static once the anti-flicker gate
 * has passed: a pulse caught at its trough would read as a different colour,
 * not a different position, and position is the whole question here.
 *
 * Hard rule, inherited from the siblings: never write a PNG that has not been
 * verified. The skeleton frame is refused unless a bone is painted at full
 * opacity, the document frame unless the document has text in it, and the test
 * counts the files itself at the end.
 */

import { test, expect, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "fs";
import path from "path";
import {
  makeSnap,
  startPreviewServer,
  stubViteHmrClient,
  type PreviewServer,
} from "../helpers/previewHarness";

const ENABLED = !!process.env.DAINTREE_SHOT_MDLOADING;

const OUT_DIR = path.resolve(
  process.env.DAINTREE_SHOT_DIR ?? path.join(process.cwd(), "artifacts", "markdown-loading-shots")
);

const DOCUMENT_MODULE = "**/src/components/Markdown/MarkdownDocument.tsx*";

interface State {
  name: string;
  theme: string;
  doc: "readme" | "notes";
  width: number;
  size?: string;
}

const STATES: State[] = [
  { name: "pane-readme", theme: "daintree", doc: "readme", width: 720 },
  { name: "pane-notes", theme: "daintree", doc: "notes", width: 720 },
  { name: "wide-readme", theme: "daintree", doc: "readme", width: 1100 },
  { name: "narrow-readme", theme: "daintree", doc: "readme", width: 440 },
  { name: "light-readme", theme: "bondi", doc: "readme", width: 720 },
  { name: "large-notes", theme: "daintree", doc: "notes", width: 720, size: "lg" },
  // The two ends of the reading-size scale, where a bar rhythm tuned to the
  // default either drowns the line or floats between them.
  { name: "smallest-notes", theme: "daintree", doc: "notes", width: 720, size: "2xs" },
  { name: "largest-notes", theme: "daintree", doc: "notes", width: 720, size: "3xl" },
];

const HEIGHT = 560;

let server: PreviewServer | undefined;

test.beforeAll(async () => {
  // No test.skip here: `test.info()` is unavailable in a beforeAll hook, so the
  // structured-skip annotation the repo requires cannot be attached. The test
  // body carries the skip; this hook simply does no work when the flag is unset.
  if (!ENABLED) return;
  if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });
  server = await startPreviewServer();
});

test.afterAll(async () => {
  await server?.close();
});

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

const round = (r: DOMRect | Box): Box => ({
  x: Math.round(r.x * 10) / 10,
  y: Math.round(r.y * 10) / 10,
  width: Math.round(r.width * 10) / 10,
  height: Math.round(r.height * 10) / 10,
});

async function measureSkeleton(page: Page) {
  return page.evaluate(() => {
    const status = document.querySelector<HTMLElement>('[role="status"]')!;
    const wrapper = status.parentElement!;
    const body = document
      .querySelector<HTMLElement>("[data-preview-body]")!
      .getBoundingClientRect();
    const bones = [...status.querySelectorAll<HTMLElement>("[data-skeleton-bone]")];
    const rel = (r: DOMRect) => ({
      x: r.x - body.x,
      y: r.y - body.y,
      width: r.width,
      height: r.height,
    });
    return {
      wrapper: rel(wrapper.getBoundingClientRect()),
      firstBone: rel(bones[0]!.getBoundingClientRect()),
      secondBone: rel(bones[1]!.getBoundingClientRect()),
      lastBone: rel(bones[bones.length - 1]!.getBoundingClientRect()),
      bones: bones.length,
      boneOpacity: getComputedStyle(bones[0]!).opacity,
    };
  });
}

async function measureDocument(page: Page) {
  return page.evaluate(() => {
    const docEl = document.querySelector<HTMLElement>(".markdown-document")!;
    const body = document
      .querySelector<HTMLElement>("[data-preview-body]")!
      .getBoundingClientRect();
    const rel = (r: DOMRect) => ({
      x: r.x - body.x,
      y: r.y - body.y,
      width: r.width,
      height: r.height,
    });
    const first = docEl.firstElementChild as HTMLElement;
    // The first text node's first client rect is the glyph band of the first
    // line (ascent to descent), which is what a text bone stands in for.
    const walker = document.createTreeWalker(first, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node && !node.textContent?.trim()) node = walker.nextNode();
    const range = document.createRange();
    if (node) range.selectNodeContents(node);
    const glyphs = node ? range.getClientRects()[0] : undefined;
    // The first paragraph, wherever it is, for the body line pitch.
    const p = docEl.querySelector("p");
    const pStyle = p ? getComputedStyle(p) : undefined;
    const docStyle = getComputedStyle(docEl);
    return {
      document: rel(docEl.getBoundingClientRect()),
      padding: `${docStyle.paddingTop} ${docStyle.paddingRight} ${docStyle.paddingBottom} ${docStyle.paddingLeft}`,
      firstBlock: { tag: first.tagName.toLowerCase(), ...rel(first.getBoundingClientRect()) },
      firstLineGlyphs: glyphs ? rel(glyphs) : null,
      firstBlockFont: `${getComputedStyle(first).fontSize} / ${getComputedStyle(first).lineHeight}`,
      bodyFont: pStyle ? `${pStyle.fontSize} / ${pStyle.lineHeight}` : null,
      textLength: docEl.textContent?.trim().length ?? 0,
    };
  });
}

test("Markdown loading swap — skeleton and document in the same box", async ({ page }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_MDLOADING is required for the Markdown loading capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_MDLOADING=1 to run the capture");

  const snap = makeSnap(OUT_DIR);
  await stubViteHmrClient(page);
  await page.emulateMedia({ reducedMotion: "reduce" });

  const written: string[] = [];
  const metrics: Record<string, unknown>[] = [];

  for (const state of STATES) {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    await page.route(DOCUMENT_MODULE, async (route) => {
      await gate;
      await route.continue();
    });

    await page.setViewportSize({ width: state.width, height: HEIGHT });
    const query = new URLSearchParams({
      theme: state.theme,
      doc: state.doc,
      width: String(state.width),
    });
    if (state.size) query.set("size", state.size);
    await page.goto(`${server!.baseURL}/markdown-loading-preview.html?${query}`);

    const shell = page.locator("[data-preview-shell]").first();
    await expect(page.getByRole("status", { name: "Loading markdown" })).toBeAttached();
    // Past the 400ms anti-flicker gate, under reduced motion the bones then show
    // in one step. Refuse a frame where they have not.
    await expect
      .poll(async () => (await measureSkeleton(page)).boneOpacity, { timeout: 5_000 })
      .toBe("1");
    const skeleton = await measureSkeleton(page);
    written.push(await snap(shell, `${state.name}--loading.png`));

    release();
    await page.unroute(DOCUMENT_MODULE);
    await expect(page.locator(".markdown-document")).toBeAttached({ timeout: 15_000 });
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        )
    );
    const doc = await measureDocument(page);
    if (doc.textLength === 0) throw new Error(`${state.name}: document rendered no text`);
    written.push(await snap(shell, `${state.name}--loaded.png`));

    metrics.push({
      state: state.name,
      skeleton: {
        ...skeleton,
        wrapper: round(skeleton.wrapper),
        firstBone: round(skeleton.firstBone),
        secondBone: round(skeleton.secondBone),
        lastBone: round(skeleton.lastBone),
      },
      document: {
        ...doc,
        document: round(doc.document),
        firstBlock: { ...doc.firstBlock, ...round(doc.firstBlock) },
        firstLineGlyphs: doc.firstLineGlyphs ? round(doc.firstLineGlyphs) : null,
      },
    });
  }

  writeFileSync(path.join(OUT_DIR, "metrics.json"), JSON.stringify(metrics, null, 2));

  const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  expect(onDisk.length).toBe(written.length);
  expect(onDisk.length).toBe(STATES.length * 2);
  console.log(`[markdown-loading-shots] ${onDisk.length} PNGs in ${OUT_DIR}`);
});
