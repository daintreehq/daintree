import { afterEach, describe, expect, it, vi } from "vitest";
import type { FleetRunRow } from "../../../../shared/types/ipc/fleet.js";
import type {
  CanopyCategory,
  CanopyPlan,
  CanopySnapshot,
} from "../../../../shared/types/ipc/canopy.js";
import { CANOPY_URGENT_PRIORITY } from "../../../../shared/types/ipc/canopy.js";
import {
  CANOPY_CLASSIFIER_ANCHORS,
  CANOPY_POLL_MS,
  CANOPY_PROGRESS_DESCRIBE_MS,
  CANOPY_REJUDGE_AFTER_MS,
  CANOPY_STALL_MS,
  CANOPY_TRANSIENT_GRACE_MS,
  CANOPY_COLD_START_GRACE_MS,
  CANOPY_FAILURE_BACKOFF_MAX_MS,
  CanopyService,
  type CanopyServiceDeps,
} from "../CanopyService.js";
import {
  CanopyProviderError,
  type CanopyPartialDescription,
  type ClassifierResult,
  type DescriberResult,
  type CanopyScreenInput,
} from "../canopyProviders.js";
import { CANOPY_REFLOW_MS } from "../canopyReflow.js";

/** A classifier reading; `blocked` defaults to the attention of an ask, else 0. */
type Reading = Omit<ClassifierResult, "blocked"> & { blocked?: number };

function withBlocked(reading: Reading): ClassifierResult {
  const asks = reading.category === "approval" || reading.category === "question";
  return { ...reading, blocked: reading.blocked ?? (asks ? reading.attention : 0) };
}

function run(runId: string, extra: Partial<FleetRunRow> = {}): FleetRunRow {
  return {
    runId,
    workspaceId: "p".repeat(64),
    spawnedAt: 1,
    cwd: "/repo",
    agentId: "claude",
    ...extra,
  };
}

interface Harness {
  service: CanopyService;
  screens: Map<string, string>;
  runs: FleetRunRow[];
  classify: ReturnType<typeof vi.fn<(input: CanopyScreenInput) => Promise<Reading>>>;
  describe: ReturnType<typeof vi.fn<DescribeFn>>;
  snapshots: CanopySnapshot[];
}

type DescribeFn = (
  input: CanopyScreenInput,
  says: CanopyCategory,
  onPartial?: (partial: CanopyPartialDescription) => void
) => Promise<DescriberResult>;

let harness: Harness | null = null;

/** Let an in-flight scan (and its microtask chain) finish. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Opens the panel before any run exists, so the opening scan is empty and settled. */
async function makeHarness(options: {
  classify?: (input: CanopyScreenInput) => Promise<Reading>;
  describe?: DescribeFn;
  now?: () => number;
  closeGraceMs?: number;
  /** The history above each run's screen; absent, no history is read. */
  history?: Map<string, string>;
  stateChangeScanMs?: number;
  rereadMs?: number;
  plan?: CanopyPlan;
  /** Off unless given, so a closed panel reads nothing. */
  backgroundPollMs?: number;
  onAsk?: CanopyServiceDeps["onAsk"];
  serviceWaking?: () => boolean;
  /** Leave the panel closed after construction. */
  closed?: boolean;
  /** False while the fleet should read as unknown (degraded). */
  fleetKnown?: () => boolean;
}): Promise<Harness> {
  const screens = new Map<string, string>();
  const runs: FleetRunRow[] = [];
  const classify = vi.fn(
    options.classify ??
      (async (): Promise<Reading> => ({
        category: "working",
        confidence: 0.99,
        attention: 0.99,
        question: null,
      }))
  );
  const describe = vi.fn(
    options.describe ??
      (async (_input: CanopyScreenInput, says: CanopyCategory): Promise<DescriberResult> => ({
        category: says,
        headline: "Headline",
        summary: "Summary",
        attentionScore: 95,
        task: null,
        risk: "unknown",
        riskReason: null,
        action: null,
        progress: null,
        tests: "unknown" as const,
        changes: "unknown" as const,
        question: null,
        options: [],
      }))
  );
  const snapshots: CanopySnapshot[] = [];
  const deps: CanopyServiceDeps = {
    // Most tests read each change at once; the floor has tests of its own.
    rereadMs: options.rereadMs ?? 0,
    getRuns: () => (options.fleetKnown?.() === false ? null : runs),
    readScreen: async (runId) => screens.get(runId) ?? null,
    // A real history read is the scrollback above the screen and the screen itself.
    ...(options.history
      ? {
          readHistory: async (runId: string) =>
            `${options.history!.get(runId) ?? ""}\n${screens.get(runId) ?? ""}`,
        }
      : {}),
    classify: async (input) => withBlocked(await classify(input)),
    describe: (input, says, _signal, onPartial) => describe(input, says, onPartial),
    broadcast: (snapshot) => snapshots.push(snapshot),
    ...(options.now ? { now: options.now } : {}),
    closeGraceMs: options.closeGraceMs ?? 0,
    ...(options.plan ? { plan: options.plan } : {}),
    backgroundPollMs: options.backgroundPollMs ?? 0,
    ...(options.onAsk ? { onAsk: options.onAsk } : {}),
    ...(options.serviceWaking ? { serviceWaking: options.serviceWaking } : {}),
    ...(options.stateChangeScanMs !== undefined
      ? { stateChangeScanMs: options.stateChangeScanMs }
      : {}),
  };
  harness = { service: new CanopyService(deps), screens, runs, classify, describe, snapshots };
  if (!options.closed) harness.service.setActive(true);
  await settle();
  return harness;
}

afterEach(() => {
  harness?.service.dispose();
  harness = null;
});

const APPROVAL_SCREEN = [
  "⏺ Bash(npm test)",
  "Do you want to proceed?",
  "❯ 1. Yes",
  "  2. No, and tell Claude what to do differently (esc)",
].join("\n");

describe("CanopyService streaming a card", () => {
  const FINAL: DescriberResult = {
    category: "approval",
    headline: "Approve running npm test",
    summary: "Runs the unit suite once.",
    attentionScore: 94,
    task: null,
    risk: "none",
    riskReason: null,
    action: null,
    progress: null,
    tests: "unknown",
    changes: "unknown",
    question: "Do you want to proceed?",
    options: ["Yes", "No, and tell Claude what to do differently (esc)"],
  };

  async function streaming() {
    let partial: ((p: CanopyPartialDescription) => void) | undefined;
    let finish!: (result: DescriberResult) => void;
    const h = await makeHarness({
      classify: async () => ({
        category: "approval",
        confidence: 0.95,
        attention: 0.95,
        question: "Do you want to proceed?",
      }),
      describe: (_input, _says, onPartial) => {
        partial = onPartial;
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
    });
    h.runs.push(run("a", { agentState: "waiting", waitingReason: "approval" }));
    h.screens.set("a", APPROVAL_SCREEN);
    void h.service.scan();
    await vi.waitFor(() => expect(partial).toBeDefined());
    return { h, partial: partial!, finish: (r: DescriberResult) => finish(r) };
  }

  it("shows the words once headline and summary have both landed, and the card replaces them", async () => {
    const { h, partial, finish } = await streaming();
    partial({ category: "approval", headline: "Approve running npm test" });
    await settle();
    // A headline alone is half the row's words: they land together.
    expect(h.service.getSnapshot().cards[0]!.headline).toBeNull();
    partial({
      category: "approval",
      headline: "Approve running npm test",
      summary: "Runs the suite.",
    });
    await vi.waitFor(() =>
      expect(h.service.getSnapshot().cards[0]).toMatchObject({
        headline: "Approve running npm test",
        summary: "Runs the suite.",
        describing: true,
      })
    );
    expect(
      h.snapshots.some((snap) => snap.cards[0]?.headline != null && snap.cards[0].summary == null)
    ).toBe(false);

    finish(FINAL);
    await vi.waitFor(() => expect(h.service.getSnapshot().cards[0]!.describing).toBe(false));
    const card = h.service.getSnapshot().cards[0]!;
    expect(card).toMatchObject({
      stage: "described",
      headline: "Approve running npm test",
      summary: "Runs the unit suite once.",
      options: FINAL.options,
    });
  });

  it("holds the run's state and rank until its card is finished", async () => {
    const { h, partial, finish } = await streaming();
    const before = h.service.getSnapshot().cards[0]!;
    partial({ category: "working", headline: "Approve running npm test", summary: "Runs it." });
    await vi.waitFor(() =>
      expect(h.service.getSnapshot().cards[0]!.headline).toBe("Approve running npm test")
    );
    expect(h.service.getSnapshot().cards[0]).toMatchObject({
      category: before.category,
      priority: before.priority,
      attentionScore: before.attentionScore,
    });
    expect(before.priority).toBeGreaterThanOrEqual(CANOPY_URGENT_PRIORITY);
    finish(FINAL);
    await vi.waitFor(() => expect(h.service.getSnapshot().cards[0]!.describing).toBe(false));
  });

  it("keeps a row's words until the whole new card replaces them", async () => {
    let calls = 0;
    let partial: ((p: CanopyPartialDescription) => void) | undefined;
    let finish!: (result: DescriberResult) => void;
    const h = await makeHarness({
      classify: async () => ({
        category: "approval",
        confidence: 0.95,
        attention: 0.95,
        question: "Do you want to proceed?",
      }),
      describe: (_input, _says, onPartial) => {
        calls++;
        if (calls === 1) return Promise.resolve({ ...FINAL, headline: "Old words" });
        partial = onPartial;
        return new Promise((resolve) => (finish = resolve));
      },
    });
    h.runs.push(run("a", { agentState: "waiting", waitingReason: "approval" }));
    h.screens.set("a", APPROVAL_SCREEN);
    await h.service.refresh();
    expect(h.service.getSnapshot().cards[0]!.headline).toBe("Old words");

    h.screens.set("a", `${APPROVAL_SCREEN}\n\nAnother line`);
    void h.service.scan();
    await vi.waitFor(() => expect(partial).toBeDefined());
    partial!({ category: "approval", headline: "New words" });
    partial!({ category: "approval", headline: "New words", summary: "New summary." });
    await settle();
    expect(h.service.getSnapshot().cards[0]).toMatchObject({
      headline: "Old words",
      summary: FINAL.summary,
    });
    finish({ ...FINAL, headline: "New words", summary: "New summary." });
    await vi.waitFor(() =>
      expect(h.service.getSnapshot().cards[0]).toMatchObject({
        headline: "New words",
        summary: "New summary.",
      })
    );
  });

  it("drops the prompt of a screen that moved on at once, and keeps its words for the new card", async () => {
    const { h, partial } = await streaming();
    partial({ category: "approval", headline: "Approve running npm test", summary: "Runs it." });
    await vi.waitFor(() =>
      expect(h.service.getSnapshot().cards[0]!.headline).toBe("Approve running npm test")
    );
    h.screens.set("a", `${APPROVAL_SCREEN}\n\nA different dialog`);
    void h.service.scan();
    await vi.waitFor(() => expect(h.classify).toHaveBeenCalledTimes(2));
    const card = h.service.getSnapshot().cards[0]!;
    // Never the last dialog's answers beside a new one.
    expect(card.options).toEqual([]);
    // The words stand until the new card replaces them: no blink between.
    expect(card).toMatchObject({
      headline: "Approve running npm test",
      wordsFromEarlierRead: false,
    });
  });

  it("offers nothing to act on from a card still being written", async () => {
    const { h, partial, finish } = await streaming();
    partial({ category: "approval", headline: "Approve running npm test" });
    await settle();
    expect(h.service.getSnapshot().cards[0]!.stage).not.toBe("described");
    finish(FINAL);
  });

  it("ignores words that arrive after the card is finished", async () => {
    const { h, partial, finish } = await streaming();
    finish(FINAL);
    await vi.waitFor(() => expect(h.service.getSnapshot().cards[0]!.describing).toBe(false));
    partial({ category: "working", headline: "Stale words" });
    await settle();
    expect(h.service.getSnapshot().cards[0]!.headline).toBe("Approve running npm test");
  });
});

describe("CanopyService", () => {
  it("describes the runs that need the user, and a working one for its progress", async () => {
    const h = await makeHarness({
      classify: async (input) =>
        input.screen.includes("proceed")
          ? {
              category: "approval",
              confidence: 0.95,
              attention: 0.95,
              question: "Do you want to proceed?",
            }
          : { category: "working", confidence: 0.99, attention: 0.05, question: null },
      describe: async (_input, says) =>
        says === "working"
          ? {
              category: "working",
              headline: "Thinking about the test plan",
              summary: "Has read the suites; no edits yet.",
              attentionScore: 3,
              task: "Plan the tests",
              risk: "unknown",
              riskReason: null,
              action: null,
              progress: null,
              tests: "unknown" as const,
              changes: "unknown" as const,
              question: null,
              options: [],
            }
          : {
              category: "approval",
              headline: "Run the tests?",
              summary: "Waiting to run npm test.",
              attentionScore: 95,
              task: null,
              risk: "unknown",
              riskReason: null,
              action: null,
              progress: null,
              tests: "unknown" as const,
              changes: "unknown" as const,
              question: "Do you want to proceed?",
              options: ["Yes", "No, and tell Claude what to do differently (esc)"],
            },
    });
    h.runs.push(run("a"), run("b"));
    h.screens.set("a", APPROVAL_SCREEN);
    h.screens.set("b", "✻ Pondering… (12s · esc to interrupt)");

    await h.service.scan();

    expect(h.classify).toHaveBeenCalledTimes(2);
    expect(h.describe).toHaveBeenCalledTimes(2);
    const cards = new Map(h.service.getSnapshot().cards.map((card) => [card.runId, card]));
    expect(cards.get("a")).toMatchObject({
      category: "approval",
      stage: "described",
      attentionProbability: 0.95,
      attentionScore: 95,
      task: null,
      risk: "unknown",
      riskReason: null,
      action: null,
      progress: null,
      tests: "unknown" as const,
      changes: "unknown" as const,
      priority: 95,
      headline: "Run the tests?",
      options: ["Yes", "No, and tell Claude what to do differently (esc)"],
    });
    expect(cards.get("b")).toMatchObject({
      category: "working",
      stage: "described",
      wordsCategory: "working",
      attentionScore: 3,
      priority: 3,
      task: "Plan the tests",
      headline: "Thinking about the test plan",
    });
  });

  it("writes a working run's progress at most once per interval, keeping its words between", async () => {
    let now = 1_000_000;
    const h = await makeHarness({
      now: () => now,
      classify: async () => ({
        category: "working",
        confidence: 0.99,
        attention: 0.05,
        question: null,
      }),
    });
    h.runs.push(run("a", { agentState: "working" }));
    h.screens.set("a", "✻ Editing src/app.ts… (esc to interrupt)");
    await h.service.scan();
    expect(h.describe).toHaveBeenCalledTimes(1);
    // A first describe has nothing earlier to compare against.
    expect(h.describe.mock.calls[0]![0].previousReading ?? null).toBeNull();

    const early = CANOPY_PROGRESS_DESCRIBE_MS / 2;
    now += early;
    h.screens.set("a", "✻ Running npm test… (esc to interrupt)");
    await h.service.refresh();
    // Classified again, but its words stay until the interval is up.
    expect(h.classify).toHaveBeenCalledTimes(2);
    expect(h.describe).toHaveBeenCalledTimes(1);
    expect(h.service.getSnapshot().cards[0]).toMatchObject({
      headline: "Headline",
      wordsCategory: "working",
      wordsFromEarlierRead: true,
      describing: false,
    });

    now += CANOPY_PROGRESS_DESCRIBE_MS;
    h.screens.set("a", "✻ Fixing the failing test… (esc to interrupt)");
    await h.service.refresh();
    expect(h.describe).toHaveBeenCalledTimes(2);
    // The next words are written against the last ones, so they can say what moved.
    expect(h.describe.mock.calls[1]![0].previousReading).toMatchObject({
      category: "working",
      headline: "Headline",
      summary: "Summary",
      secondsAgo: Math.round((early + CANOPY_PROGRESS_DESCRIBE_MS) / 1000),
    });
  });

  it("describes a run at once when it moves from a prompt to work, without the prompt's words", async () => {
    let category: CanopyCategory = "approval";
    let now = 1_000_000;
    const h = await makeHarness({
      now: () => now,
      classify: async () => ({
        category,
        confidence: 0.95,
        attention: category === "approval" ? 0.95 : 0.05,
        question: null,
      }),
    });
    h.runs.push(run("a"));
    h.screens.set("a", APPROVAL_SCREEN);
    await h.service.scan();
    expect(h.describe).toHaveBeenCalledTimes(1);

    category = "working";
    now += 5_000;
    h.runs[0] = run("a", { agentState: "working" });
    h.screens.set("a", "✻ Running npm test… (esc to interrupt)");
    await h.service.refresh();
    // Words about the approval are no reading of the work, however recent.
    expect(h.describe).toHaveBeenCalledTimes(2);
    expect(h.describe.mock.calls[1]![0].previousReading).toMatchObject({ category: "approval" });
    expect(h.service.getSnapshot().cards[0]!.wordsCategory).toBe("working");
  });

  it("holds the progress throttle when the readers call the same work running and working", async () => {
    let now = 1_000_000;
    const h = await makeHarness({
      now: () => now,
      classify: async () => ({
        category: "working",
        confidence: 0.99,
        attention: 0.05,
        question: null,
      }),
      describe: async () => ({
        category: "running",
        headline: "Serving the docs",
        summary: "Dev server up on :4321.",
        attentionScore: 2,
        task: null,
        risk: "unknown",
        riskReason: null,
        action: null,
        progress: null,
        tests: "unknown" as const,
        changes: "unknown" as const,
        question: null,
        options: [],
      }),
    });
    h.runs.push(run("a", { agentState: "working" }));
    h.screens.set("a", "✻ Building… (esc to interrupt)");
    await h.service.scan();
    now += 10_000;
    h.screens.set("a", "✻ Still building… (esc to interrupt)");
    await h.service.refresh();
    expect(h.describe).toHaveBeenCalledTimes(1);
  });

  it("retries a prompt-to-work describe that failed, rather than keeping the prompt's words", async () => {
    let category: CanopyCategory = "approval";
    let fail = false;
    let now = 1_000_000;
    const h = await makeHarness({
      now: () => now,
      classify: async () => ({
        category,
        confidence: 0.95,
        attention: category === "approval" ? 0.95 : 0.05,
        question: null,
      }),
      describe: async (_input, says) => {
        if (fail) throw new Error("describer down");
        return {
          category: says,
          headline: says === "approval" ? "Approve the edit" : "Editing the store",
          summary: "Summary",
          attentionScore: says === "approval" ? 90 : 4,
          task: null,
          risk: "unknown",
          riskReason: null,
          action: null,
          progress: null,
          tests: "unknown" as const,
          changes: "unknown" as const,
          question: null,
          options: [],
        };
      },
    });
    h.runs.push(run("a"));
    h.screens.set("a", APPROVAL_SCREEN);
    await h.service.scan();

    category = "working";
    fail = true;
    now += 5_000;
    h.runs[0] = run("a", { agentState: "working" });
    h.screens.set("a", "✻ Editing… (esc to interrupt)");
    await h.service.refresh();
    expect(h.service.getSnapshot().cards[0]!.wordsCategory).toBe("approval");

    fail = false;
    now += 5_000;
    h.screens.set("a", "✻ Still editing… (esc to interrupt)");
    await h.service.refresh();
    // Approval words are no fresh progress, however recent they are.
    expect(h.describe).toHaveBeenCalledTimes(3);
    expect(h.service.getSnapshot().cards[0]).toMatchObject({
      wordsCategory: "working",
      headline: "Editing the store",
    });
  });

  it("records when the user last looked at a run, for the incarnation the fleet shows", async () => {
    let now = 1_000_000;
    const h = await makeHarness({ now: () => now });
    h.runs.push(run("a", { spawnedAt: 7 }));
    h.service.markSeen("a");
    h.service.markSeen("gone");
    expect(h.service.getSnapshot().seen).toEqual([{ runId: "a", spawnedAt: 7, at: 1_000_000 }]);

    now += 1_000;
    h.service.markSeen("a");
    expect(h.service.getSnapshot().seen).toEqual([{ runId: "a", spawnedAt: 7, at: 1_001_000 }]);

    // A respawn under the same id has not been looked at.
    h.runs[0] = run("a", { spawnedAt: 8 });
    h.service.onFleetChanged();
    expect(h.service.getSnapshot().seen).toEqual([]);
  });

  it("broadcasts a look only to an open panel", async () => {
    const wait = () => new Promise<void>((resolve) => setTimeout(resolve, 60));
    const h = await makeHarness({});
    h.runs.push(run("a"));
    h.service.setActive(false, true);
    await wait();
    const before = h.snapshots.length;
    h.service.markSeen("a");
    await wait();
    expect(h.snapshots.length).toBe(before);
    expect(h.service.getSnapshot().seen.map((entry) => entry.runId)).toEqual(["a"]);

    h.service.setActive(true);
    await wait();
    const open = h.snapshots.length;
    h.service.markSeen("a");
    await wait();
    expect(h.snapshots.length).toBeGreaterThan(open);
  });

  it("describes a run only when the classifier thinks it likely needs the user", async () => {
    const h = await makeHarness({
      classify: async (input) =>
        input.screen.includes("proceed")
          ? { category: "approval", confidence: 0.6, attention: 0.45, question: null }
          : { category: "idle", confidence: 0.4, attention: 0.7, question: null },
    });
    h.runs.push(run("doubted"), run("likely"));
    h.screens.set("doubted", APPROVAL_SCREEN);
    h.screens.set("likely", "dev@studio app % ");
    await h.service.scan();
    // The probability is the gate, whatever category came with it.
    expect(h.describe).toHaveBeenCalledTimes(1);
    expect(h.describe.mock.calls[0]![0].screen).toBe("dev@studio app %");
  });

  it("hands the classifier Daintree's own observed state", async () => {
    const h = await makeHarness({});
    h.runs.push(
      run("a", { agentState: "waiting", waitingReason: "approval", since: Date.now() - 5_000 })
    );
    h.screens.set("a", APPROVAL_SCREEN);
    await h.service.scan();
    const observed = h.classify.mock.calls[0]![0].observed;
    expect(observed.agentState).toBe("waiting");
    expect(observed.waitingReason).toBe("approval");
    expect(observed.secondsInState).toBeGreaterThanOrEqual(5);
  });

  it("does not re-send a screen that has not changed, but does when the state moves", async () => {
    const h = await makeHarness({});
    h.runs.push(run("a", { agentState: "working" }));
    h.screens.set("a", "✻ Pondering… (12s · esc to interrupt)");
    await h.service.scan();
    h.screens.set("a", "✻ Pondering… (15s · esc to interrupt)");
    await h.service.scan();
    expect(h.classify).toHaveBeenCalledTimes(1);

    h.runs[0] = run("a", { agentState: "waiting" });
    await h.service.scan();
    expect(h.classify).toHaveBeenCalledTimes(2);
  });

  it("re-reads every screen on refresh but sends only the ones that changed", async () => {
    const h = await makeHarness({});
    h.runs.push(run("a"), run("b"));
    h.screens.set("a", "unchanged");
    h.screens.set("b", "before");
    await h.service.scan();
    h.screens.set("b", "after");
    await h.service.refresh();
    expect(h.classify).toHaveBeenCalledTimes(3);
  });

  it("reads nothing until the user turns it on, and forgets every reading when they turn it off", async () => {
    const h = await makeHarness({ plan: { activated: false, tier: "priority" } });
    h.runs.push(run("a"));
    h.screens.set("a", APPROVAL_SCREEN);
    await h.service.refresh();
    expect(h.classify).not.toHaveBeenCalled();
    expect(h.service.getSnapshot()).toMatchObject({ activated: false, cards: [] });

    h.service.setPlan({ activated: true, tier: "priority" });
    await settle();
    await settle();
    expect(h.classify).toHaveBeenCalledTimes(1);
    expect(h.service.getSnapshot().cards).toHaveLength(1);

    h.service.setPlan({ activated: false, tier: "priority" });
    expect(h.service.getSnapshot()).toMatchObject({ activated: false, cards: [] });
  });

  it("reads the free tier as soon and as often as the priority one", async () => {
    const h = await makeHarness({ plan: { activated: true, tier: "free" } });
    h.service.setActive(false);
    vi.useFakeTimers();
    try {
      h.runs.push(run("a"));
      h.screens.set("a", "screen");
      h.service.setActive(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(h.classify).toHaveBeenCalledTimes(1);

      h.screens.set("a", "a new screen");
      await vi.advanceTimersByTimeAsync(CANOPY_POLL_MS - 1);
      expect(h.classify).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(h.classify).toHaveBeenCalledTimes(2);
    } finally {
      h.service.dispose();
      vi.useRealTimers();
    }
  });

  it("polls while a panel is open, sending only the screens that changed", async () => {
    const h = await makeHarness({});
    h.service.setActive(false);
    vi.useFakeTimers();
    try {
      h.runs.push(run("a"), run("b"));
      h.screens.set("a", "screen");
      h.screens.set("b", "another");
      h.service.setActive(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(h.classify).toHaveBeenCalledTimes(2);

      // Nothing moved: a poll reads every screen and sends none of them.
      await vi.advanceTimersByTimeAsync(CANOPY_POLL_MS);
      expect(h.classify).toHaveBeenCalledTimes(2);

      h.screens.set("a", "a new screen");
      await vi.advanceTimersByTimeAsync(CANOPY_POLL_MS);
      expect(h.classify).toHaveBeenCalledTimes(3);

      // Closed: no more polls, whatever changes.
      h.service.setActive(false);
      h.screens.set("b", "moved while closed");
      await vi.advanceTimersByTimeAsync(10 * CANOPY_POLL_MS);
      expect(h.classify).toHaveBeenCalledTimes(3);
    } finally {
      h.service.dispose();
      vi.useRealTimers();
    }
  });

  it("starts no poll while a closed panel waits out its reopen grace", async () => {
    const h = await makeHarness({ closeGraceMs: 300 });
    h.service.setActive(false);
    await new Promise((resolve) => setTimeout(resolve, 350));
    vi.useFakeTimers();
    try {
      h.runs.push(run("a"));
      h.screens.set("a", "screen");
      h.service.setActive(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(h.classify).toHaveBeenCalledTimes(1);

      h.screens.set("a", "moved");
      // Closed just before the tick: the grace is running when it comes.
      await vi.advanceTimersByTimeAsync(CANOPY_POLL_MS - 100);
      h.service.setActive(false);
      await vi.advanceTimersByTimeAsync(200);
      expect(h.classify).toHaveBeenCalledTimes(1);
    } finally {
      h.service.dispose();
      vi.useRealTimers();
    }
  });

  it("never re-sends a waiting run's unchanged screen, however long it waits", async () => {
    let now = 1_000_000;
    const h = await makeHarness({ now: () => now });
    h.runs.push(run("a", { agentState: "waiting" }));
    h.screens.set("a", "Which colour do you want?");
    await h.service.scan();
    now += 30 * 60_000;
    await h.service.refresh();
    expect(h.classify).toHaveBeenCalledTimes(1);
  });

  it("keeps the scan an open started when the panel bounces closed and open again", async () => {
    const h = await makeHarness({ closeGraceMs: 300 });
    h.service.setActive(false);
    await new Promise((resolve) => setTimeout(resolve, 350));
    h.runs.push(run("a"));
    h.screens.set("a", "screen");
    h.service.setActive(true);
    // React's development replay: close and reopen inside one tick.
    h.service.setActive(false);
    h.service.setActive(true);
    await settle();
    await settle();
    expect(h.classify).toHaveBeenCalledTimes(1);
    expect(h.service.getSnapshot().active).toBe(true);
  });

  it("keeps an answered run out of the queue until the agent has worked and stopped again", async () => {
    let now = 1_000_000;
    let attention = 0.9;
    const h = await makeHarness({
      now: () => now,
      classify: async () => ({
        category: attention >= 0.5 ? "question" : "working",
        confidence: 0.9,
        attention,
        question: null,
      }),
    });
    h.runs.push(run("a"));
    h.screens.set("a", "Which colour?");
    await h.service.scan();
    const spawnedAt = h.service.getSnapshot().cards[0]!.spawnedAt;
    h.service.markHandled("a", spawnedAt);
    expect(h.service.getSnapshot().cards[0]).toMatchObject({ priority: 0 });
    expect(h.service.getSnapshot().dispositions).toEqual([
      { runId: "a", spawnedAt, kind: "replied", at: now },
    ]);

    // The same screen judged again later stays answered.
    now += 200_000;
    await h.service.refresh();
    expect(h.service.getSnapshot().cards[0]!.priority).toBe(0);

    // The reply echoed beneath the question it answered: still answered, and
    // the question it answered is not described again.
    h.screens.set("a", "Which colour?\n> blue\n\n✻ Thinking…");
    await h.service.refresh();
    expect(h.service.getSnapshot().cards[0]!.handledAt).not.toBeNull();
    expect(h.service.getSnapshot().cards[0]!.priority).toBe(0);
    expect(h.classify.mock.lastCall![0].userAction).toMatchObject({
      kind: "replied",
      screenChangedSince: true,
    });
    expect(h.describe).toHaveBeenCalledTimes(1);

    // The agent works on it: the work is described like any other, and the
    // run stays answered.
    attention = 0.1;
    h.describe.mockImplementationOnce(async (_input, says) => ({
      category: says,
      headline: "Painting it blue",
      summary: "Repainting the header in the blue the user chose.",
      attentionScore: 20,
      task: null,
      risk: "unknown",
      riskReason: null,
      action: null,
      progress: null,
      tests: "unknown",
      changes: "unknown",
      question: null,
      options: [],
    }));
    h.screens.set("a", "Painting it blue");
    await h.service.refresh();
    expect(h.describe).toHaveBeenCalledTimes(2);
    expect(h.service.getSnapshot().cards[0]).toMatchObject({
      headline: "Painting it blue",
      summary: "Repainting the header in the blue the user chose.",
      wordsCategory: "working",
      priority: 0,
    });
    expect(h.service.getSnapshot().dispositions).toMatchObject([{ kind: "replied" }]);

    // Then stops on something new: back in the queue, scored afresh.
    attention = 0.9;
    h.screens.set("a", "Done. Which shade?");
    await h.service.refresh();
    expect(h.service.getSnapshot().cards[0]!.handledAt).toBeNull();
    expect(h.service.getSnapshot().cards[0]!.priority).toBeGreaterThan(0);
    expect(h.service.getSnapshot().dispositions).toEqual([]);
  });

  it("keeps an archived run archived until the agent has something new to say", async () => {
    const h = await makeHarness({
      classify: async (input) =>
        input.screen.includes("Working")
          ? { category: "working", confidence: 0.9, attention: 0.1, question: null }
          : { category: "finished", confidence: 0.9, attention: 0.9, question: null },
    });
    h.runs.push(run("a", { agentState: "completed" }));
    h.screens.set("a", "All done.");
    await h.service.scan();
    expect(h.describe).toHaveBeenCalledTimes(1);
    h.service.archive("a", 1);
    expect(h.service.getSnapshot().dispositions).toMatchObject([{ runId: "a", kind: "archived" }]);

    // Nothing new: still archived, and no describer call is spent on it.
    await h.service.refresh();
    h.screens.set("a", "All done.\n");
    await h.service.refresh();
    expect(h.service.getSnapshot().dispositions).toMatchObject([{ kind: "archived" }]);

    // Busy: the screen moves, but progress is not something new for the user.
    h.runs[0] = run("a", { agentState: "working" });
    h.screens.set("a", "Working on the next step");
    await h.service.refresh();
    expect(h.service.getSnapshot().dispositions).toMatchObject([{ kind: "archived" }]);
    expect(h.describe).toHaveBeenCalledTimes(1);

    // It stopped again on a new screen: back in the inbox, described afresh.
    h.runs[0] = run("a", { agentState: "completed" });
    h.screens.set("a", "Finished the next step.");
    await h.service.refresh();
    expect(h.service.getSnapshot().dispositions).toEqual([]);
    expect(h.describe).toHaveBeenCalledTimes(2);
  });

  it("moves an archived run back to the inbox by hand, and ignores another incarnation", async () => {
    const h = await makeHarness({});
    h.runs.push(run("a"));
    h.screens.set("a", "Hello");
    await h.service.scan();
    h.service.archive("a", 2);
    expect(h.service.getSnapshot().dispositions).toEqual([]);
    h.service.archive("a", 1);
    h.service.unarchive("a", 2);
    expect(h.service.getSnapshot().dispositions).toHaveLength(1);
    h.service.unarchive("a", 1);
    expect(h.service.getSnapshot().dispositions).toEqual([]);
  });

  it("counts work the fleet saw between polls as the agent saying something new", async () => {
    const h = await makeHarness({
      classify: async () => ({
        category: "finished",
        confidence: 0.9,
        attention: 0.9,
        question: null,
      }),
    });
    h.runs.push(run("a", { agentState: "completed" }));
    h.screens.set("a", "Done.");
    await h.service.scan();
    h.service.archive("a", 1);
    // It ran and stopped again between two scans; only the fleet saw it busy.
    h.runs[0] = run("a", { agentState: "working" });
    h.service.onFleetChanged();
    h.runs[0] = run("a", { agentState: "completed" });
    h.screens.set("a", "Done with the next part.");
    await h.service.refresh();
    expect(h.service.getSnapshot().dispositions).toEqual([]);
  });

  it("keeps a run archived before its screen was ever read, taking the first read as its baseline", async () => {
    const h = await makeHarness({
      classify: async () => ({
        category: "approval",
        confidence: 0.9,
        attention: 0.9,
        question: "Proceed?",
      }),
    });
    h.runs.push(run("a", { agentState: "waiting" }));
    h.screens.set("a", APPROVAL_SCREEN);
    h.service.archive("a", 1);
    await h.service.refresh();
    expect(h.service.getSnapshot().dispositions).toMatchObject([{ kind: "archived" }]);
  });

  it("brings back an unchanged, described run without reading it again", async () => {
    const h = await makeHarness({
      classify: async () => ({
        category: "finished",
        confidence: 0.9,
        attention: 0.9,
        question: null,
      }),
    });
    h.runs.push(run("a", { agentState: "completed" }));
    h.screens.set("a", "Done.");
    await h.service.scan();
    h.service.archive("a", 1);
    h.service.unarchive("a", 1);
    await settle();
    expect(h.classify).toHaveBeenCalledTimes(1);
    expect(h.describe).toHaveBeenCalledTimes(1);
  });

  it("reads a screen again once back in scope when its read was dropped by a scope change", async () => {
    const finished: Reading = {
      category: "finished",
      confidence: 0.9,
      attention: 0.9,
      question: null,
    };
    let release: () => void = () => {};
    let held = false;
    const h = await makeHarness({
      classify: (input) => {
        // The first read of B is still with the provider when the scope changes.
        if (input.screen !== "B" || held) return Promise.resolve(finished);
        held = true;
        return new Promise((resolve) => {
          release = () => resolve(finished);
        });
      },
    });
    h.runs.push(run("a", { workspaceId: "one" }), run("b", { workspaceId: "two" }));
    h.screens.set("a", "A");
    h.screens.set("b", "B");
    const scan = h.service.refresh();
    await settle();
    h.service.setScope("one");
    release();
    await scan;
    expect(h.service.getSnapshot().cards.map((card) => card.runId)).toEqual(["a"]);
    h.service.setScope(null);
    await h.service.refresh();
    await settle();
    expect(
      h.service
        .getSnapshot()
        .cards.map((card) => card.runId)
        .sort()
    ).toEqual(["a", "b"]);
  });

  it("reads only the screens in scope", async () => {
    const h = await makeHarness({});
    h.runs.push(run("a", { workspaceId: "one" }), run("b", { workspaceId: "two" }));
    h.screens.set("a", "A");
    h.screens.set("b", "B");
    h.service.setScope("one");
    await h.service.refresh();
    expect(h.classify.mock.calls.map(([input]) => input.screen)).toEqual(["A"]);
    expect(h.service.getSnapshot().scope).toBe("one");
  });

  it("drops a moved screen's prompt at once, and marks its words old when no reading follows", async () => {
    let fail = false;
    const h = await makeHarness({
      classify: async () => {
        if (fail) throw new Error("down");
        return { category: "approval", confidence: 0.9, attention: 0.9, question: "Proceed?" };
      },
    });
    h.runs.push(run("a"));
    h.screens.set("a", APPROVAL_SCREEN);
    await h.service.scan();
    expect(h.service.getSnapshot().cards[0]!.stage).toBe("described");

    fail = true;
    h.screens.set("a", `${APPROVAL_SCREEN}\n(moved)`);
    await h.service.refresh();
    const card = h.service.getSnapshot().cards[0]!;
    expect(card.question).toBeNull();
    expect(card.options).toEqual([]);
    // No reading of the new screen came: the words say they are from before,
    // and the priority stands rather than blanking.
    expect(card.wordsFromEarlierRead).toBe(true);
    expect(card.priorityFromEarlierRead).toBe(false);
  });

  it("closes at once for a view that went away, with no reopen grace", async () => {
    const h = await makeHarness({ closeGraceMs: 300 });
    h.service.setActive(false, true);
    expect(h.service.getSnapshot().active).toBe(false);
  });

  it("judges an unchanged screen again once it has sat long enough to look stuck", async () => {
    let now = 1_000_000;
    const h = await makeHarness({ now: () => now });
    h.runs.push(run("a", { agentState: "working" }));
    h.screens.set("a", "✻ Running tests… (esc to interrupt)");
    await h.service.scan();
    const first = h.service.getSnapshot().cards[0]!;

    now += CANOPY_REJUDGE_AFTER_MS - 1_000;
    await h.service.refresh();
    expect(h.classify).toHaveBeenCalledTimes(1);

    now += 2_000;
    await h.service.refresh();
    expect(h.classify).toHaveBeenCalledTimes(2);
    // Still the same prompt, first read when it was: nothing reads as new or unread.
    const again = h.service.getSnapshot().cards[0]!;
    expect(again.revision).toBe(first.revision);
    expect(again.observedAt).toBe(first.observedAt);
  });

  it("drops a card's old words when the describer is not asked for new ones", async () => {
    let attention = 0.9;
    const h = await makeHarness({
      classify: async () => ({ category: "approval", confidence: 0.9, attention, question: null }),
    });
    h.runs.push(run("a"));
    h.screens.set("a", APPROVAL_SCREEN);
    await h.service.scan();
    expect(h.service.getSnapshot().cards[0]!.headline).toBe("Headline");

    attention = 0.3;
    h.screens.set("a", `${APPROVAL_SCREEN}\n(a different menu)`);
    await h.service.refresh();
    const card = h.service.getSnapshot().cards[0]!;
    expect(card.headline).toBeNull();
    expect(card.summary).toBeNull();
    expect(h.describe).toHaveBeenCalledTimes(1);
  });

  it("drops a quote or option the describer made up", async () => {
    const h = await makeHarness({
      classify: async () => ({
        category: "approval",
        confidence: 0.9,
        attention: 0.9,
        question: "Do you want to proceed?",
      }),
      describe: async () => ({
        category: "approval",
        headline: "Run the tests?",
        summary: "",
        attentionScore: 95,
        task: null,
        risk: "unknown",
        riskReason: null,
        action: null,
        progress: null,
        tests: "unknown" as const,
        changes: "unknown" as const,
        question: "Shall I deploy to production?",
        options: ["Yes", "Deploy everything"],
      }),
    });
    h.runs.push(run("a"));
    h.screens.set("a", APPROVAL_SCREEN);
    await h.service.scan();
    const card = h.service.getSnapshot().cards[0]!;
    expect(card.question).toBe("Do you want to proceed?");
    expect(card.options).toEqual(["Yes"]);
  });

  it("orders options the way the screen draws them, whatever order they were described in", async () => {
    const h = await makeHarness({
      classify: async () => ({
        category: "approval",
        confidence: 0.9,
        attention: 0.9,
        question: null,
      }),
      describe: async () => ({
        category: "approval",
        headline: "Trust this folder?",
        summary: "",
        attentionScore: 95,
        task: null,
        risk: "unknown",
        riskReason: null,
        action: null,
        progress: null,
        tests: "unknown" as const,
        changes: "unknown" as const,
        question: null,
        options: ["No, exit", "Yes, I trust this folder"],
      }),
    });
    h.runs.push(run("a"));
    h.screens.set(
      "a",
      "Is this a project you trust?\n❯ 1. Yes, I trust this folder\n  2. No, exit"
    );
    await h.service.scan();
    expect(h.service.getSnapshot().cards[0]!.options).toEqual([
      "Yes, I trust this folder",
      "No, exit",
    ]);
  });

  it("places an option by its own row, not by the same words higher up", async () => {
    const h = await makeHarness({
      classify: async () => ({
        category: "approval",
        confidence: 0.9,
        attention: 0.9,
        question: null,
      }),
      describe: async () => ({
        category: "approval",
        headline: "Approve running npm test",
        summary: "",
        attentionScore: 92,
        task: null,
        risk: "none",
        riskReason: null,
        action: null,
        progress: null,
        tests: "unknown" as const,
        changes: "unknown" as const,
        question: null,
        // Described out of order: "Yes" must still be placed by its own row.
        options: ["Yes, and don't ask again for npm test", "No", "Yes"],
      }),
    });
    h.runs.push(run("a"));
    h.screens.set(
      "a",
      [
        "No files changed.",
        "Do you want to proceed?",
        "❯ 1. Yes",
        "  2. Yes, and don't ask again for npm test",
        "  3. No",
      ].join("\n")
    );
    await h.service.scan();
    expect(h.service.getSnapshot().cards[0]!.options).toEqual([
      "Yes",
      "Yes, and don't ask again for npm test",
      "No",
    ]);
  });

  it("marks a password prompt as secret", async () => {
    const h = await makeHarness({
      classify: async () => ({
        category: "question",
        confidence: 0.9,
        attention: 0.9,
        question: "Password:",
      }),
      describe: async () => ({
        category: "question",
        headline: "sudo wants your password",
        summary: "",
        attentionScore: 95,
        task: null,
        risk: "unknown",
        riskReason: null,
        action: null,
        progress: null,
        tests: "unknown" as const,
        changes: "unknown" as const,
        question: "Password:",
        options: [],
      }),
    });
    h.runs.push(run("a"));
    h.screens.set("a", "$ sudo ./install.sh\nPassword:");
    await h.service.scan();
    expect(h.service.getSnapshot().cards[0]!.secretPrompt).toBe(true);
  });

  it("lets nothing from a pass land once the last panel closes", async () => {
    let release!: () => void;
    const h = await makeHarness({
      classify: async () => {
        await new Promise<void>((resolve) => (release = resolve));
        return { category: "approval", confidence: 0.9, attention: 0.9, question: null };
      },
    });
    h.runs.push(run("a"));
    h.screens.set("a", APPROVAL_SCREEN);
    const scan = h.service.scan();
    await vi.waitFor(() => expect(h.classify).toHaveBeenCalledTimes(1));

    h.service.setActive(false);
    release();
    await scan;
    expect(h.describe).not.toHaveBeenCalled();
    expect(h.service.getSnapshot().cards).toEqual([]);
    expect(h.service.getSnapshot().lastError).toBeNull();
  });

  it("abandons a pass started before Canopy was turned off, and reads the screen again once it's back on", async () => {
    let release!: () => void;
    let calls = 0;
    const h = await makeHarness({
      classify: async () => {
        calls++;
        if (calls === 1) {
          // The abandoned pass would read an ask; the fresh one reads work.
          await new Promise<void>((resolve) => (release = resolve));
          return { category: "question", confidence: 0.9, attention: 0.9, question: "Go?" };
        }
        return { category: "working", confidence: 0.9, attention: 0.9, question: null };
      },
    });
    h.runs.push(run("a"));
    h.screens.set("a", "✻ Working (esc to interrupt)");
    const scan = h.service.scan();
    await vi.waitFor(() => expect(calls).toBe(1));

    h.service.setPlan({ activated: false, tier: "priority" });
    h.service.setPlan({ activated: true, tier: "priority" });
    release();
    await scan;
    await settle();
    await h.service.refresh();
    expect(calls).toBe(2);
    // Nothing the abandoned pass read lands, or goes on to the describer.
    expect(h.service.getSnapshot().cards.map((card) => card.category)).toEqual(["working"]);
    expect(h.describe.mock.calls.some(([, says]) => says === "question")).toBe(false);
  });

  it("sends nothing while no panel is open", async () => {
    const h = await makeHarness({});
    h.service.setActive(false);
    h.runs.push(run("a"));
    h.screens.set("a", "screen");
    await h.service.scan();
    await h.service.refresh();
    expect(h.classify).not.toHaveBeenCalled();
  });

  it("skips a run that left while its screen was being read", async () => {
    let releaseRead!: () => void;
    const h = await makeHarness({});
    h.runs.push(run("a"));
    const deps = (h.service as unknown as { deps: { readScreen: unknown } }).deps;
    deps.readScreen = async () => {
      await new Promise<void>((resolve) => (releaseRead = resolve));
      return "screen";
    };
    const scan = h.service.scan();
    await vi.waitFor(() => expect(releaseRead).toBeTypeOf("function"));
    h.runs.splice(0, 1);
    releaseRead();
    await scan;
    expect(h.classify).not.toHaveBeenCalled();
    expect(h.service.getSnapshot().cards).toEqual([]);
  });

  it("treats a respawn under the same id as a new terminal", async () => {
    const h = await makeHarness({});
    h.runs.push(run("a", { spawnedAt: 1 }));
    h.screens.set("a", "same screen");
    await h.service.scan();
    h.runs[0] = run("a", { spawnedAt: 2 });
    await h.service.scan();
    expect(h.classify).toHaveBeenCalledTimes(2);
  });

  describe("holding still", () => {
    const working = async (): Promise<Reading> => ({
      category: "working",
      confidence: 0.9,
      attention: 0.1,
      question: null,
    });

    it("reads a busy run's changing screen at most every rereadMs, unless its state changes or Refresh is pressed", async () => {
      let clock = 1_000_000;
      const h = await makeHarness({ now: () => clock, rereadMs: 10_000, classify: working });
      const busy = (...rows: string[]) =>
        [...rows, "", "✻ Reading… (3s · esc to interrupt)"].join("\n");
      h.runs.push(run("a", { agentState: "working" }));
      h.screens.set("a", busy("• Read src/a.ts"));
      await h.service.scan();
      expect(h.classify).toHaveBeenCalledTimes(1);

      h.screens.set("a", busy("• Read src/a.ts", "• Read src/b.ts"));
      clock += 3_000;
      await h.service.scan();
      expect(h.classify).toHaveBeenCalledTimes(1);
      clock += 7_000;
      await h.service.scan();
      expect(h.classify).toHaveBeenCalledTimes(2);

      // Stopping to ask is read at once, before Daintree's own state follows.
      h.screens.set("a", "• Read src/c.ts\n\nDo you want to proceed?\n❯ 1. Yes\n  2. No");
      clock += 1_000;
      await h.service.scan();
      expect(h.classify).toHaveBeenCalledTimes(3);

      // Daintree sees it waiting, then working again: the change of state is read at once.
      h.runs[0] = run("a", { agentState: "waiting", waitingReason: "approval" });
      h.screens.set("a", busy("• Read src/d.ts"));
      clock += 1_000;
      await h.service.scan();
      expect(h.classify).toHaveBeenCalledTimes(4);

      // Back at work and moving fast: Refresh reads it anyway.
      h.runs[0] = run("a", { agentState: "working" });
      clock += 1_000;
      await h.service.scan();
      h.screens.set("a", busy("• Read src/e.ts"));
      clock += 1_000;
      await h.service.refresh();
      expect(h.classify).toHaveBeenCalledTimes(6);
    });

    it("reads a waiting run's screen at once whenever it moves", async () => {
      let clock = 1_000_000;
      const h = await makeHarness({
        now: () => clock,
        rereadMs: 10_000,
        classify: async () => ({
          category: "approval",
          confidence: 0.9,
          attention: 0.95,
          question: "Do you want to proceed?",
        }),
      });
      h.runs.push(run("a", { agentState: "waiting", waitingReason: "approval" }));
      h.screens.set("a", APPROVAL_SCREEN);
      await h.service.refresh();
      h.screens.set("a", APPROVAL_SCREEN.replace("npm test", "rm -rf build"));
      clock += 1_000;
      await h.service.scan();
      expect(h.classify).toHaveBeenCalledTimes(2);
    });

    it("reads nothing while the user types a reply into the agent's input box", async () => {
      const h = await makeHarness({});
      h.runs.push(run("a", { agentState: "waiting", waitingReason: "prompt" }));
      const box = (draft: string) =>
        [
          "⏺ Done.",
          "",
          "✻ Worked for 9s · done",
          "",
          "─".repeat(30),
          `❯ ${draft}`,
          "─".repeat(30),
        ].join("\n");
      h.screens.set("a", box(""));
      await h.service.refresh();
      for (const draft of ["f", "fix", "fix the", "fix the tests"]) {
        h.screens.set("a", box(draft));
        await h.service.scan();
      }
      expect(h.classify).toHaveBeenCalledTimes(1);
      expect(h.classify.mock.calls[0]![0].screen).not.toContain("fix");
    });

    it("keeps the prompt the same, read and all, when Daintree's state only catches up with it", async () => {
      let clock = 1_000_000;
      const h = await makeHarness({
        now: () => clock,
        classify: async () => ({
          category: "approval",
          confidence: 0.95,
          attention: 0.95,
          question: "Do you want to proceed?",
        }),
      });
      // The screen shows the dialog before Daintree sees the agent waiting.
      h.runs.push(run("a", { agentState: "working" }));
      h.screens.set("a", APPROVAL_SCREEN);
      await h.service.refresh();
      const first = h.service.getSnapshot().cards[0]!;
      expect(h.describe).toHaveBeenCalledTimes(1);

      clock += 8_000;
      h.runs[0] = run("a", { agentState: "waiting", waitingReason: "approval", since: clock });
      await h.service.refresh();
      const caught = h.service.getSnapshot().cards[0]!;
      expect(caught).toMatchObject({
        revision: first.revision,
        observedAt: first.observedAt,
        headline: first.headline,
      });
      expect(caught.observedWhenRead).toEqual(first.observedWhenRead);
    });

    it("keeps an approval's choices when Daintree names its wait differently on the same screen", async () => {
      const h = await makeHarness({
        classify: async () => ({
          category: "approval",
          confidence: 0.95,
          attention: 0.95,
          question: "Do you want to proceed?",
        }),
        describe: async (_input, says) => ({
          category: says,
          headline: "Approve running npm test",
          summary: "Runs the suite.",
          attentionScore: 94,
          task: null,
          risk: "none",
          riskReason: null,
          action: null,
          progress: null,
          tests: "unknown",
          changes: "unknown",
          question: "Do you want to proceed?",
          options: ["Yes", "No"],
        }),
      });
      h.runs.push(run("a", { agentState: "waiting", waitingReason: "approval" }));
      h.screens.set("a", "Do you want to proceed?\n❯ 1. Yes\n  2. No");
      await h.service.refresh();
      expect(h.service.getSnapshot().cards[0]!.options).toEqual(["Yes", "No"]);
      h.runs[0] = run("a", { agentState: "waiting", waitingReason: "prompt" });
      await h.service.refresh();
      expect(h.service.getSnapshot().cards[0]!.options).toEqual(["Yes", "No"]);
    });

    it("marks words old when the reading of the screen they were written for fails", async () => {
      let fail = false;
      const h = await makeHarness({
        classify: async () => ({
          category: "finished",
          confidence: 0.9,
          attention: 0.9,
          question: null,
        }),
        describe: async (_input, says) => {
          if (fail) throw new CanopyProviderError("describer", "HTTP 500");
          return {
            category: says,
            headline: "Review the fix",
            summary: "All tests pass.",
            attentionScore: 40,
            task: null,
            risk: "unknown",
            riskReason: null,
            action: null,
            progress: 100,
            tests: "passing",
            changes: "committed",
            question: null,
            options: [],
          };
        },
      });
      h.runs.push(run("a", { agentState: "waiting" }));
      h.screens.set("a", "⏺ All tests pass.\n\n✻ Worked for 9s · done");
      await h.service.refresh();
      fail = true;
      h.screens.set("a", "⏺ 2 tests fail.\n\n✻ Worked for 9s · done");
      await h.service.refresh();
      expect(h.service.getSnapshot().cards[0]!.wordsFromEarlierRead).toBe(true);
    });

    it("writes a busy run's progress again once the screen its words were for has moved on", async () => {
      let clock = 1_000_000;
      let headline = "Reading the units module";
      const h = await makeHarness({
        now: () => clock,
        classify: working,
        describe: async (_input, says) => ({
          category: says,
          headline,
          summary: "Summary",
          attentionScore: 5,
          task: null,
          risk: "unknown",
          riskReason: null,
          action: null,
          progress: null,
          tests: "unknown",
          changes: "unknown",
          question: null,
          options: [],
        }),
      });
      const busy = (row: string) => `${row}\n\n✻ Working… (3s · esc to interrupt)`;
      h.runs.push(run("a", { agentState: "working" }));
      h.screens.set("a", busy("• Read src/units.ts"));
      await h.service.refresh();
      // A new screen within the progress window keeps the old words.
      headline = "Running the tests";
      clock += 5_000;
      h.screens.set("a", busy("• Ran npm test"));
      await h.service.refresh();
      expect(h.describe).toHaveBeenCalledTimes(1);
      // That screen then holds still: judged again, its words are written for it.
      clock += CANOPY_REJUDGE_AFTER_MS;
      await h.service.refresh();
      expect(h.service.getSnapshot().cards[0]!.headline).toBe("Running the tests");
    });

    it("treats a stop Daintree sees long after the reading as a new episode", async () => {
      let clock = 1_000_000;
      const h = await makeHarness({
        now: () => clock,
        classify: async () => ({
          category: "approval",
          confidence: 0.95,
          attention: 0.95,
          question: "Do you want to proceed?",
        }),
      });
      h.runs.push(run("a", { agentState: "working" }));
      h.screens.set("a", APPROVAL_SCREEN);
      await h.service.refresh();
      const first = h.service.getSnapshot().cards[0]!;
      clock += 60_000;
      h.runs[0] = run("a", { agentState: "waiting", waitingReason: "approval", since: clock });
      await h.service.refresh();
      expect(h.service.getSnapshot().cards[0]!.revision).not.toBe(first.revision);
    });

    it("writes an unchanged screen again only when its verdict changes, and keeps what it then says", async () => {
      let clock = 1_000_000;
      let summary = "First wording.";
      let attention = 0.1;
      const h = await makeHarness({
        now: () => clock,
        classify: async () => ({ category: "working", confidence: 0.9, attention, question: null }),
        describe: async (_input, says) => ({
          category: says,
          headline: "Planning the pantry module",
          summary,
          attentionScore: 5,
          task: null,
          risk: "unknown",
          riskReason: null,
          action: null,
          progress: null,
          tests: "unknown",
          changes: "unknown",
          question: null,
          options: [],
        }),
      });
      h.runs.push(run("a", { agentState: "working" }));
      h.screens.set("a", "⏺ Planning the pantry module\n\n✻ Pondering… (3s · esc to interrupt)");
      await h.service.refresh();
      // Judged again on the same screen, now as stuck: a new verdict, so the
      // describer writes it again.
      summary = "Second wording of the same thing.";
      attention = 0.85;
      clock += CANOPY_REJUDGE_AFTER_MS;
      await h.service.refresh();
      expect(h.describe).toHaveBeenCalledTimes(2);
      // Stuck is news: its own words stand.
      expect(h.service.getSnapshot().cards[0]!.summary).toBe("Second wording of the same thing.");
      // Judged again, still stuck on the same screen: nothing new to write.
      clock += CANOPY_REJUDGE_AFTER_MS;
      await h.service.refresh();
      expect(h.describe).toHaveBeenCalledTimes(2);
    });
  });

  it("never sends a credential that appears on screen or in a title", async () => {
    const h = await makeHarness({});
    h.runs.push(run("a", { lastObservedTitle: "debug token=abcdef123456" }));
    h.screens.set("a", "export OPENAI_API_KEY=abcdefgh12345");
    await h.service.scan();
    const input = h.classify.mock.calls[0]![0];
    expect(input.screen).not.toContain("abcdefgh12345");
    expect(input.title).not.toContain("abcdef123456");
  });

  it("forgets runs that leave the fleet", async () => {
    const h = await makeHarness({});
    h.runs.push(run("a"), run("b"));
    h.screens.set("a", "one");
    h.screens.set("b", "two");
    await h.service.scan();
    h.runs.splice(1, 1);
    h.service.onFleetChanged();
    expect(h.service.getSnapshot().cards.map((card) => card.runId)).toEqual(["a"]);
  });

  it("finishes a scan without waiting for the cards it set going", async () => {
    const card = gatedDescribe();
    const h = await makeHarness({
      classify: async () => ({
        category: "approval",
        confidence: 0.95,
        attention: 0.95,
        question: "Allow?",
      }),
      describe: card.describe,
    });
    h.runs.push(run("a"), run("b"));
    h.screens.set("a", APPROVAL_SCREEN);
    await h.service.scan();
    expect(h.describe).toHaveBeenCalledTimes(1);
    // The card for "a" is still being written; "b" is read regardless.
    h.screens.set("b", APPROVAL_SCREEN);
    await h.service.scan();
    expect(h.classify).toHaveBeenCalledTimes(2);
    card.release();
    await h.service.refresh();
    expect(h.service.getSnapshot().cards.every((card) => card.stage === "described")).toBe(true);
  });

  function gatedDescribe() {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const describe: DescribeFn = async (_input, says) => {
      await gate;
      return {
        category: says,
        headline: "Headline",
        summary: "Summary",
        attentionScore: 95,
        task: null,
        risk: "unknown",
        riskReason: null,
        action: null,
        progress: null,
        tests: "unknown",
        changes: "unknown",
        question: null,
        options: [],
      };
    };
    return { describe, release: () => release() };
  }

  it("lets no card land for a screen that has since gone blank", async () => {
    const card = gatedDescribe();
    const h = await makeHarness({
      classify: async () => ({
        category: "approval",
        confidence: 0.95,
        attention: 0.95,
        question: "Allow?",
      }),
      describe: card.describe,
    });
    h.runs.push(run("a"));
    h.screens.set("a", APPROVAL_SCREEN);
    await h.service.scan();
    expect(h.describe).toHaveBeenCalledTimes(1);
    h.screens.set("a", "");
    await h.service.scan();
    card.release();
    await h.service.refresh();
    expect(h.service.getSnapshot().cards[0]!.headline).toBeNull();
  });

  it("lets a working agent's progress card finish while its screen moves on", async () => {
    const card = gatedDescribe();
    const h = await makeHarness({
      classify: async () => ({
        category: "working",
        confidence: 0.95,
        attention: 0.1,
        question: null,
      }),
      describe: card.describe,
    });
    h.runs.push(run("a", { agentState: "working" }));
    h.screens.set("a", "• Editing store.ts (esc to interrupt)");
    await h.service.scan();
    expect(h.describe).toHaveBeenCalledTimes(1);
    h.screens.set("a", "• Editing view.ts (esc to interrupt)");
    await h.service.scan();
    // The new screen waits for the card rather than cancelling it.
    expect(h.classify).toHaveBeenCalledTimes(1);
    card.release();
    await h.service.refresh();
    expect(h.service.getSnapshot().cards[0]!.headline).toBe("Headline");
  });

  it("reads an unchanged prompt read again as the same prompt: same revision, still read", async () => {
    let clock = 1_000_000;
    let describes = 0;
    const h = await makeHarness({
      now: () => clock,
      classify: async () => ({
        category: "approval",
        confidence: 0.95,
        attention: 0.95,
        question: "Do you want to proceed?",
      }),
      describe: async (_input, says) => {
        describes++;
        if (describes === 1) throw new CanopyProviderError("describer", "HTTP 503", true);
        return {
          category: says,
          headline: "Approve it",
          summary: "Summary",
          attentionScore: 94,
          task: null,
          risk: "none",
          riskReason: null,
          action: null,
          progress: null,
          tests: "unknown",
          changes: "unknown",
          question: null,
          options: [],
        };
      },
    });
    h.runs.push(run("a", { agentState: "waiting", waitingReason: "approval" }));
    h.screens.set("a", APPROVAL_SCREEN);
    await h.service.refresh();
    const first = h.service.getSnapshot().cards[0]!;

    // A failed read sends main back to the same screen; the prompt the user
    // saw must not come back as a new, unread one.
    clock += CANOPY_FAILURE_BACKOFF_MAX_MS;
    await h.service.refresh();
    expect(h.classify).toHaveBeenCalledTimes(2);
    expect(h.service.getSnapshot().cards[0]).toMatchObject({
      revision: first.revision,
      observedAt: first.observedAt,
      headline: "Approve it",
    });

    // A screen that really moved is a new reading.
    h.screens.set("a", "• Running npm test (esc to interrupt)");
    await h.service.refresh();
    expect(h.service.getSnapshot().cards[0]!.revision).not.toBe(first.revision);
  });

  it("keeps the classifier's status line while the screen still shows it, and no longer", async () => {
    let fail = false;
    const h = await makeHarness({
      classify: async () => {
        if (fail) throw new CanopyProviderError("classifier", "HTTP 503", true);
        return {
          category: "approval",
          confidence: 0.95,
          attention: 0.95,
          question: "Do you want to proceed?",
          status: "Do you want to proceed?",
        };
      },
    });
    h.runs.push(run("a", { agentState: "waiting", waitingReason: "approval" }));
    h.screens.set("a", APPROVAL_SCREEN);
    await h.service.scan();
    expect(h.service.getSnapshot().cards[0]!.statusLine).toBe("Do you want to proceed?");

    // The screen moved but still asks: the line stays while the read fails.
    fail = true;
    h.screens.set("a", `${APPROVAL_SCREEN}\n`);
    await h.service.scan();
    expect(h.service.getSnapshot().cards[0]!.statusLine).toBe("Do you want to proceed?");

    // Answered: the line went with the prompt, whatever the classifier manages.
    h.screens.set("a", "• Running npm test (esc to interrupt)");
    await h.service.scan();
    expect(h.service.getSnapshot().cards[0]!.statusLine).toBeNull();
  });

  it("reads a screen again whose reading landed while the fleet was unknown", async () => {
    let known = true;
    let release!: () => void;
    let gate = new Promise<void>((resolve) => (release = resolve));
    const h = await makeHarness({
      fleetKnown: () => known,
      classify: async () => {
        await gate;
        return { category: "working", confidence: 0.9, attention: 0.1, question: null };
      },
    });
    h.runs.push(run("a"));
    h.screens.set("a", "screen");
    const first = h.service.scan();
    await vi.waitFor(() => expect(h.classify).toHaveBeenCalledTimes(1));
    known = false;
    release();
    await first;
    expect(h.service.getSnapshot().cards).toEqual([]);

    // The same screen, once the fleet is known again: read, not trusted as read.
    known = true;
    gate = Promise.resolve();
    await h.service.scan();
    expect(h.classify).toHaveBeenCalledTimes(2);
    expect(h.service.getSnapshot().cards).toHaveLength(1);
  });

  it("sends no snapshot for a poll that read nothing new", async () => {
    const h = await makeHarness({});
    h.runs.push(run("a"));
    h.screens.set("a", "screen");
    await h.service.refresh();
    await vi.waitFor(() => expect(h.snapshots.at(-1)?.cards).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 60));
    const sent = h.snapshots.length;
    await h.service.refresh();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(h.snapshots).toHaveLength(sent);
  });

  it("records a provider failure without screen text, and retries that screen after a backoff", async () => {
    let clock = 1_000_000;
    let fail = true;
    const h = await makeHarness({
      now: () => clock,
      classify: async () => {
        if (fail) throw new Error("secret screen text must not leak");
        return { category: "working", confidence: 0.9, attention: 0.9, question: null };
      },
    });
    h.runs.push(run("a"));
    h.screens.set("a", "screen");
    await h.service.scan();
    expect(h.service.getSnapshot().lastError).toBe("Canopy request failed");

    // A failing service is not asked again on the very next poll.
    fail = false;
    await h.service.scan();
    expect(h.classify).toHaveBeenCalledTimes(1);
    clock += CANOPY_FAILURE_BACKOFF_MAX_MS;
    await h.service.scan();
    expect(h.classify).toHaveBeenCalledTimes(2);
    expect(h.service.getSnapshot().lastError).toBeNull();
  });

  it("reports a describer that keeps failing, however well the classifier does", async () => {
    let clock = 1_000_000;
    const h = await makeHarness({
      now: () => clock,
      classify: async () => ({
        category: "approval",
        confidence: 0.95,
        attention: 0.95,
        question: "Do you want to proceed?",
      }),
      describe: async () => {
        throw new CanopyProviderError("describer", "request timed out", true);
      },
    });
    h.runs.push(run("a", { agentState: "waiting", waitingReason: "approval" }));
    h.screens.set("a", APPROVAL_SCREEN);
    await h.service.scan();
    expect(h.service.getSnapshot().lastError).toBeNull();
    clock += CANOPY_TRANSIENT_GRACE_MS;
    await h.service.scan();
    expect(h.service.getSnapshot().lastError).toBe("Describer: request timed out");
  });

  it("keeps a notable busy agent in the notable band after its card is written", async () => {
    const h = await makeHarness({
      classify: async (input) => ({
        category: "working",
        confidence: 0.95,
        attention: 0.6,
        question: null,
        notable: input.screen.includes("root cause") ? 0.9 : 0.1,
      }),
      describe: async () => ({
        category: "working",
        headline: "Working",
        summary: "",
        attentionScore: 5,
        task: null,
        risk: "unknown",
        riskReason: null,
        action: null,
        progress: null,
        tests: "unknown",
        changes: "unknown",
        question: null,
        options: [],
      }),
    });
    h.runs.push(run("a"), run("b"));
    h.screens.set("a", "⏺ Found the root cause: tokens are cached per tab");
    h.screens.set("b", "⏺ Reading src/units.ts");
    await h.service.scan();
    await vi.waitFor(() =>
      expect(h.service.getSnapshot().cards.every((card) => card.stage === "described")).toBe(true)
    );
    const priority = (id: string) =>
      h.service.getSnapshot().cards.find((card) => card.runId === id)!.priority;
    expect(priority("a")).toBe(CANOPY_CLASSIFIER_ANCHORS.notable);
    expect(priority("b")).toBe(5);
  });

  it("keeps a run's failure through others' successes, and drops it when the run leaves", async () => {
    const h = await makeHarness({
      classify: async (input) => {
        if (input.screen === "broken") throw new Error("boom");
        return { category: "working", confidence: 0.9, attention: 0.1, question: null };
      },
    });
    h.runs.push(run("a"), run("b"));
    h.screens.set("a", "broken");
    h.screens.set("b", "fine");
    await h.service.scan();
    expect(h.service.getSnapshot()).toMatchObject({
      lastError: "Canopy request failed",
      failedRuns: ["a"],
    });
    h.screens.set("b", "fine, and moving");
    await h.service.scan();
    expect(h.service.getSnapshot().lastError).toBe("Canopy request failed");

    h.runs.splice(0, 1);
    h.service.onFleetChanged();
    expect(h.service.getSnapshot()).toMatchObject({ lastError: null, failedRuns: [] });
  });

  it("rides out a failure that passes, and reports one that doesn't", async () => {
    let clock = 1_000_000;
    let fail = true;
    const h = await makeHarness({
      now: () => clock,
      classify: async () => {
        if (fail) throw new CanopyProviderError("classifier", "HTTP 429", true);
        return { category: "working", confidence: 0.9, attention: 0.9, question: null };
      },
    });
    h.runs.push(run("a"));
    h.screens.set("a", "screen");
    await h.service.scan();
    // A rate limit or a worker waking: not a failure yet, and the screen is tried again.
    expect(h.service.getSnapshot().lastError).toBeNull();
    expect(h.service.getSnapshot().failedRuns).toEqual([]);
    clock += CANOPY_FAILURE_BACKOFF_MAX_MS;
    await h.service.scan();
    expect(h.classify).toHaveBeenCalledTimes(2);

    clock += CANOPY_TRANSIENT_GRACE_MS;
    await h.service.scan();
    expect(h.service.getSnapshot().lastError).toBe("Classifier: HTTP 429");

    // A reading that lands ends the spell, and the next one gets the whole grace again.
    fail = false;
    clock += CANOPY_FAILURE_BACKOFF_MAX_MS;
    await h.service.scan();
    expect(h.service.getSnapshot().lastError).toBeNull();
    fail = true;
    h.screens.set("a", "screen moved on");
    await h.service.scan();
    expect(h.service.getSnapshot().lastError).toBeNull();
  });

  it("waits out a cold start before the grace begins", async () => {
    let clock = 1_000_000;
    let waking = true;
    const h = await makeHarness({
      now: () => clock,
      serviceWaking: () => waking,
      classify: async () => {
        throw new CanopyProviderError("classifier", "service waking", true);
      },
    });
    h.runs.push(run("a"));
    h.screens.set("a", "screen");
    await h.service.scan();
    clock += CANOPY_TRANSIENT_GRACE_MS * 2;
    await h.service.scan();
    expect(h.service.getSnapshot().lastError).toBeNull();

    // Started, but still failing: now the grace runs.
    waking = false;
    clock += CANOPY_FAILURE_BACKOFF_MAX_MS;
    await h.service.scan();
    expect(h.classify).toHaveBeenCalledTimes(3);
    expect(h.service.getSnapshot().lastError).toBeNull();
    clock += CANOPY_TRANSIENT_GRACE_MS;
    await h.service.scan();
    expect(h.service.getSnapshot().lastError).toBe("Classifier: service waking");
  });

  it("reports a service that never comes up, however often it is woken", async () => {
    let clock = 1_000_000;
    const h = await makeHarness({
      now: () => clock,
      serviceWaking: () => true,
      classify: async () => {
        throw new CanopyProviderError("classifier", "request timed out", true);
      },
    });
    h.runs.push(run("a"));
    h.screens.set("a", "screen");
    await h.service.scan();
    clock += CANOPY_COLD_START_GRACE_MS - 1;
    await h.service.scan();
    expect(h.service.getSnapshot().lastError).toBeNull();
    clock += CANOPY_FAILURE_BACKOFF_MAX_MS;
    await h.service.scan();
    expect(h.service.getSnapshot().lastError).toBe("Classifier: request timed out");
  });

  describe("the describer's note", () => {
    const noting =
      (notes: Array<string | null>) =>
      async (_input: CanopyScreenInput, says: CanopyCategory): Promise<DescriberResult> => ({
        category: says,
        headline: "Headline",
        summary: "Summary",
        attentionScore: 55,
        task: null,
        risk: "unknown",
        riskReason: null,
        action: null,
        progress: null,
        tests: "unknown",
        changes: "unknown",
        question: null,
        options: [],
        note: notes.shift() ?? null,
      });

    it("strips a credential the describer wrote into its note before handing it back", async () => {
      let now = 1_000_000;
      const h = await makeHarness({
        now: () => now,
        describe: noting(["Goal: deploy. Used token=abcdef123456 from .env."]),
      });
      h.runs.push(run("a"));
      h.screens.set("a", APPROVAL_SCREEN);
      await h.service.scan();

      now += 30_000;
      h.screens.set("a", "⏺ Deployed.\n✻ Baked for 12s · done 6:22");
      await h.service.refresh();
      const note = h.describe.mock.calls[1]![0].note;
      expect(note?.text).toContain("Goal: deploy.");
      expect(note?.text).not.toContain("abcdef123456");
    });

    it("hands each reading the note the last one wrote, with its age", async () => {
      let now = 1_000_000;
      const h = await makeHarness({
        now: () => now,
        describe: noting([
          "Goal: fix rounding; don't commit.",
          "Goal: fix rounding; don't commit. Done: tests pass.",
        ]),
      });
      h.runs.push(run("a"));
      h.screens.set("a", APPROVAL_SCREEN);
      await h.service.scan();
      expect(h.describe.mock.calls[0]![0].note ?? null).toBeNull();

      now += 30_000;
      h.screens.set("a", "⏺ All tests pass.\n✻ Baked for 12s · done 6:22");
      await h.service.refresh();
      expect(h.describe.mock.calls[1]![0].note).toEqual({
        text: "Goal: fix rounding; don't commit.",
        secondsAgo: 30,
      });
      // The note stays in main: no card carries it to the renderer.
      expect(JSON.stringify(h.service.getSnapshot())).not.toContain("rounding");
    });

    it("hands the next reading what scrolled away and caps the count on an unchanged screen", async () => {
      let now = 1_000_000;
      const history = new Map<string, string>();
      const h = await makeHarness({
        now: () => now,
        history,
        describe: async (_input, says) => ({
          category: says,
          headline: "Headline",
          summary: "Summary",
          attentionScore: 55,
          task: null,
          risk: "unknown",
          riskReason: null,
          action: null,
          progress: null,
          tests: "unknown",
          changes: "unknown",
          question: null,
          options: [],
          note: null,
          failureRepeats: 2,
        }),
      });
      h.runs.push(run("a"));
      h.screens.set("a", "• Ran pnpm build\n└ error TS2742\n• Edited tsconfig.json");
      await h.service.scan();
      expect(h.describe.mock.calls[0]![0].sinceLastReading ?? null).toBeNull();

      now += 30_000;
      history.set(
        "a",
        "• Ran pnpm build\n└ error TS2742\n• Edited tsconfig.json\n• Ran pnpm build\n└ error TS2742\n• Edited src/env.ts"
      );
      h.screens.set("a", "• Ran pnpm install --force\n• Ran pnpm build\n└ error TS2742 again");
      await h.service.refresh();
      expect(h.describe.mock.calls[1]![0].sinceLastReading).toBe(
        "• Ran pnpm build\n└ error TS2742\n• Edited src/env.ts"
      );
      expect(h.describe.mock.calls[1]![0].failureRepeatsCap ?? null).toBeNull();
    });

    it("keeps the last note when a reading writes none", async () => {
      let now = 1_000_000;
      const h = await makeHarness({
        now: () => now,
        describe: noting(["Goal: add CSV export.", null]),
      });
      h.runs.push(run("a"));
      h.screens.set("a", APPROVAL_SCREEN);
      await h.service.scan();
      now += 10_000;
      h.screens.set("a", "screen two");
      await h.service.refresh();
      now += 10_000;
      h.screens.set("a", "screen three");
      await h.service.refresh();
      expect(h.describe.mock.calls[2]![0].note).toEqual({
        text: "Goal: add CSV export.",
        secondsAgo: 20,
      });
    });

    it("starts a respawned terminal with no note", async () => {
      const h = await makeHarness({ describe: noting(["Goal: old terminal's work."]) });
      h.runs.push(run("a", { spawnedAt: 1 }));
      h.screens.set("a", APPROVAL_SCREEN);
      await h.service.scan();
      h.runs[0] = run("a", { spawnedAt: 2 });
      h.service.onFleetChanged();
      h.screens.set("a", "fresh screen");
      await h.service.refresh();
      expect(h.describe.mock.calls[1]![0].note ?? null).toBeNull();
    });
  });

  it("forgets a card as soon as its terminal is respawned under the same id", async () => {
    const h = await makeHarness({});
    h.runs.push(run("a", { spawnedAt: 1 }));
    h.screens.set("a", "screen");
    await h.service.scan();
    expect(h.service.getSnapshot().cards).toHaveLength(1);
    h.runs[0] = run("a", { spawnedAt: 2 });
    h.service.onFleetChanged();
    expect(h.service.getSnapshot().cards.find((c) => c.spawnedAt === 1)).toBeUndefined();
  });

  describe("the row's name and progress", () => {
    const waiting = async (): Promise<Reading> => ({
      category: "finished",
      confidence: 0.9,
      attention: 0.9,
      question: null,
    });
    const reading =
      (task: string | null, progress: number | null = null) =>
      async (_input: CanopyScreenInput, says: CanopyCategory): Promise<DescriberResult> => ({
        category: says,
        headline: "Review it",
        summary: "Done.",
        attentionScore: 55,
        task,
        risk: "unknown",
        riskReason: null,
        action: null,
        progress,
        tests: "unknown",
        changes: "unknown",
        question: null,
        options: [],
      });

    it("titles a run once from the user's request and keeps it until a new request", async () => {
      const history = new Map([["a", "❯ Fix the rounding bug in units.ts and commit the fix"]]);
      let task = "Fix the rounding bug";
      const h = await makeHarness({
        history,
        classify: waiting,
        describe: async (input, says) => reading(task)(input, says),
      });
      h.runs.push(run("a"));
      h.screens.set("a", "✻ Baked for 3s · done");
      await h.service.refresh();
      expect(h.service.getSnapshot().cards[0]!.task).toBe("Fix the rounding bug");

      // Reworded on a later read of the same request: the name stands.
      task = "Repair the rounding helper";
      h.screens.set("a", "✻ Crunched for 9s · done");
      await h.service.refresh();
      expect(h.service.getSnapshot().cards[0]!.task).toBe("Fix the rounding bug");
      expect(h.describe.mock.calls.at(-1)![0].currentTask).toBe("Fix the rounding bug");

      // A follow-up is not new work…
      history.set("a", `${history.get("a")}\n\n⏺ Done.\n❯ yes go ahead`);
      h.screens.set("a", "✻ Worked for 2s · done");
      await h.service.refresh();
      expect(h.service.getSnapshot().cards[0]!.task).toBe("Fix the rounding bug");

      // …a request for other work is.
      task = "Add a GET /units endpoint";
      history.set(
        "a",
        `${history.get("a")}\n\n⏺ Ok.\n❯ Now add a GET /units endpoint with tests and commit it`
      );
      h.screens.set("a", "✻ Cooked for 30s · done");
      await h.service.refresh();
      expect(h.service.getSnapshot().cards[0]!.task).toBe("Add a GET /units endpoint");
    });

    it("never titles a run whose history shows no request from the user", async () => {
      const h = await makeHarness({
        history: new Map([["a", "▐▛███▜▌  Claude Code v2.1.289"]]),
        classify: waiting,
        describe: reading("Develop the canopy demo"),
      });
      h.runs.push(run("a"));
      h.screens.set("a", "Quick safety check: Is this a project you trust?");
      await h.service.refresh();
      expect(h.service.getSnapshot().cards[0]!.task).toBeNull();
    });

    it("counts progress off the agent's checklist rather than the reader's guess", async () => {
      const h = await makeHarness({
        history: new Map([
          [
            "a",
            [
              "❯ Refactor the router",
              "6 tasks (4 done, 1 in progress, 1 open)",
              "◼ Run tests",
            ].join("\n"),
          ],
        ]),
        classify: waiting,
        describe: reading("Refactor the router", 40),
      });
      h.runs.push(run("a"));
      h.screens.set("a", "Do you want to proceed?");
      await h.service.refresh();
      const card = h.service.getSnapshot().cards[0]!;
      expect(card.steps).toEqual({ done: 4, total: 6, current: "Run tests" });
      expect(card.progress).toBe(75);
    });

    it("sends nothing to the readers for a screen with nothing on it", async () => {
      const h = await makeHarness({});
      h.runs.push(run("a"));
      h.screens.set("a", "\n   \n");
      await h.service.refresh();
      expect(h.classify).not.toHaveBeenCalled();
      expect(h.service.getSnapshot().cards).toEqual([]);
    });
  });

  it("reads the screens as soon as an agent's observed state moves, without waiting for a poll", async () => {
    const h = await makeHarness({ stateChangeScanMs: 0 });
    h.runs.push(run("a", { agentState: "working" }));
    h.screens.set("a", "✻ Editing src/app.ts… (esc to interrupt)");
    h.service.onFleetChanged();
    await vi.waitFor(() => expect(h.classify).toHaveBeenCalledTimes(1));

    // Same state, new output: the poll's job, not this one.
    h.screens.set("a", "✻ Running npm test… (esc to interrupt)");
    h.service.onFleetChanged();
    await settle();
    expect(h.classify).toHaveBeenCalledTimes(1);

    h.runs[0] = run("a", { agentState: "waiting", waitingReason: "approval" });
    h.screens.set("a", APPROVAL_SCREEN);
    h.service.onFleetChanged();
    await vi.waitFor(() => expect(h.classify).toHaveBeenCalledTimes(2));
    expect(h.classify.mock.calls[1]![0].screen).toContain("proceed");
  });

  it("does not scan on a state change while the panel is closed", async () => {
    const h = await makeHarness({ stateChangeScanMs: 0 });
    h.service.setActive(false);
    h.runs.push(run("a", { agentState: "waiting" }));
    h.screens.set("a", APPROVAL_SCREEN);
    h.service.onFleetChanged();
    await settle();
    await settle();
    expect(h.classify).not.toHaveBeenCalled();
  });

  describe("review regressions", () => {
    const stopped = async (): Promise<Reading> => ({
      category: "finished",
      confidence: 0.9,
      attention: 0.9,
      question: null,
    });
    const titled =
      (task: string) =>
      async (_input: CanopyScreenInput, says: CanopyCategory): Promise<DescriberResult> => ({
        category: says,
        headline: "Review it",
        summary: "Done.",
        attentionScore: 55,
        task,
        risk: "unknown",
        riskReason: null,
        action: null,
        progress: null,
        tests: "unknown",
        changes: "unknown",
        question: null,
        options: [],
      });

    it("retitles for a short request that is new work, not only long ones", async () => {
      const history = new Map([["a", "❯ Fix the rounding bug in units.ts and commit"]]);
      let task = "Fix the rounding bug";
      const h = await makeHarness({
        history,
        classify: stopped,
        describe: async (i, s) => titled(task)(i, s),
      });
      h.runs.push(run("a"));
      h.screens.set("a", "✻ Baked for 3s · done");
      await h.service.refresh();
      task = "Add dark mode";
      history.set("a", `${history.get("a")}\n⏺ Done.\n❯ Add dark mode`);
      h.screens.set("a", "✻ Cooked for 9s · done");
      await h.service.refresh();
      expect(h.service.getSnapshot().cards[0]!.task).toBe("Add dark mode");
    });

    it("lets a title written before any request was seen be replaced by the next new request", async () => {
      const history = new Map<string, string>();
      let task = "Initial title";
      const h = await makeHarness({
        history,
        classify: stopped,
        describe: async (i, s) => titled(task)(i, s),
      });
      h.runs.push(run("a", { agentId: "opencode" }));
      h.screens.set("a", "Done reading the files.");
      await h.service.refresh();
      expect(h.service.getSnapshot().cards[0]!.task).toBe("Initial title");
      // The agent switches to one whose requests can be read: the first one seen is the title's own…
      h.runs[0] = run("a", { agentId: "claude" });
      history.set("a", "❯ Summarise the pantry module in three bullet points");
      task = "Reworded title";
      h.screens.set("a", "✻ Baked for 3s · done");
      await h.service.refresh();
      expect(h.service.getSnapshot().cards[0]!.task).toBe("Initial title");
      // …and the next request for other work replaces it.
      history.set(
        "a",
        `${history.get("a")}\n⏺ Ok.\n❯ Now write tests for the pantry module and commit them`
      );
      task = "Write pantry tests";
      h.screens.set("a", "✻ Cooked for 30s · done");
      await h.service.refresh();
      expect(h.service.getSnapshot().cards[0]!.task).toBe("Write pantry tests");
    });

    it("does not describe a screen with history from a terminal that has since moved", async () => {
      const h = await makeHarness({ classify: stopped, describe: titled("Anything") });
      h.service.dispose();
      const screens = new Map([["a", "✻ Baked for 3s · done"]]);
      const describe = vi.fn(titled("Anything"));
      const service = new CanopyService({
        getRuns: () => [run("a")],
        readScreen: async (id) => screens.get(id) ?? null,
        // The user sent a new request between the screen read and the history read.
        readHistory: async () =>
          "❯ A brand new request for other work\n✢ Thinking… (1s · esc to interrupt)",
        classify: async () => withBlocked(await stopped()),
        describe,
        broadcast: () => {},
        closeGraceMs: 0,
        stateChangeScanMs: 60_000,
        backgroundPollMs: 0,
      });
      service.setActive(true);
      await settle();
      await service.refresh();
      expect(describe).not.toHaveBeenCalled();
      expect(service.getSnapshot().cards[0]?.describing).toBe(false);
      service.dispose();
    });

    it("withdraws what a card offered to act on when its screen goes blank", async () => {
      const h = await makeHarness({
        classify: async () => ({
          category: "approval",
          confidence: 0.9,
          attention: 0.95,
          question: "Do you want to proceed?",
        }),
        describe: async () => ({
          ...(await titled("t")(INPUT_STUB, "approval")),
          category: "approval",
          question: "Do you want to proceed?",
          options: ["Yes", "No"],
        }),
      });
      h.runs.push(run("a"));
      h.screens.set("a", APPROVAL_SCREEN);
      await h.service.refresh();
      expect(h.service.getSnapshot().cards[0]!.question).not.toBeNull();
      h.screens.set("a", "   \n");
      await h.service.refresh();
      const card = h.service.getSnapshot().cards[0]!;
      expect(card.question).toBeNull();
      expect(card.options).toEqual([]);
      expect(card.priorityFromEarlierRead).toBe(true);
    });
  });

  it("marks a working run stalled once its screen stands still behind a ticking spinner", async () => {
    let now = 1_000_000;
    const h = await makeHarness({ now: () => now });
    h.runs.push(run("a", { agentState: "working" }));
    h.screens.set("a", "• Waiting for background terminal (1m 02s • esc to interrupt)");
    await h.service.refresh();
    expect(h.service.getSnapshot().cards[0]!.stalledSince).toBeNull();

    now += CANOPY_STALL_MS + 1_000;
    h.screens.set("a", "• Waiting for background terminal (11m 03s • esc to interrupt)");
    await h.service.refresh();
    expect(h.service.getSnapshot().cards[0]!.stalledSince).toBe(1_000_000);

    h.screens.set("a", "• Ran npm test\n└ ok 14 tests");
    await h.service.refresh();
    expect(h.service.getSnapshot().cards[0]!.stalledSince).toBeNull();
  });

  describe("background watch", () => {
    const BG = 20_000;
    const asking =
      (blocked: number) =>
      async (input: CanopyScreenInput): Promise<Reading> =>
        input.screen.includes("proceed")
          ? {
              category: "approval",
              confidence: 0.99,
              attention: 0.97,
              blocked,
              question: "Do you want to proceed?",
            }
          : input.screen.includes("Which")
            ? {
                category: "question",
                confidence: 0.98,
                attention: 0.95,
                blocked,
                question: "Which one?",
              }
            : {
                category: "working",
                confidence: 0.99,
                attention: 0.08,
                blocked: 0.05,
                question: null,
              };

    it("reads changed screens for the classifier alone while the panel is closed", async () => {
      const h = await makeHarness({ backgroundPollMs: BG, classify: asking(0.97) });
      vi.useFakeTimers();
      try {
        // Closed under fake timers, so the background tick is one they drive.
        h.service.setActive(false);
        h.runs.push(run("a"), run("b", { agentState: "working" }));
        h.screens.set("a", APPROVAL_SCREEN);
        h.screens.set("b", "• Editing store.ts (esc to interrupt)");
        await vi.advanceTimersByTimeAsync(BG);
        expect(h.classify).toHaveBeenCalledTimes(2);
        expect(h.describe).not.toHaveBeenCalled();

        // Nothing moved: the next tick reads both screens and sends neither.
        await vi.advanceTimersByTimeAsync(BG);
        expect(h.classify).toHaveBeenCalledTimes(2);

        h.screens.set("b", "• Running the tests (esc to interrupt)");
        await vi.advanceTimersByTimeAsync(BG);
        expect(h.classify).toHaveBeenCalledTimes(3);
        expect(h.describe).not.toHaveBeenCalled();
        const card = h.service.getSnapshot().cards.find((c) => c.runId === "a")!;
        expect(card.stage).toBe("classified");
        expect(card.priority).toBe(92);
      } finally {
        harness?.service.dispose();
        vi.useRealTimers();
      }
    });

    it("keeps the describer's score when the screen moves without leaving its state", async () => {
      let describes = 0;
      const h = await makeHarness({
        classify: async () => ({
          category: "finished",
          confidence: 0.9,
          attention: 0.9,
          question: null,
        }),
        describe: async (_input, says) => {
          // The second reading is still on its way when the card is checked.
          if (++describes > 1) await new Promise(() => {});
          return {
            category: says,
            headline: "Review the fix",
            summary: "Not committed.",
            attentionScore: 55,
            task: null,
            risk: "unknown",
            riskReason: null,
            action: null,
            progress: 100,
            tests: "passing",
            changes: "uncommitted" as const,
            question: null,
            options: [],
          };
        },
      });
      h.runs.push(run("a", { agentState: "waiting" }));
      h.screens.set("a", "⏺ Fixed the rounding.\n\n✻ Worked for 9s · done");
      await h.service.refresh();
      await settle();
      expect(h.service.getSnapshot().cards[0]!.priority).toBe(55);
      // Claude's recap lands under the finished turn a minute later.
      h.service.setActive(false);
      h.screens.set(
        "a",
        "⏺ Fixed the rounding.\n\n✻ Worked for 9s · done\n\n※ recap: Fixed the rounding."
      );
      h.service.setActive(true);
      void h.service.refresh();
      await vi.waitFor(() => expect(describes).toBe(2));
      const card = h.service.getSnapshot().cards[0]!;
      // Never the classifier's 50 in between: the run stays in "needs you",
      // and its words stand until the new ones replace them.
      expect(card.wordsFromEarlierRead).toBe(false);
      expect(card.priority).toBe(55);
    });

    it("writes on opening the words the watch left due, without classifying the screen again", async () => {
      const h = await makeHarness({
        closed: true,
        backgroundPollMs: BG,
        stateChangeScanMs: 0,
        classify: async () => ({
          category: "approval",
          confidence: 0.97,
          attention: 0.97,
          question: "Allow?",
        }),
      });
      h.runs.push(run("a", { agentState: "waiting" }));
      h.screens.set("a", APPROVAL_SCREEN);
      h.service.onFleetChanged();
      await vi.waitFor(() => expect(h.classify).toHaveBeenCalledTimes(1));
      await settle();
      expect(h.describe).not.toHaveBeenCalled();

      h.service.setActive(true);
      await vi.waitFor(() => expect(h.describe).toHaveBeenCalledTimes(1));
      await h.service.refresh();
      expect(h.classify).toHaveBeenCalledTimes(1);
      expect(h.service.getSnapshot().cards[0]!.stage).toBe("described");
    });

    it("leaves another project's waiting words alone when one project's panel opens", async () => {
      const h = await makeHarness({
        closed: true,
        backgroundPollMs: BG,
        stateChangeScanMs: 0,
        classify: async () => ({
          category: "approval",
          confidence: 0.97,
          attention: 0.97,
          question: "Allow?",
        }),
      });
      h.runs.push(
        run("a", { agentState: "waiting", workspaceId: "p1" }),
        run("b", { agentState: "waiting", workspaceId: "p2" })
      );
      h.screens.set("a", APPROVAL_SCREEN);
      h.screens.set("b", APPROVAL_SCREEN);
      h.service.onFleetChanged();
      await vi.waitFor(() => expect(h.classify).toHaveBeenCalledTimes(2));
      await settle();

      h.service.setScope("p1");
      h.service.setActive(true);
      await h.service.refresh();
      expect(h.describe).toHaveBeenCalledTimes(1);
      // Back to every project: the other one's unchanged screen is not read again.
      h.service.setActive(false);
      h.service.setScope(null);
      await h.service.refresh();
      expect(h.classify).toHaveBeenCalledTimes(2);
    });

    it("describes nothing while the panel is closed, on the priority tier too", async () => {
      const h = await makeHarness({
        closed: true,
        backgroundPollMs: BG,
        stateChangeScanMs: 0,
        plan: { activated: true, tier: "priority" },
        classify: async () => ({
          category: "approval",
          confidence: 0.97,
          attention: 0.97,
          question: "Allow?",
        }),
      });
      h.runs.push(run("a", { agentState: "waiting" }));
      h.screens.set("a", APPROVAL_SCREEN);
      h.service.onFleetChanged();
      await vi.waitFor(() => expect(h.classify).toHaveBeenCalledTimes(1));
      await settle();
      expect(h.describe).not.toHaveBeenCalled();
      expect(h.service.getSnapshot().cards[0]!.stage).toBe("classified");
      // The open writes the words the watch left due.
      h.service.setActive(true);
      await vi.waitFor(() => expect(h.describe).toHaveBeenCalledTimes(1));
    });

    it("offers a screen's words before the classifier has read it", async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const h = await makeHarness({
        closed: true,
        backgroundPollMs: BG,
        stateChangeScanMs: 0,
        classify: async () => {
          await gate;
          return { category: "finished", confidence: 0.9, attention: 0.9, question: null };
        },
      });
      h.runs.push(run("a", { agentState: "waiting" }));
      h.screens.set(
        "a",
        ["⏺ Fixed the rounding in units.ts.", "", "✻ Worked for 9s · done"].join("\n")
      );
      h.service.onFleetChanged();
      await vi.waitFor(() => expect(h.classify).toHaveBeenCalledTimes(1));
      await settle();
      const before = h.service.getSnapshot();
      expect(before.cards).toEqual([]);
      expect(before.glances).toEqual([
        {
          runId: "a",
          spawnedAt: expect.any(Number),
          glance: expect.objectContaining({ said: "Fixed the rounding in units.ts." }),
        },
      ]);
      release();
      await vi.waitFor(() => expect(h.service.getSnapshot().cards).toHaveLength(1));
      // Once carded, the words travel on the card.
      expect(h.service.getSnapshot().glances).toEqual([]);
    });

    it("drops a screen's words when the screen goes blank", async () => {
      const h = await makeHarness({ closed: true, backgroundPollMs: BG, stateChangeScanMs: 0 });
      h.runs.push(run("a", { agentState: "waiting" }));
      h.screens.set("a", ["⏺ Fixed the rounding.", "", "✻ Worked for 9s · done"].join("\n"));
      h.service.onFleetChanged();
      await vi.waitFor(() => expect(h.service.getSnapshot().cards).toHaveLength(1));
      h.screens.set("a", "");
      await h.service.scan();
      expect(h.service.getSnapshot().cards[0]!.glance.said).toBeNull();
    });

    it("puts the screen's own words on a card read in the background", async () => {
      const h = await makeHarness({ closed: true, backgroundPollMs: BG, stateChangeScanMs: 0 });
      h.runs.push(run("a", { agentState: "waiting" }));
      h.screens.set(
        "a",
        [
          "• Ran npm test",
          "  └ 14 passed",
          "",
          "• Committed as 43d0e48: cups now keep two decimal places.",
          "",
          "Worked for 1m 3s • 08:55",
        ].join("\n")
      );
      h.service.onFleetChanged();
      await vi.waitFor(() => expect(h.classify).toHaveBeenCalledTimes(1));
      await settle();
      const card = h.service.getSnapshot().cards[0]!;
      expect(card.stage).toBe("classified");
      expect(card.glance.said).toBe("Committed as 43d0e48: cups now keep two decimal places.");
    });

    it("scans soon after an observed state change while the panel is closed", async () => {
      const h = await makeHarness({ closed: true, backgroundPollMs: BG, stateChangeScanMs: 0 });
      h.runs.push(run("a", { agentState: "waiting" }));
      h.screens.set("a", APPROVAL_SCREEN);
      h.service.onFleetChanged();
      await vi.waitFor(() => expect(h.classify).toHaveBeenCalledTimes(1));
      expect(h.describe).not.toHaveBeenCalled();
    });

    it("writes the words an open finds due", async () => {
      const h = await makeHarness({
        closed: true,
        backgroundPollMs: BG,
        stateChangeScanMs: 0,
        classify: asking(0.97),
      });
      h.runs.push(run("a", { agentState: "waiting" }));
      h.screens.set("a", APPROVAL_SCREEN);
      h.service.onFleetChanged();
      await vi.waitFor(() => expect(h.classify).toHaveBeenCalledTimes(1));
      await settle();

      h.service.setActive(true);
      await vi.waitFor(() => expect(h.describe).toHaveBeenCalledTimes(1));
      await settle();
      const card = h.service.getSnapshot().cards[0]!;
      expect(card.stage).toBe("described");
      expect(card.headline).toBe("Headline");
    });

    it("keeps a described run's words when it is read again with the panel closed", async () => {
      const h = await makeHarness({ backgroundPollMs: BG, classify: asking(0.97) });
      h.runs.push(run("a", { agentState: "waiting" }));
      h.screens.set("a", APPROVAL_SCREEN);
      await h.service.refresh();
      expect(h.service.getSnapshot().cards[0]!.headline).toBe("Headline");

      h.service.setActive(false);
      h.screens.set("a", `${APPROVAL_SCREEN}\n(redrawn)`);
      await h.service.refresh();
      const card = h.service.getSnapshot().cards[0]!;
      expect(h.describe).toHaveBeenCalledTimes(1);
      expect(card.headline).toBe("Headline");
      expect(card.wordsFromEarlierRead).toBe(true);
    });

    it("sends nothing while closed when the background watch is off", async () => {
      const h = await makeHarness({ closed: true, backgroundPollMs: 0, stateChangeScanMs: 0 });
      h.runs.push(run("a", { agentState: "waiting" }));
      h.screens.set("a", APPROVAL_SCREEN);
      h.service.onFleetChanged();
      await h.service.refresh();
      expect(h.classify).not.toHaveBeenCalled();
    });
  });

  describe("asks", () => {
    const reading =
      (category: CanopyCategory, blocked: number, attention = 0.95) =>
      async (): Promise<Reading> => ({
        category,
        confidence: 0.98,
        attention,
        blocked,
        question: "Ship it?",
      });

    it("scores an ask by how sure the classifier is that the agent is blocked", async () => {
      const cases: Array<[CanopyCategory, number, number]> = [
        ["approval", 0.97, 92],
        ["question", 0.93, 86],
        ["question", 0.7, 68],
        ["question", 0.3, 50],
      ];
      for (const [category, blocked, priority] of cases) {
        const h = await makeHarness({ classify: reading(category, blocked) });
        h.runs.push(run("a", { agentState: "waiting" }));
        h.screens.set("a", "Ship it?");
        h.describe.mockImplementation(() => new Promise(() => {}));
        void h.service.refresh();
        await vi.waitFor(() => expect(h.service.getSnapshot().cards).toHaveLength(1));
        expect(h.service.getSnapshot().cards[0]!.priority).toBe(priority);
        h.service.dispose();
      }
    });

    it("ranks other readings at fixed anchors", async () => {
      const cases: Array<[CanopyCategory, number, number]> = [
        ["finished", 0.9, 50],
        ["error", 0.9, 70],
        ["idle", 0.7, 20],
        ["working", 0.1, 5],
        ["working", 0.9, 70],
      ];
      for (const [category, attention, priority] of cases) {
        const h = await makeHarness({ classify: reading(category, 0.1, attention) });
        h.runs.push(run("a"));
        h.screens.set("a", "screen");
        h.describe.mockImplementation(() => new Promise(() => {}));
        void h.service.refresh();
        await vi.waitFor(() => expect(h.service.getSnapshot().cards).toHaveLength(1));
        expect(h.service.getSnapshot().cards[0]!.priority).toBe(priority);
        h.service.dispose();
      }
    });

    it("lifts a busy agent showing something notable above busy, below stuck", async () => {
      const cases: Array<[number, number, number]> = [
        [0.1, 0.9, 30],
        [0.1, 0.2, 5],
        [0.9, 0.9, 70],
      ];
      for (const [attention, notable, priority] of cases) {
        const h = await makeHarness({
          classify: async () => ({ ...(await reading("working", 0.1, attention)()), notable }),
        });
        h.runs.push(run("a"));
        h.screens.set("a", "screen");
        h.describe.mockImplementation(() => new Promise(() => {}));
        void h.service.refresh();
        await vi.waitFor(() => expect(h.service.getSnapshot().cards).toHaveLength(1));
        expect(h.service.getSnapshot().cards[0]!.priority).toBe(priority);
        h.service.dispose();
      }
    });

    it("takes an approval Daintree also saw as blocked, however unsure the classifier is", async () => {
      const h = await makeHarness({ classify: reading("approval", 0.4) });
      h.runs.push(run("a", { agentState: "waiting", waitingReason: "approval" }));
      h.screens.set("a", APPROVAL_SCREEN);
      h.describe.mockImplementation(() => new Promise(() => {}));
      void h.service.refresh();
      await vi.waitFor(() => expect(h.service.getSnapshot().cards).toHaveLength(1));
      expect(h.service.getSnapshot().cards[0]!.priority).toBe(92);
    });

    it("keeps an urgent ask at its score when the describer scores it lower", async () => {
      const h = await makeHarness({ classify: reading("question", 0.95) });
      h.describe.mockImplementation(async () => ({
        category: "finished",
        headline: "Review it",
        summary: "Done.",
        attentionScore: 40,
        task: null,
        risk: "unknown",
        riskReason: null,
        action: null,
        progress: null,
        tests: "unknown",
        changes: "unknown",
        question: null,
        options: [],
      }));
      h.runs.push(run("a", { agentState: "waiting" }));
      h.screens.set("a", "Ship it?");
      await h.service.refresh();
      expect(h.service.getSnapshot().cards[0]!.priority).toBe(86);
    });

    it("tells onAsk once per ask, and again after the agent worked", async () => {
      const onAsk = vi.fn();
      const h = await makeHarness({ classify: reading("approval", 0.97), onAsk });
      h.runs.push(run("a", { agentState: "waiting" }));
      h.screens.set("a", APPROVAL_SCREEN);
      await h.service.refresh();
      expect(onAsk).toHaveBeenCalledTimes(1);
      expect(onAsk.mock.calls[0]![1]).toEqual({ kind: "approval", question: "Ship it?" });

      // Redrawn, still the same ask.
      h.screens.set("a", `${APPROVAL_SCREEN}\n `);
      await h.service.refresh();
      expect(onAsk).toHaveBeenCalledTimes(1);

      // It worked in between, unseen by any scan: the next ask is new.
      h.service.onFleetChanged();
      h.runs[0] = run("a", { agentState: "working" });
      h.service.onFleetChanged();
      h.runs[0] = run("a", { agentState: "waiting" });
      h.screens.set("a", `${APPROVAL_SCREEN}\nagain`);
      await h.service.refresh();
      expect(onAsk).toHaveBeenCalledTimes(2);
    });

    it("tells onAsk nothing for an unsure ask or a finished turn", async () => {
      const onAsk = vi.fn();
      const h = await makeHarness({ classify: reading("question", 0.6), onAsk });
      h.runs.push(run("a", { agentState: "waiting" }));
      h.screens.set("a", "Ship it?");
      await h.service.refresh();
      expect(onAsk).not.toHaveBeenCalled();

      h.classify.mockImplementation(reading("finished", 0.1));
      h.screens.set("a", "Done.");
      await h.service.refresh();
      expect(onAsk).not.toHaveBeenCalled();
    });

    it("tells onAsk nothing about an ask on a run the user archived", async () => {
      const onAsk = vi.fn();
      const h = await makeHarness({ classify: reading("approval", 0.97), onAsk });
      h.runs.push(run("a", { agentState: "waiting" }));
      h.service.archive("a", 1);
      h.screens.set("a", APPROVAL_SCREEN);
      await h.service.refresh();
      expect(h.classify).toHaveBeenCalledTimes(1);
      expect(onAsk).not.toHaveBeenCalled();
    });

    it("tells onAsk once while Daintree keeps calling the asking run busy", async () => {
      let now = 1_000_000;
      const onAsk = vi.fn();
      const h = await makeHarness({ classify: reading("approval", 0.97), onAsk, now: () => now });
      h.runs.push(run("a", { agentState: "working" }));
      h.screens.set("a", APPROVAL_SCREEN);
      await h.service.refresh();
      expect(onAsk).toHaveBeenCalledTimes(1);

      // Unrelated fleet changes, then a re-judge of the unchanged screen.
      h.service.onFleetChanged();
      h.service.onFleetChanged();
      now += CANOPY_REJUDGE_AFTER_MS + 1_000;
      await h.service.refresh();
      expect(h.classify).toHaveBeenCalledTimes(2);
      expect(onAsk).toHaveBeenCalledTimes(1);
    });

    it("tells onAsk about a new ask after the screen went blank in between", async () => {
      const onAsk = vi.fn();
      const h = await makeHarness({ classify: reading("approval", 0.97), onAsk });
      h.runs.push(run("a", { agentState: "working" }));
      h.screens.set("a", APPROVAL_SCREEN);
      await h.service.refresh();
      expect(onAsk).toHaveBeenCalledTimes(1);

      h.screens.set("a", "   ");
      await h.service.refresh();
      h.classify.mockImplementation(reading("question", 0.95));
      h.screens.set("a", "Which database should I use?");
      await h.service.refresh();
      expect(onAsk).toHaveBeenCalledTimes(2);
      expect(onAsk.mock.calls[1]![1]).toMatchObject({ kind: "question" });
    });

    it("tells onAsk once a snooze on an unchanged ask runs out", async () => {
      const onAsk = vi.fn();
      const h = await makeHarness({ classify: reading("approval", 0.97), onAsk });
      const snooze = { until: Date.now() + 60_000 } as unknown as FleetRunRow["snooze"];
      h.runs.push(run("a", { agentState: "waiting", snooze }));
      h.screens.set("a", APPROVAL_SCREEN);
      await h.service.refresh();
      expect(onAsk).not.toHaveBeenCalled();

      h.runs[0] = run("a", { agentState: "waiting" });
      await h.service.refresh();
      expect(h.classify).toHaveBeenCalledTimes(1);
      expect(onAsk).toHaveBeenCalledTimes(1);
    });

    it("re-judges a busy run in the background at the classifier's priority, its words due", async () => {
      let now = 1_000_000;
      const h = await makeHarness({ backgroundPollMs: 20_000, now: () => now });
      h.describe.mockImplementation(async (_input, says) => ({
        category: says,
        headline: "Editing store.ts",
        summary: "Working.",
        attentionScore: 5,
        task: null,
        risk: "unknown",
        riskReason: null,
        action: null,
        progress: null,
        tests: "unknown",
        changes: "unknown",
        question: null,
        options: [],
      }));
      h.classify.mockImplementation(reading("working", 0.05, 0.1));
      h.runs.push(run("a", { agentState: "working" }));
      h.screens.set("a", "• Editing store.ts (esc to interrupt)");
      await h.service.refresh();
      expect(h.service.getSnapshot().cards[0]!.priority).toBe(5);

      h.service.setActive(false);
      h.classify.mockImplementation(reading("working", 0.05, 0.9));
      now += CANOPY_REJUDGE_AFTER_MS + CANOPY_PROGRESS_DESCRIBE_MS;
      await h.service.refresh();
      const card = h.service.getSnapshot().cards[0]!;
      expect(card.priority).toBe(70);
      expect(card.wordsFromEarlierRead).toBe(true);
      expect(card.headline).toBe("Editing store.ts");
    });
  });
});

const INPUT_STUB: CanopyScreenInput = {
  agent: "claude",
  title: "",
  screen: "",
  lines: [],
  observed: { agentState: null, waitingReason: null, secondsInState: null },
};

describe("CanopyService input from outside the panel", () => {
  async function waitingOn(category: "approval" | "question" | "working") {
    const h = await makeHarness({
      classify: async () => ({
        category,
        confidence: 0.9,
        attention: category === "working" ? 0.1 : 0.95,
        question: null,
      }),
    });
    h.runs.push(run("a", { agentState: category === "working" ? "working" : "waiting" }));
    h.screens.set("a", "Do you want to proceed?\n 1. Yes\n 2. No");
    await h.service.scan();
    return h;
  }
  const card = (h: Awaited<ReturnType<typeof waitingOn>>) => h.service.getSnapshot().cards[0]!;

  it("answers an approval with a key that answers its menu", async () => {
    const h = await waitingOn("approval");
    expect(card(h).handledAt).toBeNull();
    h.service.noteInput("a", "key");
    expect(card(h)).toMatchObject({ priority: 0 });
    expect(card(h).handledAt).not.toBeNull();
  });

  it("answers a question only once the reply is sent", async () => {
    const h = await waitingOn("question");
    h.service.noteInput("a", "key");
    expect(card(h).handledAt).toBeNull();
    h.service.noteInput("a", "submit");
    expect(card(h).handledAt).not.toBeNull();
  });

  it("leaves a working agent's card alone when the user sends it a message", async () => {
    const h = await waitingOn("working");
    h.service.noteInput("a", "submit");
    expect(card(h).handledAt).toBeNull();
  });
});

describe("CanopyService across a resize", () => {
  const QUESTION =
    "⏺ The migration ran cleanly against staging, and the row counts match production. Shall I run it against production now, or wait for the release window tonight?";
  const TOOL =
    "⏺ Bash(npm run migrate -- --target staging --dry-run=false --batch-size 500 --verbose)";
  /** The question as Claude Code draws it at `cols`: prose wrapped, the tool line cut at the edge. */
  const drawn = (cols: number, question = QUESTION) => {
    const rows: string[] = [
      TOOL.length > cols ? `${TOOL.slice(0, cols - 2)}…)` : TOOL,
      "  ⎿  done",
    ];
    let row = "";
    for (const word of question.split(" ")) {
      if (row !== "" && row.length + 1 + word.length > cols) {
        rows.push(row);
        row = word;
      } else row = row === "" ? word : `${row} ${word}`;
    }
    rows.push(row, "", "─".repeat(cols), "❯ ", "─".repeat(cols));
    return rows.join("\n");
  };
  const asking = async (): Promise<Reading> => ({
    category: "question",
    confidence: 0.9,
    attention: 0.9,
    question: "Shall I run it against production now?",
  });

  async function readAt(cols: number) {
    let clock = 1_000_000;
    const h = await makeHarness({ now: () => clock, classify: asking });
    h.runs.push(run("a", { agentState: "waiting", waitingReason: "question" }));
    h.screens.set("a", drawn(cols));
    await h.service.scan();
    await settle();
    return { h, tick: (ms: number) => (clock += ms) };
  }

  it("leaves a screen redrawn for a new size alone: nothing read again, no new prompt", async () => {
    const { h, tick } = await readAt(120);
    expect(h.classify).toHaveBeenCalledTimes(1);
    const before = h.service.getSnapshot().cards[0]!;

    h.service.noteResize("a");
    // Mid-redraw: blank, then the new size's drawing.
    h.screens.set("a", "");
    tick(100);
    await h.service.scan();
    h.screens.set("a", drawn(64));
    tick(400);
    await h.service.scan();
    tick(CANOPY_REFLOW_MS);
    await h.service.scan();
    await settle();

    expect(h.classify).toHaveBeenCalledTimes(1);
    expect(h.describe).toHaveBeenCalledTimes(1);
    const after = h.service.getSnapshot().cards[0]!;
    expect(after.revision).toBe(before.revision);
    expect(after.headline).toBe(before.headline);
    expect(after.glance).toEqual(before.glance);

    // Something new after the redraw is still read.
    h.screens.set("a", drawn(64, QUESTION.replace("tonight", "on Friday")));
    tick(1_000);
    await h.service.scan();
    expect(h.classify).toHaveBeenCalledTimes(2);
  });

  it("reads a prompt that changed across a resize, once the redraw has settled", async () => {
    const { h, tick } = await readAt(120);
    h.service.noteResize("a");
    h.screens.set("a", drawn(64, QUESTION.replace("production now", "production at noon")));
    tick(500);
    await h.service.scan();
    expect(h.classify).toHaveBeenCalledTimes(1);
    tick(CANOPY_REFLOW_MS);
    await h.service.scan();
    expect(h.classify).toHaveBeenCalledTimes(2);
    expect(h.service.getSnapshot().cards[0]!.revision).toBeGreaterThan(0);
  });

  it("reads a screen that moved without a resize at once, as always", async () => {
    const { h, tick } = await readAt(120);
    h.screens.set("a", drawn(64));
    tick(500);
    await h.service.scan();
    expect(h.classify).toHaveBeenCalledTimes(2);
  });

  it("waits out a redraw that is still blank just past the wait, then matches what it draws", async () => {
    const { h, tick } = await readAt(120);
    h.service.noteResize("a");
    h.screens.set("a", "");
    tick(CANOPY_REFLOW_MS + 100);
    await h.service.scan();
    h.screens.set("a", drawn(64));
    tick(CANOPY_REFLOW_MS);
    await h.service.scan();
    await settle();
    expect(h.classify).toHaveBeenCalledTimes(1);
  });

  it("holds a first read until a resize before it has redrawn", async () => {
    let clock = 1_000_000;
    const h = await makeHarness({ now: () => clock, classify: asking });
    h.runs.push(run("a", { agentState: "waiting", waitingReason: "question" }));
    h.service.noteResize("a");
    h.screens.set("a", drawn(120).split("\n").slice(0, 3).join("\n"));
    clock += 200;
    await h.service.scan();
    expect(h.classify).not.toHaveBeenCalled();
    h.screens.set("a", drawn(120));
    clock += CANOPY_REFLOW_MS;
    await h.service.scan();
    expect(h.classify).toHaveBeenCalledTimes(1);
  });

  it("writes words owed on open from the redrawn screen, without reading it again", async () => {
    let clock = 1_000_000;
    const h = await makeHarness({
      now: () => clock,
      classify: asking,
      closed: true,
      backgroundPollMs: 60_000,
      history: new Map([["a", "⏺ Earlier work."]]),
    });
    h.runs.push(run("a", { agentState: "waiting", waitingReason: "question" }));
    h.screens.set("a", drawn(120));
    await h.service.scan();
    await settle();
    expect(h.classify).toHaveBeenCalledTimes(1);
    expect(h.describe).not.toHaveBeenCalled();

    h.service.noteResize("a");
    h.screens.set("a", drawn(64));
    clock += 500;
    await h.service.scan();
    clock += CANOPY_REFLOW_MS;
    await h.service.scan();
    h.service.setActive(true);
    await vi.waitFor(() => expect(h.describe).toHaveBeenCalledTimes(1));
    await settle();
    expect(h.classify).toHaveBeenCalledTimes(1);
    expect(h.describe.mock.calls[0]![0].screen).toContain("…)");
  });
});

describe("CanopyService reads", () => {
  const finishedReading: Reading = {
    category: "finished",
    confidence: 0.9,
    attention: 0.9,
    question: null,
  };
  const readOf = (h: Harness, runId = "a") =>
    h.service.getSnapshot().reads.find((mark) => mark.runId === runId);
  const unread = (h: Harness, runId = "a") => {
    const mark = readOf(h, runId);
    return mark !== undefined && (mark.markedUnreadAt !== null || mark.readTurn < mark.turn);
  };

  /** A run seen at work, then stopped on a new screen: one unread turn. */
  async function stoppedAfterWork() {
    const h = await makeHarness({
      classify: async (input) =>
        input.screen.includes("Working")
          ? { category: "working", confidence: 0.9, attention: 0.1, question: null }
          : finishedReading,
    });
    h.runs.push(run("a", { agentState: "working" }));
    h.screens.set("a", "Working on it");
    await h.service.scan();
    expect(unread(h)).toBe(false);
    h.runs[0] = run("a", { agentState: "completed" });
    h.screens.set("a", "All done.");
    await h.service.refresh();
    return h;
  }

  it("marks a run unread when it stops after work, and read when the user reads it", async () => {
    const h = await stoppedAfterWork();
    expect(unread(h)).toBe(true);
    const mark = readOf(h)!;
    h.service.setRead("a", 1, true, mark.turn);
    expect(unread(h)).toBe(false);
  });

  it("never reads a turn that landed after the one the user was shown", async () => {
    const h = await stoppedAfterWork();
    const shown = readOf(h)!.turn;
    // Back at work on its own, before the read reached main.
    h.runs[0] = run("a", { agentState: "working" });
    h.screens.set("a", "Working on the follow-up");
    await h.service.refresh();
    h.service.setRead("a", 1, true, shown);
    expect(unread(h)).toBe(true);
  });

  it("keeps a start the user sent from the panel read, once they had read the run", async () => {
    const h = await stoppedAfterWork();
    h.service.setRead("a", 1, true);
    h.service.noteUserSent("a", 1);
    h.runs[0] = run("a", { agentState: "working" });
    h.screens.set("a", "Working on what you asked");
    await h.service.refresh();
    expect(unread(h)).toBe(false);
  });

  it("marks all read through the turns the panel showed, and undoes only what is unchanged", async () => {
    const h = await stoppedAfterWork();
    const before = readOf(h)!;
    let [after] = h.service.markAllRead([{ runId: "a", spawnedAt: 1, turn: before.turn }]);
    expect(unread(h)).toBe(false);
    h.service.restoreReads([{ mark: before, expectVersion: after!.version }]);
    expect(unread(h)).toBe(true);
    // Read again, then something new: the undo no longer applies.
    [after] = h.service.markAllRead([{ runId: "a", spawnedAt: 1, turn: before.turn }]);
    h.runs[0] = run("a", { agentState: "working" });
    h.screens.set("a", "Working on the next part");
    await h.service.refresh();
    h.service.setRead("a", 1, true);
    h.service.restoreReads([{ mark: before, expectVersion: after!.version }]);
    expect(unread(h)).toBe(false);
  });

  it("keeps a run marked unread by hand while it is still being looked at", async () => {
    let now = 1_000_000;
    const h = await makeHarness({ now: () => now });
    h.runs.push(run("a", { agentState: "working" }));
    h.screens.set("a", "Working on it");
    await h.service.scan();
    h.service.markSeen("a", { viewId: 1, place: "pane", looking: true });
    now += 5_000;
    h.service.setRead("a", 1, false);
    now += 5_000;
    h.service.markSeen("a", { viewId: 1, place: "pane", looking: false });
    expect(unread(h)).toBe(true);
    // Coming back to it and staying a while reads it.
    h.service.markSeen("a", { viewId: 1, place: "pane", looking: true });
    now += 5_000;
    h.service.markSeen("a", { viewId: 1, place: "pane", looking: false });
    expect(unread(h)).toBe(false);
  });

  it("reads nothing for a glance shorter than the dwell, nor for a view that went away", async () => {
    let now = 1_000_000;
    const h = await stoppedAfterWork();
    h.service.dispose();
    const g = await makeHarness({
      now: () => now,
      classify: async (input) =>
        input.screen.includes("Working")
          ? { category: "working", confidence: 0.9, attention: 0.1, question: null }
          : finishedReading,
    });
    g.runs.push(run("a", { agentState: "completed" }));
    g.screens.set("a", "All done.");
    await g.service.scan();
    expect(unread(g)).toBe(true);
    g.service.markSeen("a", { viewId: 1, place: "pane", looking: true });
    now += 200;
    g.service.markSeen("a", { viewId: 1, place: "pane", looking: false });
    expect(unread(g)).toBe(true);

    g.service.markSeen("a", { viewId: 2, place: "pane", looking: true });
    g.service.forgetViewer(2);
    now += 10_000;
    g.service.markSeen("a", { viewId: 2, place: "pane", looking: false });
    expect(unread(g)).toBe(true);
  });

  it("keeps a look in a view's grid pane apart from one in its Canopy panel", async () => {
    let now = 1_000_000;
    const h = await makeHarness({ now: () => now });
    h.runs.push(run("a", { agentState: "working" }));
    h.screens.set("a", "Working on it");
    await h.service.scan();
    h.service.setRead("a", 1, false);
    now += 1;
    // Canopy closes onto the pane showing the same run: the pane's look can
    // start before the panel's has ended.
    h.service.markSeen("a", { viewId: 1, place: "panel", looking: true });
    h.service.markSeen("a", { viewId: 1, place: "pane", looking: true });
    h.service.markSeen("a", { viewId: 1, place: "panel", looking: false });
    now += 5_000;
    h.service.markSeen("a", { viewId: 1, place: "pane", looking: false });
    expect(unread(h)).toBe(false);
  });

  it("reads a run once someone has looked at it for the dwell", async () => {
    // Read through Date each time, so the faked clock below reaches the service.
    const h = await makeHarness({ classify: async () => finishedReading, now: () => Date.now() });
    h.runs.push(run("a", { agentState: "completed" }));
    h.screens.set("a", "All done.");
    await h.service.scan();
    expect(unread(h)).toBe(true);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      h.service.markSeen("a", { viewId: 1, place: "pane", looking: true });
      vi.advanceTimersByTime(1_000);
      expect(unread(h)).toBe(true);
      vi.advanceTimersByTime(1_000);
      expect(unread(h)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("archives a run as read, and brings it back unread when it has something new to say", async () => {
    const h = await stoppedAfterWork();
    h.service.archive("a", 1);
    expect(unread(h)).toBe(false);
    h.runs[0] = run("a", { agentState: "working" });
    h.screens.set("a", "Working on the next step");
    await h.service.refresh();
    h.service.setRead("a", 1, true);
    h.runs[0] = run("a", { agentState: "completed" });
    h.screens.set("a", "Finished the next step.");
    await h.service.refresh();
    expect(h.service.getSnapshot().dispositions).toEqual([]);
    expect(unread(h)).toBe(true);
  });

  it("marks the first question of a run first seen idle unread", async () => {
    const h = await makeHarness({
      classify: async (input) =>
        input.screen.includes("format")
          ? { category: "question", confidence: 0.9, attention: 0.9, question: "Which format?" }
          : { category: "idle", confidence: 0.9, attention: 0.1, question: null },
    });
    h.runs.push(run("a", { agentState: "idle" }));
    h.screens.set("a", "Welcome to Claude Code");
    await h.service.scan();
    expect(unread(h)).toBe(false);
    // It asks with no start Daintree saw.
    h.screens.set("a", "Which format should the entry use?");
    await h.service.refresh();
    expect(unread(h)).toBe(true);
  });

  it("marks work that started and ended between two reads unread", async () => {
    const h = await makeHarness({ classify: async () => finishedReading, now: () => Date.now() });
    h.runs.push(run("a", { agentState: "idle" }));
    h.screens.set("a", "Welcome to Claude Code");
    await h.service.scan();
    expect(unread(h)).toBe(false);
    // Only the fleet saw it at work, for longer than a flicker — timed by when
    // main heard of each change, since a run's own times can be stale.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      h.runs[0] = run("a", { agentState: "working", since: 1 });
      h.service.onFleetChanged();
      vi.setSystemTime(Date.now() + 5_000);
      h.runs[0] = run("a", { agentState: "completed", since: 1 });
      h.service.onFleetChanged();
    } finally {
      vi.useRealTimers();
    }
    h.screens.set("a", "Done: renamed the helper.");
    await h.service.refresh();
    expect(unread(h)).toBe(true);
  });

  it("keeps a start the user sent from the run's own pane read, but not input from anything else", async () => {
    const own = await stoppedAfterWork();
    own.service.setRead("a", 1, true);
    own.service.noteUserSentTo("a");
    own.runs[0] = run("a", { agentState: "working" });
    own.screens.set("a", "Working on what you typed");
    await own.service.refresh();
    expect(unread(own)).toBe(false);
    own.service.dispose();

    // An action or a broadcast submits while someone has the run on screen:
    // what it sets going is still news.
    const other = await stoppedAfterWork();
    other.service.setRead("a", 1, true);
    other.service.markSeen("a", { viewId: 1, place: "pane", looking: true });
    other.service.noteInput("a", "submit");
    other.service.markSeen("a", { viewId: 1, place: "pane", looking: false });
    other.runs[0] = run("a", { agentState: "working" });
    other.screens.set("a", "Working on the broadcast");
    await other.service.refresh();
    expect(unread(other)).toBe(true);
  });

  it("archives again on an undo only while the run has done nothing since", async () => {
    const h = await stoppedAfterWork();
    const turn = readOf(h)!.turn;
    h.runs[0] = run("a", { agentState: "working" });
    h.screens.set("a", "Working on the next part");
    await h.service.refresh();
    expect(h.service.archive("a", 1, turn)).toBeNull();
    expect(h.service.getSnapshot().dispositions).toEqual([]);
    expect(h.service.archive("a", 1, readOf(h)!.turn)).not.toBeNull();
  });

  it("answers an archive with the mark it left, for an undo to restore", async () => {
    const h = await stoppedAfterWork();
    const before = readOf(h)!;
    const after = h.service.archive("a", 1)!;
    expect(after.readTurn).toBe(after.turn);
    h.service.unarchive("a", 1);
    h.service.restoreReads([{ mark: before, expectVersion: after.version }]);
    expect(unread(h)).toBe(true);
  });

  it("starts a respawned terminal with nothing unread from the one before", async () => {
    const h = await stoppedAfterWork();
    expect(unread(h)).toBe(true);
    h.runs[0] = run("a", { spawnedAt: 2, agentState: "working" });
    h.service.onFleetChanged();
    expect(readOf(h)).toBeUndefined();
    h.service.setRead("a", 1, true);
    expect(readOf(h)).toBeUndefined();
  });
});
