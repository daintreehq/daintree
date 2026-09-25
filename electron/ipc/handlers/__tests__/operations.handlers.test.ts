import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn(), on: vi.fn(), removeListener: vi.fn() },
  BrowserWindow: { fromWebContents: vi.fn(() => null), getAllWindows: vi.fn(() => []) },
  webContents: { fromId: vi.fn(() => null), getAllWebContents: vi.fn(() => []) },
}));

import { operationsNamespace } from "../operations.js";
import type { IpcContext } from "../../types.js";
import {
  OperationRegistry,
  _resetOperationRegistryForTest,
} from "../../../services/operations/index.js";

const { getStatus, list, cancel } = operationsNamespace.ops;

const localCtx = {
  projectId: "p1",
  endpoint: { kind: "local-view" },
} as unknown as IpcContext;
const remoteCtx = {
  projectId: "p1",
  endpoint: { kind: "remote-view" },
} as unknown as IpcContext;
let registry: OperationRegistry;

beforeEach(() => {
  registry = new OperationRegistry();
  _resetOperationRegistryForTest(registry);
});

describe("operations handlers", () => {
  it("answers status from the registry, unknown for an unseen or malformed id", async () => {
    await registry.run({ opId: "op-1", kind: "git-push", projectId: "p" }, async () => undefined);

    await expect(getStatus.handler(localCtx, { opId: "op-1" })).resolves.toMatchObject({
      status: "succeeded",
    });
    await expect(getStatus.handler(localCtx, { opId: "op-2" })).resolves.toEqual({
      status: "unknown",
    });
    await expect(getStatus.handler(localCtx, { opId: "../x" })).resolves.toEqual({
      status: "unknown",
    });
  });

  it("lists records, optionally for one project", async () => {
    registry.start({ opId: "a", kind: "git-push", projectId: "p1" });
    registry.start({ opId: "b", kind: "git-clone", projectId: null });

    const all = await list.handler(localCtx, {});
    expect(all.map((r) => r.opId)).toEqual(["a", "b"]);
    const scoped = await list.handler(localCtx, { projectId: "p1" });
    expect(scoped.map((r) => r.opId)).toEqual(["a"]);
  });

  it("cancels a running operation by id", async () => {
    const run = registry.run({ opId: "op-1", kind: "git-clone", projectId: null }, (op) => {
      return new Promise((_resolve, reject) => {
        op.onCancel(() => reject(new Error("aborted")));
      });
    });

    await expect(cancel.handler(localCtx, { opId: "nope" })).resolves.toBe(false);
    await expect(cancel.handler(localCtx, { opId: "op-1" })).resolves.toBe(true);
    await expect(run).rejects.toThrow("aborted");
    expect(registry.status("op-1").status).toBe("cancelled");
  });

  it("shows a remote client only its own project's operations", async () => {
    registry.start({ opId: "mine", kind: "git-push", projectId: "p1" });
    const other = registry.run({ opId: "theirs", kind: "git-clone", projectId: "p2" }, (op) => {
      return new Promise((_resolve, reject) => op.onCancel(() => reject(new Error("aborted"))));
    });

    expect((await list.handler(remoteCtx, {})).map((r) => r.opId)).toEqual(["mine"]);
    await expect(getStatus.handler(remoteCtx, { opId: "theirs" })).resolves.toEqual({
      status: "unknown",
    });
    await expect(cancel.handler(remoteCtx, { opId: "theirs" })).resolves.toBe(false);
    expect(registry.status("theirs").status).toBe("running");

    registry.cancel("theirs");
    await expect(other).rejects.toThrow("aborted");
  });
});
