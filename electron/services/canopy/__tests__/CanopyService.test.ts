import { afterEach, describe, expect, it, vi } from "vitest";
import type { FleetRunRow } from "../../../../shared/types/ipc/fleet.js";
import type {
  CanopyCategory,
  CanopyPlan,
  CanopySnapshot,
} from "../../../../shared/types/ipc/canopy.js";
import {
  CANOPY_CLASSIFIER_ANCHORS,
  CANOPY_POLL_MS,
  CANOPY_PROGRESS_DESCRIBE_MS,
  CANOPY_REJUDGE_AFTER_MS,
  CANOPY_SETTLE_MS,
  CANOPY_STALL_MS,
  CANOPY_TRANSIENT_GRACE_MS,
  CANOPY_FAILURE_BACKOFF_MAX_MS,
  CanopyService,
  failureMessage,
  type CanopyServiceDeps,
} from "../CanopyService.js";
import {
  CanopyProviderError,
  type ClassifierResult,
  type DescriberResult,
  type CanopyScreenInput,
} from "../canopyProviders.js";
import { CANOPY_REFLOW_MS } from "../canopyReflow.js";
import { CANOPY_TURN_HOLD_MS } from "../canopyReads.js";

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
  /** Every request's abort signal, classifier and describer alike, in the order made. */
  signals: AbortSignal[];
  classify: ReturnType<typeof vi.fn<(input: CanopyScreenInput) => Promise<Reading>>>;
  describe: ReturnType<typeof vi.fn<DescribeFn>>;
  snapshots: CanopySnapshot[];
}

/** The words half of a reading, as each test wants it. */
type DescribeFn = (input: CanopyScreenInput, says: CanopyCategory) => Promise<DescriberResult>;

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
  readerName?: () => string;
  readerReady?: () => boolean;
  /** Leave the panel closed after construction. */
  closed?: boolean;
  /** False while the fleet should read as unknown (degraded). */
  fleetKnown?: () => boolean;
  /** Awaited before every screen read, to hold a scan part way. */
  screenGate?: () => Promise<void>;
  onRefinementsChanged?: () => void;
  getTrash?: CanopyServiceDeps["getTrash"];
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
  const signals: AbortSignal[] = [];
  const deps: CanopyServiceDeps = {
    // Most tests read each change at once; the floor has tests of its own.
    rereadMs: options.rereadMs ?? 0,
    getRuns: () => (options.fleetKnown?.() === false ? null : runs),
    readScreen: async (runId) => {
      await options.screenGate?.();
      return screens.get(runId) ?? null;
    },
    // A real history read is the scrollback above the screen and the screen itself.
    ...(options.history
      ? {
          readHistory: async (runId: string) =>
            `${options.history!.get(runId) ?? ""}\n${screens.get(runId) ?? ""}`,
        }
      : {}),
    // One reading gives the verdict and the words together: the two mocks
    // stand for its two halves.
    read: async (input, signal) => {
      signals.push(signal);
      const classifier = withBlocked(await classify(input));
      return { classifier, words: () => describe(input, classifier.category) };
    },
    broadcast: (snapshot) => snapshots.push(snapshot),
    ...(options.now ? { now: options.now } : {}),
    closeGraceMs: options.closeGraceMs ?? 0,
    ...(options.plan ? { plan: options.plan } : {}),
    backgroundPollMs: options.backgroundPollMs ?? 0,
    ...(options.onAsk ? { onAsk: options.onAsk } : {}),
    ...(options.readerName ? { readerName: options.readerName } : {}),
    ...(options.readerReady ? { readerReady: options.readerReady } : {}),
    ...(options.onRefinementsChanged ? { onRefinementsChanged: options.onRefinementsChanged } : {}),
    ...(options.getTrash ? { getTrash: options.getTrash } : {}),
    ...(options.stateChangeScanMs !== undefined
      ? { stateChangeScanMs: options.stateChangeScanMs }
      : {}),
  };
  harness = {
    service: new CanopyService(deps),
    screens,
    runs,
    signals,
    classify,
    describe,
    snapshots,
  };
  if (!options.closed) harness.service.setActive(true);
  await settle();
  return harness;
}

afterEach(() => {
  harness?.service.dispose();
  harness = null;
});

describe("CanopyService trash", () => {
  it("carries the host's trash on its snapshot, and tells every view when it changes", async () => {
    let trash: NonNullable<CanopySnapshot["trash"]> = [];
    const { service, snapshots } = await makeHarness({ getTrash: () => trash });
    expect(service.getSnapshot().trash).toEqual([]);
    // The opening's own broadcast goes out first, so the next one is the trash's.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const before = snapshots.length;
    trash = [
      {
        run: { runId: "t1", workspaceId: "p2", spawnedAt: 1, cwd: "/repo" },
        trashedAt: 10,
        expiresAt: 20_010,
      },
    ];
    await new Promise((resolve) => setTimeout(resolve, 100));
    // Nothing tells a view of the change but the call that says it.
    expect(snapshots.length).toBe(before);
    service.trashChanged();
    await vi.waitFor(() => expect(snapshots.length).toBeGreaterThan(before));
    expect(snapshots.at(-1)?.trash?.map((entry) => entry.run.runId)).toEqual(["t1"]);
    // Nothing new in it: no view is woken for the same list.
    const after = snapshots.length;
    service.trashChanged();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(snapshots.length).toBe(after);
  });
});

const APPROVAL_SCREEN = [
  "⏺ Bash(npm test)",
  "Do you want to proceed?",
  "❯ 1. Yes",
  "  2. No, and tell Claude what to do differently (esc)",
].join("\n");

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
      // The describer's 3 sits within a couple of points of the classifier's
      // 5 already shown, in the same step: the shown number stands.
      priority: 5,
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

  it("counts readings while they are under way, and times the ones that answer", async () => {
    let clock = 1_000;
    const gates: Array<() => void> = [];
    const gate = () => new Promise<void>((resolve) => gates.push(resolve));
    const h = await makeHarness({
      now: () => clock,
      readerName: () => "Light",
      classify: async () => {
        await gate();
        return { category: "working", confidence: 0.99, attention: 0.1, question: null };
      },
    });
    const reader = () => h.service.getSnapshot().reader;
    expect(reader()).toEqual({ model: "Light", inFlight: 0, readMs: null });
    h.runs.push(run("a"), run("b"));
    h.screens.set("a", "Building the parser");
    h.screens.set("b", "Writing the tests");
    const scan = h.service.scan();
    await vi.waitFor(() => expect(reader()?.inFlight).toBe(2));
    clock += 30;
    gates.shift()!();
    await vi.waitFor(() => expect(reader()).toMatchObject({ inFlight: 1, readMs: 30 }));
    clock += 20;
    gates.shift()!();
    await scan;
    // Read at 30 ms and 50 ms: the bar says their mean.
    await vi.waitFor(() => expect(reader()).toMatchObject({ inFlight: 0, readMs: 40 }));
  });

  it("lets a failed reading go without counting it out or timing it", async () => {
    let clock = 1_000;
    let fail = true;
    const h = await makeHarness({
      now: () => clock,
      readerName: () => "Light",
      classify: async () => {
        clock += 5_000;
        if (fail) throw new Error("the model stopped");
        return { category: "idle", confidence: 0.99, attention: 0.1, question: null };
      },
    });
    h.runs.push(run("a", { agentState: "idle" }));
    h.screens.set("a", "dev@studio app % ");
    await h.service.scan();
    expect(h.service.getSnapshot().reader).toMatchObject({ inFlight: 0, readMs: null });
    // Tried again past its backoff, the answer is the first time there is.
    fail = false;
    clock += 10 * 60_000;
    await h.service.scan();
    await vi.waitFor(() =>
      expect(h.service.getSnapshot().reader).toMatchObject({ inFlight: 0, readMs: 5_000 })
    );
  });

  it("says nothing of the reader until Canopy is turned on", async () => {
    const h = await makeHarness({
      readerName: () => "Light",
      plan: { mode: "unset", activated: false },
    });
    expect(h.service.getSnapshot().reader).toBeUndefined();
  });

  it("forgets every reading the last model made once the model changes, and reads afresh", async () => {
    let category: CanopyCategory = "approval";
    const h = await makeHarness({
      classify: async () => ({
        category,
        confidence: 0.95,
        attention: category === "approval" ? 0.95 : 0.1,
        question: category === "approval" ? "Do you want to proceed?" : null,
      }),
    });
    h.runs.push(run("a", { agentState: "waiting" }));
    h.screens.set("a", APPROVAL_SCREEN);
    await h.service.scan();
    await vi.waitFor(() => expect(h.service.getSnapshot().cards[0]?.category).toBe("approval"));
    // The next model reads the very same screen otherwise.
    category = "idle";
    h.service.readerChanged();
    // Nothing of the last model's reading stands meanwhile, the screen's own words aside.
    expect(h.service.getSnapshot().cards).toEqual([]);
    await vi.waitFor(() => expect(h.service.getSnapshot().cards[0]?.category).toBe("idle"));
    expect(h.classify).toHaveBeenCalledTimes(2);
  });

  it("reads nothing while the model isn't here, and every screen once it arrives", async () => {
    let ready = false;
    const h = await makeHarness({ readerReady: () => ready });
    h.runs.push(run("a"));
    h.screens.set("a", "Building the parser");
    await h.service.scan();
    expect(h.classify).not.toHaveBeenCalled();
    // The row still shows the screen's own words meanwhile.
    expect(h.service.getSnapshot().glances.map((g) => g.runId)).toEqual(["a"]);
    ready = true;
    h.service.readerChanged();
    await vi.waitFor(() => expect(h.classify).toHaveBeenCalledTimes(1));
    await vi.waitFor(() =>
      expect(h.service.getSnapshot().cards.map((card) => card.runId)).toEqual(["a"])
    );
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
    const h = await makeHarness({ plan: { mode: "unset", activated: false } });
    h.runs.push(run("a"));
    h.screens.set("a", APPROVAL_SCREEN);
    await h.service.refresh();
    expect(h.classify).not.toHaveBeenCalled();
    expect(h.service.getSnapshot()).toMatchObject({ activated: false, cards: [] });

    h.service.setPlan({ mode: "on", activated: true });
    await settle();
    await settle();
    expect(h.classify).toHaveBeenCalledTimes(1);
    expect(h.service.getSnapshot().cards).toHaveLength(1);

    h.service.setPlan({ mode: "unset", activated: false });
    // Every reading of the screen goes, the at-a-glance words included.
    expect(h.service.getSnapshot()).toMatchObject({
      activated: false,
      cards: [],
      glances: [],
      lastError: null,
    });
  });

  it("reads the free tier as soon and as often as the priority one", async () => {
    const h = await makeHarness({ plan: { mode: "on", activated: true } });
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
    let clock = 1_000_000;
    const h = await makeHarness({
      now: () => clock,
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
    clock += CANOPY_TURN_HOLD_MS;
    h.runs[0] = run("a", { agentState: "completed" });
    h.service.onFleetChanged();
    h.screens.set("a", "Done with the next part.");
    await h.service.refresh();
    expect(h.service.getSnapshot().dispositions).toEqual([]);
  });

  it("brings back an archived run whose new ask was read while its work went on, once that work ends", async () => {
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
    h.runs.push(run("a", { agentState: "waiting", waitingReason: "approval" }));
    h.screens.set("a", APPROVAL_SCREEN);
    await h.service.scan();
    h.service.archive("a", 1);
    // Its next approval is read before the work in between has held long enough to count.
    h.runs[0] = run("a", { agentState: "working", since: clock });
    h.service.onFleetChanged();
    h.screens.set("a", APPROVAL_SCREEN.replace("npm test", "npm run build"));
    await h.service.refresh();
    expect(h.service.getSnapshot().dispositions).toHaveLength(1);
    clock += CANOPY_TURN_HOLD_MS;
    h.runs[0] = run("a", { agentState: "waiting", waitingReason: "approval", since: clock });
    h.service.onFleetChanged();
    await h.service.refresh();
    expect(h.service.getSnapshot().dispositions).toEqual([]);
  });

  it("brings back an archived run once a read while it still works shows that work held", async () => {
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
    h.runs.push(run("a", { agentState: "waiting", waitingReason: "approval" }));
    h.screens.set("a", APPROVAL_SCREEN);
    await h.service.scan();
    h.service.archive("a", 1);
    h.runs[0] = run("a", { agentState: "working", since: clock });
    h.service.onFleetChanged();
    h.screens.set("a", APPROVAL_SCREEN.replace("npm test", "npm run build"));
    await h.service.refresh();
    expect(h.service.getSnapshot().dispositions).toHaveLength(1);
    // Daintree still sees it working, now for longer than a flicker.
    clock += CANOPY_TURN_HOLD_MS;
    await h.service.refresh();
    expect(h.service.getSnapshot().dispositions).toEqual([]);
  });

  it("keeps a run put aside through a flicker of work, its screen moving or not", async () => {
    let clock = 1_000_000;
    const h = await makeHarness({
      now: () => clock,
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
    // Output alone — a recap drawn under the finished turn — flips the state for a moment.
    h.runs[0] = run("a", { agentState: "working" });
    h.service.onFleetChanged();
    clock += 200;
    h.runs[0] = run("a", { agentState: "completed" });
    h.service.onFleetChanged();
    h.screens.set("a", "Done.\n※ recap: fixed the rounding bug");
    await h.service.refresh();
    expect(h.service.getSnapshot().dispositions).toHaveLength(1);
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

  it("keeps reading a run that leaves the panel's scope, words and all", async () => {
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
        // The first read of B is still with the service when the scope changes.
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
    await settle();
    // B's reading lands with its words: they come with every reading, so a
    // run out of the panel's sight is as full as one in it.
    h.service.setScope(null);
    await settle();
    // Not read again for coming back into scope.
    expect(h.classify).toHaveBeenCalledTimes(2);
    expect(h.service.getSnapshot().cards.every((card) => card.headline === "Headline")).toBe(true);
    expect(
      h.service
        .getSnapshot()
        .cards.map((card) => card.runId)
        .sort()
    ).toEqual(["a", "b"]);
  });

  it("reads the panel's project at its pace, and the rest at the watch's", async () => {
    let clock = 1_000_000;
    const onAsk = vi.fn();
    const h = await makeHarness({
      now: () => clock,
      backgroundPollMs: 15_000,
      onAsk,
      classify: async (input) =>
        input.screen.startsWith("B")
          ? { category: "approval", confidence: 0.98, attention: 0.95, question: "Ship it?" }
          : { category: "idle", confidence: 0.9, attention: 0.1, question: null },
    });
    h.runs.push(run("a", { workspaceId: "one" }), run("b", { workspaceId: "two" }));
    h.screens.set("a", "A");
    h.screens.set("b", "B");
    h.service.setScope("one");
    await settle();
    clock += 15_000;
    await h.service.refresh();
    await settle();
    const classified = () => h.classify.mock.calls.map(([input]) => input.screen).sort();
    expect(classified()).toEqual(["A", "B"]);
    // The ask in the project the panel doesn't show still pages.
    expect(onAsk).toHaveBeenCalledTimes(1);

    // A change there waits for the watch's next read, not the panel's.
    h.screens.set("b", "B, moved");
    h.screens.set("a", "A, moved");
    clock += CANOPY_POLL_MS;
    await h.service.scan();
    expect(classified()).toEqual(["A", "A, moved", "B"]);
    clock += 15_000;
    await h.service.scan();
    expect(classified()).toEqual(["A", "A, moved", "B", "B, moved"]);
  });

  it("reads only the screens in scope while the background watch is off", async () => {
    const h = await makeHarness({ backgroundPollMs: 0 });
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

    h.service.setPlan({ mode: "unset", activated: false });
    h.service.setPlan({ mode: "on", activated: true });
    release();
    await scan;
    await settle();
    await h.service.refresh();
    expect(calls).toBe(2);
    // Nothing the abandoned pass read lands, or goes on to the describer.
    expect(h.service.getSnapshot().cards.map((card) => card.category)).toEqual(["working"]);
    expect(h.describe.mock.calls.some(([, says]) => says === "question")).toBe(false);
  });

  it("sends nothing while no panel is open and the background watch is off", async () => {
    const h = await makeHarness({ backgroundPollMs: 0 });
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

    it("never asks the classifier again about a screen it read, when Daintree's state only catches up", async () => {
      let clock = 1_000_000;
      const h = await makeHarness({
        now: () => clock,
        classify: async () => ({
          category: "question",
          confidence: 0.95,
          attention: 0.95,
          question: "Which date format should the entry use?",
        }),
      });
      h.runs.push(run("a", { agentState: "working" }));
      h.screens.set("a", "⏺ Which date format should the entry use?\n\n✻ Worked for 3s · done");
      await h.service.scan();
      await settle();
      expect(h.classify).toHaveBeenCalledTimes(1);

      clock += 6_000;
      h.runs[0] = run("a", { agentState: "waiting", waitingReason: "question", since: clock });
      await h.service.scan();
      await settle();
      expect(h.classify).toHaveBeenCalledTimes(1);
      // And it is read as it should be the next time its screen moves.
      h.screens.set("a", "⏺ Which date format should the changelog use?\n\n✻ Worked for 3s · done");
      clock += 1_000;
      await h.service.scan();
      expect(h.classify).toHaveBeenCalledTimes(2);
    });

    it("keeps an approval it was sure of without reading it again, its priority and page as they were", async () => {
      let clock = 1_000_000;
      const onAsk = vi.fn();
      const h = await makeHarness({
        now: () => clock,
        onAsk,
        classify: async () => ({
          category: "approval",
          confidence: 0.95,
          attention: 0.95,
          blocked: 0.97,
          question: "Do you want to proceed?",
        }),
      });
      h.runs.push(run("a", { agentState: "working" }));
      h.screens.set("a", APPROVAL_SCREEN);
      await h.service.scan();
      await settle();
      const before = h.service.getSnapshot().cards[0]!;
      clock += 6_000;
      h.runs[0] = run("a", { agentState: "waiting", waitingReason: "approval", since: clock });
      await h.service.scan();
      await settle();
      expect(h.classify).toHaveBeenCalledTimes(1);
      const after = h.service.getSnapshot().cards[0]!;
      expect(after.priority).toBe(before.priority);
      expect(after.revision).toBe(before.revision);
      expect(onAsk).toHaveBeenCalledTimes(1);
    });

    it("still retries words a passing failure cut short, though Daintree has caught up since", async () => {
      let clock = 1_000_000;
      let fail = true;
      const h = await makeHarness({
        now: () => clock,
        classify: async () => ({
          category: "question",
          confidence: 0.95,
          attention: 0.95,
          question: "Which date format should the entry use?",
        }),
        describe: async (_input, says) => {
          if (fail) throw new CanopyProviderError("describer", "request timed out", true);
          return {
            category: says,
            headline: "Choose the date format",
            summary: "The entry waits on it.",
            attentionScore: 90,
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
        },
      });
      h.runs.push(run("a", { agentState: "working" }));
      h.screens.set("a", "⏺ Which date format should the entry use?\n\n✻ Worked for 3s · done");
      await h.service.scan();
      await settle();
      expect(h.describe).toHaveBeenCalledTimes(1);
      fail = false;
      clock += 6_000;
      h.runs[0] = run("a", { agentState: "waiting", waitingReason: "question", since: clock });
      await h.service.scan();
      clock += CANOPY_FAILURE_BACKOFF_MAX_MS;
      await h.service.scan();
      await settle();
      expect(h.describe).toHaveBeenCalledTimes(2);
      expect(h.service.getSnapshot().cards[0]!.headline).toBe("Choose the date format");
    });

    it("reads an approval it was unsure blocks the agent again once Daintree sees it waiting on one", async () => {
      let clock = 1_000_000;
      const h = await makeHarness({
        now: () => clock,
        classify: async () => ({
          category: "approval",
          confidence: 0.95,
          attention: 0.95,
          blocked: 0.6,
          question: "Do you want to proceed?",
        }),
      });
      h.runs.push(run("a", { agentState: "working" }));
      h.screens.set("a", APPROVAL_SCREEN);
      await h.service.scan();
      await settle();
      clock += 6_000;
      h.runs[0] = run("a", { agentState: "waiting", waitingReason: "approval", since: clock });
      await h.service.scan();
      await settle();
      expect(h.classify).toHaveBeenCalledTimes(2);
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
    // Its words are not coming: the row draws none as on their way.
    expect(h.service.getSnapshot().cards[0]!.describing).toBe(false);
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
        if (describes === 1) throw new CanopyProviderError("classifier", "the model stopped", true);
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
        if (fail) throw new CanopyProviderError("classifier", "the model stopped", true);
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
    h.screens.set("a", `⏺ Read 2 files\n${APPROVAL_SCREEN}`);
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
    expect(h.service.getSnapshot().lastError).toBe("Canopy couldn't read some screens.");

    // A failing service is not asked again on the very next poll.
    fail = false;
    await h.service.scan();
    expect(h.classify).toHaveBeenCalledTimes(1);
    clock += CANOPY_FAILURE_BACKOFF_MAX_MS;
    await h.service.scan();
    expect(h.classify).toHaveBeenCalledTimes(2);
    expect(h.service.getSnapshot().lastError).toBeNull();
  });

  it("reads at once when turned back on after a failure, rather than waiting out the old backoff", async () => {
    const clock = 1_000_000;
    let fail = true;
    const h = await makeHarness({
      now: () => clock,
      classify: async () => {
        if (fail) throw new Error("down");
        return { category: "working", confidence: 0.9, attention: 0.9, question: null };
      },
    });
    h.runs.push(run("a"));
    h.screens.set("a", "screen");
    await h.service.scan();
    expect(h.service.getSnapshot().lastError).not.toBeNull();

    fail = false;
    h.service.setPlan({ mode: "unset", activated: false });
    h.service.setPlan({ mode: "on", activated: true });
    await settle();
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
    expect(h.service.getSnapshot().lastError).toBe(
      "Canopy's model took too long to read a screen."
    );
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
      lastError: "Canopy couldn't read some screens.",
      failedRuns: ["a"],
    });
    h.screens.set("b", "fine, and moving");
    await h.service.scan();
    expect(h.service.getSnapshot().lastError).toBe("Canopy couldn't read some screens.");

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
        if (fail) throw new CanopyProviderError("classifier", "the model stopped", true);
        return { category: "working", confidence: 0.9, attention: 0.9, question: null };
      },
    });
    h.runs.push(run("a"));
    h.screens.set("a", "screen");
    await h.service.scan();
    // A reader restarting: not a failure yet, and the screen is tried again.
    expect(h.service.getSnapshot().lastError).toBeNull();
    expect(h.service.getSnapshot().failedRuns).toEqual([]);
    clock += CANOPY_FAILURE_BACKOFF_MAX_MS;
    await h.service.scan();
    expect(h.classify).toHaveBeenCalledTimes(2);

    clock += CANOPY_TRANSIENT_GRACE_MS;
    await h.service.scan();
    expect(h.service.getSnapshot().lastError).toBe(
      "Canopy's model stopped running. Turn Canopy off and on to try again."
    );

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

  it("keeps an outage one spell when the background watch only reads every few minutes", async () => {
    let clock = 1_000_000;
    const h = await makeHarness({
      now: () => clock,
      closed: true,
      backgroundPollMs: 120_000,
      classify: async () => {
        throw new CanopyProviderError("classifier", "request timed out", true);
      },
    });
    h.runs.push(run("a"));
    h.screens.set("a", "screen");
    await h.service.scan();
    clock += 120_000;
    await h.service.scan();
    expect(h.service.getSnapshot().lastError).toBe(
      "Canopy's model took too long to read a screen."
    );
  });

  it("drops what a retired spell reported once a new one begins", async () => {
    let clock = 1_000_000;
    const h = await makeHarness({
      now: () => clock,
      classify: async () => {
        throw new CanopyProviderError("classifier", "request timed out", true);
      },
    });
    h.runs.push(run("a"));
    h.screens.set("a", "screen");
    await h.service.scan();
    clock += CANOPY_TRANSIENT_GRACE_MS;
    h.screens.set("a", "screen, moved");
    await h.service.scan();
    expect(h.service.getSnapshot().lastError).not.toBeNull();
    // Not read for an hour, then a passing failure: a new spell, in its grace.
    clock += 60 * 60_000;
    h.screens.set("a", "screen, an hour on");
    await h.service.scan();
    expect(h.service.getSnapshot().lastError).toBeNull();
  });

  it("gives a failure long after the last its own grace, as a new spell", async () => {
    let clock = 1_000_000;
    const h = await makeHarness({
      now: () => clock,
      classify: async () => {
        throw new CanopyProviderError("classifier", "request timed out", true);
      },
    });
    h.runs.push(run("a"));
    h.screens.set("a", "screen");
    await h.service.scan();
    // Nothing asked of the service for an hour — the panel closed, the watch off.
    clock += 60 * 60_000;
    h.screens.set("a", "screen, later");
    await h.service.scan();
    // One passing failure is not yet worth a word.
    expect(h.service.getSnapshot().lastError).toBeNull();
  });

  it("says a failed read in the user's words, never a stage or an internal message", () => {
    const said = (message: string, transient = false) =>
      failureMessage(new CanopyProviderError("classifier", message, transient));
    expect(said("model not downloaded", true)).toBe("Canopy's model isn't downloaded yet.");
    expect(said("the model stopped", true)).toBe(
      "Canopy's model stopped running. Turn Canopy off and on to try again."
    );
    expect(said("the model keeps failing to run")).toBe(
      "Canopy's model stopped running. Turn Canopy off and on to try again."
    );
    expect(said("Read timed out", true)).toBe("Canopy's model took too long to read a screen.");
    expect(said("unexpected category")).toBe("Canopy's model couldn't read some screens.");
    for (const message of ["the model stopped", "unexpected category", "Read timed out"]) {
      expect(said(message)).not.toMatch(/describer|classifier|_/i);
    }
  });

  it("says reads are held up while a failed read waits to be tried again", async () => {
    const h = await makeHarness({
      classify: async () => {
        throw new CanopyProviderError("classifier", "the model stopped", true);
      },
    });
    expect(h.service.getSnapshot().waiting).toBeUndefined();
    h.runs.push(run("a"));
    h.screens.set("a", "screen");
    await h.service.scan();
    expect(h.service.getSnapshot()).toMatchObject({ waiting: "retrying", lastError: null });
  });

  it("reads one unchanged screen again on request, words included, as the same prompt", async () => {
    const h = await makeHarness({
      classify: async () => ({
        category: "approval",
        confidence: 0.95,
        attention: 0.95,
        question: "Do you want to proceed?",
      }),
    });
    h.runs.push(run("a", { agentState: "waiting", waitingReason: "approval" }));
    h.screens.set("a", APPROVAL_SCREEN);
    await h.service.refresh();
    const before = h.service.getSnapshot().cards[0]!;
    expect(h.describe).toHaveBeenCalledTimes(1);

    // Unchanged: a refresh reads nothing new.
    await h.service.refresh();
    expect(h.classify).toHaveBeenCalledTimes(1);

    expect(await h.service.reread("a", before.spawnedAt)).toBe(true);
    expect(h.classify).toHaveBeenCalledTimes(2);
    expect(h.describe).toHaveBeenCalledTimes(2);
    // The same prompt: nothing about it reads as new.
    expect(h.service.getSnapshot().cards[0]!.revision).toBe(before.revision);
    // Another incarnation's request is refused.
    expect(await h.service.reread("a", before.spawnedAt + 1)).toBe(false);
  });

  it.each([
    ["a finished turn the classifier thinks needs nothing", "finished", 0.2],
    ["an idle session", "idle", 0.1],
  ] as const)(
    "reads %s again, words included, keeping its words until new ones land",
    async (_label, category, attention) => {
      const h = await makeHarness({
        classify: async () => ({ category, confidence: 0.9, attention, question: null }),
      });
      h.runs.push(run("a", { agentState: "completed" }));
      h.screens.set("a", "All done. Committed as abc123.");
      await h.service.refresh();
      const describedBefore = h.describe.mock.calls.length;
      const spawnedAt = h.runs[0]!.spawnedAt;
      expect(await h.service.reread("a", spawnedAt)).toBe(true);
      expect(h.classify).toHaveBeenCalledTimes(2);
      expect(h.describe.mock.calls.length).toBe(describedBefore + 1);
      expect(h.service.getSnapshot().cards[0]!.headline).toBe("Headline");
    }
  );

  it("reads a replied run again on request, without bringing it back unread", async () => {
    const h = await makeHarness({
      classify: async () => ({
        category: "question",
        confidence: 0.95,
        attention: 0.95,
        question: "Push now?",
      }),
    });
    h.runs.push(run("a", { agentState: "waiting", waitingReason: "question" }));
    h.screens.set("a", "Push now?");
    await h.service.refresh();
    const spawnedAt = h.runs[0]!.spawnedAt;
    h.service.markHandled("a", spawnedAt);
    const mark = () => h.service.getSnapshot().reads.find((m) => m.runId === "a");
    h.service.setRead("a", spawnedAt, true, mark()?.turn);
    const before = mark();
    const describes = h.describe.mock.calls.length;
    await h.service.reread("a", spawnedAt);
    expect(h.describe.mock.calls.length).toBe(describes + 1);
    expect(mark()).toEqual(before);
  });

  it("doesn't make an unchanged screen news when a re-read finds the question an earlier read missed", async () => {
    let question: string | null = null;
    const h = await makeHarness({
      classify: async () => ({
        category: question ? "question" : "idle",
        confidence: 0.9,
        attention: question ? 0.9 : 0.1,
        question,
      }),
    });
    h.runs.push(run("a", { agentState: "idle" }));
    // The turn is taken on one screen; the next one is read as needing nothing.
    h.screens.set("a", "Done with the first part.");
    await h.service.refresh();
    h.screens.set("a", "Done. Want me to push this?");
    await h.service.refresh();
    const spawnedAt = h.runs[0]!.spawnedAt;
    const mark = () => h.service.getSnapshot().reads.find((m) => m.runId === "a");
    h.service.setRead("a", spawnedAt, true, mark()?.turn);
    const before = mark();
    question = "Want me to push this?";
    await h.service.reread("a", spawnedAt);
    expect(mark()).toEqual(before);

    // The same question drawn again on a redrawn screen is still no news: the
    // correction made it the ask this turn is about.
    h.screens.set("a", "Done.\nWant me to push this?");
    await h.service.refresh();
    expect(mark()!.turn).toBe(before!.turn);
  });

  it("doesn't count the card a re-read cancels as a failure, and reads the run afresh", async () => {
    let rejectFirst: ((error: unknown) => void) | undefined;
    let describes = 0;
    const h = await makeHarness({
      classify: async () => ({
        category: "approval",
        confidence: 0.95,
        attention: 0.95,
        question: "Do you want to proceed?",
      }),
      describe: async (_input, says) => {
        describes++;
        if (describes === 1) {
          return new Promise<DescriberResult>((_resolve, reject) => {
            rejectFirst = reject;
          });
        }
        return {
          category: says,
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
          options: ["Yes", "No"],
        };
      },
    });
    h.runs.push(run("a", { agentState: "waiting", waitingReason: "approval" }));
    h.screens.set("a", APPROVAL_SCREEN);
    await h.service.scan();
    await settle();
    expect(describes).toBe(1);

    // The re-read's screen read is held open, so the cancelled card's
    // rejection lands before the fresh pass has started.
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const deps = (h.service as unknown as { deps: { readScreen: unknown } }).deps;
    deps.readScreen = async (runId: string) => {
      await held;
      return h.screens.get(runId) ?? null;
    };
    const reread = h.service.reread("a", h.runs[0]!.spawnedAt);
    rejectFirst!(new CanopyProviderError("describer", "request cancelled"));
    await settle();
    release();
    await reread;
    expect(describes).toBe(2);
    expect(h.service.getSnapshot()).toMatchObject({ lastError: null });
    expect(h.service.getSnapshot().waiting).toBeUndefined();
    expect(h.service.getSnapshot().cards[0]!.headline).toBe("Approve running npm test");
  });

  it("keeps a reply made on a screen through a re-read that corrects its question", async () => {
    let question = "Push now?";
    const h = await makeHarness({
      classify: async () => ({
        category: "question",
        confidence: 0.95,
        attention: 0.95,
        question,
      }),
    });
    h.runs.push(run("a", { agentState: "waiting", waitingReason: "question" }));
    h.screens.set("a", "Push now? Or open a PR first?");
    await h.service.refresh();
    const spawnedAt = h.runs[0]!.spawnedAt;
    h.service.markHandled("a", spawnedAt);
    // The re-read reads the same screen's question better.
    question = "Push now, or open a PR first?";
    await h.service.reread("a", spawnedAt);
    expect(h.service.getSnapshot().dispositions.map((d) => d.kind)).toEqual(["replied"]);
    // The same question redrawn is not a new ask: the reply stands.
    h.screens.set("a", "All tests pass.\nPush now? Or open a PR first?");
    await h.service.refresh();
    expect(h.service.getSnapshot().dispositions.map((d) => d.kind)).toEqual(["replied"]);
  });

  it("forgets a question a re-read finds was never asked, so it is news when it really is", async () => {
    let question: string | null = "Want me to push this?";
    const h = await makeHarness({
      classify: async () => ({
        category: question ? "question" : "idle",
        confidence: 0.9,
        attention: question ? 0.9 : 0.1,
        question,
      }),
    });
    h.runs.push(run("a", { agentState: "idle" }));
    h.screens.set("a", "Done. Pushed to origin.");
    await h.service.refresh();
    const spawnedAt = h.runs[0]!.spawnedAt;
    const mark = () => h.service.getSnapshot().reads.find((m) => m.runId === "a");
    h.service.setRead("a", spawnedAt, true, mark()?.turn);
    // The re-read finds no question on that screen.
    question = null;
    await h.service.reread("a", spawnedAt);
    const before = mark()!;
    // Now the agent really asks it.
    question = "Want me to push this?";
    h.screens.set("a", "Done. Want me to push this?");
    await h.service.refresh();
    expect(mark()!.turn).toBeGreaterThan(before.turn);
  });

  it("lets a re-read of a new ask whose first read failed bring it back unread", async () => {
    let failClassify = false;
    let question: string | null = null;
    const h = await makeHarness({
      classify: async () => {
        if (failClassify) {
          failClassify = false;
          throw new CanopyProviderError("classifier", "HTTP 500");
        }
        return {
          category: question ? "question" : "idle",
          confidence: 0.9,
          attention: question ? 0.9 : 0.1,
          question,
        };
      },
    });
    h.runs.push(run("a", { agentState: "idle" }));
    h.screens.set("a", "Done with the first part.");
    await h.service.refresh();
    const spawnedAt = h.runs[0]!.spawnedAt;
    const mark = () => h.service.getSnapshot().reads.find((m) => m.runId === "a");
    h.service.setRead("a", spawnedAt, true, mark()?.turn);
    const before = mark()!;

    // A new ask is drawn, and its first reading fails.
    h.screens.set("a", "Done. Want me to push this?");
    failClassify = true;
    await h.service.refresh();
    expect(mark()!.turn).toBe(before.turn);

    // Read again finds the ask: that is this screen's first reading, and news.
    question = "Want me to push this?";
    await h.service.reread("a", spawnedAt);
    expect(mark()!.turn).toBeGreaterThan(before.turn);
  });

  it("tries a re-read's words again after they fail, rather than trusting the old ones", async () => {
    let clock = 1_000_000;
    let failNext = false;
    let headline = "Old words";
    const h = await makeHarness({
      now: () => clock,
      classify: async () => ({
        category: "approval",
        confidence: 0.95,
        attention: 0.95,
        question: "Do you want to proceed?",
      }),
      describe: async (_input, says) => {
        if (failNext) {
          failNext = false;
          throw new CanopyProviderError("describer", "HTTP 500");
        }
        return {
          category: says,
          headline,
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
          options: ["Yes", "No"],
        };
      },
    });
    h.runs.push(run("a", { agentState: "waiting", waitingReason: "approval" }));
    h.screens.set("a", APPROVAL_SCREEN);
    await h.service.refresh();
    expect(h.service.getSnapshot().cards[0]!.headline).toBe("Old words");

    failNext = true;
    headline = "New words";
    await h.service.reread("a", h.runs[0]!.spawnedAt);
    expect(h.service.getSnapshot().cards[0]!.headline).toBe("Old words");

    // After the backoff, the same unchanged screen is described again.
    clock += CANOPY_FAILURE_BACKOFF_MAX_MS;
    await h.service.refresh();
    expect(h.service.getSnapshot().cards[0]!.headline).toBe("New words");
  });

  it("stops saying it is waiting to retry once no retry is due", async () => {
    let clock = 1_000_000;
    let fail = true;
    const h = await makeHarness({
      now: () => clock,
      classify: async () => {
        if (fail) throw new CanopyProviderError("classifier", "the model stopped", true);
        return { category: "idle", confidence: 0.9, attention: 0.1, question: null };
      },
    });
    h.runs.push(run("a"));
    h.screens.set("a", "screen");
    await h.service.scan();
    expect(h.service.getSnapshot().waiting).toBe("retrying");
    fail = false;
    clock += CANOPY_FAILURE_BACKOFF_MAX_MS;
    await h.service.scan();
    expect(h.service.getSnapshot().waiting).toBeUndefined();
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

  it("does not scan on a state change while the panel is closed and the watch is off", async () => {
    const h = await makeHarness({ stateChangeScanMs: 0, backgroundPollMs: 0 });
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
        read: async (input) => ({
          classifier: withBlocked(await stopped()),
          words: () => describe(input, "finished"),
        }),
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

    it("reads changed screens, words and all, while the panel is closed", async () => {
      const h = await makeHarness({
        backgroundPollMs: BG,
        classify: asking(0.97),
        now: () => Date.now(),
      });
      vi.useFakeTimers();
      try {
        // Closed under fake timers, so the background tick is one they drive.
        h.service.setActive(false);
        h.runs.push(run("a"), run("b", { agentState: "working" }));
        h.screens.set("a", APPROVAL_SCREEN);
        h.screens.set("b", "· Editing store.ts… (12s · ↓ 1.2k tokens)");
        await vi.advanceTimersByTimeAsync(BG);
        expect(h.classify).toHaveBeenCalledTimes(2);
        // Words come with each reading — the ask's, and the busy run's
        // progress: the panel opens on them.
        expect(h.describe).toHaveBeenCalledTimes(2);

        // Nothing moved: the next tick reads both screens and sends neither.
        await vi.advanceTimersByTimeAsync(BG);
        expect(h.classify).toHaveBeenCalledTimes(2);

        // Still at work, its working line on screen: a reading would only say so again.
        h.screens.set("b", "· Running the tests… (40s · ↓ 3.1k tokens)");
        await vi.advanceTimersByTimeAsync(BG);
        expect(h.classify).toHaveBeenCalledTimes(2);

        // The line gone, something else may be on screen in its place.
        h.screens.set("b", "⏺ Ran the tests\n  ⎿  12 passed");
        await vi.advanceTimersByTimeAsync(BG);
        expect(h.classify).toHaveBeenCalledTimes(3);
        const card = h.service.getSnapshot().cards.find((c) => c.runId === "a")!;
        expect(card.stage).toBe("described");
        expect(card.priority).toBe(95);
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
      expect(card.glance.said).toBe("Committed as 43d0e48: cups now keep two decimal places.");
    });

    it("writes a run's words afresh when it is read again with the panel closed", async () => {
      const h = await makeHarness({ backgroundPollMs: BG, classify: asking(0.97) });
      h.runs.push(run("a", { agentState: "waiting" }));
      h.screens.set("a", APPROVAL_SCREEN);
      await h.service.refresh();
      expect(h.service.getSnapshot().cards[0]!.headline).toBe("Headline");

      h.service.setActive(false);
      h.screens.set("a", `${APPROVAL_SCREEN}\n(redrawn)`);
      await h.service.refresh();
      const card = h.service.getSnapshot().cards[0]!;
      expect(h.describe).toHaveBeenCalledTimes(2);
      expect(card.headline).toBe("Headline");
      expect(card.wordsFromEarlierRead).toBe(false);
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

      // The screen moved, still the same ask.
      h.screens.set("a", `⏺ Read 2 files\n${APPROVAL_SCREEN}`);
      await h.service.refresh();
      expect(h.classify).toHaveBeenCalledTimes(2);
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

    it("tells onAsk of the next ask after the user answered one, though no work was seen", async () => {
      const onAsk = vi.fn();
      let question = "Ship it?";
      const h = await makeHarness({
        classify: async () => ({
          category: "approval",
          confidence: 0.98,
          attention: 0.95,
          blocked: 0.97,
          question,
        }),
        onAsk,
      });
      h.runs.push(run("a", { agentState: "waiting", waitingReason: "approval" }));
      h.screens.set("a", APPROVAL_SCREEN);
      await h.service.refresh();
      h.service.markHandled("a", 1);
      // The next dialog drawn in its place before any scan saw the answer land.
      question = "Deploy it?";
      h.screens.set("a", APPROVAL_SCREEN.replace("npm test", "npm run deploy"));
      await h.service.refresh();
      expect(onAsk).toHaveBeenCalledTimes(2);
    });

    it("tells onAsk once for an ask whose run only flickered to working", async () => {
      const onAsk = vi.fn();
      const h = await makeHarness({ classify: reading("approval", 0.97), onAsk });
      h.runs.push(run("a", { agentState: "waiting" }));
      h.screens.set("a", APPROVAL_SCREEN);
      await h.service.refresh();
      h.service.onFleetChanged();
      h.runs[0] = run("a", { agentState: "working" });
      h.service.onFleetChanged();
      h.runs[0] = run("a", { agentState: "waiting" });
      h.service.onFleetChanged();
      await h.service.refresh();
      expect(onAsk).toHaveBeenCalledTimes(1);
    });

    it("tells onAsk again when a snooze put on a told ask runs out", async () => {
      const onAsk = vi.fn();
      const h = await makeHarness({ classify: reading("approval", 0.97), onAsk });
      h.runs.push(run("a", { agentState: "waiting" }));
      h.screens.set("a", APPROVAL_SCREEN);
      await h.service.refresh();
      expect(onAsk).toHaveBeenCalledTimes(1);
      const snooze = { until: Date.now() + 60_000 } as unknown as FleetRunRow["snooze"];
      h.runs[0] = run("a", { agentState: "waiting", snooze });
      await h.service.refresh();
      h.runs[0] = run("a", { agentState: "waiting" });
      await h.service.refresh();
      expect(onAsk).toHaveBeenCalledTimes(2);
    });

    it("tells onAsk of the same ask shown again after real work", async () => {
      let clock = 1_000_000;
      const onAsk = vi.fn();
      const h = await makeHarness({ classify: reading("approval", 0.97), onAsk, now: () => clock });
      h.runs.push(run("a", { agentState: "waiting" }));
      h.screens.set("a", APPROVAL_SCREEN);
      await h.service.refresh();
      h.service.onFleetChanged();
      h.runs[0] = run("a", { agentState: "working", since: clock });
      h.service.onFleetChanged();
      clock += CANOPY_TURN_HOLD_MS;
      h.runs[0] = run("a", { agentState: "waiting", since: clock });
      h.service.onFleetChanged();
      await h.service.refresh();
      expect(onAsk).toHaveBeenCalledTimes(2);
    });

    it("tells onAsk of the same ask after real work, though a read during the work saw it", async () => {
      let clock = 1_000_000;
      const onAsk = vi.fn();
      const h = await makeHarness({ classify: reading("approval", 0.97), onAsk, now: () => clock });
      h.runs.push(run("a", { agentState: "waiting" }));
      h.screens.set("a", APPROVAL_SCREEN);
      await h.service.refresh();
      h.service.onFleetChanged();
      h.runs[0] = run("a", { agentState: "working", since: clock });
      h.service.onFleetChanged();
      // Read while it works, the dialog still drawn: the same ask, not told again.
      await h.service.refresh();
      expect(onAsk).toHaveBeenCalledTimes(1);
      clock += CANOPY_TURN_HOLD_MS;
      h.runs[0] = run("a", { agentState: "waiting", since: clock });
      h.service.onFleetChanged();
      await h.service.refresh();
      expect(onAsk).toHaveBeenCalledTimes(2);
    });

    it("tells onAsk of a different ask drawn in place of a told one, with nothing seen between", async () => {
      const onAsk = vi.fn();
      let question = "Ship it?";
      const h = await makeHarness({
        classify: async () => ({
          category: "approval",
          confidence: 0.98,
          attention: 0.95,
          blocked: 0.97,
          question,
        }),
        onAsk,
      });
      h.runs.push(run("a", { agentState: "waiting" }));
      h.screens.set("a", APPROVAL_SCREEN);
      await h.service.refresh();
      question = "Deploy it?";
      h.screens.set("a", APPROVAL_SCREEN.replace("npm test", "npm run deploy"));
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

    it("leaves a busy run's unchanged screen to a panel to judge again", async () => {
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

      expect(h.classify).toHaveBeenCalledTimes(1);

      // Stuck pages no one: with no panel showing the run, its unchanged screen is not judged again.
      h.service.setActive(false);
      h.classify.mockImplementation(reading("working", 0.05, 0.9));
      now += CANOPY_REJUDGE_AFTER_MS + CANOPY_PROGRESS_DESCRIBE_MS;
      await h.service.refresh();
      expect(h.classify).toHaveBeenCalledTimes(1);

      h.service.setActive(true);
      await h.service.refresh();
      expect(h.classify).toHaveBeenCalledTimes(2);
      expect(h.service.getSnapshot().cards[0]!.headline).toBe("Editing store.ts");
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

  it("forgets every look when reading stops, so none reads a turn once it is back on", async () => {
    let now = 1_000_000;
    const h = await makeHarness({
      now: () => now,
      classify: async (input) =>
        input.screen.includes("Working")
          ? { category: "working", confidence: 0.9, attention: 0.1, question: null }
          : finishedReading,
    });
    h.runs.push(run("a", { agentState: "working" }));
    h.screens.set("a", "Working on it");
    await h.service.scan();
    h.service.markSeen("a", { viewId: 1, place: "pane", looking: true });
    now += 5_000;
    // Hidden while looked at: the view's word that the look ended never lands.
    h.service.setPlan({ mode: "hidden", activated: false });
    h.service.setPlan({ mode: "on", activated: true });
    await settle();
    now += 5_000;
    h.runs[0] = run("a", { agentState: "completed" });
    h.screens.set("a", "All done.");
    await h.service.refresh();
    expect(unread(h)).toBe(true);
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

describe("CanopyService failures and broadcasts", () => {
  it("drops a failure writing a run's words once none are owed for its screen", async () => {
    let clock = 1_000_000;
    const h = await makeHarness({
      now: () => clock,
      classify: async () => ({
        category: "approval",
        confidence: 0.95,
        attention: 0.95,
        question: "Allow?",
      }),
      describe: async () => {
        throw new Error("model broke");
      },
    });
    h.runs.push(run("a"));
    h.screens.set("a", APPROVAL_SCREEN);
    await h.service.scan();
    await settle();
    expect(h.service.getSnapshot().lastError).not.toBeNull();
    h.service.archive("a", 1);
    clock += CANOPY_FAILURE_BACKOFF_MAX_MS * 2;
    h.screens.set("a", `⏺ Read 2 files\n${APPROVAL_SCREEN}`);
    await h.service.refresh();
    await settle();
    expect(h.service.getSnapshot().lastError).toBeNull();
  });

  it("keeps a run archived on a prompt the words quoted otherwise, while it is still drawn", async () => {
    const screen = [
      "⏺ Bash(npm test)",
      "Allow npm test to run?",
      "Do you want to proceed?",
      "❯ 1. Yes",
      "  2. No",
    ].join("\n");
    const h = await makeHarness({
      classify: async () => ({
        category: "approval",
        confidence: 0.95,
        attention: 0.95,
        question: "Do you want to proceed?",
      }),
      describe: async (_input, says) => ({
        category: says,
        headline: "Approve npm test",
        summary: "Runs the tests.",
        attentionScore: 92,
        task: null,
        risk: "none",
        riskReason: null,
        action: null,
        progress: null,
        tests: "unknown",
        changes: "unknown",
        question: "Allow npm test to run?",
        options: ["Yes", "No"],
      }),
    });
    h.runs.push(run("a", { agentState: "waiting", waitingReason: "approval" }));
    h.screens.set("a", screen);
    await h.service.scan();
    await settle();
    expect(h.service.getSnapshot().cards[0]!.question).toBe("Allow npm test to run?");
    h.service.archive("a", 1);
    // Something above the dialog moved; the dialog is the one archived.
    h.screens.set("a", `⏺ Read 2 files\n${screen}`);
    await h.service.refresh();
    expect(h.service.getSnapshot().dispositions).toHaveLength(1);
  });

  it("tells a view a scan ended, though nothing else changed after it said one began", async () => {
    let gate: Promise<void> | null = null;
    const h = await makeHarness({ screenGate: () => gate ?? Promise.resolve() });
    h.runs.push(run("a"));
    h.screens.set("a", "screen");
    await h.service.scan();
    await settle();
    let release!: () => void;
    gate = new Promise((resolve) => (release = resolve));
    const scan = h.service.scan();
    // Something else the snapshot carries changes while the scan is under way.
    h.service.setRead("a", 1, false);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(h.snapshots.at(-1)!.busy).toBe(true);
    gate = null;
    release();
    await scan;
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(h.snapshots.at(-1)!.busy).toBe(false);
  });
});

describe("CanopyService stopping what is in flight", () => {
  const asking = async (): Promise<Reading> => ({
    category: "approval",
    confidence: 0.95,
    attention: 0.95,
    question: "Do you want to proceed?",
  });
  const never = <T>(): Promise<T> => new Promise<T>(() => {});
  const OFF: CanopyPlan = { mode: "unset", activated: false };

  it("aborts a read under way when Canopy is turned off", async () => {
    const h = await makeHarness({ classify: never });
    h.runs.push(run("a"));
    h.screens.set("a", APPROVAL_SCREEN);
    void h.service.scan();
    await vi.waitFor(() => expect(h.signals).toHaveLength(1));
    h.service.setPlan(OFF);
    expect(h.signals[0]!.aborted).toBe(true);
  });

  it("aborts the reading under way when the last panel closes, and when it is disposed", async () => {
    const h = await makeHarness({ classify: asking, describe: never });
    h.runs.push(run("a", { agentState: "waiting", waitingReason: "approval" }));
    h.screens.set("a", APPROVAL_SCREEN);
    void h.service.scan();
    await vi.waitFor(() => expect(h.describe).toHaveBeenCalledTimes(1));
    const words = h.signals.at(-1)!;
    h.service.setActive(false);
    expect(words.aborted).toBe(true);

    h.service.setActive(true);
    await vi.waitFor(() => expect(h.describe).toHaveBeenCalledTimes(2));
    const again = h.signals.at(-1)!;
    h.service.dispose();
    expect(again.aborted).toBe(true);
  });

  it("never lands words written for a screen that moved on to another prompt", async () => {
    const pending: Array<(words: DescriberResult) => void> = [];
    const h = await makeHarness({
      classify: asking,
      describe: () => new Promise<DescriberResult>((resolve) => pending.push(resolve)),
    });
    h.runs.push(run("a", { agentState: "waiting", waitingReason: "approval" }));
    h.screens.set("a", APPROVAL_SCREEN);
    void h.service.scan();
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    h.screens.set("a", APPROVAL_SCREEN.replace("npm test", "npm run deploy"));
    await h.service.scan();
    pending[0]!({
      category: "approval",
      headline: "Words for the old prompt",
      summary: "",
      attentionScore: 92,
      task: null,
      risk: "none",
      riskReason: null,
      action: null,
      progress: null,
      tests: "unknown",
      changes: "unknown",
      question: null,
      options: [],
    });
    await settle();
    expect(h.service.getSnapshot().cards[0]!.headline).not.toBe("Words for the old prompt");
  });
});

describe("CanopyService refining attention", () => {
  const ASK_SCREEN = "⏺ Done — the store is migrated.\n\n  Want me to update the tests too?";
  const QUESTION_READ: Reading = {
    category: "question",
    confidence: 0.95,
    attention: 0.9,
    question: "Want me to update the tests too?",
  };
  const FINISHED_READ: Reading = {
    category: "finished",
    confidence: 0.95,
    attention: 0.95,
    question: null,
    status: "All 14 tests pass.",
  };
  /** Questions where the screen asks one, a finished turn where it doesn't. */
  const readScreen = async (input: CanopyScreenInput): Promise<Reading> =>
    input.screen.includes("Want me")
      ? QUESTION_READ
      : input.screen.includes("esc to interrupt")
        ? { category: "working", confidence: 0.99, attention: 0.05, question: null }
        : FINISHED_READ;
  /** The newest snapshot sent: refinements settle just before each one. */
  const lastSent = (h: Harness) => h.snapshots[h.snapshots.length - 1];

  it("reads a stop that asks something as an ask, quoted, and says so", async () => {
    const changed = vi.fn();
    const h = await makeHarness({ classify: readScreen, onRefinementsChanged: changed });
    h.runs.push(run("a", { agentState: "completed" }));
    h.screens.set("a", ASK_SCREEN);
    await h.service.refresh();
    await vi.waitFor(() =>
      expect(h.service.getRefinement("a", 1)).toMatchObject({
        kind: "asked",
        quote: "Want me to update the tests too?",
      })
    );
    expect(changed).toHaveBeenCalled();
    // Another incarnation of the same terminal id was never read.
    expect(h.service.getRefinement("a", 2)).toBeUndefined();
  });

  it("never places a run on a score alone", async () => {
    const h = await makeHarness({ classify: async () => FINISHED_READ });
    h.runs.push(run("a", { agentState: "completed" }));
    h.screens.set("a", ASK_SCREEN);
    await h.service.refresh();
    await vi.waitFor(() => expect(lastSent(h)?.cards[0]?.priority).toBeGreaterThan(55));
    expect(h.service.getRefinement("a", 1)).toBeUndefined();
  });

  it("never quotes a question the screen doesn't show", async () => {
    const h = await makeHarness({
      classify: async () => ({ ...QUESTION_READ, question: "Should I drop the database?" }),
    });
    h.runs.push(run("a", { agentState: "completed" }));
    h.screens.set("a", ASK_SCREEN);
    await h.service.refresh();
    await vi.waitFor(() => expect(lastSent(h)?.cards[0]?.category).toBe("question"));
    expect(h.service.getRefinement("a", 1)).toBeUndefined();
  });

  it("holds its verdict for the turn while re-reads of the same stop disagree", async () => {
    let reading = QUESTION_READ;
    const h = await makeHarness({ classify: async () => reading });
    h.runs.push(run("a", { agentState: "completed" }));
    h.screens.set("a", ASK_SCREEN);
    await h.service.refresh();
    await vi.waitFor(() => expect(h.service.getRefinement("a", 1)?.kind).toBe("asked"));

    reading = FINISHED_READ;
    await h.service.reread("a", 1);
    await vi.waitFor(() => expect(lastSent(h)?.cards[0]?.category).toBe("finished"));
    expect(h.service.getRefinement("a", 1)?.kind).toBe("asked");
  });

  it("reads afresh once the agent works and stops again", async () => {
    let now = 1_000_000;
    const h = await makeHarness({ classify: readScreen, now: () => now });
    h.runs.push(run("a", { agentState: "completed", since: now }));
    h.screens.set("a", ASK_SCREEN);
    await h.service.refresh();
    await vi.waitFor(() => expect(h.service.getRefinement("a", 1)?.kind).toBe("asked"));

    h.runs[0] = run("a", { agentState: "working", since: now });
    h.screens.set("a", "• Updating the tests (esc to interrupt)");
    h.service.onFleetChanged();
    await h.service.refresh();
    now += CANOPY_TURN_HOLD_MS + 1_000;
    await h.service.refresh();

    h.runs[0] = run("a", { agentState: "completed", since: now });
    h.screens.set("a", "⏺ Tests updated.");
    h.service.onFleetChanged();
    now += CANOPY_TURN_HOLD_MS + 1_000;
    await h.service.refresh();
    await vi.waitFor(() => expect(lastSent(h)?.cards[0]?.category).toBe("finished"));
    expect(h.service.getRefinement("a", 1)).toBeUndefined();
  });

  it("keeps a reading that landed while the stop was still being held", async () => {
    let now = 1_000_000;
    const h = await makeHarness({ classify: readScreen, now: () => now });
    h.runs.push(run("a", { agentState: "working", since: now }));
    h.screens.set("a", "• Running the suite (esc to interrupt)");
    await h.service.refresh();
    now += CANOPY_TURN_HOLD_MS + 1_000;
    await h.service.refresh();

    // Stopped on a wait the patterns took for a question, read at once —
    // inside the hold, before the stop counts as a turn.
    h.runs[0] = run("a", { agentState: "waiting", waitingReason: "question", since: now });
    h.screens.set("a", "⏺ All 14 tests pass.");
    h.service.onFleetChanged();
    await h.service.refresh();
    await vi.waitFor(() => expect(lastSent(h)?.cards[0]?.category).toBe("finished"));

    // The hold runs out on an unchanged screen, which is never read again.
    now += CANOPY_TURN_HOLD_MS + 1_000;
    await h.service.refresh();
    await vi.waitFor(() =>
      expect(h.service.getRefinement("a", 1)).toMatchObject({ kind: "not-asking" })
    );
  });

  it("never quotes a stall off a screen that has gone blank", async () => {
    let now = 1_000_000;
    const h = await makeHarness({ now: () => now });
    h.runs.push(run("a", { agentState: "working" }));
    h.screens.set("a", "• Waiting for background terminal (1m 02s • esc to interrupt)");
    await h.service.refresh();
    now += CANOPY_STALL_MS + 1_000;
    await h.service.refresh();
    await vi.waitFor(() => expect(h.service.getRefinement("a", 1)?.kind).toBe("stalled"));

    h.screens.set("a", "   \n");
    await h.service.refresh();
    await vi.waitFor(() => expect(h.service.getRefinement("a", 1)).toBeUndefined());
    now += CANOPY_STALL_MS + 1_000;
    await h.service.refresh();
    // An unchanged plan sends nothing new but still settles every run; the
    // wait is for a settle that, rightly, has nothing to announce.
    h.service.setPlan({ mode: "on", activated: true });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(h.service.getRefinement("a", 1)).toBeUndefined();
  });

  it("clears a question wait the screen shows asks nothing, but never an approval", async () => {
    const h = await makeHarness({ classify: async () => FINISHED_READ });
    h.runs.push(
      run("q", { agentState: "waiting", waitingReason: "question" }),
      run("y", { agentState: "waiting", waitingReason: "approval" })
    );
    h.screens.set("q", "⏺ All 14 tests pass.");
    h.screens.set("y", "⏺ All 14 tests pass.");
    await h.service.refresh();
    await vi.waitFor(() =>
      expect(h.service.getRefinement("q", 1)).toMatchObject({
        kind: "not-asking",
        quote: "All 14 tests pass.",
      })
    );
    expect(h.service.getRefinement("y", 1)).toBeUndefined();
  });

  it("reads an ask at an approval or question wait the patterns named, as either kind", async () => {
    const APPROVAL_SCREEN =
      "Bash command\n\n  npm test\n\nDo you want to proceed?\n❯ 1. Yes\n  2. No";
    const h = await makeHarness({
      classify: async (input) =>
        input.screen.includes("proceed?")
          ? { ...QUESTION_READ, category: "approval", question: "Do you want to proceed?" }
          : readScreen(input),
    });
    h.runs.push(
      run("q", { agentState: "waiting", waitingReason: "question" }),
      run("y", { agentState: "waiting", waitingReason: "approval" }),
      run("e", { agentState: "waiting", waitingReason: "error" })
    );
    h.screens.set("q", ASK_SCREEN);
    h.screens.set("y", APPROVAL_SCREEN);
    h.screens.set("e", APPROVAL_SCREEN);
    await h.service.refresh();
    await vi.waitFor(() => {
      expect(h.service.getRefinement("q", 1)).toMatchObject({
        kind: "asked",
        quote: "Want me to update the tests too?",
      });
      expect(h.service.getRefinement("y", 1)).toMatchObject({
        kind: "asked",
        quote: "Do you want to proceed?",
      });
    });
    // An error wait is blocked whatever its screen asks.
    expect(h.service.getRefinement("e", 1)).toBeUndefined();
  });

  it("says whether the user has read the ask, by that turn's read mark", async () => {
    const changed = vi.fn();
    const h = await makeHarness({ classify: readScreen, onRefinementsChanged: changed });
    h.runs.push(run("a", { agentState: "waiting", waitingReason: "question" }));
    h.screens.set("a", ASK_SCREEN);
    await h.service.refresh();
    await vi.waitFor(() =>
      expect(h.service.getRefinement("a", 1)).toMatchObject({ kind: "asked", seen: false })
    );

    changed.mockClear();
    h.service.setRead("a", 1, true);
    // The verdict holds; only whether it is news moves.
    expect(h.service.getRefinement("a", 1)).toMatchObject({
      kind: "asked",
      quote: "Want me to update the tests too?",
      seen: true,
    });
    // Heard with no panel open, so the fleet can move the run out of Needs you.
    await vi.waitFor(() => expect(changed).toHaveBeenCalled());

    h.service.setRead("a", 1, false);
    expect(h.service.getRefinement("a", 1)).toMatchObject({ kind: "asked", seen: false });
  });

  it("says whether the user has read the question wait it cleared, by that turn's read mark", async () => {
    const changed = vi.fn();
    const h = await makeHarness({
      classify: async () => FINISHED_READ,
      onRefinementsChanged: changed,
    });
    h.runs.push(run("q", { agentState: "waiting", waitingReason: "question" }));
    h.screens.set("q", "⏺ All 14 tests pass.");
    await h.service.refresh();
    await vi.waitFor(() =>
      expect(h.service.getRefinement("q", 1)).toMatchObject({ kind: "not-asking", seen: false })
    );

    changed.mockClear();
    h.service.setRead("q", 1, true);
    expect(h.service.getRefinement("q", 1)).toMatchObject({ kind: "not-asking", seen: true });
    // The sidebar hears of the read with no panel open, like any other refinement change.
    await vi.waitFor(() => expect(changed).toHaveBeenCalled());

    h.service.setRead("q", 1, false);
    expect(h.service.getRefinement("q", 1)).toMatchObject({ kind: "not-asking", seen: false });
  });

  it("drops a live refinement when Canopy goes off, and tells the fleet", async () => {
    const changed = vi.fn();
    const h = await makeHarness({ classify: readScreen, onRefinementsChanged: changed });
    h.runs.push(run("a", { agentState: "completed" }));
    h.screens.set("a", ASK_SCREEN);
    await h.service.refresh();
    await vi.waitFor(() => expect(h.service.getRefinement("a", 1)).toBeDefined());
    changed.mockClear();

    h.service.setPlan({ mode: "unset", activated: false });
    expect(h.service.getRefinement("a", 1)).toBeUndefined();
    await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
  });

  it("drops a live refinement when its model goes, with reading still on", async () => {
    const changed = vi.fn();
    let ready = true;
    const h = await makeHarness({
      classify: readScreen,
      onRefinementsChanged: changed,
      readerReady: () => ready,
    });
    h.runs.push(run("a", { agentState: "completed" }));
    h.screens.set("a", ASK_SCREEN);
    await h.service.refresh();
    await vi.waitFor(() => expect(h.service.getRefinement("a", 1)).toBeDefined());
    changed.mockClear();

    ready = false;
    h.service.readerChanged();
    expect(h.service.getRefinement("a", 1)).toBeUndefined();
    await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
  });

  it("gives way to the user archiving the run, and comes back with an unarchive", async () => {
    const h = await makeHarness({ classify: readScreen });
    h.runs.push(run("a", { agentState: "completed" }));
    h.screens.set("a", ASK_SCREEN);
    await h.service.refresh();
    await vi.waitFor(() => expect(h.service.getRefinement("a", 1)).toBeDefined());
    h.service.archive("a", 1);
    expect(h.service.getRefinement("a", 1)).toBeUndefined();
    h.service.unarchive("a", 1);
    expect(h.service.getRefinement("a", 1)?.kind).toBe("asked");
  });

  it("reads an ask with the panel closed", async () => {
    const BG = 20_000;
    const h = await makeHarness({ backgroundPollMs: BG, classify: readScreen });
    // The opening scan's broadcast was armed on the real clock: let it go
    // before the fake one takes over, or every later one waits behind it.
    await vi.waitFor(() => expect(h.snapshots.length).toBeGreaterThan(0));
    vi.useFakeTimers();
    try {
      h.service.setActive(false);
      h.runs.push(run("a", { agentState: "completed" }));
      h.screens.set("a", ASK_SCREEN);
      await vi.advanceTimersByTimeAsync(BG + 100);
      expect(h.service.getRefinement("a", 1)?.kind).toBe("asked");
    } finally {
      harness?.service.dispose();
      vi.useRealTimers();
    }
  });

  it("flags a working run whose screen stood still behind its spinner, until it moves", async () => {
    let now = 1_000_000;
    const h = await makeHarness({ now: () => now });
    h.runs.push(run("a", { agentState: "working" }));
    h.screens.set("a", "• Waiting for background terminal (1m 02s • esc to interrupt)");
    await h.service.refresh();
    await vi.waitFor(() => expect(lastSent(h)?.cards).toHaveLength(1));
    expect(h.service.getRefinement("a", 1)).toBeUndefined();

    now += CANOPY_STALL_MS + 1_000;
    h.screens.set("a", "• Waiting for background terminal (11m 03s • esc to interrupt)");
    await h.service.refresh();
    await vi.waitFor(() =>
      expect(h.service.getRefinement("a", 1)).toMatchObject({
        kind: "stalled",
        stalledSince: 1_000_000,
      })
    );

    h.screens.set("a", "• Ran npm test\n└ ok 14 tests");
    await h.service.refresh();
    await vi.waitFor(() => expect(h.service.getRefinement("a", 1)).toBeUndefined());
  });
});

describe("CanopyService requests it leaves unsent", () => {
  const BG = 20_000;
  const QUESTION = "Which routes should get validation?";
  const readsScreen = async (input: CanopyScreenInput): Promise<Reading> =>
    /shift\+← to answer|\? 1 question/.test(input.screen)
      ? { category: "question", confidence: 0.95, attention: 0.95, question: QUESTION }
      : /…|esc to interrupt/.test(input.screen)
        ? { category: "working", confidence: 0.95, attention: 0.1, question: null }
        : input.screen.includes("proceed")
          ? {
              category: "approval",
              confidence: 0.95,
              attention: 0.95,
              question: "Do you want to proceed?",
            }
          : { category: "finished", confidence: 0.9, attention: 0.7, question: null };
  const stopped = (clock: string) =>
    ["⏺ Done.", "", "✻ Worked for 9s · done", "", `~/repo · main · ${clock}`].join("\n");
  const claudeAtWork = (step: string) =>
    [
      `⏺ ${step}`,
      "",
      "· Adding a test for the cache… (32s · ↓ 3.2k tokens)",
      "  ⎿  ◼ Add a test",
    ].join("\n");

  it("holds a Claude Code spinner's screen to the floor like any working line", async () => {
    let clock = 1_000_000;
    const h = await makeHarness({ now: () => clock, rereadMs: 10_000, classify: readsScreen });
    h.runs.push(run("a", { agentState: "working" }));
    h.screens.set("a", claudeAtWork("Read src/a.ts"));
    await h.service.scan();
    h.screens.set("a", claudeAtWork("Read src/b.ts"));
    clock += 3_000;
    await h.service.scan();
    expect(h.classify).toHaveBeenCalledTimes(1);
    clock += 7_000;
    await h.service.scan();
    expect(h.classify).toHaveBeenCalledTimes(2);
  });

  it("doesn't take a list item ending in an ellipsis for a working line", async () => {
    let clock = 1_000_000;
    const h = await makeHarness({
      now: () => clock,
      backgroundPollMs: BG,
      closed: true,
      classify: readsScreen,
    });
    h.runs.push(run("a", { agentState: "working" }));
    h.screens.set("a", claudeAtWork("Read src/a.ts"));
    await h.service.scan();
    // Finished, while Daintree's state still says working.
    clock += BG;
    h.screens.set("a", ["Next steps:", "* Wire up the remaining routes…", QUESTION].join("\n"));
    await h.service.scan();
    expect(h.classify).toHaveBeenCalledTimes(2);
  });

  it.each(["? 1 question", "shift+← to answer"])(
    "reads a question Codex asks under its working line (%s), panel closed",
    async (marker) => {
      let clock = 1_000_000;
      const onAsk = vi.fn();
      const h = await makeHarness({
        now: () => clock,
        backgroundPollMs: BG,
        closed: true,
        classify: readsScreen,
        onAsk,
      });
      const working = ["• Read the server", QUESTION, "", "• Working (38s • esc to interrupt)"];
      h.runs.push(run("a", { agentId: "codex", agentState: "working" }));
      h.screens.set("a", working.join("\n"));
      await h.service.scan();
      clock += BG;
      h.screens.set("a", [...working, "• Read the routes"].join("\n"));
      await h.service.scan();
      expect(h.classify).toHaveBeenCalledTimes(1);

      clock += BG;
      h.screens.set("a", [...working, "", "• Queued follow-up inputs", marker].join("\n"));
      await h.service.scan();
      expect(h.classify).toHaveBeenCalledTimes(2);
      expect(h.service.getSnapshot().cards[0]!.category).toBe("question");
      expect(onAsk).toHaveBeenCalledTimes(1);
    }
  );

  it("reads a question Codex asks under its working line at once with the panel open", async () => {
    let clock = 1_000_000;
    const h = await makeHarness({ now: () => clock, rereadMs: 10_000, classify: readsScreen });
    const working = ["• Read the server", QUESTION, "", "• Working (38s • esc to interrupt)"];
    h.runs.push(run("a", { agentId: "codex", agentState: "working" }));
    h.screens.set("a", working.join("\n"));
    await h.service.scan();
    clock += 1_000;
    h.screens.set("a", [...working, "", "? 1 question", "shift+← to answer"].join("\n"));
    await h.service.scan();
    expect(h.classify).toHaveBeenCalledTimes(2);
  });

  it("stops reading a stopped run's redraws once it has settled, but for Refresh", async () => {
    let clock = 1_000_000;
    const h = await makeHarness({ now: () => clock, classify: readsScreen });
    h.runs.push(run("a", { agentState: "waiting", waitingReason: "prompt" }));
    h.screens.set("a", stopped("14:00"));
    await h.service.scan();

    // Settling: every move is read, up to its last moment.
    clock += CANOPY_SETTLE_MS - 1;
    h.screens.set("a", stopped("14:01"));
    await h.service.scan();
    expect(h.classify).toHaveBeenCalledTimes(2);

    // Settled: only its status line moves, and nothing is sent.
    clock += 1;
    h.screens.set("a", stopped("14:02"));
    await h.service.scan();
    expect(h.classify).toHaveBeenCalledTimes(2);

    await h.service.refresh();
    expect(h.classify).toHaveBeenCalledTimes(3);
  });

  it("reads anything more than a redraw that a settled run draws, with no work or answer seen", async () => {
    let clock = 1_000_000;
    const onAsk = vi.fn();
    const h = await makeHarness({ now: () => clock, classify: readsScreen, onAsk });
    h.runs.push(run("a", { agentState: "waiting", waitingReason: "prompt" }));
    h.screens.set("a", stopped("14:00"));
    await h.service.scan();
    clock += CANOPY_SETTLE_MS;
    // A dialog Daintree's own state didn't name, drawn inside a flicker.
    h.screens.set("a", APPROVAL_SCREEN);
    await h.service.scan();
    expect(h.classify).toHaveBeenCalledTimes(2);
    expect(onAsk).toHaveBeenCalledTimes(1);
  });

  it("reads a settled run's redraw again once it is answered, or Daintree sees a new kind of wait", async () => {
    let clock = 1_000_000;
    const h = await makeHarness({ now: () => clock, classify: readsScreen });
    h.runs.push(run("a", { agentState: "waiting", waitingReason: "prompt" }));
    h.screens.set("a", stopped("14:00"));
    await h.service.scan();
    clock += CANOPY_SETTLE_MS;

    // An answer reopens it: the next dialog can follow with no work seen in between.
    h.service.noteInput("a", "submit");
    h.screens.set("a", stopped("14:02"));
    await h.service.scan();
    expect(h.classify).toHaveBeenCalledTimes(2);

    clock += CANOPY_SETTLE_MS;
    h.runs[0] = run("a", { agentState: "waiting", waitingReason: "approval" });
    await h.service.scan();
    expect(h.classify).toHaveBeenCalledTimes(3);
  });

  it("gives a respawned terminal a settling of its own", async () => {
    let clock = 1_000_000;
    const h = await makeHarness({ now: () => clock, classify: readsScreen });
    h.runs.push(run("a", { agentState: "waiting", waitingReason: "prompt" }));
    h.screens.set("a", stopped("14:00"));
    await h.service.scan();
    clock += CANOPY_SETTLE_MS;
    h.runs[0] = run("a", { spawnedAt: 2, agentState: "waiting", waitingReason: "prompt" });
    h.screens.set("a", stopped("14:02"));
    await h.service.scan();
    h.screens.set("a", stopped("14:03"));
    await h.service.scan();
    expect(h.classify).toHaveBeenCalledTimes(3);
  });

  it("drops the choices a held screen no longer draws", async () => {
    let clock = 1_000_000;
    const h = await makeHarness({
      now: () => clock,
      classify: readsScreen,
      describe: async (_input, says) => ({
        category: says,
        headline: "Approve running npm test",
        summary: "Runs the unit suite.",
        attentionScore: 92,
        task: null,
        risk: "none",
        riskReason: null,
        action: null,
        progress: null,
        tests: "unknown",
        changes: "unknown",
        question: "Do you want to proceed?",
        options: ["Yes", "No, and tell Claude what to do differently"],
      }),
    });
    h.runs.push(run("a", { agentState: "waiting", waitingReason: "approval" }));
    h.screens.set("a", APPROVAL_SCREEN);
    await h.service.refresh();
    expect(h.service.getSnapshot().cards[0]!.options).toHaveLength(2);

    clock += CANOPY_SETTLE_MS;
    h.screens.set("a", APPROVAL_SCREEN.replace(/2\. No.*$/, "2. Skip this one"));
    await h.service.scan();
    expect(h.classify).toHaveBeenCalledTimes(1);
    expect(h.service.getSnapshot().cards[0]!.options).toEqual(["Yes"]);
  });

  it("writes owed words from the read they were owed for across a redraw", async () => {
    let clock = 1_000_000;
    const h = await makeHarness({
      now: () => clock,
      backgroundPollMs: BG,
      closed: true,
      classify: readsScreen,
    });
    const dialog = (time: string) => `${APPROVAL_SCREEN}\n\n~/repo · main · ${time}`;
    h.runs.push(run("a", { agentState: "waiting", waitingReason: "approval" }));
    h.screens.set("a", dialog("14:00"));
    await h.service.scan();
    clock += CANOPY_SETTLE_MS;
    h.screens.set("a", dialog("14:02"));
    await h.service.scan();

    // Opened, not refreshed: Refresh reads every screen afresh.
    h.service.setActive(true);
    await h.service.scan();
    await vi.waitFor(() => expect(h.describe).toHaveBeenCalledTimes(1));
    expect(h.classify).toHaveBeenCalledTimes(1);
  });

  it("reads nothing for a settled run's flicker of work, and reads work that holds", async () => {
    let clock = 1_000_000;
    const h = await makeHarness({
      now: () => clock,
      classify: readsScreen,
      stateChangeScanMs: 60_000,
    });
    const set = (patch: Partial<FleetRunRow>) => {
      h.runs[0] = run("a", { since: clock, ...patch });
      h.service.onFleetChanged();
    };
    h.runs.push(run("a", { agentState: "waiting", waitingReason: "prompt", since: clock }));
    h.screens.set("a", stopped("14:00"));
    await h.service.scan();
    clock += CANOPY_SETTLE_MS;

    // Its status line redrawn: output alone flips Daintree's state to working for a moment.
    set({ agentState: "working" });
    h.screens.set("a", stopped("14:02"));
    clock += 400;
    await h.service.scan();
    set({ agentState: "waiting", waitingReason: "prompt" });
    await h.service.scan();
    expect(h.classify).toHaveBeenCalledTimes(1);

    set({ agentState: "working" });
    clock += CANOPY_TURN_HOLD_MS;
    h.screens.set("a", "⏺ Reading src/a.ts");
    await h.service.scan();
    expect(h.classify).toHaveBeenCalledTimes(2);
  });

  it("never takes a busy state timed in the future for a flicker", async () => {
    let clock = 1_000_000;
    const h = await makeHarness({
      now: () => clock,
      backgroundPollMs: BG,
      closed: true,
      classify: readsScreen,
    });
    h.runs.push(run("a", { agentState: "working", since: clock + 10 * CANOPY_SETTLE_MS }));
    h.screens.set("a", stopped("14:00"));
    await h.service.scan();
    clock += CANOPY_SETTLE_MS;
    h.screens.set("a", stopped("14:02"));
    await h.service.scan();
    expect(h.classify).toHaveBeenCalledTimes(2);
  });

  it("times the stop from the scans when the run was first seen at work", async () => {
    let clock = 1_000_000;
    const h = await makeHarness({
      now: () => clock,
      classify: readsScreen,
      stateChangeScanMs: 60_000,
    });
    h.runs.push(run("a", { agentState: "working" }));
    h.screens.set("a", "⏺ Editing src/a.ts");
    await h.service.scan();
    // Minutes of work no fleet change timed, then the stop.
    clock += 5 * 60_000;
    h.runs[0] = run("a", { agentState: "waiting", waitingReason: "prompt", since: clock });
    h.service.onFleetChanged();
    h.screens.set("a", stopped("14:00"));
    await h.service.scan();
    clock += 60_000;
    h.screens.set("a", stopped("14:01"));
    await h.service.scan();
    expect(h.classify).toHaveBeenCalledTimes(3);
  });

  it("brings an archived run back on a new approval after work, by scans alone", async () => {
    let clock = 1_000_000;
    const onAsk = vi.fn();
    const h = await makeHarness({
      now: () => clock,
      classify: readsScreen,
      onAsk,
      stateChangeScanMs: 60_000,
    });
    h.runs.push(run("a", { agentState: "waiting", waitingReason: "prompt", since: clock }));
    h.screens.set("a", stopped("14:00"));
    await h.service.scan();
    h.service.archive("a", 1);
    clock += CANOPY_SETTLE_MS;

    h.runs[0] = run("a", { agentState: "working", since: clock });
    h.service.onFleetChanged();
    clock += CANOPY_TURN_HOLD_MS;
    h.runs[0] = run("a", { agentState: "waiting", waitingReason: "prompt", since: clock });
    h.service.onFleetChanged();
    h.screens.set("a", APPROVAL_SCREEN);
    await h.service.scan();
    expect(h.service.getSnapshot().dispositions).toHaveLength(0);
    expect(onAsk).toHaveBeenCalledTimes(1);
  });

  it("tries a failed read of a working screen again once its backoff is out, panel closed", async () => {
    let clock = 1_000_000;
    let failing = false;
    const h = await makeHarness({
      now: () => clock,
      backgroundPollMs: BG,
      closed: true,
      classify: async (input) => {
        if (failing) throw new CanopyProviderError("classifier", "HTTP 500");
        return readsScreen(input);
      },
    });
    h.runs.push(run("a", { agentState: "working" }));
    h.screens.set("a", claudeAtWork("Read src/a.ts"));
    await h.service.scan();
    failing = true;
    h.screens.set("a", claudeAtWork("Read src/b.ts"));
    await h.service.refresh();
    expect(h.classify).toHaveBeenCalledTimes(2);

    failing = false;
    clock += CANOPY_FAILURE_BACKOFF_MAX_MS * 2;
    await h.service.scan();
    expect(h.classify).toHaveBeenCalledTimes(3);
  });

  it("reads a run no faster than the watch's pace, panel closed, unless its own state changes", async () => {
    let clock = 1_000_000;
    const h = await makeHarness({
      now: () => clock,
      backgroundPollMs: BG,
      closed: true,
      // A read that takes its time: the pace counts from when it was sent.
      classify: async (input) => {
        clock += 2_000;
        return readsScreen(input);
      },
    });
    // At work under a CLI whose working line Canopy doesn't know: every change could be news.
    h.runs.push(run("a", { agentId: "opencode", agentState: "working" }));
    h.screens.set("a", "Compiling module 1");
    const sent = clock;
    await h.service.scan();
    // Another run's state change starts the next scan.
    clock = sent + BG / 2;
    h.screens.set("a", "Compiling module 2");
    await h.service.scan();
    expect(h.classify).toHaveBeenCalledTimes(1);
    // The regular poll, a whole pace after the read was sent.
    clock = sent + BG;
    await h.service.scan();
    expect(h.classify).toHaveBeenCalledTimes(2);

    h.runs[0] = run("a", { agentId: "opencode", agentState: "waiting", waitingReason: "prompt" });
    h.screens.set("a", "Done.");
    clock += 1_000;
    await h.service.scan();
    expect(h.classify).toHaveBeenCalledTimes(3);
  });
});
