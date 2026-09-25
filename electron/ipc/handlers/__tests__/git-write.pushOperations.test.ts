import { describe, it, expect, vi, beforeEach } from "vitest";

const ipcMainMock = vi.hoisted(() => ({
  handle: vi.fn(),
  removeHandler: vi.fn(),
}));

// `git:push` registers via `typedHandleWithContext`, so `buildIpcContext` runs
// and reaches BrowserWindow through the webContents registry — a bare `ipcMain`
// mock leaves it undefined and every context-taking handler throws.
vi.mock("electron", () => ({
  ipcMain: ipcMainMock,
  BrowserWindow: {
    fromWebContents: vi.fn(() => null),
    getAllWindows: vi.fn(() => []),
  },
  webContents: { fromId: vi.fn(() => null) },
}));

vi.mock("../../../store.js", () => ({
  store: { get: vi.fn().mockReturnValue({ uiFeedbackSoundEnabled: false }) },
}));

vi.mock("../../../services/SoundService.js", () => ({
  soundService: { play: vi.fn() },
}));

vi.mock("../../../services/getSoundService.js", () => ({
  getSoundService: vi.fn().mockResolvedValue({ play: vi.fn() }),
}));

const createHardenedGitMock = vi.hoisted(() => vi.fn());
const createAuthenticatedGitMock = vi.hoisted(() => vi.fn());

vi.mock("../../../utils/hardenedGit.js", () => ({
  validateCwd: vi.fn(),
  createHardenedGit: createHardenedGitMock,
  createAuthenticatedGit: createAuthenticatedGitMock,
  buildContinueEnv: vi.fn(() => ({})),
}));

import { registerGitWriteHandlers } from "../git-write.js";
import { _resetRateLimitQueuesForTest } from "../../utils.js";
import {
  OperationRegistry,
  _resetOperationRegistryForTest,
} from "../../../services/operations/index.js";
import type { OperationsEvent } from "../../../../shared/types/ipc/operations.js";

const CWD = "/repo";
const FAKE_EVENT = { sender: { id: 1 } };
const FOR_EACH_REF = "refs/heads/topic\u0000origin\u0000refs/remotes/origin/topic";

type ProgressFn = (data: {
  stage: string;
  progress: number;
  processed: number;
  total: number;
}) => void;

let events: OperationsEvent[];
let registry: OperationRegistry;
let progress: ProgressFn | undefined;
let releasePush: () => void;
let failPush: (error: Error) => void;
let pushCalls: number;

function getHandler(channel: string) {
  const call = ipcMainMock.handle.mock.calls.find((c: unknown[]) => c[0] === channel);
  if (!call) throw new Error(`Handler for ${channel} not registered`);
  return call[1] as (_e: unknown, ...args: unknown[]) => Promise<unknown>;
}

const push = (payload: Record<string, unknown>) =>
  getHandler("git:push")(FAKE_EVENT, { cwd: CWD, ...payload });

async function pushStarted(count = 1) {
  await vi.waitFor(() => expect(pushCalls).toBe(count));
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetRateLimitQueuesForTest();
  events = [];
  registry = new OperationRegistry({ emit: (_projectId, event) => events.push(event) });
  _resetOperationRegistryForTest(registry);
  pushCalls = 0;
  createAuthenticatedGitMock.mockImplementation(
    async (_cwd: string, opts?: { progress?: ProgressFn }) => {
      if (opts?.progress) progress = opts.progress;
      return {
        revparse: vi.fn(async () => "topic\n"),
        raw: vi.fn(async (args: string[]) =>
          args[0] === "for-each-ref" ? `${FOR_EACH_REF}\n` : ""
        ),
        getRemotes: vi.fn(async () => [{ name: "origin", refs: { fetch: "", push: "" } }]),
        push: vi.fn(
          () =>
            new Promise<void>((resolve, reject) => {
              pushCalls += 1;
              releasePush = resolve;
              failPush = reject;
            })
        ),
      };
    }
  );
  registerGitWriteHandlers({} as never);
});

describe("git push as an operation", () => {
  it("joins a retry with the same opId instead of pushing twice", async () => {
    const first = push({ opId: "op-1" });
    await pushStarted();
    const second = push({ opId: "op-1" });
    releasePush();
    await Promise.all([first, second]);

    expect(pushCalls).toBe(1);
    expect(registry.status("op-1")).toMatchObject({ status: "succeeded" });

    // Retried after the answer was lost: answered from the record.
    await push({ opId: "op-1" });
    expect(pushCalls).toBe(1);
  });

  it("gives a named caller the outcome of a push already running for the cwd", async () => {
    const unnamed = push({});
    await pushStarted();
    const named = push({ opId: "op-join" });
    failPush(new Error("fatal: Authentication failed"));

    await expect(unnamed).rejects.toThrow();
    await expect(named).rejects.toThrow();
    expect(pushCalls).toBe(1);
    expect(registry.status("op-join")).toMatchObject({ status: "failed" });
  });

  it("keeps a second unnamed push a silent no-op, as before", async () => {
    const first = push({});
    await pushStarted();
    await push({});
    expect(pushCalls).toBe(1);
    releasePush();
    await first;
  });

  it("reports progress to the operation, stamped with its opId", async () => {
    const run = push({ opId: "op-progress" });
    await pushStarted();
    progress!({ stage: "writing", progress: 50, processed: 5, total: 10 });
    releasePush();
    await run;

    expect(events).toContainEqual({
      type: "progress",
      progress: expect.objectContaining({
        opId: "op-progress",
        kind: "git-push",
        stage: "writing",
        fraction: 0.5,
      }),
    });
    expect(events.at(-1)).toMatchObject({
      type: "settled",
      record: { opId: "op-progress", outcome: { status: "succeeded" } },
    });
  });

  it("still settles a push with no opId under an id the Host minted", async () => {
    const run = push({});
    await pushStarted();
    releasePush();
    await run;

    const [record] = registry.list();
    expect(record).toMatchObject({ kind: "git-push", outcome: { status: "succeeded" } });
  });
});
