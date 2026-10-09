/**
 * Canopy holds still: the real app, real PTYs and Daintree's own agent-state
 * tracking, with screens read by the live Canopy service. Four fake Claude
 * agents draw realistic screens; the inbox is sampled every 100 ms for its row
 * order, the priority each row shows and its words. The user types a reply
 * into one agent's terminal and clears it; another agent stops on an approval.
 * Only the approval may move anything. Moving between agents resizes each to
 * the panel's pane and back, and resizing the window resizes them all: the
 * agents redraw for the new width, and nothing in the inbox may move for it.
 * Nor may any row turn unread without an agent doing something: a row going
 * read is the user reading it, but going unread takes a stop, a start or an ask.
 *
 * Opt-in only, since it reads screens with the live service:
 *
 *   DAINTREE_E2E_CANOPY_LIVE=1 npx playwright test --project=full-panels canopy-stability
 */

import { test, expect, type Page } from "@playwright/test";
import { execSync } from "child_process";
import { writeFileSync } from "fs";
import path from "path";
import { launchApp, closeApp, type AppContext } from "../../helpers/launch";
import { createFixtureRepo } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import { getGridPanelIds } from "../../helpers/panels";
import { SEL } from "../../helpers/selectors";
import { T_LONG } from "../../helpers/timeouts";
import { dismissBlockingPalette } from "../../helpers/overlays";
import { fakeAgentEnv } from "../../helpers/fakeAgent";
import {
  installFakeCanopyAgent,
  readFakeCanopyDraft,
  readFakeCanopyKeys,
  readFakeCanopySizes,
  setFakeCanopyScene,
  type FakeCanopyScene,
} from "../../helpers/fakeCanopyAgent";

const ENABLED = !!process.env.DAINTREE_E2E_CANOPY_LIVE;

const HEADER = [
  "▐▛███▜▌   Claude Code v9.9.9",
  "▝▜█████▛▘  Opus · Claude Max",
  "  ▘▘ ▝▝    ~/code/recipes",
  "",
];

const FINISHED: FakeCanopyScene = {
  lines: [
    ...HEADER,
    "> Fix the rounding in scaleRecipe and run the tests",
    "",
    "⏺ Fixed the rounding: amounts are scaled before they are rounded.",
    "",
    "⏺ Bash(npm test)",
    "  ⎿  ✓ 14 passed",
    "",
    "⏺ All 14 tests pass. The change is not committed yet.",
    "",
    "✻ Worked for 41s · done",
  ],
};

const APPROVAL = (command: string, why: string): FakeCanopyScene => ({
  box: false,
  lines: [
    ...HEADER,
    "> Clean up and commit",
    "",
    `⏺ Bash(${command})`,
    "",
    "╭──────────────────────────────────────────────────────────╮",
    "│ Bash command                                             │",
    "│                                                          │",
    `│   ${command.padEnd(55)}│`,
    `│   ${why.padEnd(55)}│`,
    "│                                                          │",
    "│ Do you want to proceed?                                  │",
    "│ ❯ 1. Yes                                                 │",
    "│   2. No, and tell Claude what to do differently (esc)    │",
    "╰──────────────────────────────────────────────────────────╯",
  ],
});

const QUESTION: FakeCanopyScene = {
  lines: [
    ...HEADER,
    "> Add a CHANGELOG entry for the units work, and ask me which date format to use first",
    "",
    "⏺ Which date format should the CHANGELOG entry use: 2026-10-08, or October 8, 2026?",
    "",
    "✻ Worked for 3s · done",
  ],
};

const WORKING: FakeCanopyScene = {
  working: true,
  spinner: "Testing",
  streamEveryMs: 5_000,
  lines: [...HEADER, "> Make the unit conversions round-trip and run the tests", ""],
  stream: [
    "⏺ Read(src/units.ts)",
    "  ⎿  Read 84 lines",
    "⏺ Update(src/units.ts)",
    "  ⎿  Updated src/units.ts with 6 additions and 2 removals",
    "⏺ Bash(npm test)",
    "  ⎿  ✗ converts ml to cups keeps fractions",
    "⏺ The fraction test fails: the rounding happens before the conversion.",
    "⏺ Update(src/units.ts)",
    "  ⎿  Updated src/units.ts with 3 additions and 3 removals",
    "⏺ Bash(npm test)",
    "  ⎿  ✓ 14 passed",
  ],
};

/** Stopped agents with lines long enough that every width wraps or cuts them differently. */
const LONG_FINISHED = (subject: string): FakeCanopyScene => ({
  lines: [
    ...HEADER,
    `> Fix the rounding in ${subject} and run the tests`,
    "",
    `⏺ Fixed the rounding in ${subject}: amounts are now scaled at full precision and rounded once at the end, so halving a recipe twice and doubling it back returns the original quantities.`,
    "",
    `⏺ Bash(npm test -- --reporter=verbose src/recipes/${subject}.test.ts src/recipes/units.test.ts src/recipes/format.test.ts)`,
    "  ⎿  ✓ 14 passed",
    "",
    `⏺ All 14 tests pass. Want me to commit this as "fix(recipes): round ${subject} amounts once at the end"?`,
    "",
    "✻ Worked for 41s · done",
  ],
});

interface Sample {
  at: number;
  /** The panel is on screen. */
  open: boolean;
  rows: Array<{
    id: string;
    priority: string | null;
    text: string;
    height: number;
    /** The row shows bones where its summary will be. */
    due: boolean;
    /** The row is marked unread. */
    unread: boolean;
  }>;
}

interface Change {
  at: number;
  run: string;
  /**
   * `reorder`: rows no event touched changed their order. `blank`: the open
   * panel showed no rows after it had shown some. `raw`: a row showed a
   * spinner's own line, timer and all. `unread`: a row turned read or unread.
   */
  kind: "position" | "priority" | "words" | "height" | "reorder" | "blank" | "raw" | "unread";
  from: string;
  to: string;
}

let ctx: AppContext;
let binDir: string;
let cleanupFixture: (() => void) | undefined;
/** The four agents, launched by the first test and carried through the rest. */
const agents = { finished: "", approval: "", working: "", question: "" };

/**
 * Something that happened; it explains changes on its run (any run for "*")
 * for `within` ms, its run moving among the rest included. `opens` marks the
 * panel coming up, whose entry may show an empty list for a moment.
 */
interface Event {
  at: number;
  run: string | null;
  what: string;
  within: number;
  opens?: boolean;
}

/**
 * A run printing new work between `from` and `to`: what its readings say about
 * that work — its words, and its priority — may change meanwhile. Never its place.
 */
interface Progress {
  run: string;
  from: number;
  to: number;
}

const card = (paneId: string) => `canopy-card-${paneId}`;

/**
 * Every visible change since `started`, those no event explains, and a printed
 * report. A row's height changing is never explained: every row keeps one
 * height whatever it says. `allowed` names changes a test expects of its own.
 */
async function measure(
  page: Page,
  started: number,
  events: Event[],
  progress: Progress[],
  allowed: (change: Change) => boolean = () => false
): Promise<{ changes: Change[]; unexplained: Change[] }> {
  const all = (await takeSamples(page)).filter((sample) => sample.at >= started);
  const involved = (at: number) =>
    new Set(
      events
        .filter((event) => event.run !== null && event.run !== "*")
        .filter((event) => at >= event.at && at - event.at <= event.within)
        .map((event) => event.run!)
    );
  // A closed panel shows no rows: a reopen is compared with what it last showed.
  const shown = all.filter((sample) => sample.rows.length > 0);
  const changes = [...changesIn(shown, involved), ...blanksIn(all, events), ...rawIn(all)];
  const explained = (change: Change) =>
    allowed(change) ||
    // Going read is the user reading it. Going unread needs something the
    // agent did — never its own progress printing, a redraw or a resize.
    (change.kind === "unread" &&
      (change.to === "read" ||
        events.some(
          (event) =>
            change.at >= event.at &&
            change.at - event.at <= event.within &&
            (event.run === change.run || event.run === "*")
        ))) ||
    (change.kind !== "unread" &&
      change.kind !== "reorder" &&
      change.kind !== "height" &&
      change.kind !== "blank" &&
      change.kind !== "raw" &&
      // A row moved only by another one moving keeps its order with the rest;
      // `reorder` catches any that do not.
      (change.kind === "position" ||
        events.some(
          (event) =>
            change.at >= event.at &&
            change.at - event.at <= event.within &&
            (event.run === change.run || event.run === "*")
        ) ||
        progress.some(
          (spell) => spell.run === change.run && change.at >= spell.from && change.at <= spell.to
        )));
  // A spinner's frame is never news, whatever else happened at the time.
  const glyphless = (text: string) => text.replace(/[✻✶✢✳✽✺⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/g, "");
  const ticking = changes.filter(
    (change) => change.kind === "words" && glyphless(change.from) === glyphless(change.to)
  );
  const unexplained = [
    ...changes.filter((change) => !explained(change)),
    ...ticking.filter((change) => explained(change)),
  ];
  const rel = (at: number) => `${((at - started) / 1000).toFixed(1)}s`;
  console.log(
    [
      "events:",
      ...events.map((event) => `  ${rel(event.at)} ${event.run ?? ""} ${event.what}`),
      `changes (${changes.length}):`,
      ...changes.map(
        (change) =>
          `  ${rel(change.at)} ${change.run} ${change.kind} ${change.from.slice(0, 60)} → ${change.to.slice(0, 60)}`
      ),
      `unexplained: ${unexplained.length}`,
    ].join("\n")
  );
  return { changes, unexplained };
}

const toggleCanopy = (page: Page) =>
  page.keyboard.press(process.platform === "darwin" ? "Meta+E" : "Control+Shift+O");

async function launchClaude(page: Page): Promise<string> {
  const before = new Set(await getGridPanelIds(page));
  await dismissBlockingPalette(page);
  await page.locator(SEL.agent.trayButton).click();
  await page.locator(SEL.agent.launcherRow("Claude")).first().click();
  let id: string | undefined;
  await expect
    .poll(
      async () => {
        id = (await getGridPanelIds(page)).find((candidate) => !before.has(candidate));
        return id !== undefined;
      },
      { timeout: T_LONG, intervals: [250] }
    )
    .toBe(true);
  return id!;
}

const dialog = (page: Page) => page.locator('[data-testid="canopy-dialog"]');

/** Starts sampling the inbox in the page; read back with `takeSamples`. */
async function sampleInbox(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __canopySamples?: Sample[] };
    const fresh = w.__canopySamples === undefined;
    w.__canopySamples = [];
    if (!fresh) return;
    setInterval(() => {
      const rows = [
        ...document.querySelectorAll<HTMLElement>("[data-canopy-list] [data-canopy-card]"),
      ]
        .map((row) => {
          // The age by the state glyph ticks by the minute and runs straight into
          // the name after it, where no pattern can find its edge: it is taken
          // out here, where it is still its own element.
          const copy = row.cloneNode(true) as HTMLElement;
          for (const age of copy.querySelectorAll("[data-canopy-age]")) age.textContent = "#";
          return { row, text: copy.textContent ?? "" };
        })
        .map(({ row, text }) => ({
          id: row.id,
          priority: row.dataset.priority ?? null,
          text,
          // Layout height, not the box on screen: the dialog scales in as it opens.
          height: row.offsetHeight,
          due: row.querySelector("[data-canopy-detail-due]") !== null,
          unread: row.dataset.unread === "true",
        }));
      const open = document.querySelector('[data-testid="canopy-dialog"]') !== null;
      w.__canopySamples!.push({ at: Date.now(), open, rows });
    }, 100);
  });
}

async function takeSamples(page: Page): Promise<Sample[]> {
  return page.evaluate(
    () => (window as unknown as { __canopySamples?: Sample[] }).__canopySamples ?? []
  );
}

/**
 * A row's words, with the ages that tick by the minute taken out, and its
 * read state too: that is its own kind of change (`unread`).
 */
function words(text: string): string {
  return (
    text
      .replace(/\bunread,\s?/g, "")
      // The row's text runs its parts together ("urgentnow98"), so no word edges.
      .replace(/just now|now|\d+\s?(?:s|m|h|d)(?![a-z])/g, "#")
      .replace(/\s+/g, " ")
      .trim()
  );
}

function changesIn(samples: Sample[], involved: (at: number) => Set<string>): Change[] {
  const out: Change[] = [];
  for (let i = 1; i < samples.length; i++) {
    const before = new Map(samples[i - 1]!.rows.map((row, index) => [row.id, { ...row, index }]));
    const touched = involved(samples[i]!.at);
    const order = (rows: Sample["rows"]) =>
      rows
        .map((row) => row.id)
        .filter((id) => !touched.has(id) && before.has(id))
        .join(" ");
    const was = samples[i - 1]!.rows.filter((row) =>
      samples[i]!.rows.some((other) => other.id === row.id)
    );
    if (order(was) !== order(samples[i]!.rows)) {
      out.push({
        at: samples[i]!.at,
        run: "list",
        kind: "reorder",
        from: order(was),
        to: order(samples[i]!.rows),
      });
    }
    samples[i]!.rows.forEach((row, index) => {
      const prev = before.get(row.id);
      if (!prev) return;
      const at = samples[i]!.at;
      if (prev.index !== index) {
        out.push({
          at,
          run: row.id,
          kind: "position",
          from: String(prev.index),
          to: String(index),
        });
      }
      if (prev.height !== row.height) {
        out.push({
          at,
          run: row.id,
          kind: "height",
          from: String(prev.height),
          to: String(row.height),
        });
      }
      if (prev.unread !== row.unread) {
        out.push({
          at,
          run: row.id,
          kind: "unread",
          from: prev.unread ? "unread" : "read",
          to: row.unread ? "unread" : "read",
        });
      }
      if (prev.priority !== row.priority) {
        out.push({
          at,
          run: row.id,
          kind: "priority",
          from: String(prev.priority),
          to: String(row.priority),
        });
      }
      const was = words(prev.text);
      const now = words(row.text);
      if (was !== now) {
        // Just the span that changed, with a little on either side.
        let head = 0;
        while (head < was.length && was[head] === now[head]) head++;
        let tail = 0;
        while (
          tail < was.length - head &&
          tail < now.length - head &&
          was[was.length - 1 - tail] === now[now.length - 1 - tail]
        ) {
          tail++;
        }
        const from = Math.max(0, head - 12);
        out.push({
          at,
          run: row.id,
          kind: "words",
          from: was.slice(from, was.length - tail + 12),
          to: now.slice(from, now.length - tail + 12),
        });
      }
    });
  }
  return out;
}

/** The open panel showing no rows once it had some, outside a moment of its own entry. */
function blanksIn(samples: Sample[], events: Event[]): Change[] {
  const out: Change[] = [];
  let shownBefore = false;
  for (const sample of samples) {
    if (sample.rows.length > 0) {
      shownBefore = true;
      continue;
    }
    const entering = events.some(
      (event) => event.opens === true && sample.at >= event.at && sample.at - event.at <= 600
    );
    if (sample.open && shownBefore && !entering) {
      out.push({ at: sample.at, run: "list", kind: "blank", from: "rows", to: "none" });
    }
  }
  return out;
}

/** Rows showing a spinner's own line: its glyph and timer tick on every read. */
function rawIn(samples: Sample[]): Change[] {
  const out: Change[] = [];
  const seen = new Set<string>();
  for (const sample of samples) {
    for (const row of sample.rows) {
      if (!/esc to interrupt|\(esc to cancel, \d/.test(row.text) || seen.has(row.id)) continue;
      seen.add(row.id);
      out.push({ at: sample.at, run: row.id, kind: "raw", from: "", to: row.text.slice(0, 80) });
    }
  }
  return out;
}

test.describe("Canopy stability against the live service", () => {
  // Each test carries on from the one before it, agents and all.
  test.describe.configure({ mode: "serial" });
  test.beforeAll(async () => {
    if (!ENABLED) return;
    const { dir, cleanup } = createFixtureRepo({ name: "canopy-stability" });
    cleanupFixture = cleanup;
    binDir = installFakeCanopyAgent(dir);
    writeFileSync(path.join(dir, ".gitignore"), ".e2e canopy bin/\n");
    execSync("git add -A && git commit -m canopy-fixture", { cwd: dir, stdio: "ignore" });
    ctx = await launchApp({ env: fakeAgentEnv(binDir) });
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, dir, "Canopy Stability");
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    cleanupFixture?.();
  });

  test("holds still while the user types into an agent, and moves only for a new approval", async () => {
    test.info().annotations.push({
      type: "conditional-skip",
      description:
        "DAINTREE_E2E_CANOPY_LIVE is required: the spec reads screens with the live service",
    });
    test.skip(!ENABLED, "set DAINTREE_E2E_CANOPY_LIVE=1 to read screens with the live service");
    // Four agents launch and settle before anything is measured.
    test.setTimeout(480_000);
    const page = ctx.window;

    agents.finished = await launchClaude(page);
    agents.approval = await launchClaude(page);
    agents.working = await launchClaude(page);
    agents.question = await launchClaude(page);
    const { finished, approval, working, question } = agents;
    setFakeCanopyScene(binDir, finished, FINISHED);
    setFakeCanopyScene(binDir, approval, APPROVAL("rm -rf dist", "Remove the stale build output"));
    setFakeCanopyScene(binDir, working, WORKING);
    setFakeCanopyScene(binDir, question, QUESTION);

    // Daintree's own tracking settles: three stopped, one at work.
    for (const id of [finished, approval, question]) {
      await expect(page.locator(`[data-panel-id="${id}"]`)).toHaveAttribute(
        "data-agent-state",
        "waiting",
        {
          timeout: 60_000,
        }
      );
    }

    // Turn Canopy on from its offer, the way a user does.
    await toggleCanopy(page);
    await dialog(page).getByRole("button", { name: "Turn on Canopy" }).click();
    // From the first open on: rows show at once, summaries as bones until
    // their words land, and no row changes height for it.
    await sampleInbox(page);
    const turnedOn = Date.now();
    await expect(dialog(page).locator("[data-canopy-list] [data-canopy-card]")).toHaveCount(4, {
      timeout: 60_000,
    });
    // Every row read and worded before measuring starts: the rows show at
    // once and fill in as the open's readings land, which is not what this
    // test measures.
    await expect
      .poll(
        async () =>
          dialog(page)
            .locator("[data-canopy-list] [data-canopy-card]")
            .evaluateAll((rows) =>
              rows.every((row) => (row as HTMLElement).dataset.priority !== undefined)
            ),
        { timeout: 60_000, intervals: [500] }
      )
      .toBe(true);
    await expect(dialog(page).locator("[data-canopy-list][data-revealing]")).toHaveCount(0, {
      timeout: 30_000,
    });
    await expect(dialog(page).locator("[data-canopy-detail-due]")).toHaveCount(0, {
      timeout: 30_000,
    });
    const firstOpen = (await takeSamples(page)).filter((sample) => sample.at >= turnedOn);
    expect(firstOpen.some((sample) => sample.rows.some((row) => row.due))).toBe(true);
    const heights = new Map<string, Set<number>>();
    for (const sample of firstOpen) {
      for (const row of sample.rows) {
        heights.set(row.id, (heights.get(row.id) ?? new Set()).add(row.height));
      }
    }
    expect([...heights.values()].map((seen) => [...seen])).toEqual(
      [...heights.values()].map((seen) => [[...seen][0]])
    );
    // Nor blanks once shown.
    expect(
      blanksIn(firstOpen, [{ at: turnedOn, run: null, what: "opens", within: 0, opens: true }])
    ).toEqual([]);
    await sampleInbox(page);
    const started = Date.now();
    const events: Event[] = [];

    // The user types a reply into the finished agent's terminal, then clears it.
    await dialog(page).locator(`#canopy-card-${finished}`).click();
    events.push({
      at: Date.now(),
      run: `canopy-card-${finished}`,
      what: "opens the finished agent",
      within: 2_000,
    });
    // The keyboard in the agent's own terminal, after the inbox has landed its
    // focus, so every key reaches the agent rather than the list's shortcuts.
    const terminal = dialog(page).locator("[data-canopy-terminal] textarea");
    await expect
      .poll(
        async () => {
          await terminal.focus();
          return terminal.evaluate((el) => el === document.activeElement);
        },
        { timeout: T_LONG, intervals: [500] }
      )
      .toBe(true);
    const draft = "fix the failing date tests and then commit";
    events.push({ at: Date.now(), run: null, what: "starts typing", within: 0 });
    await page.keyboard.type(draft, { delay: 120 });
    // It reached the agent, whose input box now holds it.
    await expect.poll(() => readFakeCanopyDraft(binDir, finished), { timeout: T_LONG }).toBe(draft);
    await page.waitForTimeout(10_000); // timer: the measured hold after typing
    for (let i = 0; i < draft.length; i++) await page.keyboard.press("Backspace", { delay: 40 });
    await expect.poll(() => readFakeCanopyDraft(binDir, finished), { timeout: T_LONG }).toBe("");
    events.push({ at: Date.now(), run: null, what: "clears the draft", within: 0 });
    await page.waitForTimeout(15_000); // timer: the measured hold after clearing

    // A real change: the working agent stops on an approval.
    setFakeCanopyScene(
      binDir,
      working,
      APPROVAL("git push --force", "Overwrite the remote branch")
    );
    events.push({
      at: Date.now(),
      run: `canopy-card-${working}`,
      what: "asks for approval",
      within: 20_000,
    });
    await page.waitForTimeout(30_000); // timer: the approval lands and settles

    const asked = events[events.length - 1]!.at;
    const { unexplained } = await measure(page, started, events, [
      { run: card(working), from: started, to: asked },
    ]);
    expect(unexplained).toEqual([]);
  });

  test("holds still through a quiet spell and a close and reopen, and moves only the agents that start work", async () => {
    test.info().annotations.push({
      type: "conditional-skip",
      description:
        "DAINTREE_E2E_CANOPY_LIVE is required: the spec reads screens with the live service",
    });
    test.skip(!ENABLED, "set DAINTREE_E2E_CANOPY_LIVE=1 to read screens with the live service");
    test.setTimeout(300_000);
    const page = ctx.window;
    await sampleInbox(page);
    const started = Date.now();

    // Nothing happens for a while.
    await page.waitForTimeout(40_000); // timer: the measured quiet spell

    // Closed and opened again, with nothing new in between.
    await toggleCanopy(page);
    await expect(dialog(page)).toHaveCount(0);
    await page.waitForTimeout(15_000); // timer: the panel stays closed
    const reopened = Date.now();
    await toggleCanopy(page);
    await expect(dialog(page).locator("[data-canopy-list] [data-canopy-card]")).toHaveCount(4);
    await page.waitForTimeout(10_000); // timer: the reopened list holds
    const reopenEnded = Date.now();

    // Two agents start new work at once.
    const events: Event[] = [
      { at: reopened, run: null, what: "reopens the panel", within: 0, opens: true },
    ];
    setFakeCanopyScene(binDir, agents.finished, { ...WORKING, spinner: "Refactoring" });
    setFakeCanopyScene(binDir, agents.question, { ...WORKING, spinner: "Writing" });
    const began = Date.now();
    events.push({ at: began, run: card(agents.finished), what: "starts new work", within: 25_000 });
    events.push({ at: began, run: card(agents.question), what: "starts new work", within: 25_000 });
    await page.waitForTimeout(60_000); // timer: both work and stream for a minute
    const ended = Date.now();

    const { changes, unexplained } = await measure(page, started, events, [
      { run: card(agents.finished), from: began, to: ended },
      { run: card(agents.question), from: began, to: ended },
    ]);
    // Not even an explained change while nothing happened, or at the reopen —
    // but a row read meanwhile: the panel closed onto a pane the user then had
    // in front of them, and it opens again showing what they read there.
    expect(
      changes.filter(
        (change) => change.at < reopenEnded && !(change.kind === "unread" && change.to === "read")
      )
    ).toEqual([]);
    expect(unexplained).toEqual([]);
  });

  test("moves only the approval the user answers, and then that agent's own work", async () => {
    test.info().annotations.push({
      type: "conditional-skip",
      description:
        "DAINTREE_E2E_CANOPY_LIVE is required: the spec reads screens with the live service",
    });
    test.skip(!ENABLED, "set DAINTREE_E2E_CANOPY_LIVE=1 to read screens with the live service");
    test.setTimeout(240_000);
    const page = ctx.window;
    await sampleInbox(page);
    const started = Date.now();
    const events: Event[] = [];

    // The user answers the first approval from its row, with its number key.
    const row = dialog(page).locator(`#${card(agents.approval)}`);
    await row.click();
    await expect(row).toBeFocused();
    const keysBefore = readFakeCanopyKeys(binDir, agents.approval).length;
    await page.keyboard.press("1");
    const answered = Date.now();
    // The answer reached the agent — Enter on the highlighted first choice,
    // as the menu takes it — and the row says it is answered.
    await expect
      .poll(() => readFakeCanopyKeys(binDir, agents.approval).slice(keysBefore), {
        timeout: T_LONG,
      })
      .toContain("\r");
    await expect(row).toHaveAttribute("data-priority", "0", { timeout: T_LONG });
    events.push({
      at: answered,
      run: card(agents.approval),
      what: "answers the approval",
      within: 25_000,
    });
    // The cursor moves on to the next run that needs the user, and opens it.
    events.push({ at: answered, run: "*", what: "moves on to the next ask", within: 2_000 });
    // The agent takes the answer and gets back to work.
    setFakeCanopyScene(binDir, agents.approval, { ...WORKING, spinner: "Cleaning" });
    const resumed = Date.now();
    events.push({ at: resumed, run: card(agents.approval), what: "works again", within: 25_000 });
    await page.waitForTimeout(45_000); // timer: the answered run settles

    const now = Date.now();
    const { unexplained } = await measure(page, started, events, [
      { run: card(agents.approval), from: resumed, to: now },
      // Still at the work they started in the test before.
      { run: card(agents.finished), from: started, to: now },
      { run: card(agents.question), from: started, to: now },
    ]);
    expect(unexplained).toEqual([]);
  });

  test("holds still while the user moves between agents and resizes the window, which redraws every one", async () => {
    test.info().annotations.push({
      type: "conditional-skip",
      description:
        "DAINTREE_E2E_CANOPY_LIVE is required: the spec reads screens with the live service",
    });
    test.skip(!ENABLED, "set DAINTREE_E2E_CANOPY_LIVE=1 to read screens with the live service");
    test.setTimeout(300_000);
    const page = ctx.window;
    const { finished, approval, working, question } = agents;
    setFakeCanopyScene(binDir, finished, LONG_FINISHED("scaleRecipe"));
    setFakeCanopyScene(binDir, approval, LONG_FINISHED("convertUnits"));
    setFakeCanopyScene(binDir, question, QUESTION);
    // The pointer off the list, where the last test left it, so the new
    // readings are placed before measuring starts rather than held for it.
    await page.mouse.move(2, 2);
    for (const id of [finished, approval, question, working]) {
      await expect(page.locator(`[data-panel-id="${id}"]`)).toHaveAttribute(
        "data-agent-state",
        "waiting",
        { timeout: 60_000 }
      );
    }
    // Every new screen read and worded before measuring starts: the inbox
    // goes ten seconds without a row changing.
    let last = "";
    let quietSince = Date.now();
    await expect
      .poll(
        async () => {
          const now = await dialog(page)
            .locator("[data-canopy-list] [data-canopy-card]")
            .evaluateAll((rows) =>
              rows
                .map(
                  (row) => `${row.id}|${(row as HTMLElement).dataset.priority}|${row.textContent}`
                )
                .join("\n")
            );
          if (now !== last) {
            last = now;
            quietSince = Date.now();
          }
          return Date.now() - quietSince >= 10_000 && !now.includes("Reading the screen");
        },
        { timeout: 120_000, intervals: [1_000] }
      )
      .toBe(true);
    await sampleInbox(page);
    const started = Date.now();
    const sizesBefore = Object.fromEntries(
      [finished, approval, question, working].map((id) => [
        id,
        readFakeCanopySizes(binDir, id).length,
      ])
    );

    // Into each agent and on to the next: each is held at the pane's size
    // while shown, and handed back its own when the next one is.
    for (const id of [finished, approval, question, working, finished]) {
      await dialog(page)
        .locator(`#${card(id)}`)
        .click();
      await page.waitForTimeout(6_000); // timer: the shown agent redraws and is scanned
    }

    // The window shrinks and grows back: every agent's terminal is resized.
    const resize = (dw: number, dh: number) =>
      ctx.app.evaluate(
        ({ BrowserWindow }, delta) => {
          const win = BrowserWindow.getAllWindows().find((w) => w.isVisible());
          if (!win) return;
          const [w, h] = win.getSize();
          win.setSize(w! + delta.dw, h! + delta.dh);
        },
        { dw, dh }
      );
    await resize(-220, -140);
    await page.waitForTimeout(8_000); // timer: every agent redraws and is scanned
    await resize(220, 140);
    await page.waitForTimeout(12_000); // timer: and again, then the measured hold

    // Every agent was resized, so every one redrew.
    for (const id of [finished, approval, question, working]) {
      expect(readFakeCanopySizes(binDir, id).length).toBeGreaterThan(sizesBefore[id]!);
    }
    // Nothing moved for it: no order, priority, height or words changed but
    // a row going from unread to read as it was opened.
    const opened = (change: Change) =>
      change.kind === "words" && change.from.replace("unread, ", "") === change.to;
    const { unexplained } = await measure(page, started, [], [], opened);
    expect(unexplained).toEqual([]);
  });
});
