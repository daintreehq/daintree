import path from "path";
import { execFileSync } from "child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { test, expect, type Locator, type Page } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../../helpers/launch";
import { createFixtureRepo, removePathSync } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import { dispatchAction } from "../../helpers/actions";
import {
  FAKE_AGENT_READY,
  fakeAgentEnv,
  installFakeAgent,
  ptyWrite,
  readFakeAgentLaunchLog,
  readFakeAgentStdinChunks,
} from "../../helpers/fakeAgent";
import { getTerminalTextById } from "../../helpers/terminal";
import { SEL } from "../../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_LONG } from "../../helpers/timeouts";

// One journey through the diff panel: git's patch as main computes it, drawn
// as hunks, stepped through by file, and handed back to an agent as a note.

const TEXT_FILE = "notes.txt";
const MD_FILE = "docs/plan.md";
const PNG_FILE = "assets/logo.png";

const TEXT_BEFORE = "alpha\nbravo\ncharlie\ndelta\necho\n";
const TEXT_AFTER = "alpha\nbravo\ncharlie revised\ndelta\necho\nfoxtrot added\n";
const TEXT_EDITED = TEXT_AFTER + "golf appended\n";
const MD_BEFORE = "# Launch checklist\n\nShip the build once every box is ticked.\n";
const MD_AFTER = "# Release runbook\n\nShip the build once every box is ticked.\n";
// 2x2 blue at HEAD, 3x3 red in the working tree: the sizes tell the sides apart.
const PNG_HEAD = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAD0lEQVR4nGNgYPgPRmAKABf2A/1+6zfzAAAAAElFTkSuQmCC",
  "base64"
);
const PNG_WORKING = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAMAAAADCAIAAADZSiLoAAAAEElEQVR4nGP4z8AAQQxYWACPjgj4kWPEuQAAAABJRU5ErkJggg==",
  "base64"
);
const NOTE_BODY = 'Keep the old name, say "charlie"';

let ctx: AppContext;
let page: Page;
let repoDir: string;
let binDir: string;
let binRoot: string;
let agentPaneId: string;
let fixtureCleanup: (() => void) | undefined;

function git(args: string[]): void {
  execFileSync("git", args, { cwd: repoDir, stdio: "ignore" });
}

function diffDialog(): Locator {
  return page.locator(SEL.reviewHub.diffDialog);
}

/** The text of every rendered row of one change type, in document order. */
async function codeLines(kind: "insert" | "delete"): Promise<string[]> {
  return diffDialog()
    .locator(`td.diff-code-${kind}`)
    .evaluateAll((cells) => cells.map((cell) => cell.textContent ?? ""));
}

async function expectTextHunks(added: string[], header: string): Promise<void> {
  await expect.poll(() => codeLines("delete"), { timeout: T_LONG }).toEqual(["charlie"]);
  await expect.poll(() => codeLines("insert"), { timeout: T_SHORT }).toEqual(added);
  await expect(diffDialog().locator(".diff-hunk-header-text")).toHaveText([header]);
  for (const line of ["charlie", ...added]) {
    await expect(
      diffDialog().locator("td.diff-code-insert, td.diff-code-delete").getByText(line, {
        exact: true,
      })
    ).toBeVisible();
  }
}

/** Rows holding the replaced line: one side by side in Split, two stacked in Unified. */
function replacementRows(): Locator {
  return diffDialog()
    .locator("tr")
    .filter({
      has: page.locator("td.diff-code-delete, td.diff-code-insert", {
        hasText: /^charlie( revised)?$/,
      }),
    });
}

/** Pass only once `read()` has held `expected` for the whole window. */
async function expectUnchangedFor(
  read: () => string,
  expected: string,
  ms: number,
  message: string
): Promise<void> {
  const start = Date.now();
  await expect(async () => {
    expect(JSON.stringify(read()), message).toBe(JSON.stringify(expected));
    expect(Date.now() - start).toBeGreaterThanOrEqual(ms);
  }).toPass({ timeout: ms + T_SHORT, intervals: [100] });
}

function positionIndicator(): Locator {
  return diffDialog().locator('[data-testid="diff-file-position-indicator"]');
}

function layoutRadio(name: "Unified" | "Split" | "Rendered"): Locator {
  return diffDialog()
    .getByRole("radiogroup", { name: "Diff layout" })
    .getByRole("radio", { name, exact: true });
}

/** Everything the agent has read from its PTY since `from` chunks in. */
function agentInputSince(from: number): string {
  return readFakeAgentStdinChunks(binDir)
    .slice(from)
    .map((chunk) => chunk.data)
    .join("");
}

test.describe.serial("Core: diff panel", () => {
  test.beforeAll(async () => {
    const fixture = createFixtureRepo({ name: "diff-panel" });
    fixtureCleanup = fixture.cleanup;
    repoDir = realpathSync(fixture.dir);
    // Byte-exact on every platform: Windows runners default autocrlf on, which
    // would have git compare CRLF checkouts against the LF text written here.
    git(["config", "core.autocrlf", "false"]);
    mkdirSync(path.join(repoDir, "docs"), { recursive: true });
    mkdirSync(path.join(repoDir, "assets"), { recursive: true });
    writeFileSync(path.join(repoDir, TEXT_FILE), TEXT_BEFORE);
    writeFileSync(path.join(repoDir, MD_FILE), MD_BEFORE);
    writeFileSync(path.join(repoDir, PNG_FILE), PNG_HEAD);
    git(["add", "-A"]);
    git(["commit", "-m", "add review fixtures"]);
    // Churn orders the change set: the text file (3 lines) leads, the
    // Markdown heading (2) follows, and the binary image (0) comes last.
    writeFileSync(path.join(repoDir, TEXT_FILE), TEXT_AFTER);
    writeFileSync(path.join(repoDir, MD_FILE), MD_AFTER);
    writeFileSync(path.join(repoDir, PNG_FILE), PNG_WORKING);

    // Outside the repo, so the fake CLI's own files never join the change set.
    binRoot = mkdtempSync(path.join(tmpdir(), "daintree-e2e-diff-agent-"));
    binDir = installFakeAgent(binRoot, { bracketedPaste: true, rawInput: true });

    ctx = await launchApp({ env: fakeAgentEnv(binDir) });
    page = await openAndOnboardProject(ctx.app, ctx.window, repoDir, "Diff Panel");
    ctx.window = page;

    const launched = await dispatchAction(
      page,
      "agent.launch",
      { agentId: "claude", location: "grid", name: "Reviewer" },
      { source: "test" }
    );
    expect(launched.ok, JSON.stringify(launched)).toBe(true);
    await expect.poll(() => readFakeAgentLaunchLog(binDir).length, { timeout: T_LONG * 2 }).toBe(1);
    const paneId = readFakeAgentLaunchLog(binDir)[0].paneId;
    expect(paneId, "the fake agent was started without a pane id").toBeTruthy();
    agentPaneId = paneId!;
    await expect
      .poll(() => getTerminalTextById(page, agentPaneId), { timeout: T_LONG })
      .toContain("Enter to confirm");
    expect(await ptyWrite(page, agentPaneId, "\r")).toBe(true);
    await expect
      .poll(() => getTerminalTextById(page, agentPaneId), { timeout: T_LONG })
      .toContain(FAKE_AGENT_READY);
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    fixtureCleanup?.();
    if (binRoot) removePathSync(binRoot);
  });

  test("a file on the worktree card opens git's hunks, and Unified redraws the same lines", async () => {
    const card = page.locator(SEL.worktree.card("main"));
    // A fresh card opens with its details folded; the file list lives inside.
    await card.getByRole("button", { name: "Show details" }).click({ timeout: T_LONG });
    const row = card.getByRole("button", { name: `Open ${TEXT_FILE}`, exact: true });
    await expect(row).toBeVisible({ timeout: T_LONG });
    await row.click();

    await expect(diffDialog()).toBeVisible({ timeout: T_MEDIUM });
    await expect(positionIndicator()).toHaveText("1 of 3", { timeout: T_LONG });
    // Split is the stored default; Rendered exists only for Markdown.
    await expect(layoutRadio("Split")).toHaveAttribute("aria-checked", "true");
    await expect(layoutRadio("Rendered")).toHaveCount(0);
    await expect(diffDialog().locator("table.diff-split")).toHaveCount(1, { timeout: T_LONG });
    await expectTextHunks(["charlie revised", "foxtrot added"], "@@ -1,5 +1,6 @@");
    await expect(replacementRows()).toHaveCount(1);

    await layoutRadio("Unified").click();
    await expect(layoutRadio("Unified")).toHaveAttribute("aria-checked", "true");
    await expect(diffDialog().locator("table.diff-unified")).toHaveCount(1, {
      timeout: T_MEDIUM,
    });
    await expectTextHunks(["charlie revised", "foxtrot added"], "@@ -1,5 +1,6 @@");
    await expect(replacementRows()).toHaveCount(2);

    await layoutRadio("Split").click();
    await expect(diffDialog().locator("table.diff-split")).toHaveCount(1, { timeout: T_MEDIUM });
    await expectTextHunks(["charlie revised", "foxtrot added"], "@@ -1,5 +1,6 @@");
    await expect(replacementRows()).toHaveCount(1);
  });

  test("Next file steps to the Markdown file, and Rendered shows the changed heading", async () => {
    await diffDialog().getByRole("button", { name: "Next file", exact: true }).click();
    await expect(positionIndicator()).toHaveText("2 of 3", { timeout: T_MEDIUM });
    await expect(diffDialog().getByText(MD_FILE, { exact: true }).first()).toBeVisible();
    await expect
      .poll(() => codeLines("delete"), { timeout: T_LONG })
      .toEqual(["# Launch checklist"]);
    await expect.poll(() => codeLines("insert")).toEqual(["# Release runbook"]);

    await layoutRadio("Rendered").click();
    const rendered = diffDialog().locator('[data-testid="rendered-markdown-diff"]');
    await expect(rendered).toBeVisible({ timeout: T_LONG });
    // Parsed into headings, not shown as the `#` source lines.
    const removedHeading = rendered.locator('[data-block-kind="removed"] h1');
    const addedHeading = rendered.locator('[data-block-kind="added"] h1');
    await expect(removedHeading).toHaveText("Launch checklist");
    await expect(addedHeading).toHaveText("Release runbook");
    await expect(removedHeading).toBeVisible();
    await expect(addedHeading).toBeVisible();
    await expect(diffDialog().locator("td.diff-code-insert")).toHaveCount(0);

    // Back to source for the rest of the run: the layout is a stored preference.
    await layoutRadio("Split").click();
    await expect
      .poll(() => codeLines("insert"), { timeout: T_MEDIUM })
      .toEqual(["# Release runbook"]);
  });

  test("] steps to the image, and both versions decode side by side", async () => {
    // The file keys listen on the diff body, not the footer, so the key goes
    // to the diff's own scroll region.
    const region = diffDialog().getByRole("region", { name: MD_FILE, exact: true });
    await region.focus();
    await expect(region).toBeFocused();
    await page.keyboard.press("]");
    await expect(positionIndicator()).toHaveText("3 of 3", { timeout: T_MEDIUM });

    const head = diffDialog().getByRole("img", { name: `HEAD version of ${PNG_FILE}` });
    const working = diffDialog().getByRole("img", { name: `Working tree version of ${PNG_FILE}` });
    await expect(head).toBeVisible({ timeout: T_LONG });
    await expect(working).toBeVisible({ timeout: T_LONG });
    const natural = (img: Locator) =>
      img.evaluate((el: HTMLImageElement) =>
        el.complete ? `${el.naturalWidth}x${el.naturalHeight}` : "pending"
      );
    await expect.poll(() => natural(head), { timeout: T_LONG }).toBe("2x2");
    await expect.poll(() => natural(working), { timeout: T_LONG }).toBe("3x3");
    // Two-up: HEAD sits wholly to the left of the working tree, not under it.
    await expect(
      diffDialog()
        .getByRole("radiogroup", { name: "Comparison mode" })
        .getByRole("radio", { name: "Two-up" })
    ).toHaveAttribute("aria-checked", "true");
    const headBox = await head.boundingBox();
    const workingBox = await working.boundingBox();
    expect(headBox && workingBox, "both image versions have a layout box").toBeTruthy();
    expect(headBox!.x + headBox!.width).toBeLessThanOrEqual(workingBox!.x);
    await expect(
      diffDialog().getByRole("button", { name: "Next file", exact: true })
    ).toBeDisabled();
  });

  test("an edit on disk marks the diff stale, and Refresh draws the new hunk", async () => {
    await diffDialog().getByRole("button", { name: "Previous file", exact: true }).click();
    await expect(positionIndicator()).toHaveText("2 of 3", { timeout: T_MEDIUM });
    await diffDialog().getByRole("button", { name: "Previous file", exact: true }).click();
    await expect(positionIndicator()).toHaveText("1 of 3", { timeout: T_MEDIUM });
    await expectTextHunks(["charlie revised", "foxtrot added"], "@@ -1,5 +1,6 @@");
    const banner = diffDialog()
      .getByRole("status")
      .filter({ hasText: "File changed since this diff loaded" });
    await expect(banner).toHaveCount(0);

    writeFileSync(path.join(repoDir, TEXT_FILE), TEXT_EDITED);

    // Carried by the worktree status refresh, not by anything the pane watches.
    await expect(banner).toBeVisible({ timeout: T_LONG * 2 });
    // Until asked, the diff on screen stays the one that loaded.
    expect(await codeLines("insert")).toEqual(["charlie revised", "foxtrot added"]);

    await banner.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(banner).toHaveCount(0, { timeout: T_LONG });
    await expectTextHunks(["charlie revised", "foxtrot added", "golf appended"], "@@ -1,5 +1,7 @@");
  });

  test("a line note is pasted into the agent's composer, bracketed and unsubmitted", async () => {
    const revisedRow = diffDialog()
      .locator("tr")
      .filter({ has: page.locator("td.diff-code-insert", { hasText: /^charlie revised$/ }) });
    const gutter = revisedRow.locator("td.diff-gutter-insert");
    await expect(gutter).toHaveCount(1);
    await gutter.click();

    const composer = diffDialog().locator('[data-testid="diff-note-composer"]');
    await expect(composer).toBeVisible({ timeout: T_MEDIUM });
    await expect(composer).toContainText("Line 3");
    await composer.getByRole("textbox").fill(NOTE_BODY);
    await composer.getByRole("button", { name: "Add note", exact: true }).click();
    await expect(diffDialog().locator('[data-testid="diff-note"]')).toHaveCount(1, {
      timeout: T_MEDIUM,
    });

    const sendButton = diffDialog().locator('[data-testid="diff-notes-send"]');
    await expect(sendButton).toContainText("1");
    const before = readFakeAgentStdinChunks(binDir).length;
    await sendButton.click();
    const target = page.getByRole("menuitem").filter({ hasText: "Reviewer" });
    await expect(target).toBeVisible({ timeout: T_MEDIUM });
    await target.click();

    const expected =
      "\x1b[200~" +
      `File: ${TEXT_FILE}\nLine(s): 3\n"${NOTE_BODY.replace(/"/g, '\\"')}"` +
      "\x1b[201~";
    await expect
      .poll(() => JSON.stringify(agentInputSince(before)), { timeout: T_LONG })
      .toBe(JSON.stringify(expected));

    // Never submitted: nothing follows the paste, not even after the longest
    // settle a delayed submit waits for.
    await expectUnchangedFor(
      () => agentInputSince(before),
      expected,
      3_000,
      "the notes must sit in the composer without an Enter behind them"
    );
    // And the log is live: a marker written now lands directly behind the paste.
    expect(await ptyWrite(page, agentPaneId, "~")).toBe(true);
    await expect
      .poll(() => JSON.stringify(agentInputSince(before)), { timeout: T_MEDIUM })
      .toBe(JSON.stringify(expected + "~"));

    // Sent notes leave the review: the card and the send control go with them.
    await expect(diffDialog().locator('[data-testid="diff-note"]')).toHaveCount(0, {
      timeout: T_MEDIUM,
    });
    await expect(sendButton).toHaveCount(0);
  });
});
