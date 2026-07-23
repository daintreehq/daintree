import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceCopyTreeClient } from "../WorkspaceCopyTreeClient.js";
import type { WorkspaceHostProcess } from "../../WorkspaceHostProcess.js";
import type { ProcessEntry } from "../types.js";

function makeHost(overrides: Partial<WorkspaceHostProcess> = {}): WorkspaceHostProcess {
  return {
    generateRequestId: () => "req-1",
    send: vi.fn(),
    sendWithResponse: vi.fn(),
    dispose: vi.fn(),
    ...overrides,
  } as unknown as WorkspaceHostProcess;
}

function makeEntry(host: WorkspaceHostProcess, projectPath: string): ProcessEntry {
  return {
    host,
    refCount: 1,
    initPromise: Promise.resolve(),
    currentReadyPromise: Promise.resolve(),
    cleanupTimeout: null,
    windowIds: new Set(),
    projectPath,
    projectId: `id:${projectPath}`,
    directPortViews: new Map(),
  };
}

describe("WorkspaceCopyTreeClient", () => {
  let client: WorkspaceCopyTreeClient;
  let hostA: WorkspaceHostProcess;
  let hostB: WorkspaceHostProcess;
  let entries: ProcessEntry[];

  beforeEach(() => {
    hostA = makeHost();
    hostB = makeHost();
    entries = [makeEntry(hostA, "/project/a"), makeEntry(hostB, "/project/b")];

    client = new WorkspaceCopyTreeClient({
      resolveHostForPath: (targetPath: string) =>
        entries.find((e) => targetPath.startsWith(e.projectPath))?.host,
      iterateEntries: () => entries.values(),
    });
  });

  describe("cancelContext", () => {
    it("routes cancel to the host that owns the operation", () => {
      client.activeCopyTreeOperations.set("op-1", "/project/a");

      client.cancelContext("op-1");

      expect(hostA.send).toHaveBeenCalledWith({ type: "copytree:cancel", operationId: "op-1" });
      expect(hostB.send).not.toHaveBeenCalled();
    });

    it("silently no-ops when operationId is not found", () => {
      client.cancelContext("nonexistent");

      expect(hostA.send).not.toHaveBeenCalled();
      expect(hostB.send).not.toHaveBeenCalled();
    });

    it("cleans up both maps after cancel", () => {
      client.copyTreeProgressCallbacks.set("op-2", vi.fn());
      client.activeCopyTreeOperations.set("op-2", "/project/a");

      client.cancelContext("op-2");

      expect(client.activeCopyTreeOperations.has("op-2")).toBe(false);
      expect(client.copyTreeProgressCallbacks.has("op-2")).toBe(false);
    });

    it("silently no-ops when rootPath is set but host no longer resolves", () => {
      client.activeCopyTreeOperations.set("op-3", "/nonexistent");

      expect(() => client.cancelContext("op-3")).not.toThrow();
      expect(hostA.send).not.toHaveBeenCalled();
      expect(hostB.send).not.toHaveBeenCalled();
    });
  });

  describe("cancelAllContext", () => {
    it("broadcasts cancel to all hosts for every active operation", () => {
      client.activeCopyTreeOperations.set("op-1", "/project/a");
      client.activeCopyTreeOperations.set("op-2", "/project/b");

      client.cancelAllContext();

      expect(hostA.send).toHaveBeenCalledWith({ type: "copytree:cancel", operationId: "op-1" });
      expect(hostA.send).toHaveBeenCalledWith({ type: "copytree:cancel", operationId: "op-2" });
      expect(hostB.send).toHaveBeenCalledWith({ type: "copytree:cancel", operationId: "op-1" });
      expect(hostB.send).toHaveBeenCalledWith({ type: "copytree:cancel", operationId: "op-2" });
    });

    it("clears both maps", () => {
      const cb = vi.fn();
      client.copyTreeProgressCallbacks.set("op-1", cb);
      client.activeCopyTreeOperations.set("op-1", "/project/a");

      client.cancelAllContext();

      expect(client.activeCopyTreeOperations.size).toBe(0);
      expect(client.copyTreeProgressCallbacks.size).toBe(0);
    });
  });

  describe("dispose", () => {
    it("clears both maps", () => {
      const cb = vi.fn();
      client.copyTreeProgressCallbacks.set("op-1", cb);
      client.activeCopyTreeOperations.set("op-1", "/project/a");

      client.dispose();

      expect(client.activeCopyTreeOperations.size).toBe(0);
      expect(client.copyTreeProgressCallbacks.size).toBe(0);
    });
  });
});
