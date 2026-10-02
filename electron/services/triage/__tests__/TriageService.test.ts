import { afterEach, describe, expect, it, vi } from "vitest";
import type { FleetRunRow } from "../../../../shared/types/ipc/fleet.js";
import type { TriageCategory, TriageSnapshot } from "../../../../shared/types/ipc/triage.js";
import { TriageService, type TriageServiceDeps } from "../TriageService.js";
import type { ClassifierResult, DescriberResult, TriageScreenInput } from "../triageProviders.js";

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
  service: TriageService;
  screens: Map<string, string>;
  runs: FleetRunRow[];
  classify: ReturnType<typeof vi.fn<(input: TriageScreenInput) => Promise<ClassifierResult>>>;
  describe: ReturnType<
    typeof vi.fn<(input: TriageScreenInput, says: TriageCategory) => Promise<DescriberResult>>
  >;
  snapshots: TriageSnapshot[];
}

let harness: Harness | null = null;

/** Let an in-flight scan (and its microtask chain) finish. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Opens the panel before any run exists, so the opening scan is empty and settled. */
async function makeHarness(options: {
  classify?: (input: TriageScreenInput) => Promise<ClassifierResult>;
  describe?: (input: TriageScreenInput, says: TriageCategory) => Promise<DescriberResult>;
  missingKeys?: string[];
}): Promise<Harness> {
  const screens = new Map<string, string>();
  const runs: FleetRunRow[] = [];
  const classify = vi.fn(
    options.classify ??
      (async (): Promise<ClassifierResult> => ({
        category: "working",
        confidence: 0.99,
        question: null,
      }))
  );
  const describe = vi.fn(
    options.describe ??
      (async (_input: TriageScreenInput, says: TriageCategory): Promise<DescriberResult> => ({
        category: says,
        headline: "Headline",
        summary: "Summary",
        question: null,
        options: [],
      }))
  );
  const snapshots: TriageSnapshot[] = [];
  const deps: TriageServiceDeps = {
    config: {
      classifierKey: "c",
      describerKey: "d",
      describerModel: "gpt-oss-120b",
      missingKeys: options.missingKeys ?? [],
    },
    getRuns: () => runs,
    readScreen: async (runId) => screens.get(runId) ?? null,
    classify: (input) => classify(input),
    describe: (input, says) => describe(input, says),
    broadcast: (snapshot) => snapshots.push(snapshot),
    setInterval: () => () => {},
  };
  harness = { service: new TriageService(deps), screens, runs, classify, describe, snapshots };
  harness.service.setActive(true);
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

describe("TriageService", () => {
  it("describes only the runs that need the user", async () => {
    const h = await makeHarness({
      classify: async (input) =>
        input.screen.includes("proceed")
          ? { category: "approval", confidence: 0.95, question: "Do you want to proceed?" }
          : { category: "working", confidence: 0.99, question: null },
      describe: async () => ({
        category: "approval",
        headline: "Run the tests?",
        summary: "Waiting to run npm test.",
        question: "Do you want to proceed?",
        options: ["Yes", "No, and tell Claude what to do differently (esc)"],
      }),
    });
    h.runs.push(run("a"), run("b"));
    h.screens.set("a", APPROVAL_SCREEN);
    h.screens.set("b", "✻ Pondering… (12s · esc to interrupt)");

    await h.service.scan();

    expect(h.classify).toHaveBeenCalledTimes(2);
    expect(h.describe).toHaveBeenCalledTimes(1);
    const cards = new Map(h.service.getSnapshot().cards.map((card) => [card.runId, card]));
    expect(cards.get("a")).toMatchObject({
      category: "approval",
      stage: "described",
      headline: "Run the tests?",
      options: ["Yes", "No, and tell Claude what to do differently (esc)"],
    });
    expect(cards.get("b")).toMatchObject({
      category: "working",
      stage: "classified",
      headline: null,
    });
  });

  it("describes a quiet-looking run when the classifier is unsure of it", async () => {
    const h = await makeHarness({
      classify: async () => ({ category: "idle", confidence: 0.4, question: null }),
    });
    h.runs.push(run("a"));
    h.screens.set("a", "dev@studio app % ");
    await h.service.scan();
    expect(h.describe).toHaveBeenCalledTimes(1);
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

  it("re-sends every screen on refresh", async () => {
    const h = await makeHarness({});
    h.runs.push(run("a"));
    h.screens.set("a", "anything");
    await h.service.scan();
    await h.service.refresh();
    expect(h.classify).toHaveBeenCalledTimes(2);
  });

  it("drops a quote or option the describer made up", async () => {
    const h = await makeHarness({
      classify: async () => ({
        category: "approval",
        confidence: 0.9,
        question: "Do you want to proceed?",
      }),
      describe: async () => ({
        category: "approval",
        headline: "Run the tests?",
        summary: "",
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
      classify: async () => ({ category: "approval", confidence: 0.9, question: null }),
      describe: async () => ({
        category: "approval",
        headline: "Trust this folder?",
        summary: "",
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

  it("marks a password prompt as secret", async () => {
    const h = await makeHarness({
      classify: async () => ({ category: "question", confidence: 0.9, question: "Password:" }),
      describe: async () => ({
        category: "question",
        headline: "sudo wants your password",
        summary: "",
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
        return { category: "approval", confidence: 0.9, question: null };
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

  it("abandons a pass started under keys that have since changed, and reads the screen again", async () => {
    let release!: () => void;
    let calls = 0;
    const h = await makeHarness({
      classify: async () => {
        calls++;
        if (calls === 1) await new Promise<void>((resolve) => (release = resolve));
        return { category: "working", confidence: 0.9, question: null };
      },
    });
    h.runs.push(run("a"));
    h.screens.set("a", "✻ Working (esc to interrupt)");
    const scan = h.service.scan();
    await vi.waitFor(() => expect(calls).toBe(1));

    h.service.setConfig({
      classifierKey: "c2",
      describerKey: "d2",
      describerModel: "gpt-oss-120b",
      missingKeys: [],
    });
    release();
    await scan;
    await settle();
    await h.service.scan();
    expect(calls).toBe(2);
    expect(h.service.getSnapshot().cards).toHaveLength(1);
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

  it("never sends a provider key that appears on screen or in a title", async () => {
    const h = await makeHarness({});
    h.runs.push(run("a", { lastObservedTitle: "debug d-provider-key-123" }));
    h.screens.set("a", "echo c-provider-key-456");
    (h.service as unknown as { config: { classifierKey: string; describerKey: string } }).config = {
      ...(h.service as unknown as { config: object }).config,
      classifierKey: "c-provider-key-456",
      describerKey: "d-provider-key-123",
    } as never;
    await h.service.scan();
    const input = h.classify.mock.calls[0]![0];
    expect(input.screen).not.toContain("c-provider-key-456");
    expect(input.title).not.toContain("d-provider-key-123");
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

  it("records a provider failure without screen text, and retries that screen next scan", async () => {
    let fail = true;
    const h = await makeHarness({
      classify: async () => {
        if (fail) throw new Error("secret screen text must not leak");
        return { category: "working", confidence: 0.9, question: null };
      },
    });
    h.runs.push(run("a"));
    h.screens.set("a", "screen");
    await h.service.scan();
    expect(h.service.getSnapshot().lastError).toBe("Triage request failed");

    fail = false;
    await h.service.scan();
    expect(h.classify).toHaveBeenCalledTimes(2);
    expect(h.service.getSnapshot().lastError).toBeNull();
  });

  it("sends nothing while unconfigured", async () => {
    const h = await makeHarness({ missingKeys: ["CEREBRAS_API_KEY"] });
    h.runs.push(run("a"));
    h.screens.set("a", "screen");
    await h.service.scan();
    expect(h.classify).not.toHaveBeenCalled();
    expect(h.service.getSnapshot()).toMatchObject({
      configured: false,
      missingKeys: ["CEREBRAS_API_KEY"],
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
});
