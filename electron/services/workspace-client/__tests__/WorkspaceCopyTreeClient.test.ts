import crypto from "crypto";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { WorkspaceCopyTreeClient } from "../WorkspaceCopyTreeClient.js";
import type { WorkspaceHostProcess } from "../../WorkspaceHostProcess.js";
import type { ProcessEntry } from "../types.js";
import type { CopyTreeOperationOwner } from "../../copyTreeOperationOwner.js";

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

  describe("generateContext", () => {
    it("carries the destination to the host so the bundle is written there, not returned", async () => {
      const sendWithResponse = vi
        .fn()
        .mockResolvedValue({ result: { content: "", fileCount: 2, filePath: "/tmp/ctx/a.xml" } });
      hostA = makeHost({ sendWithResponse });
      entries[0] = makeEntry(hostA, "/project/a");

      const result = await client.generateContext(
        "/project/a",
        { exclude: ["docs/**"] },
        undefined,
        "/tmp/ctx/a.xml"
      );

      expect(sendWithResponse.mock.calls[0][0]).toMatchObject({
        type: "copytree:generate",
        rootPath: "/project/a",
        options: { exclude: ["docs/**"] },
        outputPath: "/tmp/ctx/a.xml",
      });
      expect(result.filePath).toBe("/tmp/ctx/a.xml");
    });

    it("releases the operation once the generation settles", async () => {
      const sendWithResponse = vi.fn().mockRejectedValue(new Error("host died"));
      hostA = makeHost({ sendWithResponse });
      entries[0] = makeEntry(hostA, "/project/a");

      await expect(client.generateContext("/project/a")).rejects.toThrow("host died");

      expect(client.activeCopyTreeOperations.size).toBe(0);
      expect(client.copyTreeProgressCallbacks.size).toBe(0);
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
    const OWNER_A: CopyTreeOperationOwner = { workspaceId: "ws-a", endpointId: "local:1" };
    const OWNER_B: CopyTreeOperationOwner = { workspaceId: "ws-b", endpointId: "local:2" };
    const ownedByA = (owner: CopyTreeOperationOwner) => owner.workspaceId === "ws-a";

    /** Operations that stay in flight: A's generation and listing, B's generation, one with no owner. */
    function startInFlight() {
      const never = () => new Promise<never>(() => {});
      hostA = makeHost({ sendWithResponse: vi.fn(never) });
      hostB = makeHost({ sendWithResponse: vi.fn(never) });
      entries = [makeEntry(hostA, "/project/a"), makeEntry(hostB, "/project/b")];
      void client.generateContext("/project/a", {}, vi.fn(), undefined, OWNER_A);
      void client.generateContext("/project/b", {}, vi.fn(), undefined, OWNER_B);
      void client.getContextFileTree("/project/a", undefined, undefined, undefined, OWNER_A);
      void client.testConfig("/project/a", {}, OWNER_A);
      void client.testConfig("/project/b", {}, OWNER_B);
      void client.generateContext("/project/a", {}, vi.fn());
      const [aGenerate, bGenerate, aListing, aConfig, bConfig, unowned] = [
        ...client.activeCopyTreeOperations.keys(),
      ];
      return { aGenerate, bGenerate, aListing, aConfig, bConfig, unowned };
    }

    function cancelsSent(host: WorkspaceHostProcess): string[] {
      return (host.send as ReturnType<typeof vi.fn>).mock.calls.map(
        ([message]) => (message as { operationId: string }).operationId
      );
    }

    it("cancels the matching owner's operations on every host, and nothing else", () => {
      const ops = startInFlight();

      client.cancelAllContext(ownedByA);

      const swept = [ops.aGenerate, ops.aListing, ops.aConfig];
      expect(cancelsSent(hostA)).toEqual(swept);
      expect(cancelsSent(hostB)).toEqual(swept);
      expect([...client.activeCopyTreeOperations.keys()]).toEqual([
        ops.bGenerate,
        ops.bConfig,
        ops.unowned,
      ]);
      expect([...client.copyTreeProgressCallbacks.keys()]).toEqual([ops.bGenerate, ops.unowned]);
    });

    it("never sweeps an operation started with no owner", () => {
      const ops = startInFlight();

      client.cancelAllContext(() => true);

      expect(cancelsSent(hostA)).not.toContain(ops.unowned);
      expect([...client.activeCopyTreeOperations.keys()]).toEqual([ops.unowned]);
    });

    describe("forgets an operation's owner once it is done", () => {
      const REUSED_ID = "00000000-0000-4000-8000-000000000000" as const;
      const pending = () => new Promise<never>(() => {});

      afterEach(() => {
        vi.restoreAllMocks();
      });

      it.each<[string, (respond: Mock) => Promise<void>]>([
        [
          "its generation completes",
          async (respond) => {
            respond.mockResolvedValueOnce({ result: { content: "", fileCount: 1 } });
            await client.generateContext("/project/a", {}, undefined, undefined, OWNER_A);
          },
        ],
        [
          "its generation fails",
          async (respond) => {
            respond.mockRejectedValueOnce(new Error("host died"));
            await expect(
              client.generateContext("/project/a", {}, undefined, undefined, OWNER_A)
            ).rejects.toThrow("host died");
          },
        ],
        [
          "its config test completes",
          async (respond) => {
            respond.mockResolvedValueOnce({ result: { includedFiles: 0, includedSize: 0 } });
            await client.testConfig("/project/a", {}, OWNER_A);
          },
        ],
        [
          "its listing completes",
          async (respond) => {
            respond.mockResolvedValueOnce({ nodes: [] });
            await client.getContextFileTree("/project/a", undefined, undefined, undefined, OWNER_A);
          },
        ],
        [
          "it is cancelled by id",
          async (respond) => {
            respond.mockImplementationOnce(pending);
            void client.generateContext("/project/a", {}, undefined, undefined, OWNER_A);
            client.cancelContext(REUSED_ID);
          },
        ],
        [
          "it is swept",
          async (respond) => {
            respond.mockImplementationOnce(pending);
            void client.generateContext("/project/a", {}, undefined, undefined, OWNER_A);
            client.cancelAllContext(ownedByA);
          },
        ],
      ])("once %s", async (_label, finish) => {
        vi.spyOn(crypto, "randomUUID").mockReturnValue(REUSED_ID);
        const respond = vi.fn();
        hostA = makeHost({ sendWithResponse: respond });
        entries[0] = makeEntry(hostA, "/project/a");
        await finish(respond);
        (hostA.send as Mock).mockClear();
        (hostB.send as Mock).mockClear();

        // The id comes round again for a run with no owner, which no sweep may reach.
        respond.mockImplementationOnce(pending);
        void client.generateContext("/project/a", {}, vi.fn());
        client.cancelAllContext(() => true);

        expect(hostA.send).not.toHaveBeenCalled();
        expect(hostB.send).not.toHaveBeenCalled();
      });
    });
  });

  describe("getContextFileTree", () => {
    it("sends the context listing request to the host that owns the path", async () => {
      const sendWithResponse = vi.fn().mockResolvedValue({ nodes: [] });
      hostA = makeHost({ sendWithResponse });
      entries[0] = makeEntry(hostA, "/project/a");

      await client.getContextFileTree("/project/a", "src", { exclude: ["docs/**"] }, true);

      expect(sendWithResponse).toHaveBeenCalledTimes(1);
      expect(sendWithResponse.mock.calls[0][0]).toMatchObject({
        type: "copytree:get-file-tree",
        worktreePath: "/project/a",
        dirPath: "src",
        options: { exclude: ["docs/**"] },
        includeExcluded: true,
      });
    });

    it("tracks the listing so a cancel-all can reclaim a walk in progress", async () => {
      let seenDuringCall = 0;
      const sendWithResponse = vi.fn().mockImplementation(async () => {
        seenDuringCall = client.activeCopyTreeOperations.size;
        return { nodes: [] };
      });
      hostA = makeHost({ sendWithResponse });
      entries[0] = makeEntry(hostA, "/project/a");

      await client.getContextFileTree("/project/a");

      // A full-root dry run can run for hundreds of milliseconds, so it has to
      // be cancellable for its whole duration — and released afterwards.
      expect(seenDuringCall).toBe(1);
      expect(client.activeCopyTreeOperations.size).toBe(0);
    });

    it("surfaces a host-reported error rather than an empty tree", async () => {
      // An empty listing reads as "nothing here"; a failure has to look like a
      // failure, or the picker silently shows a project as having no files.
      const sendWithResponse = vi.fn().mockResolvedValue({ nodes: [], error: "scan exploded" });
      hostA = makeHost({ sendWithResponse });
      entries[0] = makeEntry(hostA, "/project/a");

      await expect(client.getContextFileTree("/project/a")).rejects.toThrow("scan exploded");
      expect(client.activeCopyTreeOperations.size).toBe(0);
    });

    it("throws when no host owns the path", async () => {
      await expect(client.getContextFileTree("/nonexistent")).rejects.toThrow(
        "No workspace host for path"
      );
    });
  });
});
