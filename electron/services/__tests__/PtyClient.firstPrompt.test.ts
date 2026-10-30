import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { EventEmitter } from "events";
import type { PtyHostSpawnOptions } from "../../../shared/types/pty-host.js";
import type { TerminalFirstPrompt } from "../../../shared/types/panel.js";
import { FIRST_PROMPT_MAX_CHARS } from "../../../shared/utils/firstPrompt.js";
import { appendHandbackInstruction } from "../../../shared/utils/handback.js";

const shared = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter } = require("events") as typeof import("events");
  const appEmitter = new EventEmitter();
  const appMock = Object.assign(appEmitter, {
    getPath: vi.fn().mockReturnValue("/mock/user/data"),
  });
  return {
    forkMock: vi.fn(),
    tracker: { removeTrashed: vi.fn(), persistTrashed: vi.fn(), clearAll: vi.fn() },
    appMock,
  };
});

vi.mock("electron", () => ({
  utilityProcess: { fork: shared.forkMock },
  UtilityProcess: EventEmitter,
  MessagePortMain: class {},
  app: shared.appMock,
}));

vi.mock("../TrashedPidTracker.js", () => ({
  getTrashedPidTracker: () => shared.tracker,
}));

vi.mock("../../utils/logger.js", () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  isValidLogOverrideLevel: vi.fn(() => true),
  ingestHostLogEvent: vi.fn(),
}));

interface MockUtilityProcess extends EventEmitter {
  postMessage: Mock;
  kill: Mock;
  stdout: EventEmitter;
  stderr: EventEmitter;
  pid?: number;
}

function createMockChild(): MockUtilityProcess {
  return Object.assign(new EventEmitter(), {
    postMessage: vi.fn(),
    kill: vi.fn(),
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    pid: 321,
  });
}

interface SubmitMessage {
  id: string;
  text: string;
  firstPrompt?: { text: string; truncated?: true };
}

function submitMessages(child: MockUtilityProcess): SubmitMessage[] {
  return child.postMessage.mock.calls
    .map((call: unknown[]) => call[0] as SubmitMessage & { type?: string })
    .filter((msg) => msg?.type === "submit");
}

function spawnGenerations(child: MockUtilityProcess, id: string): number[] {
  return child.postMessage.mock.calls
    .map(
      (call: unknown[]) => call[0] as { type?: string; id?: string; options?: PtyHostSpawnOptions }
    )
    .filter((msg) => msg?.type === "spawn" && msg.id === id)
    .map((msg) => msg.options!.launchGeneration!);
}

describe("PtyClient first prompt (#15521)", () => {
  let mockChild: MockUtilityProcess;
  let PtyClientClass: typeof import("../PtyClient.js").PtyClient;
  let disposeLifecycleLedger: typeof import("../pty/lifecycleLedger.js").disposeLifecycleLedger;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    shared.appMock.removeAllListeners();
    mockChild = createMockChild();
    shared.forkMock.mockReturnValue(mockChild);
    ({ PtyClient: PtyClientClass } = await import("../PtyClient.js"));
    ({ disposeLifecycleLedger } = await import("../pty/lifecycleLedger.js"));
    vi.useFakeTimers();
    disposeLifecycleLedger();
  });

  afterEach(() => {
    disposeLifecycleLedger();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const agentOptions: PtyHostSpawnOptions = {
    cwd: "/repo",
    cols: 80,
    rows: 24,
    launchAgentId: "claude",
    projectId: "proj-1",
  };

  function readyClient() {
    const client = new PtyClientClass();
    mockChild.emit("message", { type: "ready" });
    const recorded: Array<{ id: string; firstPrompt: TerminalFirstPrompt }> = [];
    client.on("first-prompt", (id: string, firstPrompt: TerminalFirstPrompt) =>
      recorded.push({ id, firstPrompt })
    );
    return { client, recorded };
  }

  function written(id: string, launchGeneration: number, text: string, at = 5_000): void {
    mockChild.emit("message", {
      type: "first-prompt-written",
      id,
      launchGeneration,
      firstPrompt: { text, via: "send", at },
    });
  }

  it("offers an agent run's sends until one is written, then records that one only", () => {
    const { client, recorded } = readyClient();
    client.spawn("t1", agentOptions);
    const [generation] = spawnGenerations(mockChild, "t1");

    client.submit("t1", "Fix the login bug");
    client.submit("t1", "Also the signup form");
    expect(submitMessages(mockChild).map((m) => m.firstPrompt?.text)).toEqual([
      "Fix the login bug",
      "Also the signup form",
    ]);

    written("t1", generation!, "Fix the login bug");
    written("t1", generation!, "Also the signup form");
    expect(recorded).toEqual([
      { id: "t1", firstPrompt: { text: "Fix the login bug", via: "send", at: 5_000 } },
    ]);

    client.submit("t1", "A third");
    expect(submitMessages(mockChild).at(-1)?.firstPrompt).toBeUndefined();
    client.dispose();
  });

  it("never offers a send to a run that has its record or isn't an agent", () => {
    const { client } = readyClient();
    client.spawn("launched", { ...agentOptions, hasFirstPrompt: true });
    client.spawn("shell", { ...agentOptions, launchAgentId: undefined });

    client.submit("launched", "hello");
    client.submit("shell", "ls");
    expect(submitMessages(mockChild).map((m) => m.firstPrompt)).toEqual([undefined, undefined]);
    client.dispose();
  });

  it("offers the text as its caller wrote it, before the handback instruction", () => {
    const { client } = readyClient();
    client.spawn("t1", agentOptions);
    client.spawn("t2", agentOptions);
    client.spawn("t3", agentOptions);

    client.submit("t1", appendHandbackInstruction("Run the suite", "k7f3qa"), "tok", "k7f3qa");
    client.submit(
      "t2",
      "From the Daintree Assistant on studio. Brief.\n\nRun the suite",
      "tok",
      undefined,
      "settled-prompt-strict",
      undefined,
      "Run the suite"
    );
    // A notice is nobody's prompt.
    client.submit("t3", "Worker finished", "tok", undefined, "settled-prompt", undefined, null);

    expect(submitMessages(mockChild).map((m) => m.firstPrompt)).toEqual([
      { text: "Run the suite" },
      { text: "Run the suite" },
      undefined,
    ]);
    client.dispose();
  });

  it("caps the offered text and offers nothing for a blank send", () => {
    const { client } = readyClient();
    client.spawn("t1", agentOptions);

    client.submit("t1", "   ");
    client.submit("t1", "x".repeat(FIRST_PROMPT_MAX_CHARS + 50));
    const [blank, long] = submitMessages(mockChild);
    expect(blank?.firstPrompt).toBeUndefined();
    expect(long?.firstPrompt?.text).toHaveLength(FIRST_PROMPT_MAX_CHARS);
    expect(long?.firstPrompt?.truncated).toBe(true);
    client.dispose();
  });

  it("drops a predecessor's write after a respawn and keeps the successor open", () => {
    const { client, recorded } = readyClient();
    client.spawn("t1", agentOptions);
    client.kill("t1");
    client.spawn("t1", agentOptions);
    const [first, second] = spawnGenerations(mockChild, "t1");

    written("t1", first!, "meant for the old run");
    expect(recorded).toEqual([]);

    client.submit("t1", "the new run's task");
    expect(submitMessages(mockChild).at(-1)?.firstPrompt?.text).toBe("the new run's task");
    written("t1", second!, "the new run's task");
    expect(recorded.map((r) => r.firstPrompt.text)).toEqual(["the new run's task"]);
    client.dispose();
  });

  it("stops offering once the run exits or is killed", () => {
    const { client, recorded } = readyClient();
    client.spawn("t1", agentOptions);
    client.spawn("t2", agentOptions);
    const [g1] = spawnGenerations(mockChild, "t1");
    const [g2] = spawnGenerations(mockChild, "t2");

    mockChild.emit("message", { type: "exit", id: "t1", exitCode: 0, launchGeneration: g1 });
    client.kill("t2");
    written("t1", g1!, "late");
    written("t2", g2!, "late");
    expect(recorded).toEqual([]);
    client.dispose();
  });
});
