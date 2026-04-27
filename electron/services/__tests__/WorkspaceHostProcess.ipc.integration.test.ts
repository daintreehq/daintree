/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const shared = vi.hoisted(() => {
  const forkMock = vi.fn();
  const appMock = {
    getPath: vi.fn(() => "/tmp/userData"),
    on: vi.fn(),
    off: vi.fn(),
  };
  return { forkMock, appMock };
});

vi.mock("electron", () => ({
  utilityProcess: { fork: shared.forkMock },
  UtilityProcess: class {},
  MessagePortMain: class {},
  app: shared.appMock,
}));

vi.mock("../github/GitHubAuth.js", () => ({
  GitHubAuth: {
    getToken: vi.fn(() => null),
  },
}));

vi.mock("../../utils/logger.js", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

let helpers: typeof import("./helpers/ipcContractTestUtils.js") | undefined;
try {
  helpers = await import("./helpers/ipcContractTestUtils.js");
} catch (_err) {
  console.warn("worker_threads helpers unavailable, skipping IPC contract tests");
}

const shouldSkip = !helpers;
const stubWorkerPath = helpers ? helpers.helperPath("stubWorkspaceHost.worker.mjs") : "";

describe.skipIf(shouldSkip)(
  "WorkspaceHostProcess IPC contract (real worker_threads boundary)",
  () => {
    let handle: import("./helpers/ipcContractTestUtils.js").StubHostHandle;
    let WorkspaceHostProcessCtor: typeof import("../WorkspaceHostProcess.js").WorkspaceHostProcess;

    beforeEach(async () => {
      handle = helpers!.spawnStubHost(stubWorkerPath);
      shared.forkMock.mockReset();
      shared.forkMock.mockReturnValue(handle.fakeChild);
      shared.appMock.getPath.mockClear();
      shared.appMock.on.mockClear();
      shared.appMock.off.mockClear();

      vi.resetModules();
      const mod = await import("../WorkspaceHostProcess.js");
      WorkspaceHostProcessCtor = mod.WorkspaceHostProcess;
    });

    afterEach(async () => {
      await handle.dispose();
      vi.clearAllMocks();
    });

    it("completes the ready handshake when the host posts `ready` over a real MessagePort", async () => {
      const host = new WorkspaceHostProcessCtor("/tmp/project", {
        maxRestartAttempts: 3,
        healthCheckIntervalMs: 60_000,
      } as any);
      try {
        await host.waitForReady();
        expect(host.isReady()).toBe(true);
        expect((host as any).child).toBe(handle.fakeChild);
      } finally {
        host.dispose();
      }
    });

    it("roundtrips Map/Date/Buffer/RegExp through real V8 structured-clone (both directions)", async () => {
      const host = new WorkspaceHostProcessCtor("/tmp/project", {
        maxRestartAttempts: 3,
        healthCheckIntervalMs: 60_000,
      } as any);
      try {
        await host.waitForReady();

        const payload = {
          map: new Map<string, string>([
            ["worktree-1", "main"],
            ["worktree-2", "feature/x"],
          ]),
          createdAt: new Date("2026-02-01T08:30:00.000Z"),
          rawDiff: Buffer.from("--- a/file\n+++ b/file\n@@ -1 +1 @@", "utf8"),
          regex: /^[a-z0-9-]+$/i,
        };

        const resultPromise = helpers!.waitForChildMessage<{
          type: string;
          requestId: string;
          payload: typeof payload;
        }>(
          handle.fakeChild,
          (m: any) => m?.type === "ipc-test:roundtrip-result" && m?.requestId === "wkr-1",
          5000
        );

        handle.fakeChild.postMessage({
          type: "ipc-test:roundtrip",
          requestId: "wkr-1",
          payload,
        });

        const result = await resultPromise;

        expect(result.payload.map).toBeInstanceOf(Map);
        expect(result.payload.map.get("worktree-1")).toBe("main");
        expect(result.payload.map.get("worktree-2")).toBe("feature/x");

        expect(result.payload.createdAt).toBeInstanceOf(Date);
        expect(result.payload.createdAt.getTime()).toBe(payload.createdAt.getTime());

        const echoedDiff = Buffer.from(result.payload.rawDiff);
        expect(echoedDiff.toString("utf8")).toBe("--- a/file\n+++ b/file\n@@ -1 +1 @@");

        expect(result.payload.regex).toBeInstanceOf(RegExp);
        expect(result.payload.regex.source).toBe("^[a-z0-9-]+$");
        expect(result.payload.regex.flags).toBe("i");
      } finally {
        host.dispose();
      }
    });

    it("emits host-recovering when the worker exits abruptly via real process.exit", async () => {
      const host = new WorkspaceHostProcessCtor("/tmp/project", {
        maxRestartAttempts: 0, // skip auto-restart so the test ends cleanly
        healthCheckIntervalMs: 60_000,
      } as any);
      try {
        await host.waitForReady();

        const recoveringPromise = new Promise<number | null>((resolve, reject) => {
          host.on("host-recovering", (code: number | null) => resolve(code));
          setTimeout(() => reject(new Error("host-recovering not emitted within 5s")), 5000);
        });

        handle.fakeChild.postMessage({ type: "ipc-test:die" });

        const code = await recoveringPromise;
        expect(code).toBe(1);
        expect(host.isReady()).toBe(false);
      } finally {
        host.dispose();
      }
    });

    it("attachWorktreePort sends the port in the transferList second arg, not in the message body", async () => {
      const host = new WorkspaceHostProcessCtor("/tmp/project", {
        maxRestartAttempts: 3,
        healthCheckIntervalMs: 60_000,
      } as any);
      try {
        await host.waitForReady();

        // Spy AFTER ready so we don't capture startup chatter
        // (set-log-level-overrides etc.). The spy still forwards to the
        // original by default — the worker actually receives the message.
        const postSpy = vi.spyOn(handle.fakeChild, "postMessage");

        const { MessageChannel } = await import("node:worker_threads");
        const channel = new MessageChannel();
        try {
          const accepted = host.attachWorktreePort(channel.port2 as any);
          expect(accepted).toBe(true);

          const attachCall = postSpy.mock.calls.find(
            (c) => (c[0] as any)?.type === "attach-worktree-port"
          );
          expect(attachCall).toBeDefined();
          // Body holds only the type discriminator — no port reference.
          expect(attachCall![0]).toEqual({ type: "attach-worktree-port" });
          // Transfer list (second arg) carries the port itself. This matches
          // the MessagePortMain transfer contract; mock-only tests can
          // satisfy the call shape but only a real port survives the trip
          // through the worker_threads structured-clone boundary.
          //
          // Note: this assertion only locks the SOURCE-side call shape.
          // worker_threads does not populate `event.ports` on the receiver,
          // so the worker stub never sees the transferred port — that
          // unwrap path is Electron-runtime-specific. See
          // ipcContractTestUtils.ts header for the full gap rationale.
          expect(attachCall![1]).toBeDefined();
          expect(Array.isArray(attachCall![1])).toBe(true);
          expect((attachCall![1] as unknown[]).length).toBe(1);
          expect((attachCall![1] as unknown[])[0]).toBe(channel.port2);
        } finally {
          try {
            channel.port1.close();
          } catch {
            /* ignore */
          }
        }
      } finally {
        host.dispose();
      }
    });
  }
);
