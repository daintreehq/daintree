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

// Tall enough to overflow the preview in both source and rendered mode.
// Blank-line separated so the rendered document is a stack of real <p>
// elements rather than one wrapped paragraph.
const TALL_MARKDOWN =
  "# Tall browser document\n\n" +
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

/**
 * Opens the browser through the real action rather than driving the
 * virtualized tree: `revealPath` seeds the selection, so the preview renders
 * the file without a click that depends on row virtualization.
 */
async function openFileBrowser(page: Page, revealPath: string) {
  const listed = await dispatchAction(page, "worktree.list");
  if (!listed.ok) throw new Error(`worktree.list failed: ${listed.error?.message ?? "unknown"}`);
  const worktrees = listed.result?.worktrees ?? [];
  const target = worktrees.find((w) => w.isMain) ?? worktrees[0];
  if (!target) throw new Error("no worktree to browse");

  await dispatchAction(page, "worktree.openFileBrowser", {
    worktreeId: target.id,
    revealPath,
    revealKind: "file",
  });

  const dialog = page.locator(SEL.fileViewer.dialog);
  await expect(dialog).toBeVisible({ timeout: T_MEDIUM });
  return dialog;
}

async function closeDialog(page: Page) {
  await page.locator(SEL.fileViewer.closeButton).first().click();
  await expect(page.locator(SEL.fileViewer.dialog)).not.toBeVisible({ timeout: T_SHORT });
}

/**
 * #11441: neither markdown surface brings its own scroller — MarkdownDocument
 * carries no overflow class, and CodeViewer forces `.cm-scroller` visible — so
 * without a scroll owner in the preview everything past the first screenful
 * was unreachable. Mirrors `expectScrollsWithinDialog` in core-file-viewer.
 */
async function expectPreviewScrolls(scrollRoot: Locator) {
  await expect
    .poll(
      () =>
        scrollRoot.evaluate((el) => {
          const dialogRect = el.closest('[data-testid="panel-dialog"]')?.getBoundingClientRect();
          return {
            scrollsInternally: el.scrollHeight > el.clientHeight,
            // A real scrollbar, not merely programmatic scrollability: an
            // `overflow: hidden` element still accepts a `scrollTop` write, so
            // the scroll check below would pass on a clipped preview.
            scrollable: ["auto", "scroll"].includes(getComputedStyle(el).overflowY),
            // The preview stays inside the dialog surface. A pane that sizes to
            // the document instead fits the window while having its bottom edge
            // — and its scrollbar — clipped away.
            withinDialog:
              dialogRect !== undefined &&
              el.getBoundingClientRect().bottom <= dialogRect.bottom + 1,
            // The content is the preview's own child, not a nested scrollport
            // that would trap the wheel and leave the outer one at zero.
            childDelegatesScroll:
              el.firstElementChild instanceof HTMLElement &&
              el.firstElementChild.scrollHeight <= el.firstElementChild.clientHeight + 1,
          };
        }),
      { timeout: T_MEDIUM }
    )
    .toEqual({
      scrollsInternally: true,
      scrollable: true,
      withinDialog: true,
      childDelegatesScroll: true,
    });

  // Content past the first screen is reachable, and scrolling lands on the real
  // bottom rather than some intermediate clamp.
  const scroll = await scrollRoot.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
    return { reached: el.scrollTop, max: el.scrollHeight - el.clientHeight };
  });
  expect(scroll.reached).toBeGreaterThan(0);
  expect(scroll.reached).toBeGreaterThanOrEqual(scroll.max - 2);
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
    const document = dialog.locator(".markdown-document");
    await expect(document).toContainText("Paragraph 001", { timeout: T_LONG });

    const scrollRoot = dialog.getByTestId("file-browser-markdown-scroll");
    await expectPreviewScrolls(scrollRoot);

    // The user-visible symptom: the tail of the document was unreachable.
    await scrollRoot.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await expect(dialog.getByRole("heading", { name: /file-browser-end/ })).toBeInViewport({
      timeout: T_MEDIUM,
    });

    await closeDialog(ctx.window);
  });

  test("markdown source mode scrolls in the same preview scroll root", async () => {
    const dialog = await openFileBrowser(ctx.window, "tall.md");
    await expect(dialog.locator(".markdown-document")).toBeVisible({ timeout: T_LONG });

    await dialog.getByRole("button", { name: "Source" }).click();
    await expect(dialog.locator(".cm-content")).toContainText("# Tall browser document", {
      timeout: T_LONG,
    });

    // CodeViewer's root carries `overflow-auto` by default, so this also proves
    // the two scrollports don't fight: with no definite height it grows with
    // CodeMirror and delegates the scroll up to the preview wrapper.
    await expectPreviewScrolls(dialog.getByTestId("file-browser-markdown-scroll"));

    await closeDialog(ctx.window);
  });

  test("a short markdown document fills the preview instead of stopping at its own height", async () => {
    const dialog = await openFileBrowser(ctx.window, "short.md");
    await expect(dialog.locator(".markdown-document")).toContainText("One paragraph", {
      timeout: T_LONG,
    });

    // `min-h-full` rather than no class at all: the document reaches the bottom
    // of the preview so its background doesn't stop mid-pane, and rather than
    // `h-full`, which would clamp it and re-break the tall case above.
    await expect
      .poll(
        () =>
          dialog.getByTestId("file-browser-markdown-scroll").evaluate((el) => {
            const document = el.firstElementChild;
            return {
              fillsPreview:
                document instanceof HTMLElement && document.offsetHeight >= el.clientHeight - 1,
              noSpuriousOverflow: el.scrollHeight <= el.clientHeight + 1,
            };
          }),
        { timeout: T_MEDIUM }
      )
      .toEqual({ fillsPreview: true, noSpuriousOverflow: true });

    await closeDialog(ctx.window);
  });
});
