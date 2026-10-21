/**
 * Mermaid diagram states visual-review harness.
 *
 * A ```mermaid fence shows its source while the diagram renders, keeps showing
 * it if the diagram fails, and swaps to the diagram when it lands. Whether the
 * waiting and failed states say which one they are, and whether the swap moves
 * the block, is only visible in pixels — and the waiting state only lasts as
 * long as the Mermaid chunk takes to load. So this drives
 * `mermaid-diagram-preview.html` and holds the Mermaid module request open:
 * photograph the pending block, release the request, photograph the diagram,
 * and record where the frame and the paragraph after it sit in each.
 *
 * Opt-in only, like every sibling review harness:
 *
 *   DAINTREE_SHOT_MERMAID=1 npx playwright test --project=screenshots mermaid-diagram-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_MERMAID  required — any truthy value runs the capture
 *   DAINTREE_SHOT_DIR      output directory (default artifacts/mermaid-diagram-shots)
 *
 * Hard rule, inherited from the siblings: never write a PNG that has not been
 * verified. Each frame is refused unless the block reports the state it is
 * named for, and the test counts the files itself at the end.
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

const ENABLED = !!process.env.DAINTREE_SHOT_MERMAID;

const OUT_DIR = path.resolve(
  process.env.DAINTREE_SHOT_DIR ?? path.join(process.cwd(), "artifacts", "mermaid-diagram-shots")
);

const MERMAID_MODULE = "**/.vite/deps/mermaid*.js*";

const THEMES = ["daintree", "bondi"];
const WIDTH = 720;
const NARROW = 440;
const HEIGHT = 620;

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

async function measure(page: Page) {
  return page.evaluate(() => {
    const block = document.querySelector<HTMLElement>(".markdown-mermaid")!;
    const body = document
      .querySelector<HTMLElement>("[data-preview-body]")!
      .getBoundingClientRect();
    const rel = (el: Element | null) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return {
        x: Math.round(r.x - body.x),
        y: Math.round(r.y - body.y),
        width: Math.round(r.width),
        height: Math.round(r.height),
      };
    };
    const style = getComputedStyle(block);
    return {
      state: block.dataset.mermaidState,
      block: rel(block),
      frameBorder: style.borderTopWidth,
      frameBackground: style.backgroundColor,
      next: rel(block.nextElementSibling),
      text: block.innerText.slice(0, 400),
    };
  });
}

async function settle(page: Page) {
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
  );
}

async function open(page: Page, theme: string, diagram: string, width: number) {
  await page.setViewportSize({ width, height: HEIGHT });
  const query = new URLSearchParams({ theme, diagram, width: String(width) });
  await page.goto(`${server!.baseURL}/mermaid-diagram-preview.html?${query}`);
  await expect(page.locator(".markdown-mermaid")).toBeAttached({ timeout: 15_000 });
}

async function expectState(page: Page, state: string) {
  await expect(page.locator(".markdown-mermaid")).toHaveAttribute("data-mermaid-state", state, {
    timeout: 20_000,
  });
}

test("Mermaid diagram — pending, rendered, failed, blocked and unavailable", async ({ page }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_MERMAID is required for the Mermaid diagram capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_MERMAID=1 to run the capture");
  test.setTimeout(180_000);

  const snap = makeSnap(OUT_DIR);
  await stubViteHmrClient(page);

  const written: string[] = [];
  const metrics: Record<string, unknown>[] = [];
  const shell = page.locator("[data-preview-shell]").first();

  for (const theme of THEMES) {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    await page.route(MERMAID_MODULE, async (route) => {
      await gate;
      await route.continue();
    });
    await open(page, theme, "valid", WIDTH);
    await expectState(page, "pending");
    // Past the anti-flicker gate, so whatever a long wait shows is on screen.
    await page.waitForTimeout(900); // e2e-wait: ok — holding past the 400ms loading gate is the state under capture
    await settle(page);
    metrics.push({ shot: `${theme}--pending`, ...(await measure(page)) });
    written.push(await snap(shell, `${theme}--1-pending.png`));

    release();
    await page.unroute(MERMAID_MODULE);
    await expectState(page, "rendered");
    await expect(page.locator(".markdown-mermaid svg")).toBeAttached();
    await settle(page);
    metrics.push({ shot: `${theme}--rendered`, ...(await measure(page)) });
    written.push(await snap(shell, `${theme}--2-rendered.png`));

    for (const [diagram, file] of [
      ["broken", "3-failed"],
      ["linked", "4-blocked"],
    ] as const) {
      await open(page, theme, diagram, WIDTH);
      await expectState(page, "failed");
      await settle(page);
      metrics.push({ shot: `${theme}--${file}`, ...(await measure(page)) });
      written.push(await snap(shell, `${theme}--${file}.png`));
    }

    // The Mermaid chunk refusing to load: the one failure that offers Retry.
    await page.route(MERMAID_MODULE, (route) => route.abort());
    await open(page, theme, "valid", WIDTH);
    await expectState(page, "failed");
    await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
    await settle(page);
    metrics.push({ shot: `${theme}--5-unavailable`, ...(await measure(page)) });
    written.push(await snap(shell, `${theme}--5-unavailable.png`));
    await page.unroute(MERMAID_MODULE);
  }

  await open(page, "daintree", "broken", NARROW);
  await expectState(page, "failed");
  await settle(page);
  metrics.push({ shot: "narrow--failed", ...(await measure(page)) });
  written.push(await snap(shell, "narrow--3-failed.png"));

  writeFileSync(path.join(OUT_DIR, "metrics.json"), JSON.stringify(metrics, null, 2));

  const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  expect(onDisk.length).toBe(written.length);
  expect(onDisk.length).toBe(THEMES.length * 5 + 1);
  console.log(`[mermaid-diagram-shots] ${onDisk.length} PNGs in ${OUT_DIR}`);
});
