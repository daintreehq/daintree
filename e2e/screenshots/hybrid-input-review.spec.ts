/**
 * Hybrid input (agent composer) LAYOUT review harness.
 *
 * The composer's layout is decided by two things that belong to the workspace
 * around it rather than to the component: how wide the grid column is, and how
 * many lines the draft wraps to. Reaching a 260px composer holding a three-line
 * draft in the real app means building a seven-way split and typing into one
 * pane of it — and the interesting widths are exactly the ones nobody builds by
 * hand.
 *
 * So this drives the composer's own preview entry (`hybrid-input-preview.html`)
 * rather than booting Electron: the real `HybridInputBar`, the real CodeMirror
 * autosize, the real theme tokens and `index.css`, placed in a column of a
 * named width with a seeded draft.
 *
 * Five arrangements, each answering one of the questions this review is about:
 *   ladder  — one draft at every width, so the reflow behaviour is a single picture
 *   growth  — one width at every draft length, so the vertical behaviour is too
 *   typing  — one prompt at a run of lengths, foot-aligned, so what a keystroke
 *             near a wrap does to the controls and the height is one picture
 *   tiles   — ten panes at a fleet-realistic width, which is where repeated
 *             trailing icons are actually judged
 *   sidebar — the Assistant's widths, with and without the mic
 *
 * Every layout capture writes a JSON sidecar beside its PNG with each
 * composer's measured shell height, line count and arrangement, and refuses
 * to write at all if a control covers any text.
 *
 * Opt-in only: skips itself unless DAINTREE_SHOT_HYBRIDINPUT is set.
 *
 *   DAINTREE_SHOT_HYBRIDINPUT=1 DAINTREE_SHOT_DIR=/abs/out \
 *     npx playwright test --project=screenshots hybrid-input-review
 *
 * A second test captures the control row (`❯`, attach, stash, mic) at rest, under
 * hover on each control with its tooltip open, disabled, and with the pointer
 * over a disabled control. Run it alone with
 * DAINTREE_SHOT_COMPOSER_CONTROLS instead; the two share an output directory, so
 * run one at a time.
 *
 * A third test captures the composer's selection states across whole grid
 * panes: no pane selected, the pane selected with the keyboard in its terminal,
 * and the pane selected with the keyboard in its composer — plus the pointer
 * over an unselected composer, so hover can be told from selection. Run it
 * alone with DAINTREE_SHOT_COMPOSER_STATES.
 *
 * Env knobs:
 *   DAINTREE_SHOT_HYBRIDINPUT  required — any truthy value runs the capture
 *   DAINTREE_SHOT_DIR          required — an ABSOLUTE output directory outside the repo.
 *                              Deliberately no default: a committed spec with an in-repo
 *                              fallback is how PNGs end up in a working tree.
 *   DAINTREE_SHOT_THEMES       themes for the per-case captures (default daintree,bondi,namib)
 *
 * Hard rule, inherited from the sibling harnesses: never write a PNG that has not been
 * verified. Every capture asserts the arrangement it means to show is on screen and that
 * every composer in it actually mounted an editor, and the test counts the files itself
 * at the end rather than trusting the exit code.
 */

import { test, expect, type Locator, type Page } from "@playwright/test";
import { mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync } from "fs";
import path from "path";
import { createServer, type ViteDevServer } from "vite";
import {
  PILL_PANES,
  WIDTHS,
  TILE_AGENTS,
  TYPING_DRAFT,
  TYPING_LENGTHS,
} from "../../src/components/Terminal/__preview__/hybridInputFixtures";

const LAYOUT_ENABLED = !!process.env.DAINTREE_SHOT_HYBRIDINPUT;
const CONTROLS_ENABLED = !!process.env.DAINTREE_SHOT_COMPOSER_CONTROLS;
const STATES_ENABLED = !!process.env.DAINTREE_SHOT_COMPOSER_STATES;
const ENABLED = LAYOUT_ENABLED || CONTROLS_ENABLED || STATES_ENABLED;
const OUT_DIR = process.env.DAINTREE_SHOT_DIR ?? "";
const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,bondi,namib")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

// 2× so a 24px button, a 1px border and the gap between the last glyph and the
// shell edge are judged at the size a Retina user sees them. At 1× the spacing
// details this harness exists to show round away.
test.use({ deviceScaleFactor: 2 });

const ROOT_SHEET = "#root > div[data-preview-case]";

let server: ViteDevServer | undefined;
let baseURL = "";

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
    if (file.endsWith(".png")) rmSync(path.join(OUT_DIR, file), { force: true });
  }

  // `strictPort: false` so the harness can run beside a live `npm run dev`.
  // `fs.allow` names the REAL node_modules: a worktree symlinks it to the main
  // checkout, and Vite resolves the fonts through the link to a path outside the
  // project root, which its serving allow-list refuses. A capture measured in the
  // fallback face is the wrong picture — and this review is about spacing.
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
 * Serve an inert `@vite/client` so no page in this sweep opens an HMR socket.
 * Chromium throttles repeated WebSocket handshakes to one host until the client
 * gives up and falls into a blob-URL SharedWorker that the dev CSP refuses —
 * after which every load mounts blank. `updateStyle` stays real: in dev every
 * CSS import is a JS module that calls it, so a no-op there renders the whole
 * page unstyled.
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
 * Freeze motion so a capture is the settled state, not a frame of a transition.
 * The caret is left alone — an empty composer showing one is the honest picture.
 */
// Scrollbars are deliberately NOT hidden here, unlike the sibling harnesses.
// The composer's canvas flips to `overflow-y: auto` at its 8-line cap, so at
// narrow widths whether a draft is scrollable or genuinely lost is one of the
// things this review has to judge — and hiding the bar makes the two look
// identical. The first run of this harness did hide it, and read as content
// loss.
const FREEZE_CSS = `
  *, *::before, *::after {
    animation-duration: 0s !important;
    animation-delay: 0s !important;
    transition-duration: 0s !important;
    transition-delay: 0s !important;
  }
`;

/** Write one PNG, having proved there is something to write. */
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

async function open(
  page: Page,
  query: {
    case: string;
    theme: string;
    draft?: string;
    stash?: boolean;
    voice?: false;
    selected?: number;
  }
): Promise<Locator> {
  const params = new URLSearchParams({ case: query.case, theme: query.theme });
  if (query.selected !== undefined) params.set("selected", String(query.selected));
  if (query.draft) params.set("draft", query.draft);
  if (query.stash) params.set("stash", "1");
  if (query.voice === false) params.set("voice", "0");
  await page.goto(`${baseURL}/hybrid-input-preview.html?${params.toString()}`);
  const sheet = page.locator(ROOT_SHEET);
  // JetBrains Mono 400 is `font-display: optional`: a page that misses its
  // first ~100ms paints the fallback mono for its whole life, and Menlo wraps
  // at different points — a layout review captured in it is the wrong picture.
  // The face is cached once fetched, so a reload paints in it.
  for (let attempt = 0; ; attempt++) {
    await page.addStyleTag({ content: FREEZE_CSS });
    await expect(sheet).toBeAttached();
    await expect(page.locator(".cm-content").first()).toBeAttached();
    const faces = await composerFaces(page);
    if (faces.length > 0 && faces.every((face) => face === "JetBrains Mono")) break;
    if (attempt === 3) {
      throw new Error(`composer painted in ${faces.join(", ")}, not JetBrains Mono — refusing`);
    }
    await page.reload();
  }
  return sheet;
}

/**
 * The faces the first composer's text actually painted in, read over CDP.
 * CodeMirror can redraw the probed line between the tag and the query, which
 * CDP reports as a missing node: probe again rather than reload.
 */
async function composerFaces(page: Page): Promise<string[]> {
  for (let attempt = 0; ; attempt++) {
    try {
      const faces = await probeComposerFaces(page);
      // A line redrawn after the tag reports no fonts at all, not a wrong one.
      if (faces.length > 0 || attempt === 5) return faces;
    } catch (error) {
      if (attempt === 5 || !String(error).includes("Could not find node")) throw error;
    }
    await page.waitForTimeout(150);
  }
}

async function probeComposerFaces(page: Page): Promise<string[]> {
  await page.evaluate(() => {
    document.querySelector("[data-font-probe]")?.removeAttribute("data-font-probe");
    const lines = Array.from(document.querySelectorAll(".cm-line"));
    const withText = lines.find((line) =>
      Array.from(line.childNodes).some(
        (node) => node.nodeType === Node.TEXT_NODE && (node.textContent ?? "").trim() !== ""
      )
    );
    (withText ?? document.querySelector(".cm-placeholder"))?.setAttribute("data-font-probe", "");
  });
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("DOM.enable");
    await cdp.send("CSS.enable");
    const { root } = await cdp.send("DOM.getDocument", { depth: -1 });
    const { nodeId } = await cdp.send("DOM.querySelector", {
      nodeId: root.nodeId,
      selector: "[data-font-probe]",
    });
    if (!nodeId) return [];
    const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
    return fonts.map((font) => font.familyName);
  } finally {
    await cdp.detach();
  }
}

/**
 * The contract every capture must satisfy before it is written.
 *
 * CodeMirror mounts imperatively and lazily, so a composer can be fully laid out
 * and still hold no editor — which photographs as a plausible empty bar. Proving
 * `.cm-content` is present in every pane is what stops this harness producing a
 * believable picture of a component that never rendered.
 */
async function proveComposersMounted(
  page: Page,
  expected: number,
  { mic = true }: { mic?: boolean } = {}
): Promise<void> {
  const roots = page.locator("[data-hybrid-input-root]");
  await expect(roots).toHaveCount(expected);
  await expect(page.locator(".cm-content")).toHaveCount(expected);
  // The trailing controls, on every pane, and exactly the ones the capture
  // means to show. The mic renders only once voice is configured, and the
  // first run of this harness quietly captured a one-button trailing group — a
  // believable picture that understated the exact thing the review was about.
  // Counting both ways is what stops that recurring in either direction.
  await expect(page.getByRole("button", { name: "Attach files" })).toHaveCount(expected);
  await expect(page.locator("[data-hybrid-input-root] .lucide-mic")).toHaveCount(
    mic ? expected : 0
  );
  // Every composer must also have a real box. A zero-height bar is the failure
  // mode a column-width harness is most likely to produce by accident.
  const heights = await roots.evaluateAll((els) =>
    els.map((el) => el.getBoundingClientRect().height)
  );
  const dead = heights.filter((h) => h < 8);
  if (dead.length > 0) {
    throw new Error(`${dead.length} of ${expected} composers have no height — refusing to write`);
  }
}

interface ComposerLayout {
  id: string;
  frameWidth: number;
  shellHeight: number;
  rows: number;
  arrangement: "rail" | "inline" | "column";
  lastRowRight: number;
  trailingLeft: number;
  overlaps: boolean;
}

/**
 * Every composer's arrangement, read from what is actually on screen.
 *
 * Runs in the page, so it is self-contained. Text is clipped to the editor's
 * scroll viewport: a draft past the height cap scrolls, and its unclipped
 * rows would report the last line far below the shell. "Rail" is the trailing
 * group sitting below the bottom visible row, "inline" the two sharing it,
 * "column" the canvas having given up the controls' width on every row.
 * The caret counts as text — a control over it hides where typing lands.
 *
 * What counts as covered is what is painted: every run of text, and the
 * whole box of anything that paints one (a pill chip's tint, a thumbnail). An
 * element that paints nothing is looked through to its text, so a control
 * beside the last row of a wrapped `@file` chip, inside its transparent box
 * but over none of its glyphs, is not a collision.
 */
function measureComposers(): (ComposerLayout | { id: string; missing: true })[] {
  return Array.from(document.querySelectorAll<HTMLElement>("[data-hybrid-input-root]")).map(
    (root) => {
      const id = root.getAttribute("data-hybrid-input-root") ?? "?";
      const shell = root.querySelector<HTMLElement>(".group\\/shell");
      const content = root.querySelector<HTMLElement>(".cm-content");
      const scroller = root.querySelector<HTMLElement>(".cm-scroller");
      const trailing = root.querySelector('[aria-label="Attach files"]')?.parentElement;
      const frame = root.closest<HTMLElement>("[data-preview-frame]") ?? root;
      if (!shell || !content || !scroller || !trailing) return { id, missing: true as const };
      const t = trailing.getBoundingClientRect();
      const view = scroller.getBoundingClientRect();
      const rects: DOMRect[] = [];
      const collect = (node: Node) => {
        for (const child of Array.from(node.childNodes)) {
          if (child.nodeType === Node.TEXT_NODE) {
            const range = document.createRange();
            range.selectNodeContents(child);
            rects.push(...Array.from(range.getClientRects()));
          } else if (child instanceof Element) {
            const style = getComputedStyle(child);
            const paints =
              child instanceof HTMLImageElement ||
              child instanceof SVGElement ||
              (style.backgroundColor !== "rgba(0, 0, 0, 0)" &&
                style.backgroundColor !== "transparent") ||
              style.backgroundImage !== "none";
            if (paints) rects.push(...Array.from(child.getClientRects()));
            else collect(child);
          }
        }
      };
      for (const line of Array.from(content.querySelectorAll<HTMLElement>(".cm-line"))) {
        collect(line);
      }
      for (const caret of Array.from(root.querySelectorAll<HTMLElement>(".cm-cursor"))) {
        rects.push(caret.getBoundingClientRect());
      }
      const visible = rects
        .map((r) => ({
          left: Math.max(r.left, view.left),
          right: Math.min(r.right, view.right),
          top: Math.max(r.top, view.top),
          bottom: Math.min(r.bottom, view.bottom),
          width: r.width,
        }))
        .filter((r) => r.right - r.left > 0.5 && r.bottom - r.top > 0.5);
      const text = visible.filter((r) => r.width > 0.5);
      const bottom = Math.max(...text.map((r) => r.bottom), view.top);
      const lastRow = text.filter((r) => r.bottom > bottom - 4);
      const lastRowRight = lastRow.length ? Math.max(...lastRow.map((r) => r.right)) : view.left;
      // 3px of grace: the 24px controls are centred on a 20px row, so their
      // box reaches 2px into the half-leading of the row above by design.
      const overlaps = visible.some(
        (r) => r.left < t.right && r.right > t.left && r.top < t.bottom - 3 && r.bottom > t.top + 3
      );
      return {
        id,
        frameWidth: Math.round(frame.getBoundingClientRect().width),
        shellHeight: Math.round(shell.getBoundingClientRect().height),
        rows: Math.round(scroller.clientHeight / 20),
        arrangement:
          t.top >= bottom - 4
            ? ("rail" as const)
            : root.querySelector<HTMLElement>("[data-composer-canvas]")?.style.paddingRight
              ? ("column" as const)
              : ("inline" as const),
        lastRowRight: Math.round(lastRowRight),
        trailingLeft: Math.round(t.left),
        overlaps,
      };
    }
  );
}

async function measured(page: Page): Promise<ComposerLayout[]> {
  const layouts = await page.evaluate(measureComposers);
  const missing = layouts.filter((l) => "missing" in l);
  if (missing.length > 0) {
    throw new Error(`${missing.length} composers could not be measured — refusing to write`);
  }
  return layouts as ComposerLayout[];
}

/**
 * Measure every composer and prove its controls cover no text, writing the
 * measurements beside the PNG so a review can check a reading of the picture
 * — how tall each shell is, how many rows its draft took — against numbers
 * rather than estimating them from pixels.
 *
 * The overlap check is the invariant every arrangement must hold: the
 * controls never sit over a glyph, a chip, the placeholder or the caret. It is
 * what stops a placement rule that is wrong at one width photographing as a
 * plausible composer with its last word under the paperclip.
 */
async function recordLayout(page: Page, file: string): Promise<ComposerLayout[]> {
  const layouts = await measured(page);
  const covered = layouts.filter((l) => l.overlaps);
  if (covered.length > 0) {
    throw new Error(
      `controls cover text in ${covered.map((l) => l.id).join(", ")} — refusing to write`
    );
  }
  writeFileSync(
    path.join(OUT_DIR, file.replace(/\.png$/, ".json")),
    JSON.stringify(layouts, null, 2)
  );
  return layouts;
}

/** Two frames: one for CodeMirror's measure pass, one for anything it scheduled. */
async function settle(page: Page): Promise<void> {
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  );
}

/**
 * Drag one live composer, ending on a dropped file's wrapped pill, wider and
 * back, measuring at every step once it has settled.
 *
 * The pill is the one shape where the column beside the text can win, so its
 * arrangement turns over as the pane widens: column, then rail, then corner.
 * A rule whose readings leaned on the editor's current height would hold the
 * column on the way up that a fresh mount at the same width would not take —
 * so every width must lay out the same in both directions, and the same as
 * the freshly mounted composers on the sheet at 270px and 300px.
 */
async function recordPillResize(page: Page, theme: string, fresh: ComposerLayout[]): Promise<void> {
  const id = "pills-270-file";
  const widths = Array.from({ length: 13 }, (_, i) => 240 + i * 10);
  const at = async (width: number) => {
    await page.evaluate(
      ({ id, width }) => {
        const frame = document
          .querySelector(`[data-hybrid-input-root="${id}"]`)
          ?.closest<HTMLElement>("[data-preview-frame]");
        if (!frame) throw new Error(`${id} has no frame`);
        frame.style.width = `${width}px`;
      },
      { id, width }
    );
    // A width change can reach the editor's height a few frames late — its
    // lines are re-measured, then the autosize writes. Read every frame until
    // eight in a row agree: each frame on the way is kept and must cover no
    // text, and `settledFrames` is when the last change arrived.
    let previous = "";
    let stable = 0;
    let settledFrames = 0;
    const frames: string[] = [];
    for (let frame = 1; frame <= 60; frame++) {
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
      const layout = (await measured(page)).find((l) => l.id === id);
      if (!layout) throw new Error(`${id} could not be measured`);
      if (layout.overlaps) throw new Error(`${id} covers text at ${width}px, frame ${frame}`);
      const key = `${layout.arrangement}:${layout.shellHeight}`;
      frames.push(key);
      if (key === previous) stable++;
      else {
        stable = 0;
        settledFrames = frame;
      }
      previous = key;
      if (stable === 8) return { width, settledFrames, frames, ...layout };
    }
    throw new Error(`${id} never settled at ${width}px`);
  };
  const up = [];
  for (const width of widths) up.push(await at(width));
  const down = [];
  for (const width of [...widths].reverse()) down.push(await at(width));
  writeFileSync(path.join(OUT_DIR, `resize--${theme}.json`), JSON.stringify({ up, down }, null, 2));

  const problems: string[] = [];
  for (const step of [...up, ...down]) {
    if (step.overlaps) problems.push(`controls cover text at ${step.width}px`);
  }
  for (const step of up) {
    const back = down.find((d) => d.width === step.width)!;
    if (back.shellHeight !== step.shellHeight || back.arrangement !== step.arrangement) {
      problems.push(
        `${step.width}px: ${step.arrangement} ${step.shellHeight}px widening, ${back.arrangement} ${back.shellHeight}px narrowing`
      );
    }
  }
  for (const pane of fresh.filter((l) => l.id.endsWith("-file"))) {
    for (const step of [...up, ...down].filter((s) => s.width === pane.frameWidth)) {
      if (step.shellHeight !== pane.shellHeight || step.arrangement !== pane.arrangement) {
        problems.push(
          `${step.width}px: ${step.arrangement} ${step.shellHeight}px resized, ${pane.arrangement} ${pane.shellHeight}px freshly mounted`
        );
      }
    }
  }
  if (problems.length > 0) throw new Error(`pill resize: ${problems.join("; ")}`);
}

/**
 * Type a prompt into one live composer a character at a time, then delete it
 * the same way, measuring after every keystroke.
 *
 * The typing sheet mounts each length fresh, so it cannot show what only a
 * live editor can: a placement that flips back and forth, or one that
 * remembers how it got here. This proves three things on the real sequence —
 * the controls never cover the text or the caret, the composer never changes
 * height by anything but whole 20px lines, and every length lays out the same
 * whether it was reached by typing or by deleting.
 */
async function recordLiveTyping(page: Page, theme: string): Promise<void> {
  await open(page, { case: "live", theme });
  await proveComposersMounted(page, 1);
  await page.locator('[data-hybrid-input-root="live"] .cm-content').click();
  await settle(page);

  const at = async (length: number) => ({ length, ...(await measured(page))[0]! });
  const forward = [await at(0)];
  for (const char of TYPING_DRAFT) {
    await page.keyboard.type(char);
    await settle(page);
    forward.push(await at(forward.length));
  }
  const backward = [forward[forward.length - 1]!];
  for (let length = TYPING_DRAFT.length - 1; length >= 0; length--) {
    await page.keyboard.press("Backspace");
    await settle(page);
    backward.push(await at(length));
  }
  writeFileSync(
    path.join(OUT_DIR, `live--${theme}.json`),
    JSON.stringify({ forward, backward }, null, 2)
  );

  const problems: string[] = [];
  for (const step of [...forward, ...backward]) {
    if (step.overlaps) problems.push(`controls cover text at length ${step.length}`);
  }
  for (let i = 1; i < forward.length; i++) {
    const delta = forward[i]!.shellHeight - forward[i - 1]!.shellHeight;
    if (delta !== 0 && delta !== 20) {
      problems.push(`typing to ${i} changed the height by ${delta}px`);
    }
  }
  for (const back of backward) {
    const fwd = forward[back.length]!;
    if (fwd.shellHeight !== back.shellHeight || fwd.arrangement !== back.arrangement) {
      problems.push(
        `length ${back.length}: ${fwd.arrangement} ${fwd.shellHeight}px typing, ${back.arrangement} ${back.shellHeight}px deleting`
      );
    }
  }
  if (problems.length > 0) throw new Error(`live typing: ${problems.join("; ")}`);
}

/**
 * Size the viewport to the sheet before capturing it. `index.css` pins the
 * document to the viewport, so a sheet taller than it never scrolls into an
 * element screenshot — it silently clips instead.
 */
async function fitViewport(page: Page, sheet: Locator): Promise<void> {
  // Widen first, then measure. The sheet's own width is constrained by the
  // viewport, so measuring at the default 1280 and sizing to that result is a
  // fixed point that silently clips — the tile grid lost its fifth column that
  // way. Measure against a viewport wide enough not to be the constraint.
  await page.setViewportSize({ width: 2600, height: 1400 });
  await page.waitForTimeout(150);
  const box = await sheet.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return {
      w: Math.ceil(Math.max(r.width, el.scrollWidth)),
      h: Math.ceil(Math.max(r.height, el.scrollHeight)),
    };
  });
  await page.setViewportSize({
    width: Math.min(Math.max(box.w + 32, 640), 4000),
    height: Math.min(Math.max(box.h + 32, 400), 6000),
  });
  await page.waitForTimeout(250);
}

test("hybrid input layout review", async ({ page }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_HYBRIDINPUT is required for the hybrid-input capture",
  });
  test.skip(!LAYOUT_ENABLED, "set DAINTREE_SHOT_HYBRIDINPUT=1 to run the capture");
  test.setTimeout(360_000);

  await stubViteHmrClient(page);
  const written: string[] = [];

  const capture = async (
    query: Parameters<typeof open>[1],
    count: number,
    file: string,
    { mic = true }: { mic?: boolean } = {}
  ) => {
    const sheet = await open(page, query);
    await proveComposersMounted(page, count, { mic });
    await fitViewport(page, sheet);
    await recordLayout(page, file);
    written.push(await snap(sheet, file));
  };

  for (const theme of THEMES) {
    // The reflow ladder, one draft per sheet: the reported three-liner, a
    // single line, a two-line prose prompt with a short last line, and a list
    // whose last line is short by construction. The width behaviour and the
    // wrap behaviour are separate questions and one picture conflates them.
    for (const draft of ["reported", "short", "prose", "list", "path"] as const) {
      await capture(
        { case: "ladder", theme, draft },
        WIDTHS.length,
        `ladder--${theme}--${draft}.png`
      );
    }

    // The ladder again with a stashed draft, which adds the third trailing
    // button. The narrow end of this row is where the trailing group's cost is
    // most visible.
    await capture(
      { case: "ladder", theme, draft: "reported", stash: true },
      WIDTHS.length,
      `ladder--${theme}--stash.png`
    );

    // A pasted screenshot ending the prompt, at six widths, and at the two
    // narrowest again with the draft ending on the pill itself: the tinted
    // pill whose label wraps in a narrow pane, the case a column can win.
    {
      const sheet = await open(page, { case: "pills", theme });
      await proveComposersMounted(page, PILL_PANES.length);
      for (const pane of PILL_PANES) {
        const chips = await page.evaluate(
          async ({ id, tight, file }) => {
            const hooks = (
              window as unknown as {
                __composerChips: {
                  attachOne: (id: string, which: 0 | 1) => Promise<number>;
                  trimAfterChip: (id: string) => void;
                };
              }
            ).__composerChips;
            const count = await hooks.attachOne(id, file ? 1 : 0);
            if (tight) hooks.trimAfterChip(id);
            return count;
          },
          { id: pane.id, tight: pane.tight, file: pane.file }
        );
        expect(chips, `${pane.id} holds its screenshot chip`).toBe(1);
      }
      await expect(page.locator("[data-hybrid-input-root] .cm-image-chip img")).toHaveCount(
        PILL_PANES.filter((pane) => !pane.file).length
      );
      await expect(page.locator("[data-hybrid-input-root] .cm-file-drop-chip")).toHaveCount(
        PILL_PANES.filter((pane) => pane.file).length
      );
      await settle(page);
      await fitViewport(page, sheet);
      const fresh = await recordLayout(page, `pills--${theme}.png`);
      written.push(await snap(sheet, `pills--${theme}.png`));
      // The live resize once: placement is geometry, the same in every theme.
      if (theme === THEMES[0]) await recordPillResize(page, theme, fresh);
    }

    // Vertical growth at one narrow width.
    await capture({ case: "growth", theme }, 4, `growth--${theme}.png`);

    // One prompt at a run of lengths, foot-aligned: the keystroke-by-keystroke
    // behaviour around each wrap.
    await capture({ case: "typing", theme }, TYPING_LENGTHS.length, `typing--${theme}.png`);

    // Ten tiled panes.
    await capture({ case: "tiles", theme }, TILE_AGENTS.length, `tiles--${theme}.png`);

    // The Assistant sidebar widths, one to three lines, with the mic and
    // without. The paperclip-only variant is the sparsest the trailing group
    // ever gets.
    await capture({ case: "sidebar", theme }, 6, `sidebar--${theme}.png`);
    await capture({ case: "sidebar", theme, voice: false }, 6, `sidebar--${theme}--no-mic.png`, {
      mic: false,
    });
  }

  // The live sequence once: placement is geometry, and geometry is the same in
  // every theme.
  await recordLiveTyping(page, THEMES[0]!);

  // Count the files ourselves. A harness that trusts its own exit code is how a
  // review ends up reasoning about screenshots that were never written.
  const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  expect(onDisk.length).toBe(written.length);
  expect(onDisk.length).toBe(THEMES.length * 12);
  console.log(`[hybrid-input-shots] ${onDisk.length} PNGs in ${OUT_DIR}`);
});

const CONTROL_NAMES = [
  ["picker", "Open command picker"],
  ["attach", "Attach files"],
  ["stash", "Restore stashed input"],
  ["mic", "Start voice recording"],
] as const;

test("composer control row states", async ({ page }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_COMPOSER_CONTROLS is required for the control-row capture",
  });
  test.skip(!CONTROLS_ENABLED, "set DAINTREE_SHOT_COMPOSER_CONTROLS=1 to run the capture");
  test.setTimeout(240_000);

  await stubViteHmrClient(page);
  const written: string[] = [];

  for (const theme of THEMES) {
    const sheet = await open(page, { case: "controls", theme, stash: true });
    await proveComposersMounted(page, 2);
    await fitViewport(page, sheet);
    const enabled = page.locator('[data-hybrid-input-root="controls-enabled"]');
    const disabled = page.locator('[data-hybrid-input-root="controls-disabled"]');

    // All four controls on both composers, and the disabled one's natively
    // disabled — a disabled capture of live buttons is the believable wrong
    // picture. Not `toBeDisabled`: it inherits the shell's `aria-disabled`, and
    // passed on a stash button that ignored `disabled` entirely.
    for (const [, name] of CONTROL_NAMES) {
      await expect(enabled.getByRole("button", { name })).toHaveJSProperty("disabled", false);
      await expect(disabled.getByRole("button", { name })).toHaveJSProperty("disabled", true);
    }

    await page.mouse.move(0, 0);
    written.push(await snap(sheet, `controls--${theme}--rest.png`));

    for (const [key, name] of CONTROL_NAMES) {
      await enabled.getByRole("button", { name }).hover();
      await expect(page.getByRole("tooltip")).toBeVisible({ timeout: 3000 });
      written.push(await snap(sheet, `controls--${theme}--hover-${key}.png`));
      await page.mouse.move(0, 0);
      await expect(page.getByRole("tooltip")).toHaveCount(0, { timeout: 3000 });
    }

    // The pointer over a disabled control: the unavailable composer is inert
    // to the pointer as a whole, so no control under it may wash or tooltip.
    const box = await disabled.getByRole("button", { name: "Attach files" }).boundingBox();
    if (!box) throw new Error("disabled attach has no box — refusing to write");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(900);
    await expect(page.getByRole("tooltip")).toHaveCount(0);
    written.push(await snap(sheet, `controls--${theme}--hover-disabled.png`));
    await page.mouse.move(0, 0);
  }

  const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  expect(onDisk.length).toBe(written.length);
  expect(onDisk.length).toBe(THEMES.length * (2 + CONTROL_NAMES.length));
  console.log(`[composer-controls-shots] ${onDisk.length} PNGs in ${OUT_DIR}`);
});

type KeyboardIn = "terminal" | "composer";

/**
 * Where the keyboard is, proved from the DOM. A "selected, not focused" capture
 * whose editor quietly kept focus photographs the focused state under the
 * wrong name, and the two are exactly what this review compares.
 */
async function proveKeyboardIn(page: Page, paneId: string, where: KeyboardIn): Promise<void> {
  const actual = await page.evaluate((id) => {
    const active = document.activeElement;
    if (!active) return "none";
    if (active.closest(`[data-hybrid-input-root="${id}"] .cm-content`)) return "composer";
    if (active.matches(`[data-preview-terminal="${id}"]`)) return "terminal";
    return `elsewhere:${active.tagName.toLowerCase()}`;
  }, paneId);
  if (actual !== where) {
    throw new Error(`${paneId}: keyboard is in ${actual}, wanted ${where} — refusing to write`);
  }
}

/** Every shell's painted state, written beside the PNG so a reading can be checked against it. */
async function shellSidecar(page: Page, file: string): Promise<void> {
  const shells = await page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>("[data-hybrid-input-root]")).map((root) => {
      const shell = root.querySelector<HTMLElement>(".group\\/shell");
      const cs = shell ? getComputedStyle(shell) : null;
      return {
        id: root.getAttribute("data-hybrid-input-root"),
        attrs: shell
          ? Object.fromEntries(
              Array.from(shell.attributes)
                .filter((a) => a.name.startsWith("data-"))
                .map((a) => [a.name, a.value])
            )
          : null,
        borderColor: cs?.borderTopColor,
        backgroundColor: cs?.backgroundColor,
        boxShadow: cs?.boxShadow,
        outline: cs ? `${cs.outlineStyle} ${cs.outlineWidth} ${cs.outlineColor}` : null,
      };
    })
  );
  writeFileSync(
    path.join(OUT_DIR, file.replace(/\.png$/, ".json")),
    JSON.stringify(shells, null, 2)
  );
}

const STATE_CASES = [
  { case: "panes", count: 3, selected: 1, hoverPane: 0 },
  { case: "fleet", count: 6, selected: 4, hoverPane: 0 },
] as const;

test("composer selection states", async ({ page }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_COMPOSER_STATES is required for the selection-state capture",
  });
  test.skip(!STATES_ENABLED, "set DAINTREE_SHOT_COMPOSER_STATES=1 to run the capture");
  test.setTimeout(600_000);

  await stubViteHmrClient(page);
  const written: string[] = [];

  for (const theme of THEMES) {
    for (const spec of STATE_CASES) {
      const sheet = await open(page, { case: spec.case, theme, selected: spec.selected });
      await proveComposersMounted(page, spec.count);
      await fitViewport(page, sheet);
      const selectedId = `${spec.case}-${spec.selected}`;
      const terminal = page.locator(`[data-preview-terminal="${selectedId}"]`);
      const editor = page.locator(`[data-hybrid-input-root="${selectedId}"] .cm-content`);

      // Selected, keyboard in the terminal: the state the report says reads
      // exactly like every other composer.
      await page.mouse.move(1, 1);
      await terminal.focus();
      await proveKeyboardIn(page, selectedId, "terminal");
      let file = `${spec.case}--${theme}--selected.png`;
      await shellSidecar(page, file);
      written.push(await snap(sheet, file));

      // The pointer over an unselected composer, with the selection unchanged:
      // hover must never read as the selected state.
      if (spec.case === "panes") {
        const hoverShell = page.locator(
          `[data-hybrid-input-root="${spec.case}-${spec.hoverPane}"] .cm-content`
        );
        await hoverShell.hover();
        await page.waitForTimeout(120);
        await proveKeyboardIn(page, selectedId, "terminal");
        file = `${spec.case}--${theme}--hover.png`;
        await shellSidecar(page, file);
        written.push(await snap(sheet, file));
        await page.mouse.move(1, 1);
      }

      // Selected and typing: the keyboard in the composer.
      await editor.click();
      await page.mouse.move(1, 1);
      await page.waitForTimeout(120);
      await proveKeyboardIn(page, selectedId, "composer");
      file = `${spec.case}--${theme}--focused.png`;
      await shellSidecar(page, file);
      written.push(await snap(sheet, file));
    }
  }

  // The two high-contrast modes, on the first theme only: both replace the
  // palette's own mixes (system colours, or the stepped-up placeholder and
  // doubled edges), so one palette shows them.
  const contrastModes = [
    { name: "contrast-more", media: { contrast: "more" as const } },
    { name: "forced-colors", media: { forcedColors: "active" as const } },
  ];
  for (const mode of contrastModes) {
    const theme = THEMES[0]!;
    const sheet = await open(page, { case: "panes", theme, selected: 1 });
    await page.emulateMedia(mode.media);
    await proveComposersMounted(page, 3);
    await fitViewport(page, sheet);
    await page.mouse.move(1, 1);
    await page.locator('[data-preview-terminal="panes-1"]').focus();
    await proveKeyboardIn(page, "panes-1", "terminal");
    let file = `panes--${theme}--${mode.name}--selected.png`;
    await shellSidecar(page, file);
    written.push(await snap(sheet, file));
    await page.locator('[data-hybrid-input-root="panes-1"] .cm-content').click();
    await page.mouse.move(1, 1);
    await page.waitForTimeout(120);
    await proveKeyboardIn(page, "panes-1", "composer");
    file = `panes--${theme}--${mode.name}--focused.png`;
    await shellSidecar(page, file);
    written.push(await snap(sheet, file));
    await page.emulateMedia({ contrast: null, forcedColors: null });
  }

  const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  expect(onDisk.length).toBe(written.length);
  expect(onDisk.length).toBe(THEMES.length * 5 + contrastModes.length * 2);
  console.log(`[composer-states-shots] ${onDisk.length} PNGs in ${OUT_DIR}`);
});
