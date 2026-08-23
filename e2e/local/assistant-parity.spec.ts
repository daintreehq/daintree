import { test, expect, type Page } from "@playwright/test";
import path from "node:path";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { createFixtureRepo } from "../helpers/fixtures";
import { openAndOnboardProject } from "../helpers/project";
import type { Locator } from "@playwright/test";
import { T_LONG } from "../helpers/timeouts";
import { assertFreshBuild } from "./freshBuild";

/**
 * The assistant against a REAL engine and a REAL backend, with screenshots.
 *
 * Local only, and in no npm script or workflow — see the `local` project in
 * playwright.config.ts. Every run spends model calls and needs the backend on
 * 127.0.0.1:8473, which is exactly why it must never gate anything, and exactly why it
 * is the only place the panel is checked as a user actually meets it.
 *
 * The fake-engine suite (e2e/full/panels/assistant-native-panel.spec.ts) proves the
 * panel handles a byte-exact event stream correctly. It cannot prove the panel LOOKS
 * like the terminal beside it, or that a real model turn survives the round trip.
 * That is what this is for.
 *
 * Run:
 *   npm run build && npx playwright test --project=local
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.resolve(HERE, "../screenshots/local");
const BACKEND = process.env.DAINTREE_BACKEND_URL ?? "http://127.0.0.1:8473";

/** The exact job that exposed the repeated-preamble failure. Kept verbatim. */
const HEAVY_PROMPT = `If you check across all our performance benchmarks, you can see a lot of general benchmarks we have.
What I want you to do is a huge huge run of performance improvements to daintree. Do that by:
- Running the performance benchmarks
- Figuring out how you can fix anything underlying
- Figuring out what is right for optimisation
- Figuring out what you can change and what you can improve while still having the entire system work
The final conclusion is that you must actually get all the end-to-end tests and all unit tests still working and still running. Just go ahead and do a massive round of performance enhancements to daintree.

Again this is a big, large, complex job and you can go ahead and do whatever changes, set up temporary code, all of that that you need. You should conclude by having all end-to-end tests run and pass. Right at the end you'll give a table of all the benchmarks with their before and after values and how much you were able to improve them by.

You want to fix everything:
- startup time
- memory use
- speed of certain actions
- anything else you can think of
Your goal at the end is to have a significantly more performant version of Daintree by making use of all benchmarks that we have available.`;

let ctx: AppContext;
let fixtureDir: string;
let fixtureCleanup: (() => void) | undefined;

test.beforeAll(() => {
  // Before anything else: a stale dist/ makes every result below a statement about the
  // previous build. See freshBuild.ts.
  assertFreshBuild();
  mkdirSync(SHOTS, { recursive: true });
});

test.beforeEach(async () => {
  const { dir, cleanup } = createFixtureRepo({ name: "assistant-parity" });
  fixtureDir = dir;
  fixtureCleanup = cleanup;

  ctx = await launchApp({
    env: {
      // No DAINTREE_ASSISTANT_BIN: this runs the REAL bundled engine.
      DAINTREE_BACKEND_URL: BACKEND,
      // Full run permissions, so a turn that wants to spawn an agent can, and the
      // approval sheet is exercised rather than sidestepped.
      DAINTREE_ASSISTANT_TIER: "system",
      DAINTREE_ASSISTANT_DEBUG_LOG: "1",
    },
  });
  ctx.window = await openAndOnboardProject(ctx.app, ctx.window, fixtureDir, "Assistant Parity");
});

test.afterEach(async () => {
  if (ctx?.app) await closeApp(ctx.app);
  fixtureCleanup?.();
});

async function openAssistant(window: Page) {
  const toggle = window
    .getByRole("toolbar", { name: "Main toolbar" })
    .getByRole("button", { name: "Daintree Assistant", exact: true });
  await expect(toggle).toBeVisible({ timeout: T_LONG });
  if ((await toggle.getAttribute("aria-pressed")) !== "true") await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true", { timeout: T_LONG });

  const panel = window.locator("#daintree-assistant-panel");
  await expect(panel).toBeVisible({ timeout: T_LONG });
  return panel;
}

/**
 * The computed typography of a node, which is the only form of "same font" that can be
 * asserted. A class name proves nothing: two elements can carry different classes and
 * render identically, or the same class and diverge once a cascade lands on one.
 */
/**
 * Launches a real agent terminal — the surface the panel is supposed to look like.
 *
 * A plain shell is the wrong comparison: it shows a prompt and a cursor, and says
 * nothing about how an AGENT terminal reads. Claude Code fills the pane with the
 * chrome the assistant is being matched against.
 */
async function launchAgentTerminal(page: Page, cwd: string): Promise<Locator> {
  const result = await page.evaluate(
    ([id, actionArgs, dispatchOptions]) => {
      const dispatch = (
        window as unknown as {
          __daintreeDispatchAction?: (
            actionId: string,
            args?: unknown,
            options?: { source?: string }
          ) => Promise<unknown>;
        }
      ).__daintreeDispatchAction;
      if (!dispatch) throw new Error("dispatch bridge missing");
      return dispatch(id, actionArgs, dispatchOptions);
    },
    [
      "agent.launch",
      { agentId: "claude", cwd, location: "grid", force: true },
      { source: "user" },
    ] as const
  );
  const id = (result as { data?: { terminalId?: string } })?.data?.terminalId;
  const panel = id ? page.locator(`[data-panel-id="${id}"]`) : page.locator(".xterm").first();
  await expect(panel.locator(".xterm").or(panel).first()).toBeVisible({ timeout: T_LONG });
  return panel;
}

/**
 * Pastes text into the composer, as a user would.
 *
 * NOT `keyboard.insertText`. That dispatches one `insertText` input event, and
 * Chromium silently drops it into a contenteditable when the data contains a newline —
 * so a multi-line prompt typed that way lands as NOTHING. The test then pressed Enter
 * at an empty composer, waited ninety seconds for a turn nobody asked for, counted zero
 * duplicated answers and passed. A test that cannot tell "no duplicates" from "no
 * conversation" is worse than no test.
 *
 * A `paste` ClipboardEvent is also the honest gesture: nobody hand-types a prompt this
 * size, and pasting is the path with the chip handlers on it (imageChip, fileDropChip),
 * which a text paste has to survive.
 */
async function pasteInto(input: Locator, text: string) {
  await input.click();
  await input.evaluate((el, value) => {
    const data = new DataTransfer();
    data.setData("text/plain", value);
    el.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true })
    );
  }, text);
}

async function typography(page: Page, selector: string) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const cs = getComputedStyle(el);
    return {
      fontFamily: cs.fontFamily,
      fontSize: cs.fontSize,
      letterSpacing: cs.letterSpacing,
    };
  }, selector);
}

test("the panel and a terminal share one typeface", async () => {
  const { window } = ctx;
  await openAssistant(window);
  await launchAgentTerminal(window, fixtureDir);
  await expect(window.locator(".xterm").first()).toBeVisible({ timeout: T_LONG });

  const panelType = await typography(window, ".assistant-panel");
  const termType = await typography(window, ".xterm .xterm-rows");
  console.log("panel   ", JSON.stringify(panelType));
  console.log("terminal", JSON.stringify(termType));

  expect(panelType, "the assistant panel did not render").not.toBeNull();
  expect(termType, "no terminal rendered to compare against").not.toBeNull();

  // Family, not size: the terminal's size is user-configurable and the panel's
  // hierarchy legitimately varies within itself. The typeface is what makes the two
  // read as one surface, and it is the thing a copied component silently loses.
  const family = (v: string) => v.split(",")[0]!.replace(/["']/g, "").trim();
  expect(family(panelType!.fontFamily)).toBe(family(termType!.fontFamily));
});

test("side-by-side screenshots of the panel and a terminal", async () => {
  const { window } = ctx;
  const panel = await openAssistant(window);
  // Two agent panes: narrower columns, and a shot that shows the assistant sitting in
  // a real working layout rather than beside one lonely terminal.
  await launchAgentTerminal(window, fixtureDir);
  await launchAgentTerminal(window, fixtureDir);
  await expect(window.locator(".xterm").first()).toBeVisible({ timeout: T_LONG });
  // Agent chrome takes a moment to paint; a shot taken at first-visible catches a
  // half-drawn pane and makes the comparison worthless.
  await window.waitForTimeout(6000);

  await panel.screenshot({ path: path.join(SHOTS, "assistant-panel.png") });
  await window
    .locator(".xterm")
    .first()
    .screenshot({ path: path.join(SHOTS, "agent-terminal.png") });
  await window.screenshot({ path: path.join(SHOTS, "both-surfaces.png") });
});

test("a real turn answers once, and /clear starts fresh", async () => {
  test.setTimeout(9 * 60 * 1000);
  const { window } = ctx;
  const panel = await openAssistant(window);

  await expect(panel.getByText("Connected", { exact: true })).toBeVisible({ timeout: T_LONG });
  await panel.screenshot({ path: path.join(SHOTS, "01-idle.png") });

  // The composer is the terminal's own input bar now, so it is a CodeMirror surface
  // rather than a textarea.
  const input = panel.locator(".cm-content");
  await expect(input).toBeVisible({ timeout: T_LONG });
  await input.click();
  await pasteInto(input, HEAVY_PROMPT);
  await panel.screenshot({ path: path.join(SHOTS, "02-composed.png") });

  // PROVE the draft landed before sending it. Without this the test happily typed into
  // nothing, pressed Enter at an empty composer, waited 90 seconds for a turn that was
  // never asked for, and passed — "0 prose blocks, 0 duplicated" is true of a panel
  // that did nothing at all.
  const drafted = (await input.innerText()).trim();
  console.log(`composer holds ${drafted.length} chars`);
  expect(drafted.length, "the prompt never reached the composer").toBeGreaterThan(500);

  await window.keyboard.press("Enter");
  // And prove it was ACCEPTED: the draft clears only on acceptance.
  await expect
    .poll(
      async () =>
        (await input.count()) === 0 || (await input.locator(".cm-placeholder").count()) > 0,
      { timeout: T_LONG }
    )
    .toBe(true);

  // Let the turn run. This is a real model doing real work, so it is slow by nature.
  await window.waitForTimeout(90_000);
  await panel.screenshot({ path: path.join(SHOTS, "03-working.png"), scale: "css" });

  // The failure this exists for: one prompt rendering as the same preamble over and
  // over. Counted from the transcript rather than eyeballed from a screenshot.
  const proseTexts = await panel.locator(".assistant-prose").allInnerTexts();
  const heads = proseTexts.map((t) => t.trim().slice(0, 80)).filter(Boolean);
  const duplicated = heads.length - new Set(heads).size;
  console.log(`prose blocks: ${heads.length}, duplicated openings: ${duplicated}`);
  for (const h of new Set(heads)) console.log(`  · ${h}`);

  // A CONVERSATION happened, before any claim about duplicates in it. Zero prose blocks
  // gives zero duplicates, and that is exactly how this test passed for hours while the
  // prompt was never reaching the composer at all.
  expect(heads.length, "the assistant produced no answer at all").toBeGreaterThan(0);
  const answered = proseTexts.join("\n").trim();
  expect(answered.length, "the answer was empty").toBeGreaterThan(80);
  expect(duplicated, "the same answer was rendered more than once").toBe(0);
  // LOOPING, as distinct from restating.
  //
  // The per-block comparison above catches an answer rendered twice. This catches the
  // shape the engine's convergence guard exists for: the same sentence emitted round
  // after round because the model is circling rather than progressing. The original
  // failure produced five near-identical preambles in one turn.
  //
  // Two occurrences is NOT the test. A model that checks something, re-checks it and
  // then restates its finding is behaving reasonably — especially on a task it has
  // decided it cannot do — and failing that would be asserting a writing style rather
  // than a defect. Three or more of the same sentence is not a restatement.
  const counts = new Map<string, number>();
  for (const sentence of answered.split(/(?<=[.!?])\s+/)) {
    const key = sentence.trim();
    if (key.length <= 40) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const looped = [...counts.entries()].filter(([, n]) => n >= 3);
  for (const [text, n] of looped) console.log(`  repeated ${n}×: ${text.slice(0, 90)}`);
  expect(
    looped.map(([t]) => t.slice(0, 60)),
    "the turn looped on the same sentence"
  ).toEqual([]);

  // /clear must leave a fresh surface, not a notice under stale history.
  await pasteInto(input, "/clear");
  await window.keyboard.press("Enter");

  // The known content goes away — checked against what was actually on screen, rather
  // than against a count that was already zero before /clear ran.
  await expect.poll(() => panel.locator(".assistant-prose").count(), { timeout: T_LONG }).toBe(0);
  await panel.screenshot({ path: path.join(SHOTS, "04-after-clear.png") });
  await expect(panel.getByText(heads[0]!.slice(0, 40))).toHaveCount(0);
});

test("the answer paints as it streams, not all at once", async () => {
  test.setTimeout(5 * 60 * 1000);
  const { window } = ctx;
  const panel = await openAssistant(window);
  await expect(panel.getByText("Connected", { exact: true })).toBeVisible({ timeout: T_LONG });

  const input = panel.locator(".cm-content");
  await expect(input).toBeVisible({ timeout: T_LONG });
  await input.click();
  // Prose-only and long enough to stream for several seconds. A tool-using prompt
  // would spend most of its wall clock in tool rows, where there is no prose to grow.
  await window.keyboard.insertText(
    "Explain in four full paragraphs what a git worktree is, how it differs from a branch, " +
      "and why someone running many agents in parallel would want them. Prose only, no tools."
  );
  await window.keyboard.press("Enter");

  // Sample the rendered transcript while the turn runs. Streaming is a claim about the
  // SHAPE of arrival, and the final text is identical either way — the only way to tell
  // "painted as it arrived" from "painted once at the end" is to watch it grow.
  const lengths: number[] = [];
  const deadline = Date.now() + 150_000;
  while (Date.now() < deadline) {
    const len = await panel
      .locator(".assistant-prose")
      .allInnerTexts()
      .then((t) => t.join("").length);
    if (lengths.length === 0 || len !== lengths[lengths.length - 1]) lengths.push(len);
    // Settled: prose exists, and there is nothing left to stop. Watching the spinner
    // instead would stop sampling in the middle of a tool call, where the panel
    // deliberately shows none — so the loop could exit while the turn was still live
    // and the growth assertions below would be measuring an unfinished answer.
    if (len > 0 && lengths.length > 3) {
      const live = await panel.getByRole("button", { name: "Stop", exact: true }).count();
      if (live === 0) break;
    }
    await window.waitForTimeout(120);
  }

  const growth = lengths.filter((n) => n > 0);
  console.log(`distinct transcript lengths while streaming: ${growth.length}`);
  console.log(`  ${growth.slice(0, 12).join(" → ")}${growth.length > 12 ? " → …" : ""}`);

  expect(growth.length, "the turn produced no visible prose at all").toBeGreaterThan(0);
  // A whole answer appearing at once gives exactly ONE distinct non-zero length. Several
  // means the panel painted partial answers, which is what streaming looks like from
  // the outside. Deliberately a low bar: this asserts streaming happens, not its rate.
  expect(
    growth.length,
    "the answer appeared in one piece — nothing streamed into the panel"
  ).toBeGreaterThan(3);
  // And it must GROW, not churn: a shrinking sample would mean the transcript was being
  // rebuilt rather than appended to.
  expect(growth[growth.length - 1]).toBeGreaterThan(growth[0]!);

  await panel.screenshot({ path: path.join(SHOTS, "05-streamed.png") });
});
