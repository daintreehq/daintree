import { beforeEach, describe, expect, it, vi } from "vitest";

const workerClientMock = vi.hoisted(() => {
  const generate = vi.fn();
  const cancel = vi.fn();
  const constructed = vi.fn();
  class CopytreeWorkerClient {
    generate = generate;
    cancel = cancel;
    constructor(...args: unknown[]) {
      constructed(...args);
    }
  }
  return { generate, cancel, constructed, CopytreeWorkerClient };
});

vi.mock("../../workspace-host/CopytreeWorkerClient.js", () => ({
  CopytreeWorkerClient: workerClientMock.CopytreeWorkerClient,
}));

import {
  _resetWorkspaceRootCopyTreeForTests,
  cancelAllWorkspaceRootContext,
  generateWorkspaceRootContext,
} from "../workspaceRootCopyTree.js";
import type { CopyTreeOperationOwner } from "../copyTreeOperationOwner.js";

const RESULT = { content: "", fileCount: 1, filePath: "/tmp/out.xml", outputBytes: 4 };
const OWNER_A: CopyTreeOperationOwner = { workspaceId: "ws-a", endpointId: "local:1" };
const OWNER_B: CopyTreeOperationOwner = { workspaceId: "ws-b", endpointId: "local:2" };
const ownedByA = (owner: CopyTreeOperationOwner) => owner.workspaceId === "ws-a";

/** Let the lazy client's dynamic import and any queued cancels settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe("workspaceRootCopyTree", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetWorkspaceRootCopyTreeForTests();
    workerClientMock.generate.mockResolvedValue(RESULT);
  });

  it("reuses one persistent worker client across copies", async () => {
    const onProgress = vi.fn();
    await Promise.all([
      generateWorkspaceRootContext("/a", {}, onProgress, "/tmp/1.xml"),
      generateWorkspaceRootContext("/b", {}, onProgress, "/tmp/2.xml"),
    ]);
    await generateWorkspaceRootContext("/c", {}, onProgress, "/tmp/3.xml");

    expect(workerClientMock.constructed).toHaveBeenCalledTimes(1);
    expect(workerClientMock.generate).toHaveBeenCalledTimes(3);
    expect(workerClientMock.generate.mock.calls[0]).toEqual([
      "/a",
      {},
      onProgress,
      expect.any(String),
      "/tmp/1.xml",
    ]);
  });

  it("never lets main's client fall back to generating on main's own thread", async () => {
    await generateWorkspaceRootContext("/a", {}, vi.fn(), "/tmp/1.xml");
    expect(workerClientMock.constructed).toHaveBeenCalledWith(undefined, false);
  });

  it("never starts a copy cancelled while the client was still loading", async () => {
    // Prime the client so cancel-all knows one exists, then cancel the next copy
    // before its own await on the client resolves.
    await generateWorkspaceRootContext("/warm", {}, vi.fn(), "/tmp/0.xml");
    workerClientMock.generate.mockClear();

    const pending = generateWorkspaceRootContext("/a", {}, vi.fn(), "/tmp/1.xml", OWNER_A);
    cancelAllWorkspaceRootContext(ownedByA);

    await expect(pending).resolves.toEqual(expect.objectContaining({ fileCount: 0 }));
    expect((await pending).error).toBeTruthy();
    expect(workerClientMock.generate).not.toHaveBeenCalled();
  });

  it("never spawns a worker just to cancel nothing", async () => {
    cancelAllWorkspaceRootContext(() => true);
    await settle();
    expect(workerClientMock.constructed).not.toHaveBeenCalled();
  });

  it("cancels only the copies still in flight", async () => {
    let finish!: (value: typeof RESULT) => void;
    workerClientMock.generate.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const pending = generateWorkspaceRootContext("/a", {}, vi.fn(), "/tmp/1.xml", OWNER_A);
    await vi.waitFor(() => expect(workerClientMock.generate).toHaveBeenCalledTimes(1));
    const operationId = workerClientMock.generate.mock.calls[0]![3];

    cancelAllWorkspaceRootContext(ownedByA);
    await vi.waitFor(() => expect(workerClientMock.cancel).toHaveBeenCalledWith(operationId));

    finish(RESULT);
    await pending;
    workerClientMock.cancel.mockClear();
    cancelAllWorkspaceRootContext(ownedByA);
    await settle();
    expect(workerClientMock.cancel).not.toHaveBeenCalled();
  });

  it("forgets an operation whose generation rejected", async () => {
    workerClientMock.generate.mockRejectedValueOnce(new Error("worker down"));
    await expect(
      generateWorkspaceRootContext("/a", {}, vi.fn(), "/tmp/1.xml", OWNER_A)
    ).rejects.toThrow("worker down");

    cancelAllWorkspaceRootContext(() => true);
    await settle();
    expect(workerClientMock.cancel).not.toHaveBeenCalled();
  });

  it("cancels only the copies whose owner matches", async () => {
    const finishes: Array<(value: typeof RESULT) => void> = [];
    workerClientMock.generate.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishes.push(resolve);
        })
    );
    const a = generateWorkspaceRootContext("/a", {}, vi.fn(), "/tmp/1.xml", OWNER_A);
    const b = generateWorkspaceRootContext("/b", {}, vi.fn(), "/tmp/2.xml", OWNER_B);
    const unowned = generateWorkspaceRootContext("/c", {}, vi.fn(), "/tmp/3.xml");
    await vi.waitFor(() => expect(workerClientMock.generate).toHaveBeenCalledTimes(3));
    const idOf = (root: string) =>
      workerClientMock.generate.mock.calls.find(([path]) => path === root)![3];

    cancelAllWorkspaceRootContext(ownedByA);
    await settle();

    expect(workerClientMock.cancel.mock.calls).toEqual([[idOf("/a")]]);
    for (const finish of finishes) finish(RESULT);
    await Promise.all([a, b, unowned]);
  });

  it("starts a copy another workspace's cancel reached while the client was loading", async () => {
    await generateWorkspaceRootContext("/warm", {}, vi.fn(), "/tmp/0.xml");
    workerClientMock.generate.mockClear();

    const pending = generateWorkspaceRootContext("/b", {}, vi.fn(), "/tmp/1.xml", OWNER_B);
    cancelAllWorkspaceRootContext(ownedByA);

    await expect(pending).resolves.toEqual(RESULT);
    expect(workerClientMock.generate).toHaveBeenCalledTimes(1);
  });
});
