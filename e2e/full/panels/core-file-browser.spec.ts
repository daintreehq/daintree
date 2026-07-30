import path from "path";
import { writeFileSync } from "fs";
import { test, expect, type Locator, type Page } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../../helpers/launch";
import { createFixtureRepo } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import { SEL } from "../../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_LONG } from "../../helpers/timeouts";

let ctx: AppContext;
let fixtureDir: string;
let fixtureCleanup: (() => void) | undefined;

// Tall enough to overflow the preview in both modes. Blank-line separated so
// the rendered document is a stack of real <p> elements rather than one
// wrapped paragraph. The long unbroken line matters for source mode, where
// CodeViewer defaults `wrapLines` to false: it forces horizontal overflow, so
// the spec can prove which element owns that axis.
const TALL_MARKDOWN =
  "# Tall browser document\n\n" +
  `    const wide = "${"x".repeat(600)}";\n\n` +
  Array.from(
    { length: 300 },
    (_, i) => `Paragraph ${String(i + 1).padStart(3, "0")} lorem ipsum dolor sit amet.`
  ).join("\n\n") +
  "\n\n## file-browser-end\n";

const SHORT_MARKDOWN = "# Short browser document\n\nOne paragraph, nowhere near a screenful.\n";

interface DispatchResult {
  ok?: boolean;
  error?: { message?: string };
  result?: { worktrees?: Array<{ id: string; isMain?: boolean }> };
}

async function dispatchAction(
  page: Page,
  actionId: string,
  args?: unknown
): Promise<DispatchResult> {
  return page.evaluate(
    ([id, a]) =>
      (
        window as unknown as {
          __daintreeDispatchAction: (id: string, a?: unknown) => Promise<DispatchResult>;
        }
      ).__daintreeDispatchAction(id, a),
    [actionId, args] as const
  );
}

// Scoped to the file browser's own marker rather than a bare `panel-dialog`:
// that host is shared, so an unrelated dialog must not satisfy this. Either
// column toggle identifies it — each one unmounts with the column it lives in,
// so neither alone survives every layout the panel can take (#11496).
const BROWSER_DIALOG =
  `${SEL.fileViewer.dialog}:has([data-testid="file-browser-sidebar-toggle"],` +
  ` [data-testid="file-browser-viewer-toggle"])`;

/**
 * Opens the browser through the real action rather than driving the
 * virtualized tree: `revealPath` seeds the selection, so the preview renders
 * the file without a click that depends on row virtualization.
 */
async function openFileBrowser(page: Page, revealPath: string) {
  // Polled rather than read once: the project's worktree readiness gate is
  // best-effort, so a loaded runner can briefly answer with an empty list.
  let worktreeId: string | undefined;
  await expect
    .poll(
      async () => {
        const listed = await dispatchAction(page, "worktree.list");
        worktreeId = (listed.result?.worktrees ?? []).find((w) => w.isMain)?.id;
        return worktreeId ?? null;
      },
      { timeout: T_MEDIUM }
    )
    .not.toBeNull();

  const opened = await dispatchAction(page, "worktree.openFileBrowser", {
    worktreeId,
    revealPath,
    revealKind: "file",
  });
  if (opened.ok === false) {
    throw new Error(`openFileBrowser failed: ${opened.error?.message ?? "unknown"}`);
  }

  const dialog = page.locator(BROWSER_DIALOG);
  await expect(dialog).toBeVisible({ timeout: T_MEDIUM });
  return dialog;
}

async function closeDialog(page: Page) {
  await page.locator(BROWSER_DIALOG).locator(SEL.fileViewer.closeButton).first().click();
  await expect(page.locator(BROWSER_DIALOG)).not.toBeVisible({ timeout: T_SHORT });
}

/**
 * Vertical scroll ownership: the element scrolls, and its scrollbar is on
 * screen.
 *
 * The containment check measures the dialog SURFACE, not `panel-dialog` — that
 * test id sits on AppDialog's inset-0 backdrop, so measuring against it would
 * only prove the pane ends before the window bottom. The bounded surface is the
 * backdrop's first child; without that, a pane clipped by the surface's own
 * overflow-hidden still passes.
 */
async function expectOwnsVerticalScroll(scrollOwner: Locator) {
  await expect
    .poll(
      () =>
        scrollOwner.evaluate((el) => {
          const surfaceRect = el
            .closest('[data-testid="panel-dialog"]')
            ?.firstElementChild?.getBoundingClientRect();
          const rect = el.getBoundingClientRect();
          return {
            // A collapsed root with overflowing content would otherwise satisfy
            // the overflow check below while showing nothing.
            hasHeight: el.clientHeight > 0,
            scrollsVertically: el.scrollHeight > el.clientHeight,
            // A real scrollbar, not merely programmatic scrollability: an
            // `overflow: hidden` element still accepts a `scrollTop` write.
            scrollable: ["auto", "scroll"].includes(getComputedStyle(el).overflowY),
            withinSurface:
              surfaceRect !== undefined &&
              rect.bottom <= surfaceRect.bottom + 1 &&
              rect.top >= surfaceRect.top - 1,
          };
        }),
      { timeout: T_MEDIUM }
    )
    .toEqual({
      hasHeight: true,
      scrollsVertically: true,
      scrollable: true,
      withinSurface: true,
    });

  // Content past the first screen is reachable, and scrolling lands on the real
  // bottom rather than some intermediate clamp. Reset afterwards so a later
  // assertion starts from a known position.
  const vertical = await scrollOwner.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
    const reached = el.scrollTop;
    el.scrollTop = 0;
    return { reached, max: el.scrollHeight - el.clientHeight };
  });
  expect(vertical.reached).toBeGreaterThan(0);
  expect(vertical.reached).toBeGreaterThanOrEqual(vertical.max - 2);
}

test.describe.serial("Core: File browser preview", () => {
  test.beforeAll(async () => {
    const { dir, cleanup } = createFixtureRepo({ name: "file-browser" });
    fixtureDir = dir;
    fixtureCleanup = cleanup;
    writeFileSync(path.join(dir, "tall.md"), TALL_MARKDOWN);
    writeFileSync(path.join(dir, "short.md"), SHORT_MARKDOWN);
    ctx = await launchApp();
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, fixtureDir, "File Browser");
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    fixtureCleanup?.();
  });

  test("rendered markdown taller than the preview scrolls inside it", async () => {
    const dialog = await openFileBrowser(ctx.window, "tall.md");

    // Rendered is the browser's default markdown mode.
    await expect(dialog.locator(".markdown-document")).toContainText("Paragraph 001", {
      timeout: T_LONG,
    });

    // #11441: MarkdownDocument brings no scroller of its own, so before the fix
    // nothing between the pane and the document was a scroll container.
    const scrollRoot = dialog.getByTestId("file-browser-markdown-scroll");
    await expectOwnsVerticalScroll(scrollRoot);

    // The document grows instead of clamping to the wrapper — restoring
    // `h-full` on the MarkdownViewer call fails right here.
    await expect
      .poll(
        () =>
          scrollRoot.evaluate((el) => {
            const doc = el.firstElementChild;
            return doc instanceof HTMLElement && doc.scrollHeight <= doc.clientHeight + 1;
          }),
        { timeout: T_MEDIUM }
      )
      .toBe(true);

    // The user-visible symptom: the tail of the document was unreachable.
    // ratio 1 — a single visible pixel of the heading is not "readable".
    await scrollRoot.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await expect(dialog.getByRole("heading", { name: /file-browser-end/ })).toBeInViewport({
      ratio: 1,
      timeout: T_MEDIUM,
    });

    await closeDialog(ctx.window);
  });

  test("markdown source mode keeps one scrollport that owns both axes", async () => {
    const dialog = await openFileBrowser(ctx.window, "tall.md");
    await expect(dialog.locator(".markdown-document")).toBeVisible({ timeout: T_LONG });

    await dialog.getByRole("button", { name: "Source", exact: true }).click();
    await expect(dialog.locator(".cm-content")).toContainText("# Tall browser document", {
      timeout: T_LONG,
    });

    // Source mode is deliberately left unwrapped: CodeViewer at pane height is
    // the single scrollport, which keeps its horizontal scrollbar on screen.
    // Handing the vertical axis to an outer wrapper would let this element grow
    // to content height, stranding the horizontal scrollbar below the fold.
    await expect(dialog.getByTestId("file-browser-markdown-scroll")).toHaveCount(0);

    // Resolved by walking up from the editor to the nearest scrollable
    // ancestor: the invariant is about whichever element actually owns the
    // scroll, not about a particular tag or test id.
    await expect
      .poll(
        () =>
          dialog.locator(".cm-editor").evaluate((cm) => {
            let owner = cm.parentElement;
            while (owner && !["auto", "scroll"].includes(getComputedStyle(owner).overflowY)) {
              owner = owner.parentElement;
            }
            if (!owner) return { found: false };
            const surfaceRect = owner
              .closest('[data-testid="panel-dialog"]')
              ?.firstElementChild?.getBoundingClientRect();
            const rect = owner.getBoundingClientRect();
            return {
              found: true,
              ownsVertical: owner.scrollHeight > owner.clientHeight,
              ownsHorizontal: owner.scrollWidth > owner.clientWidth,
              horizontalScrollable: ["auto", "scroll"].includes(getComputedStyle(owner).overflowX),
              withinSurface: surfaceRect !== undefined && rect.bottom <= surfaceRect.bottom + 1,
            };
          }),
        { timeout: T_MEDIUM }
      )
      .toEqual({
        found: true,
        ownsVertical: true,
        ownsHorizontal: true,
        horizontalScrollable: true,
        withinSurface: true,
      });

    await closeDialog(ctx.window);
  });

  test("a short markdown document fills the preview instead of stopping at its own height", async () => {
    const dialog = await openFileBrowser(ctx.window, "short.md");
    await expect(dialog.locator(".markdown-document")).toContainText("One paragraph", {
      timeout: T_LONG,
    });

    // `min-h-full` rather than no class at all: the document reaches the bottom
    // of the preview so its background doesn't stop mid-pane — and rather than
    // `h-full`, which would clamp it and re-break the tall case above.
    await expect
      .poll(
        () =>
          dialog.getByTestId("file-browser-markdown-scroll").evaluate((el) => {
            const doc = el.firstElementChild;
            return {
              fillsPreview: doc instanceof HTMLElement && doc.offsetHeight >= el.clientHeight - 1,
              noSpuriousOverflow: el.scrollHeight <= el.clientHeight + 1,
            };
          }),
        { timeout: T_MEDIUM }
      )
      .toEqual({ fillsPreview: true, noSpuriousOverflow: true });

    await closeDialog(ctx.window);
  });
});
