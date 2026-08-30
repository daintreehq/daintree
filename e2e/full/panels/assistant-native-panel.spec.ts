import { test, expect } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchApp, closeApp, type AppContext } from "../../helpers/launch";
import { createFixtureRepo } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import { T_LONG, T_MEDIUM, T_SETTLE } from "../../helpers/timeouts";
import { getFirstGridPanel, openSettings, openTerminal } from "../../helpers/panels";
import { SEL } from "../../helpers/selectors";

/**
 * The native assistant panel, driven end to end against a real engine process.
 *
 * `DAINTREE_ASSISTANT_BIN` points at the scriptable fake engine, so every turn is an
 * exact byte sequence rather than whatever a model happened to say. That is the whole
 * reason the fake exists: this suite asserts things the panel must do — a tool batch
 * reads as a plan, `waiting` reads as blocked-on-you, a typed confirmation cannot be
 * clicked past, `turn:end` content replaces the streamed buffer — and none of those
 * can be asserted against non-deterministic prose, a live backend, or real spend.
 *
 * The fake is separately proven faithful to the real Go engine's wire shapes by
 * `e2e/helpers/__tests__/fakeAssistantEngine.test.ts`, so a green run here is a
 * statement about the product rather than about a fiction.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE_ENGINE = path.resolve(HERE, "../../helpers/fake-assistant-engine.mjs");

let ctx: AppContext;
let fixtureDir: string;
let fixtureCleanup: (() => void) | undefined;

/**
 * Opens the assistant panel.
 *
 * Open state comes from the TOOLBAR TOGGLE'S `aria-pressed`, not from whether the
 * composer looks visible. The panel slides off-canvas instead of unmounting, so
 * Playwright reports its contents as visible while it is closed — a check on the
 * composer silently skips the toggle, leaves `isOpen` false, and the engine never
 * starts because the panel it belongs to is not actually open.
 */
async function openAssistant(window: AppContext["window"]) {
  const toggle = window
    .getByRole("toolbar", { name: "Main toolbar" })
    .getByRole("button", { name: "Daintree Assistant", exact: true });
  await expect(toggle).toBeVisible({ timeout: T_LONG });

  if ((await toggle.getAttribute("aria-pressed")) !== "true") {
    await toggle.click();
  }
  await expect(toggle).toHaveAttribute("aria-pressed", "true", { timeout: T_LONG });

  const panel = window.locator("#daintree-assistant-panel");
  await expect(panel).toBeVisible({ timeout: T_LONG });
  await waitForSession(window);
  return panel;
}

/** Waits for a live engine session. The status line is the readiness signal. */
async function waitForSession(window: AppContext["window"]) {
  await expect(
    window.locator("#daintree-assistant-panel").getByText("Connected", { exact: true })
  ).toBeVisible({ timeout: T_LONG });
}

/**
 * The composer — present only when the NATIVE panel rendered, never for an xterm.
 *
 * It is the terminal's OWN input bar (`HybridInputBar`), not a copy, so it is a
 * CodeMirror surface rather than a textarea: `.cm-content` is the contenteditable the
 * user actually types into. The panel deliberately has no Send button — the terminal's
 * bar does not have one either, and the assistant is not a different kind of input.
 */
function composer(window: AppContext["window"]) {
  return window.locator("#daintree-assistant-panel .cm-content");
}

/**
 * The composer's own shell — the element HybridInputBar puts `aria-disabled` on.
 *
 * Separate from `composer()`, which is the CodeMirror content node: the disabled state
 * is a property of the bar, not of the editor inside it, and a question sheet blocking
 * the turn is now expressed by disabling the bar rather than by removing it.
 */
function composerShell(window: AppContext["window"]) {
  return window
    .locator("#daintree-assistant-panel [data-hybrid-input-root] [aria-disabled]")
    .first();
}

/**
 * Types into the composer.
 *
 * `fill()` does not work on a CodeMirror surface: it is a contenteditable, not a form
 * control, and CodeMirror rebuilds the DOM from its own document state. Real key input
 * is what drives that document, so the text has to be typed.
 */
async function type(window: AppContext["window"], text: string) {
  const input = composer(window);
  await expect(input).toBeVisible({ timeout: T_LONG });
  await input.click();
  await window.keyboard.insertText(text);
}

/**
 * What is actually in the composer, as the user would say it.
 *
 * NOT `innerText`. CodeMirror renders its placeholder as a child of the content
 * element, so an EMPTY editor reads back as "Ask Daintree Assistant" — which is how a
 * prompt that sent perfectly well looks like a prompt that was refused. The placeholder
 * is present only while the document is empty, so its presence is the reliable signal.
 *
 * A missing composer is also empty: the panel renders it only once boot is finished.
 */
async function composerText(window: AppContext["window"]): Promise<string> {
  const input = composer(window);
  if ((await input.count()) === 0) return "";
  if ((await input.locator(".cm-placeholder").count()) > 0) return "";
  return (await input.innerText()).trim();
}

async function ask(window: AppContext["window"], text: string) {
  const input = composer(window);
  await expect(input).toBeVisible({ timeout: T_LONG });
  // Wait for the ENGINE, not just the panel. The composer renders as soon as the panel
  // does, but the session is still starting — and a prompt sent before it is ready is
  // refused (the draft is KEPT rather than eaten) instead of queued, so asking early
  // would assert against a turn that never happened. The status line is the readiness
  // signal.
  await waitForSession(window);

  await type(window, text);
  await window.keyboard.press("Enter");
  // The composer clears only on ACCEPTANCE, so an empty box is proof the prompt was
  // taken rather than refused.
  await expect.poll(() => composerText(window), { timeout: T_MEDIUM }).toBe("");
}

test.describe.serial("Assistant: native panel", () => {
  test.beforeEach(async () => {
    const { dir, cleanup } = createFixtureRepo({ name: "assistant-native" });
    fixtureDir = dir;
    fixtureCleanup = cleanup;

    ctx = await launchApp({
      env: {
        // The engine under test. Resolution prefers this over the bundled binary, so
        // no build of the real engine is needed for these assertions.
        DAINTREE_ASSISTANT_BIN: FAKE_ENGINE,
        // Zero delay: these assert behaviour, not animation timing.
        FAKE_ENGINE_SPEED: "0",
        FAKE_ENGINE_SCENARIO: "streaming",
      },
    });
    ctx.window = await openAndOnboardProject(
      ctx.app,
      ctx.window,
      fixtureDir,
      "Assistant Native Test"
    );
  });

  test.afterEach(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    fixtureCleanup?.();
  });

  test("renders natively rather than as a terminal", async () => {
    const { window } = ctx;
    const panel = await openAssistant(window);

    // The pair is the discriminator. The panel hosts an editable composer AND no xterm
    // — which is exactly what separates "the native panel rendered" from "we are
    // looking at the old PTY cockpit in a terminal", a regression that would otherwise
    // be invisible in a screenshot. Neither half alone is enough: an agent terminal
    // carries the same input bar beneath its xterm.
    await expect(composer(window)).toBeVisible({ timeout: T_LONG });
    await expect(panel.locator(".xterm")).toHaveCount(0);
  });

  test("streams an answer and settles its tool batch", async () => {
    const { window } = ctx;
    await openAssistant(window);
    await ask(window, "/scenario streaming");

    // The batch is announced as a plan before dispatch, so the group header appears
    // with both calls in it rather than one row at a time — and it says what they DID,
    // in the engine's own verbs, with the count trailing. A bare "2 actions" is the
    // count of a fact instead of the fact.
    const group = window.locator("#daintree-assistant-panel").getByRole("button", {
      name: /Listed worktrees.*Read git state/,
    });
    await expect(group).toBeVisible({ timeout: T_MEDIUM });
    await expect(group).toContainText("· 2");
    await expect(window.getByText(/Three worktrees are ready/)).toBeVisible({
      timeout: T_MEDIUM,
    });
  });

  test("an answer can be selected with the mouse, and a plain click still focuses the composer", async () => {
    const { window } = ctx;
    await openAssistant(window);
    await ask(window, "/scenario streaming");

    const answer = window
      .locator("#daintree-assistant-panel")
      .getByText(/Three worktrees are ready/);
    await expect(answer).toBeVisible({ timeout: T_MEDIUM });

    // A real press-drag-release, never `selectText()`, because the bugs this pins were
    // invisible to an API-driven selection — the DOM was always selectable, it was the
    // POINTER that could not do it:
    //
    //   1. the panel focused its composer on mousedown, which moves the document
    //      selection into the editor and cancels the drag before it starts, and
    //   2. the panel's own `<aside>` carried a permanent `tabindex`, so Chromium
    //      focused the region on mousedown and collapsed the selection with it.
    //
    // Either one alone reproduces on every attempt: an answer could not be copied.
    //
    // Coordinates come from the TEXT's own client rect, not the paragraph's layout box.
    // A block-level `<p>` is as wide as the panel while a short answer occupies only the
    // left of it, so the box's midpoint lands on empty ground, the press never anchors
    // in a text node, and the drag produces nothing for a reason that has nothing to do
    // with what is under test. The rect is also read TWICE and required to agree: the
    // composer refocuses itself on its own frames as the panel settles, and each focus
    // can scroll the transcript out from under a rect measured a moment earlier.
    const rect = await window.evaluate(async () => {
      const read = () => {
        const p = document.querySelector("#daintree-assistant-panel .assistant-prose p");
        const node = p?.firstChild;
        if (!node) return null;
        const r = document.createRange();
        r.selectNodeContents(node);
        const box = r.getClientRects()[0];
        window.getSelection()?.removeAllRanges();
        if (!box) return null;
        const x = box.x + 1;
        const y = box.y + box.height / 2;
        // The hit test is the point of the whole exercise: it is what proves the press
        // will land on the paragraph rather than on the scroll container behind it.
        return document.elementFromPoint(x, y) === p ? { x, y, w: box.width } : null;
      };
      for (let i = 0; i < 40; i++) {
        const a = read();
        await new Promise((r) => setTimeout(r, 100));
        const b = read();
        if (a && b && a.x === b.x && a.y === b.y) return b;
      }
      return null;
    });
    if (!rect) throw new Error("the answer never settled into a stable, hittable text rect");

    await window.mouse.move(rect.x, rect.y);
    await window.mouse.down();
    // Two moves: a press followed by a single jump can be treated as a click, where an
    // intermediate point makes it unambiguously a drag.
    await window.mouse.move(rect.x + rect.w / 2, rect.y, { steps: 10 });
    await window.mouse.move(rect.x + rect.w - 2, rect.y, { steps: 10 });
    await window.mouse.up();

    const selected = await window.evaluate(() => window.getSelection()?.toString() ?? "");
    expect(
      selected.trim().length,
      `nothing was selected (got ${JSON.stringify(selected)})`
    ).toBeGreaterThan(0);

    // The other half of the same handler: moving the focus grab to mouseup must not
    // cost the panel its click-anywhere-to-type affordance, which is why it exists.
    // Straight onto the live selection, deliberately NOT cleared first. That is the
    // harder case and the one a reader actually performs: select an answer, then click
    // to carry on typing. The selection is still non-empty when `mouseup` fires —
    // Chromium defers collapsing it to resolve click-versus-drag — so a handler that
    // reads it there declines to focus, the click then collapses it anyway, and the user
    // is left with neither a selection nor a caret.
    await window.mouse.click(rect.x + rect.w / 2, rect.y);
    await expect(composer(window)).toBeFocused();
  });

  test("clicking the composer keeps the caret, with a plain terminal focused behind it", async () => {
    const { window } = ctx;

    // A PLAIN terminal, deliberately: one with no agent identity has no input bar of
    // its own, so the session-wide `preferredTerminalFocusTarget` resolves to xterm for
    // it. That is what made this pane the thief and an agent terminal not — with only
    // agent terminals open the preference already reads "hybridInput", the composer's
    // write is a no-op, and nothing re-runs.
    await openTerminal(window);
    const pane = getFirstGridPanel(window);
    await expect(pane).toBeVisible({ timeout: T_LONG });

    // Twice. The first press on an unfocused grid pane is swallowed to activate it
    // (`shouldSuppressUnfocusedClick`); only a press that actually reaches xterm fires
    // the focusin that records "xterm", which is the state this test needs to set up.
    const screen = pane.locator(".xterm-screen");
    await screen.click();
    await screen.click();
    await expect(pane.locator(".xterm-helper-textarea")).toBeFocused();

    await openAssistant(window);
    const input = composer(window);
    await input.click();
    await expect(input).toBeFocused();

    // And it STAYS. The steal arrived a frame later and from the other side of the app:
    // the click recorded "hybridInput", the still-store-focused terminal re-ran its own
    // focus effect on that change, resolved to xterm and took the caret back. An
    // immediate assertion passes even with the bug present, so the settle is the test.
    await window.waitForTimeout(T_SETTLE);
    await expect(input).toBeFocused();
    await expect(pane.locator(".xterm-helper-textarea")).not.toBeFocused();

    // Typing is the thing the user lost, so assert the thing rather than its proxy.
    await window.keyboard.insertText("still mine");
    await expect(input).toContainText("still mine");
  });

  test("the streaming caret stops when the engine stops writing prose", async () => {
    const { window } = ctx;
    await openAssistant(window);

    const panel = window.locator("#daintree-assistant-panel");
    const streamingProse = panel.locator(".assistant-prose.is-streaming");

    await ask(window, "/scenario proseThenTool");

    // While the prose is arriving the caret is the signal that it is, so it must be
    // there — a test that only proved it goes away would pass on a caret that never
    // appeared at all.
    await expect(streamingProse).toHaveCount(1, { timeout: T_MEDIUM });

    // The engine has now left `generating` to compose a call, and the answer is STILL
    // the last thing drawn — no tool row is announced yet. The caret used to blink all
    // the way through this, claiming text was still arriving for as long as the call
    // took.
    await expect(streamingProse).toHaveCount(0, { timeout: T_MEDIUM });

    // The turn must still be mid-flight, or the caret going away proves nothing — it
    // goes away when a turn ENDS too. Read in one page evaluation rather than as two
    // more Playwright assertions, so both facts describe the same instant: the
    // scenario's composing window is long, but not a licence to assert across it.
    const midTurn = await window.evaluate(() => {
      const text = document.querySelector("#daintree-assistant-panel")?.textContent ?? "";
      return {
        proseIsStillLast: text.includes("Checking the worktrees now"),
        turnHasFinished: text.includes("Three worktrees are ready"),
      };
    });
    expect(midTurn.proseIsStillLast, "the prose the caret was parked on should still show").toBe(
      true
    );
    expect(midTurn.turnHasFinished, "the turn should not have ended yet").toBe(false);
  });

  test("a long prompt folds to a fixed height and opens on Show more", async () => {
    const { window } = ctx;
    await openAssistant(window);
    await waitForSession(window);

    // ONE long wrapping paragraph, not many short lines. The fold used to count
    // newlines, which is the wrong question: this prompt is a single line by that
    // arithmetic and a dozen on screen, so the shape people actually paste was the one
    // shape that never folded.
    const prompt = `Please review ${"the performance of every panel in this application and report back ".repeat(12)}when you are done.`;
    await type(window, prompt);
    await window.keyboard.press("Enter");
    await expect.poll(() => composerText(window), { timeout: T_MEDIUM }).toBe("");

    const panel = window.locator("#daintree-assistant-panel");
    const more = panel.getByRole("button", { name: "Show more" });
    await expect(more).toBeVisible({ timeout: T_MEDIUM });

    const bubble = panel.locator("div", { hasText: "Please review the performance" }).last();
    const foldedHeight = (await bubble.boundingBox())?.height ?? 0;
    expect(foldedHeight, "the folded prompt should be capped").toBeGreaterThan(0);

    await more.click();
    const less = panel.getByRole("button", { name: "Show less" });
    await expect(less).toBeVisible();
    // The control is a TOGGLE, and the height has to actually move — a "Show more" that
    // relabels itself without revealing anything is the failure worth catching.
    await expect
      .poll(async () => (await bubble.boundingBox())?.height ?? 0)
      .toBeGreaterThan(foldedHeight);

    await less.click();
    await expect(more).toBeVisible();
  });

  test("replaces streamed tokens with the authoritative final content", async () => {
    const { window } = ctx;
    await openAssistant(window);
    await ask(window, "/scenario authoritativeContent");

    await expect(window.getByText(/authoritative answer replaced/)).toBeVisible({
      timeout: T_MEDIUM,
    });
    // The self-healing property: a consumer that merely concatenates tokens would
    // still be showing the truncated stream.
    await expect(window.getByText(/PARTIAL-STREAM-SHOULD-BE-REPLACED/)).toHaveCount(0);
  });

  test("a typed confirmation cannot be approved by clicking", async () => {
    const { window } = ctx;
    await openAssistant(window);
    await ask(window, "/scenario approval");

    const card = window.getByRole("group", { name: "Approval required" });
    await expect(card).toBeVisible({ timeout: T_MEDIUM });

    // needsTypedConfirm is the ENGINE's verdict. The destructive button stays disabled
    // until the phrase is typed — a UI that enabled it early would have forked a
    // security rule into a second codebase.
    const approve = card.getByRole("button", { name: /Push commits/ });
    await expect(approve).toBeDisabled();

    await card.getByPlaceholder("confirm").fill("confirm");
    await expect(approve).toBeEnabled();
    await approve.click();

    await expect(window.getByText(/Pushed\./)).toBeVisible({ timeout: T_MEDIUM });
  });

  test("surfaces a lost frame instead of showing a partial answer as whole", async () => {
    const { window } = ctx;
    await openAssistant(window);
    await ask(window, "/scenario droppedFrame");

    await expect(window.getByText(/lost in transit/)).toBeVisible({ timeout: T_MEDIUM });
  });

  test("keeps an accepted background task out of the finished state", async () => {
    const { window } = ctx;
    await openAssistant(window);
    await ask(window, "/scenario asyncWork");

    // The call settled but the work was handed off. Rendering it as done — or showing
    // the dispatch duration, which reads as "finished in 1.2s" — would claim work
    // completed that had only just started somewhere else.
    await expect(window.getByText(/Handed off to run in the background/)).toBeVisible({
      timeout: T_MEDIUM,
    });
    // And NOT a present-tense claim about work this panel cannot observe: completion
    // returns as its own wake turn, never as a late result for this row, so "still
    // running" would go stale the moment the work finished.
    await expect(window.getByText(/still running/)).toHaveCount(0);
    // Named, so the row says WHAT was handed off.
    await expect(window.getByText(/migrate the schema in wt_forge/)).toBeVisible();
  });

  test("stopping a turn terminalizes its calls instead of leaving them Running", async () => {
    const { window } = ctx;
    await openAssistant(window);
    await ask(window, "/scenario cancellable");

    // Batches collapse by default, so open the group to see the individual rows.
    const group = window.locator("#daintree-assistant-panel").getByRole("button", {
      // A COUNT, not the word: "More actions" in the panel header matches /actions/.
      // This batch's tools have no verb in the fake, so the header falls back to the
      // count — which is the fallback branch, and worth exercising here.
      name: /\d+ actions?/,
    });
    await expect(group).toBeVisible({ timeout: T_MEDIUM });
    if ((await group.getAttribute("aria-expanded")) !== "true") await group.click();

    await expect(window.getByText("Running", { exact: true })).toBeVisible({ timeout: T_MEDIUM });
    await window
      .locator("#daintree-assistant-panel")
      .getByRole("button", { name: "Stop", exact: true })
      .click();

    // The call that WAS running, and the one that never started, settle differently:
    // that difference is what tells a reader what the stop actually interrupted.
    await expect(window.getByText("Cancelled", { exact: true })).toBeVisible({ timeout: T_MEDIUM });
    await expect(window.getByText("Not run", { exact: true })).toBeVisible();
    // Nothing is left describing work that is not happening.
    await expect(window.getByText("Running", { exact: true })).toHaveCount(0);
  });

  test("a failed call says what went wrong, not just a code", async () => {
    const { window } = ctx;
    await openAssistant(window);
    await ask(window, "/scenario degraded");

    // The engine's own sentence. A bare error code tells a reader that something
    // failed, not what — the cockpit led with the message for exactly that reason.
    await expect(window.getByText(/control plane is not connected/)).toBeVisible({
      timeout: T_MEDIUM,
    });
  });

  test("a slash command runs instead of becoming a prompt", async () => {
    const { window } = ctx;
    await openAssistant(window);
    const panel = window.locator("#daintree-assistant-panel");
    // Count the answers BEFORE, so "no turn ran" is a comparison rather than the
    // absence of a transient phase label. With the fake at speed zero an accidental
    // turn completes before any phase could be observed, so checking for phase text
    // proved nothing at all.
    const proseBefore = await panel.locator(".assistant-prose").count();

    await ask(window, "/status");

    // The command's OUTPUT, which only the command path can produce. Scoped past the
    // masthead, which now legitimately carries the same words.
    await expect(panel.getByText(/backend\s+local/).last()).toBeVisible({ timeout: T_MEDIUM });

    // And no turn was spent asking the model about the word "status": a command result
    // is not a prose block, so the count is unchanged.
    await expect
      .poll(() => panel.locator(".assistant-prose").count(), { timeout: T_MEDIUM })
      .toBe(proseBefore);
    await expect(window.getByText(/Three worktrees are ready/)).toHaveCount(0);
  });

  test("command output keeps the engine's own line breaks and column padding", async () => {
    const { window } = ctx;
    await openAssistant(window);
    const panel = window.locator("#daintree-assistant-panel");

    await ask(window, "/status");
    await expect(panel.getByText(/backend\s+local/).last()).toBeVisible({ timeout: T_MEDIUM });

    // `innerText`, NOT `textContent`. The distinction is the entire test: textContent
    // returns the source string, newlines and all, no matter what CSS does to it — so a
    // regex over it passes whether the panel preserved the engine's formatting or folded
    // it into one line, which is how the neighbouring `/backend\s+local` assertion above
    // went on passing while every command result rendered as a single paragraph of prose.
    // innerText is the RENDERED text, so it can only look like this if white-space is
    // actually being honoured.
    //
    // The engine formats command output as terminal text: `/status` puts `backend` and
    // `tier` on their own lines and pads the label column so the values line up. Both
    // halves are asserted because they fail independently — folding destroys the break,
    // and whitespace collapsing destroys the padding that carries the alignment.
    // Scoped to the NOTICE, by testid. The masthead carries the same words in its own
    // per-line elements, so a text-shaped locator matched it instead and read newlines
    // that came from block boundaries rather than from preserved whitespace — passing
    // identically with the fix reverted, which is the one thing this test must not do.
    const rendered = await panel
      .getByTestId("assistant-notice")
      .filter({ hasText: /backend/ })
      .last()
      .evaluate((el: HTMLElement) => el.innerText);

    expect(rendered).toMatch(/backend {2,}local/);
    expect(rendered).toMatch(/\n\s*tier {2,}operator/);
  });

  test("slash-prefixed prose still reaches the model", async () => {
    const { window } = ctx;
    await openAssistant(window);
    // Begins with a slash and a letter, and is plainly not a command. Routing on shape
    // alone swallowed text like this into an unknown-command reply, losing what the
    // user actually wrote.
    //
    // The prose must name a command the engine does NOT advertise. Written with
    // `/scenario …` this proved nothing: `/scenario` IS in the catalog, so the panel
    // took the command path and the test passed while ordinary prose like
    // "/review this diff" could still be swallowed. `/review` is not in the fake's
    // catalog, so this is the routing decision the test claims to be about.
    await ask(window, "/review this diff and tell me what you think");

    // It reached the MODEL: a turn ran and answered. The default scenario is
    // `streaming`, which is what a plain prompt produces.
    await expect(window.getByText(/Three worktrees are ready/)).toBeVisible({
      timeout: T_MEDIUM,
    });
    await expect(window.getByText(/isn't a command/)).toHaveCount(0);
    // And the prompt survived intact, rather than being trimmed on the way through.
    await expect(
      window.locator("#daintree-assistant-panel").getByText(/tell me what you think/)
    ).toBeVisible();
  });

  test("an ordinary prompt — no slash anywhere — runs a turn", async () => {
    const { window } = ctx;
    await openAssistant(window);

    // The plainest thing a user can do, and until now the one path no CI test walked.
    // Every other test here selects a scenario with `/scenario …`, which takes the
    // COMMAND route — so the ordinary `prompt` route could have been entirely broken
    // and this suite would have stayed green through a release.
    await ask(window, "which worktrees are ready to review?");

    await expect(window.getByText(/Three worktrees are ready/)).toBeVisible({
      timeout: T_MEDIUM,
    });
    // The user's own words are in the transcript, above the answer.
    const panel = window.locator("#daintree-assistant-panel");
    await expect(panel.getByText(/which worktrees are ready to review/)).toBeVisible();
    await expect(window.getByText(/isn't a command/)).toHaveCount(0);
  });

  test("typing a slash offers the engine's own command set", async () => {
    const { window } = ctx;
    await openAssistant(window);
    await type(window, "/");

    // The input bar's own palette, named as the bar names it. The commands in it are
    // the ENGINE's, handed down as an override — the bar's usual filesystem discovery
    // would offer this project's Claude commands, which the assistant cannot run.
    const palette = window.getByRole("listbox", { name: "Command autocomplete" });
    await expect(palette).toBeVisible({ timeout: T_MEDIUM });
    // Each entry says what the command DOES: the operations surface — inbox, watchers,
    // timers, workflows — is reachable only through these, so bare names would hide it
    // behind knowing what to type.
    await expect(palette.getByText("supervised agents")).toBeVisible();

    // Filters as you type, and running one takes the command path. Retyped from empty
    // rather than appended: the composer is a real editor, so typing "/wat" after "/"
    // would compose "//wat".
    await window.keyboard.press("ControlOrMeta+a");
    await window.keyboard.press("Backspace");
    await type(window, "/wat");
    await expect(palette.getByRole("option")).toHaveCount(1);
    // Enter RUNS the highlighted command; Tab and a click complete it into the draft.
    // That split is the input bar's own contract (useAutocompleteApply honours an
    // item's enterAction only in "enter" mode), and the assistant inherits it rather
    // than redefining it — so this is the gesture that has to reach the engine.
    await window.keyboard.press("Enter");
    // Text unique to `/watchers`. Every command used to answer with the same masthead,
    // so dispatching the WRONG known command produced identical output and passed.
    await expect(window.getByText(/WATCHERS/)).toBeVisible({ timeout: T_MEDIUM });
    await expect(window.getByText(/wt_forge\s+claude/)).toBeVisible();
    await expect.poll(() => composerText(window), { timeout: T_MEDIUM }).toBe("");
  });

  test("an unknown slash command says so rather than asking the model", async () => {
    const { window } = ctx;
    await openAssistant(window);
    await ask(window, "/nonsense");

    await expect(window.getByText(/isn't a command/)).toBeVisible({ timeout: T_MEDIUM });
  });

  test("a multiple-choice question blocks the turn until it is answered", async () => {
    const { window } = ctx;
    await openAssistant(window);
    await ask(window, "/scenario question");

    const card = window.getByRole("group", { name: "Question" });
    await expect(card).toBeVisible({ timeout: T_MEDIUM });

    // The composer STAYS, and is disabled. The invariant the sheet used to enforce by
    // replacing it — no typing at an engine that cannot read — is enforced by the
    // disabled state instead, and the bottom of the panel no longer moves under the
    // user twice per question. `aria-disabled` is on the bar's own wrapper.
    const bar = composerShell(window);
    await expect(bar).toBeVisible();
    await expect(bar).toHaveAttribute("aria-disabled", "true");
    // And it says WHY, rather than still inviting a question nothing can receive.
    await expect(composer(window).locator(".cm-placeholder")).toHaveText(
      /Answer the question above/
    );

    // Letters come from the ENGINE. A surface that generated its own would disagree
    // with the transcript and the debug log about which option "B" was.
    await expect(card.getByRole("option", { name: /A\s+feature\/db-migrate/ })).toBeVisible();

    // Arrow to the second option and take it with Enter — the keyboard path is the one
    // a picker is judged on, and clicking would never exercise the cursor at all.
    //
    // NOT focused by hand. The sheet takes the keys when it appears, and a test that
    // calls .focus() first proves the handlers work while saying nothing about whether
    // anyone can reach them — which is the half that actually broke (a click on the
    // question text pushed focus into the disabled composer).
    await expect(card.getByRole("listbox")).toBeFocused();
    await window.keyboard.press("ArrowDown");
    await expect(card.getByRole("option", { name: /B\s+main/ })).toHaveAttribute(
      "aria-selected",
      "true"
    );
    await window.keyboard.press("Enter");

    await expect(window.getByText(/Running the migration in main/)).toBeVisible({
      timeout: T_MEDIUM,
    });
    // The composer is live again once the turn is no longer blocked on the user.
    await expect(bar).toHaveAttribute("aria-disabled", "false");
  });

  test("a number key answers a short question outright", async () => {
    const { window } = ctx;
    await openAssistant(window);
    await ask(window, "/scenario question");

    const card = window.getByRole("group", { name: "Question" });
    await expect(card).toBeVisible({ timeout: T_MEDIUM });

    // Clicking the QUESTION TEXT must not cost the sheet its keyboard. The panel focuses
    // its composer on any click that is not a control, and while a question is pending
    // that composer is disabled — so this used to drop the keys into an editor that
    // takes no input, leaving the arrows, the digits and Escape all dead.
    await card.getByText("Which worktree should the migration run in?").click();
    await expect(card.getByRole("listbox")).toBeFocused();

    // Three options, so no filter box, so plain keys are accelerators. "3" is the third
    // option by position — the engine's own letters answer too, and both are stated in
    // the sheet's footer rather than being folklore.
    await window.keyboard.press("3");

    await expect(window.getByText(/Running the migration in Create a new worktree/)).toBeVisible({
      timeout: T_MEDIUM,
    });
  });

  test("/backend asks a real question instead of printing a terminal menu", async () => {
    // The complaint this whole surface exists to answer: `/backend` used to reply with a
    // hard-wrapped numbered menu drawn for an 80-column terminal, re-wrapped again by a
    // 400px rail. It is a picker, and the engine has had a picker channel all along.
    //
    // Driven through the COMMAND path, not `/scenario question`, because that is the
    // half nothing else covers: a question with no turn behind it, a command parked on
    // the answer while the loop stays live enough to deliver it, and a result that
    // reflects what was chosen.
    const { window } = ctx;
    await openAssistant(window);
    await ask(window, "/backend");

    const card = window.getByRole("group", { name: "Question" });
    await expect(card).toBeVisible({ timeout: T_MEDIUM });
    // The whole point: options as rows, not as text.
    await expect(card.getByRole("option")).toHaveCount(2);
    // The highlight starts on the endpoint that is actually answering, so Enter — the
    // fastest key here — never switches away from it by default.
    await expect(card.getByRole("option", { name: /B\s+local/ })).toHaveAttribute(
      "aria-selected",
      "true"
    );
    // And the question discloses that answering it writes something down.
    await expect(card.getByText(/remembered for future sessions/)).toBeVisible();

    await card.getByRole("option", { name: /A\s+official/ }).click();

    // The sheet goes as soon as the ENGINE confirms the answer — a beat before the
    // command that asked has finished applying it. The composer stays leased across
    // that beat and says why, because a prompt sent in it is refused by the engine's
    // own endpoint reservation, which would make a liar of a question that promised the
    // choice applies from the next message.
    await expect(card).toHaveCount(0, { timeout: T_MEDIUM });
    await expect(composerShell(window)).toHaveAttribute("aria-disabled", "true");
    await expect(composer(window).locator(".cm-placeholder")).toHaveText(/Applying your answer/);

    // The ENDPOINT that was chosen, in the result — the row read "official", so that is
    // where the session must now be. The surrounding sentence is microcopy.
    await expect(window.getByText(/https:\/\/assistant\.daintree\.org/).last()).toBeVisible({
      timeout: T_MEDIUM,
    });
    // The composer comes back live, and takes the keyboard with it — the sheet held it
    // and unmounts, so without a hand-off focus falls to <body> and the next keystroke
    // goes nowhere.
    await expect(composerShell(window)).toHaveAttribute("aria-disabled", "false");
    await expect(composer(window)).toBeFocused({ timeout: T_MEDIUM });
  });

  test("paragraphs are separated, and the separation is visible", async () => {
    const { window } = ctx;
    const panel = await openAssistant(window);
    await ask(window, "/scenario paragraphs");

    const prose = panel.locator(".assistant-prose").last();
    await expect(prose.getByText(/Third paragraph after the list/)).toBeVisible({
      timeout: T_MEDIUM,
    });

    // Measured, not eyeballed. The failure this exists for produced a perfectly
    // correct DOM — the right number of <p> elements in the right order — that
    // rendered as one unbroken slab because a per-element `margin: 0` out-specified
    // the sibling rule meant to separate them. Nothing about the markup was wrong, so
    // only geometry can catch it.
    const gaps = await prose.evaluate((root) => {
      const blocks = [...root.children] as HTMLElement[];
      const out: { tag: string; gap: number }[] = [];
      for (let i = 1; i < blocks.length; i++) {
        const prev = blocks[i - 1]!.getBoundingClientRect();
        const here = blocks[i]!.getBoundingClientRect();
        out.push({ tag: blocks[i]!.tagName, gap: Math.round(here.top - prev.bottom) });
      }
      return out;
    });
    console.log("block gaps:", JSON.stringify(gaps));

    expect(gaps.length, "the answer did not render as separate blocks").toBeGreaterThan(3);
    // The fenced block is its own scroll container, which is what keeps a long command
    // from forcing the whole rail sideways.
    const pre = prose.locator("pre");
    await expect(pre).toBeVisible();
    expect(await pre.evaluate((el) => getComputedStyle(el).overflowX)).toBe("auto");
    // A real gap, not a hairline. At the terminal's 12px this is ~10px, and the check
    // is deliberately loose: it asserts the blocks are SEPARATED, not by how much.
    for (const { tag, gap } of gaps) {
      expect(gap, `${tag} sits flush against the block above it`).toBeGreaterThanOrEqual(4);
    }
    // And a heading takes more air than a paragraph does — the hierarchy has to be
    // legible, not merely present.
    const heading = gaps.find((g) => g.tag === "H2");
    const paragraph = gaps.find((g) => g.tag === "P");
    // Asserted PRESENT, not skipped when missing. `if (heading && paragraph)` passed
    // happily when the heading rendered as a DIV or vanished entirely — which is the
    // regression, not the exemption.
    expect(heading, "the markdown heading did not render as an H2").toBeDefined();
    expect(paragraph, "no paragraph rendered").toBeDefined();
    expect(heading!.gap).toBeGreaterThan(paragraph!.gap);
  });

  test("a standing grant answers the NEXT call without a card", async () => {
    const { window } = ctx;
    await openAssistant(window);
    await ask(window, "/scenario approvalSimple");

    const card = window.getByRole("group", { name: /Approval/ });
    await expect(card).toBeVisible({ timeout: T_MEDIUM });

    // "Allow 5×" widens authority beyond this one call. Until now nothing clicked it:
    // the fake's approval omitted `rememberable`, so the two grant buttons the cockpit
    // drew were not even rendered in any test, let alone exercised.
    const bounded = card.getByRole("button", { name: /Allow 5/ });
    await expect(bounded).toBeVisible();
    await bounded.click();
    await expect(card).toHaveCount(0, { timeout: T_MEDIUM });
    // A grant is an APPROVAL of the call in front of you, not merely a promise about
    // later ones.
    await expect(window.getByText(/Tests are running/)).toBeVisible({ timeout: T_MEDIUM });

    // The next identical call is answered from the grant, with no card at all. This is
    // the whole point of the button, and the half most likely to be silently missing:
    // a grant that only approved once would pass every assertion above.
    await ask(window, "/scenario approvalSimple");
    await expect(window.getByText(/Tests are running/).first()).toBeVisible({
      timeout: T_MEDIUM,
    });
    await expect(card, "the grant did not cover the next call").toHaveCount(0);
  });

  test("a grant is bounded — it does not become permanent", async () => {
    const { window } = ctx;
    await openAssistant(window);
    await ask(window, "/scenario approvalSimple");

    const card = window.getByRole("group", { name: /Approval/ });
    await expect(card).toBeVisible({ timeout: T_MEDIUM });
    await card.getByRole("button", { name: /Allow 5/ }).click();
    await expect(card).toHaveCount(0, { timeout: T_MEDIUM });

    // Five uses: the granting call itself, then four more. The sixth must ask again.
    // An off-by-one here is invisible in use and is the difference between "allow five
    // times" and "allow forever", on the control that authorises tool calls.
    for (let i = 0; i < 4; i++) {
      await ask(window, "/scenario approvalSimple");
      await expect(card, `card reappeared on covered call ${i + 1}`).toHaveCount(0);
    }
    await ask(window, "/scenario approvalSimple");
    await expect(card, "the bounded grant never ran out").toBeVisible({ timeout: T_MEDIUM });
  });

  test("an empty operations deck omits its sections rather than drawing them hollow", async () => {
    // A second app, told to answer with nothing in any section.
    await closeApp(ctx.app);
    ctx = await launchApp({
      env: {
        DAINTREE_ASSISTANT_BIN: FAKE_ENGINE,
        FAKE_ENGINE_SPEED: "0",
        FAKE_ENGINE_SCENARIO: "streaming",
        FAKE_ENGINE_OPERATIONS: "empty",
      },
    });
    ctx.window = await openAndOnboardProject(
      ctx.app,
      ctx.window,
      fixtureDir,
      "Assistant Native Test"
    );
    const panel = await openAssistant(ctx.window);
    await waitForSession(ctx.window);
    await composer(ctx.window).click();
    await ctx.window.keyboard.press("Control+o");

    await expect(panel.getByRole("button", { name: "Close" })).toBeVisible({
      timeout: T_MEDIUM,
    });
    // NOW always shows — it is the rollup, and "nothing is happening" is an answer.
    await expect(panel.getByText("NOW", { exact: true })).toBeVisible();
    await expect(panel.getByText(/Nothing running, nothing waiting on you/)).toBeVisible();
    // The other six are omitted. Seven "nothing here" headings buries the one section
    // that has something in it, which is why the cockpit dropped them too — and with
    // every section populated in the fake, a deck that drew them hollow passed.
    for (const section of [
      "NEEDS ATTENTION",
      "WORKFLOWS",
      "AGENTS",
      "ASYNC",
      "SCHEDULED",
      "RECENT",
    ]) {
      await expect(
        panel.getByText(section, { exact: true }),
        `${section} was drawn with nothing in it`
      ).toHaveCount(0);
    }
  });

  test("^O opens the operations deck, and closes it again", async () => {
    const { window } = ctx;
    const panel = await openAssistant(window);
    await waitForSession(window);

    // Bound on the PANEL, not the composer, so it works with focus anywhere inside —
    // including inside the editor, which is where focus actually is in practice.
    await composer(window).click();
    await window.keyboard.press("Control+o");

    await expect(panel.getByRole("button", { name: "Close" })).toBeVisible({
      timeout: T_MEDIUM,
    });
    // The cockpit's seven sections, in its order — what is wrong, then what is
    // planned, then what is running, then what already happened.
    for (const section of [
      "NOW",
      "NEEDS ATTENTION",
      "WORKFLOWS",
      "AGENTS",
      "ASYNC",
      "SCHEDULED",
      "RECENT",
    ]) {
      await expect(panel.getByText(section, { exact: true })).toBeVisible({
        timeout: T_MEDIUM,
      });
    }
    // Rows, not just headings: a deck of seven empty headings would satisfy the
    // check above while showing the user nothing.
    await expect(panel.getByText(/wt_forge is waiting/)).toBeVisible();
    await expect(panel.getByText(/Ship the migration/)).toBeVisible();

    // The deck replaces the TRANSCRIPT — two scrolling regions in a sidebar's width
    // makes both unreadable — but NOT the composer. The cockpit's stayed live under
    // its deck for the same reason: reading what is running is exactly when you think
    // of the next thing to say, and a deck you have to close to type is a deck you
    // close before you have finished reading it.
    await expect(panel.getByText("Put agents to work")).toHaveCount(0);
    await expect(composer(window)).toBeVisible();

    await window.keyboard.press("Control+o");
    await expect(panel.getByText("Put agents to work")).toBeVisible({ timeout: T_MEDIUM });
  });

  test("the panel header's menu opens the operations deck", async () => {
    const { window } = ctx;
    const panel = await openAssistant(window);
    await waitForSession(window);

    // The deck's only pointer-driven way in. It used to be an overflow button sitting
    // in the composer's status row — the narrowest strip in the app, and otherwise
    // nothing but readings — so a mouse user reaching for "what is running" was
    // reaching into a row of numbers. ^O covers the keyboard, and covered it before
    // this moved, so a suite that only tested the chord would not have noticed the
    // click target disappear.
    await panel.getByTestId("assistant-header-more").click();
    await window.getByRole("menuitem", { name: "View operations" }).click();

    await expect(panel.getByRole("button", { name: "Close" })).toBeVisible({
      timeout: T_MEDIUM,
    });
    // Answered on REQUEST: opening has to ask the engine for a fresh reading, or the
    // deck draws whatever was last cached — which for a first open is nothing at all.
    // Rows rather than headings, for the same reason as above.
    await expect(panel.getByText(/wt_forge is waiting/)).toBeVisible({ timeout: T_MEDIUM });

    // And the status row it left is now free of controls entirely.
    await expect(
      panel.getByTestId("assistant-status-row").getByRole("button", { name: "Operations" })
    ).toHaveCount(0);
  });

  test("the status row stays on one line at the panel's narrowest, mid-tool", async () => {
    const { window } = ctx;
    const panel = await openAssistant(window);

    // Squeezed to the minimum the panel allows, which is where this broke. At a
    // comfortable width the old row fitted and every assertion below would have passed
    // over the bug.
    const handle = window.getByRole("separator", { name: "Resize Daintree Assistant panel" });
    await handle.focus();
    await window.keyboard.press("Home");

    await ask(window, "/scenario proseThenTool");

    const row = panel.getByTestId("assistant-status-row");
    const stop = row.getByRole("button", { name: "Stop", exact: true });
    await expect(stop).toBeVisible({ timeout: T_MEDIUM });

    // Genuinely mid-tool, not just mid-turn: wait for the activity row the scenario's
    // tool call announces. That phase is the worst case for this row — it is the one
    // the inline status line deliberately stays silent for, so the composer row was
    // the only thing saying anything, and "Inspecting project… · still working · 41s"
    // is the longest string the phase vocabulary can produce.
    await expect(panel.getByText(/Listed worktrees/)).toBeVisible({ timeout: T_MEDIUM });

    // The phase is gone from here. It is drawn once, at the tail of the running turn,
    // where the next output will appear — not twice, with the second copy in the one
    // place there is no room for it.
    await expect(panel.getByText(/Inspecting project/)).toHaveCount(0);

    // Nothing in the row wraps. Asked of the TEXT, via the rects the browser actually
    // laid it out into, rather than of the row's pixel height against a constant — a
    // height threshold is a test of the theme's font and density, and would have to be
    // retuned by whoever changes either. A text node that fits on one line has exactly
    // one client rect; one that wrapped has two.
    const wrapped = await row.evaluate((el) => {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      const out: string[] = [];
      let node = walker.nextNode();
      while (node) {
        const text = node.textContent?.trim() ?? "";
        if (text) {
          const range = document.createRange();
          range.selectNodeContents(node);
          if (range.getClientRects().length > 1) out.push(text);
        }
        node = walker.nextNode();
      }
      return out;
    });
    expect(wrapped, `these wrapped onto a second line: ${wrapped.join(" | ")}`).toEqual([]);
  });

  test("Escape stops a running turn", async () => {
    const { window } = ctx;
    await openAssistant(window);
    await ask(window, "/scenario cancellable");

    // Wait until it is genuinely running before interrupting — an Escape sent at an
    // idle panel proves nothing, and would pass whether or not interrupt works.
    const stop = window.getByRole("button", { name: "Stop" });
    await expect(stop).toBeVisible({ timeout: T_MEDIUM });
    await window.keyboard.press("Escape");

    // The turn terminalizes: the Stop affordance goes away because there is no longer
    // anything to stop.
    await expect(stop).toHaveCount(0, { timeout: T_MEDIUM });
  });

  test("/clear leaves a fresh surface, not a notice over old history", async () => {
    const { window } = ctx;
    const panel = await openAssistant(window);
    await ask(window, "/scenario simple");
    await expect(window.getByText(/Three worktrees are ready/)).toBeVisible({
      timeout: T_MEDIUM,
    });

    await ask(window, "/clear");

    // The whole point: the previous conversation is GONE, the way the cockpit's
    // /clear left a fresh screen. A notice printed under the old transcript would
    // still show the answer above it.
    await expect
      .poll(() => panel.locator(".assistant-prose").count(), { timeout: T_MEDIUM })
      .toBe(0);
    await expect(window.getByText(/Three worktrees are ready/)).toHaveCount(0);
  });

  test("/clear takes the live state with it, not just the transcript", async () => {
    const { window } = ctx;
    const panel = await openAssistant(window);
    // A turn with tool rows and a running clock, cleared while it is still settling —
    // which is when a user reaches for /clear, because that is when they can see it has
    // gone wrong.
    await ask(window, "/scenario streaming");
    await expect(window.getByText(/Three worktrees are ready/)).toBeVisible({
      timeout: T_MEDIUM,
    });

    await ask(window, "/clear");
    await expect(panel.getByText(/Conversation cleared/)).toBeVisible({ timeout: T_MEDIUM });

    // The transcript goes, and so does everything that described the turn: the activity
    // rows, and the phase line with its ticking elapsed clock. Leaving those behind left
    // "Integrating results · 13s" counting up under an empty conversation, describing a
    // turn that no longer existed anywhere, with no way to dismiss it short of
    // restarting the session.
    await expect(panel.locator(".assistant-prose")).toHaveCount(0);
    await expect(window.getByText(/Three worktrees are ready/)).toHaveCount(0);
    await expect(panel.getByRole("button", { name: /\d+ actions?|Listed worktrees/ })).toHaveCount(
      0
    );
    await expect(panel.getByText(/Integrating|Analyzing|Writing|Working/)).toHaveCount(0);
    // Back to the resting state: connected, with nothing in flight.
    await expect(panel.getByText("Connected", { exact: true })).toBeVisible();
  });

  test("a REFUSED /clear leaves the conversation exactly where it was", async () => {
    // The engine refuses `/clear` while a turn is in flight, and that refusal arrives
    // as an ordinary command result. The panel used to match on the command TEXT, so it
    // wiped the transcript, the activity rows and every live readout while the engine
    // kept the conversation and carried on working in it — leaving the user talking to
    // a model whose context they could no longer see.
    await closeApp(ctx.app);
    ctx = await launchApp({
      env: {
        DAINTREE_ASSISTANT_BIN: FAKE_ENGINE,
        FAKE_ENGINE_SPEED: "0",
        FAKE_ENGINE_SCENARIO: "streaming",
        FAKE_ENGINE_CLEAR: "refuse",
      },
    });
    ctx.window = await openAndOnboardProject(
      ctx.app,
      ctx.window,
      fixtureDir,
      "Assistant Native Test"
    );
    const panel = await openAssistant(ctx.window);

    await ask(ctx.window, "/scenario streaming");
    await expect(ctx.window.getByText(/Three worktrees are ready/)).toBeVisible({
      timeout: T_MEDIUM,
    });
    const proseBefore = await panel.locator(".assistant-prose").count();
    expect(proseBefore).toBeGreaterThan(0);

    await ask(ctx.window, "/clear");
    await expect(panel.getByText(/Can't clear while a turn is in progress/)).toBeVisible({
      timeout: T_MEDIUM,
    });

    // The refusal is REPORTED and nothing is destroyed.
    await expect(ctx.window.getByText(/Three worktrees are ready/)).toBeVisible();
    expect(await panel.locator(".assistant-prose").count()).toBe(proseBefore);
  });

  test("declining is the weighted default on an approval", async () => {
    const { window } = ctx;
    await openAssistant(window);
    await ask(window, "/scenario approvalSimple");

    const decline = window.getByRole("button", { name: "Decline", exact: true });
    await expect(decline).toBeVisible({ timeout: T_MEDIUM });

    // The cockpit drew DECLINE in inverse video (render_approval.go) — fail-closed by
    // default. Asserted as a RELATIONSHIP rather than a class name: whatever the
    // theme, the button that authorises the action must not be the one that looks
    // like the one you are meant to press.
    const weight = (name: string) =>
      window
        .getByRole("button", { name, exact: true })
        .evaluate((el) => getComputedStyle(el).backgroundColor);
    const declineBg = await weight("Decline");
    const approveBg = await window
      .getByRole("button", { name: "Run command", exact: true })
      .first()
      .evaluate((el) => getComputedStyle(el).backgroundColor);
    const alpha = (c: string) => {
      const m = /rgba?\(([^)]+)\)/.exec(c);
      if (!m) return 0;
      const parts = m[1]!.split(",").map((n) => Number(n.trim()));
      return parts.length === 4 ? parts[3]! : 1;
    };
    expect(alpha(declineBg), "Decline is not the filled button").toBeGreaterThan(alpha(approveBg));
  });

  test("N declines from the keyboard without touching the mouse", async () => {
    const { window } = ctx;
    await openAssistant(window);
    await ask(window, "/scenario approvalSimple");

    const card = window.getByRole("group", { name: /Approval/ });
    await expect(card).toBeVisible({ timeout: T_MEDIUM });
    await card.press("n");

    await expect(card).toHaveCount(0, { timeout: T_MEDIUM });
  });

  test("the whole panel scales with the terminal font size", async () => {
    const { window } = ctx;
    const panel = await openAssistant(window);
    await waitForSession(window);

    // `.assistant-panel` is the SURFACE, inside the region that carries the id. The
    // region is app chrome and inherits the app's own 16px, so measuring it would read
    // 16 whatever the terminal is set to — passing before this feature existed and
    // failing after it worked.
    const surface = panel.locator(".assistant-panel");
    const rootSize = () =>
      surface.evaluate((el) => Number.parseFloat(getComputedStyle(el).fontSize));
    const before = await rootSize();

    // The user's own setting, changed the way a user changes it. This is the failure
    // the panel shipped with: it painted at a hardcoded 12px while xterm hydrated the
    // configured size, so anyone who had ever touched this setting saw two panes in
    // two different sizes with no way to reconcile them.
    await openSettings(window);
    await window.locator(`${SEL.settings.navSidebar} button`, { hasText: "Appearance" }).click();
    await window
      .locator(`${SEL.settings.subtabNav} button[role="tab"]`, { hasText: "Terminal" })
      .click();
    const fontSizeInput = window.locator(SEL.settings.fontSizeInput);
    await expect(fontSizeInput).toBeVisible({ timeout: T_MEDIUM });
    const target = (await fontSizeInput.inputValue()) === "18" ? "13" : "18";
    await fontSizeInput.fill(target);
    await fontSizeInput.blur();
    await expect(window.locator(`text=Current: ${target}px`)).toBeVisible({
      timeout: T_MEDIUM,
    });
    await window.keyboard.press("Escape");

    await expect.poll(rootSize, { timeout: T_MEDIUM }).toBe(Number(target));
    expect(await rootSize()).not.toBe(before);

    // And it moves the whole surface, not only the elements that named a size. The
    // status line is chrome, sized in `em` off the root, so it has to follow.
    const statusSize = await surface
      .getByText("Connected", { exact: true })
      .evaluate((el) => Number.parseFloat(getComputedStyle(el).fontSize));
    expect(statusSize).toBeGreaterThan(0);
    expect(statusSize).toBeLessThanOrEqual(Number(target));
    expect(statusSize).toBeGreaterThan(Number(target) * 0.8);
  });

  test("nothing forces the panel to scroll sideways at a narrow width", async () => {
    const { window } = ctx;
    const panel = await openAssistant(window);
    await ask(window, "/scenario degraded");
    // Anchored on the failure PROSE rather than a tool id: ids are rendered through the
    // engine's human-verb table now, so `git.push` reads as "Push" whenever the table
    // knows it — which is exactly the improvement, and exactly what a locator written
    // against the raw id would keep failing on.
    await expect(window.getByText(/orchestration tools are offline/i).first()).toBeVisible({
      timeout: T_MEDIUM,
    });

    // Long tool ids, paths and URLs are the norm on this surface, and the panel is a
    // sidebar. A body that scrolls horizontally hides content behind a gesture nobody
    // makes in a rail.
    const overflow = await panel.evaluate((el) => {
      const rows = el.querySelectorAll<HTMLElement>("*");
      let worst = 0;
      for (const row of rows) {
        if (row.scrollWidth > row.clientWidth + 1 && getComputedStyle(row).overflowX !== "auto") {
          worst = Math.max(worst, row.scrollWidth - row.clientWidth);
        }
      }
      return worst;
    });
    expect(overflow, "something in the panel overflows its width").toBeLessThanOrEqual(1);
  });

  test("an engine crash settles the turn instead of leaving it running forever", async () => {
    const { window } = ctx;
    const panel = await openAssistant(window);
    await ask(window, "/scenario crash");

    // The engine dies mid-turn with a live tool call and no terminal frames. Everything
    // it left in flight has to be settled by the PANEL, because nothing is left to
    // settle it: a phase line reading "Working" over a dead process, and a call stuck
    // on Running, describe work that is not happening and never will.
    await expect(panel.getByText(/stopped unexpectedly/)).toBeVisible({ timeout: T_LONG });
    await expect(panel.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
    await expect(window.getByText("Running", { exact: true })).toHaveCount(0);

    // And the prose that DID arrive is kept. Losing it would be the wrong repair — the
    // engine crashed, the conversation did not.
    await expect(panel.getByText(/Starting the migration/)).toBeVisible();
  });

  test("a session can be restarted after a crash", async () => {
    const { window } = ctx;
    const panel = await openAssistant(window);
    await ask(window, "/scenario crash");
    await expect(panel.getByText(/stopped unexpectedly/)).toBeVisible({ timeout: T_LONG });

    // "+ New session" is the way back. A panel that reports a crash and cannot restart
    // is a dead pane with an explanation in it.
    await panel.getByRole("button", { name: "Start new session" }).click();
    await waitForSession(window);
    await ask(window, "which worktrees are ready?");
    await expect(window.getByText(/Three worktrees are ready/)).toBeVisible({
      timeout: T_MEDIUM,
    });
  });

  test("an autonomous wake turn offers no Stop", async () => {
    const { window } = ctx;
    const panel = await openAssistant(window);
    await ask(window, "/scenario wake");

    await expect(panel.getByText(/CI went red on wt_forge/)).toBeVisible({ timeout: T_MEDIUM });
    // A wake turn is work the ASSISTANT started. There is nothing of the user's to
    // cancel, and a Stop that cannot stop anything is a button that lies.
    const stop = panel.getByRole("button", { name: "Stop", exact: true });
    if ((await stop.count()) > 0) await expect(stop).toBeDisabled();
  });

  test("Refresh re-reads the operations deck instead of showing the first answer", async () => {
    const { window } = ctx;
    const panel = await openAssistant(window);
    await waitForSession(window);
    await composer(window).click();
    await window.keyboard.press("Control+o");

    const row = panel.getByText(/wt_forge is waiting on a confirmation/);
    await expect(row).toBeVisible({ timeout: T_MEDIUM });
    const first = await row.innerText();

    // The fake numbers each reading, so a Refresh that re-requested and a Refresh that
    // did nothing are distinguishable. With a fixed snapshot they were not, and the
    // button could have been wired to nothing.
    await panel.getByRole("button", { name: "Refresh" }).click();
    await expect.poll(() => row.innerText(), { timeout: T_MEDIUM }).not.toBe(first);
  });

  test("a question can be dismissed as well as answered", async () => {
    const { window } = ctx;
    await openAssistant(window);
    await ask(window, "/scenario question");

    const card = window.getByRole("group", { name: "Question" });
    await expect(card).toBeVisible({ timeout: T_MEDIUM });
    // Escape dismisses — the turn continues without a choice, which is a different
    // answer from picking an option and the only one that was never exercised.
    await window.keyboard.press("Escape");

    await expect(card).toHaveCount(0, { timeout: T_MEDIUM });
    // The composer is live again either way: the turn is no longer blocked on the user.
    await expect(composerShell(window)).toHaveAttribute("aria-disabled", "false", {
      timeout: T_MEDIUM,
    });
    // And the PANEL is still open. Escape used to be swallowed in the capture phase by
    // the global keybinding handler, which closed the whole assistant instead — hiding
    // the panel while the engine stayed parked on a question nobody could now answer.
    await expect(
      window
        .getByRole("toolbar", { name: "Main toolbar" })
        .getByRole("button", { name: "Daintree Assistant", exact: true })
    ).toHaveAttribute("aria-pressed", "true");
  });

  test("Escape DECLINES an approval, and leaves the panel open", async () => {
    const { window } = ctx;
    await openAssistant(window);
    await ask(window, "/scenario approvalSimple");

    const card = window.getByRole("group", { name: /Approval/ });
    await expect(card).toBeVisible({ timeout: T_MEDIUM });
    await card.focus();
    await window.keyboard.press("Escape");

    // Fail-CLOSED, as render_approval.go bound it: there is nothing to dismiss — the
    // engine has parked a dispatch and is waiting — so the only honest reading of "get
    // this off my screen" is the one that refuses the tool.
    await expect(card).toHaveCount(0, { timeout: T_MEDIUM });
    await expect(window.getByText(/Skipped/)).toBeVisible({ timeout: T_MEDIUM });
    await expect(window.getByText(/Tests are running/)).toHaveCount(0);
    // The panel stays. Escape declining the tool AND hiding the panel in one keystroke
    // is what this used to do.
    await expect(
      window
        .getByRole("toolbar", { name: "Main toolbar" })
        .getByRole("button", { name: "Daintree Assistant", exact: true })
    ).toHaveAttribute("aria-pressed", "true");
  });

  test("shows no spend figure — the assistant is not billed by usage", async () => {
    const { window } = ctx;
    const panel = await openAssistant(window);
    await ask(window, "/scenario streaming");
    // Wait for a turn to actually settle, so this is a statement about a session that
    // HAS cost figures on the wire rather than one that never got any.
    await expect(panel.getByText("Connected", { exact: true })).toBeVisible({
      timeout: T_MEDIUM,
    });

    // The engine still reports `cost` and the store still holds it; what changed is
    // that the panel does not draw it. Per-turn spend was a readout from when the
    // assistant billed by usage — it bills by subscription now, so a figure here
    // answers a question nobody is being asked and implies a meter that is not running.
    await expect(panel.getByText(/\$\d/)).toHaveCount(0);
  });

  /**
   * Screenshots of the REAL app, in both default themes, for design review.
   *
   * Taken from the live panel rather than a fixture harness: a fixture is a belief
   * about what the panel receives, and reviewing one reviews the belief.
   */
  for (const theme of ["daintree", "bondi"] as const) {
    test(`looks right in the ${theme} theme`, async () => {
      const { window } = ctx;
      await window.evaluate((id) => {
        window.localStorage.setItem("daintree-theme", JSON.stringify({ state: { themeId: id } }));
      }, theme);

      await openAssistant(window);
      await ask(window, "/scenario approval");
      await expect(window.getByRole("group", { name: "Approval required" })).toBeVisible({
        timeout: T_MEDIUM,
      });

      await window
        .locator("#daintree-assistant-panel")
        .screenshot({ path: `e2e/screenshots/assistant-${theme}.png` });
    });
  }
});

/**
 * The account journey, driven through the host.
 *
 * Daintree implements NONE of this. It removed its own assistant account settings, IPC
 * and service when sign-in moved into the session, and what is left is a transport: the
 * panel sends `/login` down the command path and renders the text that comes back. So
 * every assertion here is about transport and rendering — that the engine's commands
 * reach it, that its answers are shown as it wrote them, and that Daintree never
 * arrives at "signed in", "subscribed" or "not subscribed" on its own.
 *
 * That last one is the point of the suite rather than a nicety. A host that cached a
 * plan, or inferred one from prose, would be a second authority on billing that the
 * backend never agreed to — and the first thing it would get wrong is telling a paying
 * customer they have not paid.
 */
test.describe.serial("Assistant: the account journey", () => {
  let accountCtx: AppContext;
  let accountFixture: string;
  let accountCleanup: (() => void) | undefined;

  /** Launches the app with the fake engine in a given account state. */
  async function launchWithAccount(env: Record<string, string>) {
    if (accountCtx?.app) await closeApp(accountCtx.app);
    accountCtx = await launchApp({
      env: { DAINTREE_ASSISTANT_BIN: FAKE_ENGINE, FAKE_ENGINE_SPEED: "0", ...env },
    });
    accountCtx.window = await openAndOnboardProject(
      accountCtx.app,
      accountCtx.window,
      accountFixture,
      "Assistant Account Test"
    );
    return accountCtx.window;
  }

  test.beforeEach(() => {
    const { dir, cleanup } = createFixtureRepo({ name: "assistant-account" });
    accountFixture = dir;
    accountCleanup = cleanup;
  });

  test.afterEach(async () => {
    if (accountCtx?.app) await closeApp(accountCtx.app);
    accountCleanup?.();
  });

  test("the palette offers the engine's account commands", async () => {
    // The panel keeps no command list of its own — the palette is built from the
    // catalog in `host:ready` and nothing else. So this is the check that the account
    // surface is REACHABLE: with the commands removed from Settings, a `/login` the
    // palette does not offer is an install with no way to sign in at all, which is
    // exactly the state this branch was in before the engine gained them.
    const window = await launchWithAccount({});
    await openAssistant(window);
    await type(window, "/");

    const palette = window.getByRole("listbox", { name: "Command autocomplete" });
    await expect(palette).toBeVisible({ timeout: T_MEDIUM });
    for (const gloss of [
      "sign in to your account",
      "sign out on this machine",
      "who you are signed in as",
      "which backend answers",
    ]) {
      await expect(palette.getByText(gloss)).toBeVisible();
    }
  });

  test("signing in renders the plan the engine reports", async () => {
    const window = await launchWithAccount({ FAKE_ENGINE_PLAN: "standard" });
    await openAssistant(window);
    const panel = window.locator("#daintree-assistant-panel");

    await ask(window, "/login");

    // The engine's own words and its own layout. `innerText` rather than
    // `textContent`, because the padded label column only survives if the panel is
    // actually honouring the whitespace rather than reflowing the answer into prose.
    const rendered = await panel
      .getByTestId("assistant-notice")
      .filter({ hasText: /plan/ })
      .last()
      .evaluate((el: HTMLElement) => el.innerText);
    expect(rendered).toMatch(/plan {2,}standard/);
    expect(rendered).toMatch(/access {2,}active/);
  });

  test("a checkout reaches a running session without a restart or a second sign-in", async () => {
    // The property a subscription flow lives or dies on: someone buys a plan in a
    // browser, comes back to the window they left open, and the app knows. A host that
    // cached the plan at boot would need a restart, and would be wrong in the meantime.
    const window = await launchWithAccount({
      FAKE_ENGINE_PLAN: "standard",
      FAKE_ENGINE_CHECKOUT_PLAN: "pro",
    });
    await openAssistant(window);
    const panel = window.locator("#daintree-assistant-panel");

    await ask(window, "/login");
    await expect(panel.getByText(/plan\s+standard/).last()).toBeVisible({ timeout: T_MEDIUM });

    // The purchase lands between the two reads. Same window, same session, same engine.
    await ask(window, "/account");
    await expect(panel.getByText(/plan\s+pro/).last()).toBeVisible({ timeout: T_MEDIUM });
  });

  test("a plan that cannot be checked reads as unverified, never as unsubscribed", async () => {
    // The dependency case, and the one wrong answer that costs money: the credential is
    // good and the billing authority simply did not answer. Rendering that as "not
    // subscribed" tells a paying customer they have not paid. The engine words it as
    // retryable; the host's job is to not turn that into a verdict of its own.
    const window = await launchWithAccount({
      FAKE_ENGINE_SIGNED_IN: "1",
      FAKE_ENGINE_ACCOUNT: "unavailable",
    });
    await openAssistant(window);
    const panel = window.locator("#daintree-assistant-panel");

    await ask(window, "/account");

    await expect(panel.getByText(/access\s+unverified/).last()).toBeVisible({ timeout: T_MEDIUM });
    await expect(panel.getByText(/try again shortly/i)).toBeVisible();
    // Nothing anywhere says the account has no plan. The words are the product here.
    await expect(panel.getByText(/not signed in|no plan|not subscribed/i)).toHaveCount(0);
  });

  test("signing out ends the session, and the next turn is refused by the engine", async () => {
    const window = await launchWithAccount({
      FAKE_ENGINE_SIGNED_IN: "1",
      FAKE_ENGINE_REQUIRE_ACCOUNT: "1",
    });
    await openAssistant(window);
    const panel = window.locator("#daintree-assistant-panel");

    // Signed in, a turn runs.
    await ask(window, "/scenario simple");
    await expect(panel.locator(".assistant-prose").first()).toBeVisible({ timeout: T_MEDIUM });

    await ask(window, "/logout");
    await expect(panel.getByText(/Signed out/).last()).toBeVisible({ timeout: T_MEDIUM });

    // The refusal comes from the ENGINE, as a typed error with its registered prefix —
    // not from Daintree noticing it had just seen a `/logout` go past. The distinction
    // is the whole ownership boundary: a host that pre-empted here would be refusing
    // turns on its own reading of an account it does not own.
    await ask(window, "/scenario simple");
    await expect(panel.getByText(/Account problem:/)).toBeVisible({ timeout: T_MEDIUM });
    await expect(panel.getByText(/\/login/)).toBeVisible();
  });

  test("no account or backend controls exist in Settings", async () => {
    // The architecture, asserted where it would regress: someone adds a "Sign in"
    // button to the assistant's settings tab because it seems more discoverable there.
    // It would be a second credential surface, a second endpoint choice, and a second
    // opinion about the plan — all of which this branch deleted on purpose.
    const window = await launchWithAccount({});
    await openSettings(window);
    const dialog = window.getByRole("dialog");
    await dialog.getByRole("tab", { name: /Assistant/ }).click();

    for (const control of [/sign in/i, /log in/i, /account/i, /backend url/i, /api key/i]) {
      await expect(dialog.getByRole("button", { name: control })).toHaveCount(0);
      await expect(dialog.getByRole("textbox", { name: control })).toHaveCount(0);
    }
  });

  /**
   * Replaces `shell.openExternal` in the MAIN process with a recorder.
   *
   * Works because `electron/utils/openExternal.ts` reads `shell.openExternal` at CALL
   * time rather than capturing it at import, so a replacement installed after boot is
   * still the one a click reaches. Same technique as the loopback OAuth spec.
   *
   * Recording rather than asserting inside the page is the point: a unit test can prove
   * an `<a href>` was rendered, and nothing short of the real main process can prove
   * that clicking it is routed out to the system browser instead of navigating the app.
   */
  async function recordExternalOpens(app: AppContext["app"]) {
    await app.evaluate(({ shell, app: electronApp }) => {
      const g = globalThis as unknown as { __opened: string[]; __spawned: string[] };
      g.__opened = [];
      g.__spawned = [];
      shell.openExternal = async (url: string): Promise<void> => {
        g.__opened.push(url);
      };
      // Handing the URL to the browser is only half of what must happen — the in-app
      // popup has to be DENIED. A handler that opened externally AND allowed the window
      // would satisfy every assertion about the recorder while a stray Electron window
      // appeared over the panel, so the windows are watched too. Event-based rather
      // than a count afterwards, because a popup that opens and closes again inside the
      // click would leave no trace in a count.
      electronApp.on("web-contents-created", (_e, contents) => {
        g.__spawned.push(contents.getType());
      });
    });
    return {
      /** Clears both records. Call immediately before the activation under test. */
      reset: () =>
        app.evaluate(() => {
          const g = globalThis as unknown as { __opened: string[]; __spawned: string[] };
          g.__opened.length = 0;
          g.__spawned.length = 0;
        }),
      opened: () =>
        app.evaluate(() => (globalThis as unknown as { __opened: string[] }).__opened ?? []),
      spawned: () =>
        app.evaluate(() => (globalThis as unknown as { __spawned: string[] }).__spawned ?? []),
    };
  }

  /**
   * Where each line's value column starts, for the lines that have one.
   *
   * The engine pads a label column so values line up, and the panel preserves that
   * whitespace rather than reflowing it. Asserting the ALIGNMENT rather than a literal
   * run of spaces is what makes this independent of the fake's exact padding — a check
   * for `/plan {2,}/` passes just as happily when every column has collapsed to two
   * spaces and nothing lines up any more.
   */
  function valueColumns(rendered: string): number[] {
    return rendered
      .split("\n")
      .map((line) => /^\S+ {2,}\S/.exec(line)?.[0].lastIndexOf(" "))
      .filter((i): i is number => i !== undefined && i >= 0);
  }

  /** The one link inside the last notice that has one. */
  function noticeLink(window: AppContext["window"]) {
    return window
      .locator("#daintree-assistant-panel")
      .getByTestId("assistant-notice")
      .filter({ has: window.locator("a[href]") })
      .last()
      .locator("a[href]");
  }

  test("an address the engine printed is a link, and clicking it leaves the app", async () => {
    // The whole point of the linkifier, end to end. Everything below the render — that
    // `target="_blank"` is denied in-app and handed to `openExternalUrl` instead — lives
    // in the main process, so this is the only tier that can see it happen.
    const PLAN_URL = "https://staging.daintree.test/subscribe";
    const window = await launchWithAccount({
      FAKE_ENGINE_SIGNED_IN: "1",
      FAKE_ENGINE_PLAN: "standard",
      FAKE_ENGINE_ACCOUNT_URL: PLAN_URL,
    });
    const external = await recordExternalOpens(accountCtx.app);
    await openAssistant(window);
    const panel = window.locator("#daintree-assistant-panel");

    await ask(window, "/account");
    const link = noticeLink(window);
    await expect(link).toBeVisible({ timeout: T_MEDIUM });

    // The href is the engine's string, not a normalised reconstruction of it.
    await expect(link).toHaveAttribute("href", PLAN_URL);
    await expect(link).toHaveText(PLAN_URL);

    // Inserting an element into the text is exactly the change that would collapse the
    // engine's padding, so the columns are checked WITH the link present. `innerText`
    // rather than `textContent`, for the reason the command-output test above gives:
    // only the rendered form can show that whitespace actually survived.
    const rendered = await panel
      .getByTestId("assistant-notice")
      .filter({ hasText: /plan/ })
      .last()
      .evaluate((el: HTMLElement) => el.innerText);
    const columns = valueColumns(rendered);
    expect(columns.length).toBeGreaterThan(1);
    expect(new Set(columns).size).toBe(1);

    // Nothing has opened yet, so a link that navigated on render rather than on click
    // cannot masquerade as a working one.
    await external.reset();
    await link.click();

    // Routed OUT, and NOT opened in the app: the handler must deny the window as well
    // as hand the address over.
    await expect.poll(external.opened, { timeout: T_MEDIUM }).toEqual([PLAN_URL]);
    expect(await external.spawned()).toEqual([]);
    await expect(panel).toBeVisible();
  });

  test("a refused turn's guidance is navigable too, not just a command's answer", async () => {
    // A command result and a refused turn arrive as different events and are stored by
    // different branches of the store. A host that linkified only the command path would
    // pass the test above and still leave every turn-level refusal unrendered.
    //
    // The URL here is SYNTHETIC: at this pin the engine's `accountFailureAdvice` prints
    // no address on the error path (it names `auth status --refresh` instead), so the
    // fake carries a neutral one purely to exercise the shape. The claim being tested is
    // the host's, not the engine's.
    const SUPPORT_URL = "https://staging.daintree.test/status";
    const window = await launchWithAccount({
      FAKE_ENGINE_REQUIRE_ACCOUNT: "1",
      FAKE_ENGINE_ACCOUNT_URL: SUPPORT_URL,
    });
    const external = await recordExternalOpens(accountCtx.app);
    await openAssistant(window);
    const panel = window.locator("#daintree-assistant-panel");

    await ask(window, "/scenario simple");
    await expect(panel.getByText(/Account problem:/)).toBeVisible({ timeout: T_MEDIUM });

    const link = noticeLink(window);
    await expect(link).toHaveAttribute("href", SUPPORT_URL);

    // From the keyboard, because a refusal is exactly the moment someone is being told
    // to go somewhere else, and a mouse must not be the only way to get there.
    await external.reset();
    await link.focus();
    await window.keyboard.press("Enter");
    await expect.poll(external.opened, { timeout: T_MEDIUM }).toEqual([SUPPORT_URL]);
    expect(await external.spawned()).toEqual([]);
  });
});
