import crypto from "node:crypto";
import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", async () => (await import("./harness/fakeElectron.js")).electronMock);

vi.mock("../../../shared/utils/trustedRenderer.js", () => ({
  isTrustedRendererUrl: () => true,
}));

vi.mock("../../services/TelemetryService.js", () => ({
  getCurrentCorrelationId: () => "corr-harness",
}));

vi.mock("../../window/webContentsRegistry.js", async () => {
  const { liveViews, projectKeys } = await import("./harness/fakeView.js");
  return {
    getWindowForWebContents: () => null,
    getProjectForWebContents: (id: number) => projectKeys.get(id) ?? null,
    getAppWebContents: () => null,
    // Every view in the harness is remote-bound: none is a local app view.
    getAllAppWebContents: () => [],
    getWebContentsForProject: () => [],
    hasRegisteredProjectViews: () => false,
    isCachedViewWebContents: () => false,
    resolveLiveWebContents: (id: number) => liveViews.get(id)?.webContents ?? null,
    registerPortHolderWebContents: () => undefined,
    clearPortHolderWebContents: () => undefined,
    clearPortHolderWebContentsIfCurrent: () => undefined,
    getPortHolderWebContentsId: () => undefined,
  };
});

import type { IpcEnvelope } from "../../../shared/types/ipc/errors.js";
import type { OperationOutcome } from "../../../shared/types/remoteHosts.js";
import { wrapSuccess } from "../../../shared/utils/ipcErrorSerialization.js";
import { CHANNELS } from "../../ipc/channels.js";
import { getIpcDispatcher } from "../../ipc/dispatcher.js";
import { getEndpointRegistry } from "../../ipc/endpointRegistry.js";
import type { IpcContext } from "../../ipc/types.js";
import {
  broadcastToProjectRenderers,
  broadcastToRenderer,
  typedHandleWithContext,
} from "../../ipc/utils.js";
import { getOperationRegistry } from "../../services/operations/index.js";
import { AppError } from "../../utils/errorTypes.js";
import { bytesTransferSource } from "../link/transfer.js";
import type { PortMessage } from "./harness/fakeView.js";
import { waitUntil } from "./harness/poll.js";
import { HOST_ID, startRemoteHarness, type RemoteHarness } from "./harness/remoteHarness.js";

const VIEW_A = 11; // studio-01:proj-1
const VIEW_B = 12; // studio-01:proj-2
const TEST_TIMEOUT_MS = 60_000;

let h: RemoteHarness | null = null;
const cleanups: Array<() => unknown> = [];

async function harness(options?: Parameters<typeof startRemoteHarness>[0]) {
  h = await startRemoteHarness(options);
  await h.connect();
  return h;
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  await h?.dispose();
  h = null;
});

/** What the preload's unwrapping invoke does with an envelope. */
function unwrap<T>(envelope: IpcEnvelope): T {
  if (envelope.ok) return envelope.data as T;
  // The preload encodes the code into the message so it survives contextBridge.
  throw new Error(`[AppError|${envelope.error.code ?? "UNKNOWN"}] ${envelope.error.message}`);
}

function errorCode(envelope: IpcEnvelope): string | null {
  return envelope.ok ? null : (envelope.error.code ?? null);
}

function decode(message: PortMessage): string {
  return new TextDecoder().decode(message.data as Uint8Array);
}

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

describe("Remote Hosts end to end over a real socket", () => {
  it(
    "hydrate: a remote-bound view's hybrid hydrate reaches the host's handler and merges its answer",
    async () => {
      const r = await harness();
      const view = r.addView(VIEW_A, "proj-1");
      const hostCalls: IpcContext[] = [];
      cleanups.push(
        typedHandleWithContext(
          CHANNELS.APP_HYDRATE as never,
          ((ctx: IpcContext) => {
            const remote = ctx.endpoint.kind === "remote-view";
            if (remote) hostCalls.push(ctx);
            return remote
              ? { side: "host", projectId: ctx.projectId, projects: ["proj-1", "proj-2"] }
              : { side: "shell", theme: "daintree" };
          }) as never
        )
      );

      // No split yet: a hybrid channel is never silently answered locally.
      const unsplit = await r.invoke(CHANNELS.APP_HYDRATE, view, {});
      expect(errorCode(unsplit)).toBe("CHANNEL_NOT_REMOTABLE");
      expect(hostCalls).toHaveLength(0);

      cleanups.push(getIpcDispatcher().allowHybridOverLink(CHANNELS.APP_HYDRATE));
      cleanups.push(
        getIpcDispatcher().registerHybridSplit(CHANNELS.APP_HYDRATE, async ({ local, remote }) => ({
          ...((await local()) as object),
          host: await remote(),
        }))
      );

      const envelope = await r.invoke(CHANNELS.APP_HYDRATE, view, {});

      expect(envelope).toEqual(
        wrapSuccess({
          side: "shell",
          theme: "daintree",
          host: { side: "host", projectId: "proj-1", projects: ["proj-1", "proj-2"] },
        })
      );
      expect(hostCalls).toHaveLength(1);
      expect(hostCalls[0]!.event).toBeNull();
      expect(hostCalls[0]!.webContentsId).toBeLessThan(0);
      expect(hostCalls[0]!.client).toMatchObject({ clientName: "greg-mbp", kind: "remote" });
    },
    TEST_TIMEOUT_MS
  );

  it(
    "invoke: a typed host handler round-trips its envelope, and an AppError keeps its details",
    async () => {
      const r = await harness();
      const view = r.addView(VIEW_A, "proj-1");
      cleanups.push(
        typedHandleWithContext(
          CHANNELS.WORKTREE_GET_ALL as never,
          ((ctx: IpcContext, payload?: { fail?: boolean }) => {
            if (payload?.fail) {
              throw new AppError({
                code: "PLUGIN_NOT_ON_HOST",
                message: "plugin missing at /Users/greg/secret",
                context: { path: "/Users/greg/secret" },
                details: { code: "PLUGIN_NOT_ON_HOST", pluginId: "acme", hostId: HOST_ID },
              });
            }
            return [
              {
                id: "wt-main",
                path: `/srv/${ctx.projectId}`,
                branch: "main",
                isMainWorktree: true,
              },
            ];
          }) as never
        )
      );

      const ok = await r.invoke(CHANNELS.WORKTREE_GET_ALL, view);
      expect(ok).toEqual(
        wrapSuccess([{ id: "wt-main", path: "/srv/proj-1", branch: "main", isMainWorktree: true }])
      );

      const failed = await r.invoke(CHANNELS.WORKTREE_GET_ALL, view, { fail: true });
      expect(failed.ok).toBe(false);
      if (failed.ok) return;
      const error = failed.error as typeof failed.error & { details?: unknown };
      expect(error.code).toBe("PLUGIN_NOT_ON_HOST");
      expect(error.details).toEqual({
        code: "PLUGIN_NOT_ON_HOST",
        pluginId: "acme",
        hostId: HOST_ID,
      });
      expect(JSON.stringify(error)).not.toContain("/Users/greg/secret");
    },
    TEST_TIMEOUT_MS
  );

  it(
    "events: a project broadcast reaches only the bound view; a global broadcast reaches it too",
    async () => {
      const r = await harness();
      const a = r.addView(VIEW_A, "proj-1");
      const b = r.addView(VIEW_B, "proj-2");
      await r.openStreams(a);
      await r.openStreams(b);
      const channel = CHANNELS.OPERATIONS_EVENT;

      broadcastToProjectRenderers("proj-1", channel, { type: "scoped" });
      broadcastToRenderer(channel, { type: "global" });

      await waitUntil(() => a.events.length === 2, "view A's events");
      await waitUntil(() => b.events.length === 1, "view B's event");
      // One session carries both views' events in order, so a misrouted
      // scoped event would have reached B before the global one.
      expect(a.events).toEqual([
        { channel, args: [{ type: "scoped" }] },
        { channel, args: [{ type: "global" }] },
      ]);
      expect(b.events).toEqual([{ channel, args: [{ type: "global" }] }]);
    },
    TEST_TIMEOUT_MS
  );

  it(
    "terminal I/O: input reaches the pty, output reaches the renderer port unchanged, acks flow back",
    async () => {
      const r = await harness();
      r.pty.spawn("t1", "proj-1");
      const view = r.addView(VIEW_A, "proj-1");
      await r.openStreams(view);

      view.write("t1", "ls -la\r");
      await waitUntil(() => r.pty.terminals.get("t1")!.writes.length === 1, "the write at the pty");
      expect(r.pty.terminals.get("t1")!.writes).toEqual(["ls -la\r"]);

      view.autoAck = false;
      const sent = r.pty.emit("t1", "hello ") + r.pty.emit("t1", "wörld");
      await waitUntil(() => view.dataFrames("t1").length === 2, "two output frames");
      for (const frame of view.dataFrames("t1")) {
        expect(Object.keys(frame).sort()).toEqual(["bytes", "data", "id", "type"]);
        expect(frame.data).toBeInstanceOf(Uint8Array);
        expect(frame.bytes).toBe((frame.data as Uint8Array).byteLength);
      }
      expect(view.text("t1")).toBe("hello wörld");
      // Nothing has acked yet: the pty-host still counts the output against the port.
      expect(r.pty.unacked("t1")).toBe(sent);

      for (const frame of view.dataFrames("t1")) view.ack("t1", frame.bytes as number);
      await waitUntil(() => r.pty.unacked("t1") === 0, "the renderer's acks at the pty");
    },
    TEST_TIMEOUT_MS
  );

  it(
    "resize: the driving view's resize reaches its pty and never a foreign project's",
    async () => {
      const r = await harness();
      r.pty.spawn("t1", "proj-1");
      r.pty.spawn("t-foreign", "proj-2");
      const view = r.addView(VIEW_A, "proj-1");
      await r.openStreams(view);

      view.resize("t-foreign", 200, 60);
      view.resize("t1", 132, 43);
      await waitUntil(() => r.pty.terminals.get("t1")!.resizes.length === 1, "the resize");

      expect(r.pty.terminals.get("t1")).toMatchObject({ cols: 132, rows: 43 });
      // Same port, sent first: had it been forwarded it would already be there.
      expect(r.pty.terminals.get("t-foreign")!.resizes).toEqual([]);
    },
    TEST_TIMEOUT_MS
  );

  it(
    "reconnect (transport): missed output replays exactly once in order; an overflowed ring sends one snapshot RESET frame",
    async () => {
      const r = await harness();
      r.pty.spawn("t1", "proj-1");
      const view = r.addView(VIEW_A, "proj-1");
      const { relay } = await r.openStreams(view);
      const expected: string[] = [];
      const say = (text: string) => {
        r.pty.emit("t1", text);
        expected.push(text);
      };

      for (let i = 0; i < 20; i++) say(`a${i};`);
      await waitUntil(() => view.text("t1") === expected.join(""), "the first output");

      // Drop mid-output: frames are in flight at every stage when the socket dies.
      for (let i = 0; i < 50; i++) say(`b${i};`);
      const dropping = r.dropLink();
      for (let i = 0; i < 50; i++) say(`c${i};`);
      await dropping;
      for (let i = 0; i < 200; i++) say(`d${i};`);
      // At least everything said while away is still owed to the renderer.
      expect(view.dataFrames("t1").length).toBeLessThanOrEqual(expected.length - 200);

      await r.restoreLink();
      say("END");
      await waitUntil(() => view.text("t1").endsWith("END"), "the output after the resume");

      expect(view.text("t1")).toBe(expected.join(""));
      expect(view.dataFrames("t1")).toHaveLength(expected.length);
      expect(view.resets("t1")).toEqual([]);
      expect(relay.position("t1")).toEqual({ incarnation: 0, lastSeq: expected.length });
      const painted = view.text("t1");

      // Now more than the ring holds while the Shell is away.
      await r.dropLink();
      const chunk = "x".repeat(64 * 1024 - 16);
      let frames = expected.length;
      for (let i = 0; i < 96; i++) {
        r.pty.emit("t1", `${String(i).padStart(6, "0")}|${chunk}\n`);
        frames++;
      }
      r.pty.emit("t1", "TAIL-OF-OVERFLOW");
      frames++;
      const bridge = r.bridges.get(relay.endpointId)!;
      await waitUntil(() => bridge.position("t1")?.seq === frames, "the host to ring the overflow");

      await r.restoreLink();
      await waitUntil(() => view.resets("t1").length === 1, "the snapshot reset");

      const [reset] = view.resets("t1");
      const terminal = r.pty.terminals.get("t1")!;
      expect(reset!.snapshot).toEqual({ data: terminal.transcript, cols: 80, rows: 24 });
      expect((reset!.snapshot as { data: string }).data.endsWith("TAIL-OF-OVERFLOW")).toBe(true);
      // Transport only: no data frame carried the overflowed range, so the
      // RESET frame is its sole carrier. FakeView records frames and paints
      // nothing; the xterm repaint is TerminalInstanceService.remoteReset.test.ts.
      expect(view.text("t1")).toBe(painted);

      r.pty.emit("t1", "live-again");
      await waitUntil(() => view.text("t1").endsWith("live-again"), "live output after the reset");
      expect(view.text("t1")).toBe(painted + "live-again");
      expect(relay.position("t1")).toEqual({ incarnation: 0, lastSeq: frames + 1 });
    },
    TEST_TIMEOUT_MS
  );

  it(
    "operation outcome (transport): a clone whose reply was lost resolves to succeeded over the reconnected link",
    async () => {
      const r = await harness();
      const view = r.addView(VIEW_A, "proj-1");
      let finish!: () => void;
      const finished = new Promise<void>((resolve) => (finish = resolve));
      // A stand-in for the clone handler with the production registry shape;
      // counted so the retry claim rests on executions, not on bookkeeping.
      let handlerCalls = 0;
      let cloneRuns = 0;
      cleanups.push(
        typedHandleWithContext(
          CHANNELS.PROJECT_CLONE_REPO as never,
          ((ctx: IpcContext, payload: { opId: string; url: string }) => {
            handlerCalls++;
            return getOperationRegistry().run(
              { opId: payload.opId, kind: "git-clone", projectId: ctx.projectId },
              async (op) => {
                cloneRuns++;
                op.progress({ fraction: 0.5, stage: "receiving", message: null });
                await finished;
                return { success: true, clonedPath: `/srv/${payload.url.split("/").pop()}` };
              }
            );
          }) as never
        )
      );

      const opId = `op-${crypto.randomUUID()}`;
      const reply = r.invoke(CHANNELS.PROJECT_CLONE_REPO, view, {
        opId,
        url: "https://example.com/acme/widgets",
      });
      await waitUntil(
        () => getOperationRegistry().get(opId)?.outcome.status === "running",
        "the clone to start on the host"
      );

      await r.dropLink();
      const lost = await reply;
      expect(["HOST_DISCONNECTED", "OUTCOME_UNKNOWN"]).toContain(errorCode(lost));

      finish();
      await waitUntil(
        () => getOperationRegistry().get(opId)?.outcome.status === "succeeded",
        "the clone to finish on the host"
      );

      // The renderer's own recovery path, fed by this view's link.
      const modulePath = "../../../src/utils/resolveUnknownOutcome.ts";
      const { resolveUnknownOutcome } = (await import(/* @vite-ignore */ modulePath)) as {
        resolveUnknownOutcome: (
          opId: string,
          options: Record<string, unknown>
        ) => Promise<OperationOutcome>;
      };
      const restored = r.restoreLink();
      const outcome = await resolveUnknownOutcome(opId, {
        waitForConnected: () => restored,
        pollIntervalMs: 20,
        settleTimeoutMs: 10_000,
        client: {
          getStatus: async (id: string) =>
            unwrap<OperationOutcome>(
              await r.invoke(CHANNELS.OPERATIONS_GET_STATUS, view, { opId: id })
            ),
          onEvent: () => () => undefined,
        },
      });

      expect(outcome).toEqual({
        status: "succeeded",
        result: { success: true, clonedPath: "/srv/widgets" },
        settledAt: expect.any(Number),
      });
      // The retry by opId lands on the same record rather than cloning twice.
      const again = await r.invoke(CHANNELS.PROJECT_CLONE_REPO, view, {
        opId,
        url: "https://example.com/acme/widgets",
      });
      expect(again).toEqual(wrapSuccess({ success: true, clonedPath: "/srv/widgets" }));
      expect(handlerCalls).toBe(2);
      expect(cloneRuns).toBe(1);
      expect(getEndpointRegistry().getRemote()).toHaveLength(1);
    },
    TEST_TIMEOUT_MS
  );

  it(
    "latency: a keystroke's echo stays interactive under a bulk transfer and an output flood",
    async () => {
      const r = await harness();
      r.pty.spawn("t-echo", "proj-1", { echo: true });
      r.pty.spawn("t-flood", "proj-1");
      const view = r.addView(VIEW_A, "proj-1");
      await r.openStreams(view);

      const keystroke = async (key: string): Promise<number> => {
        const echoed = view.nextMessage(
          (m) => m.type === "data" && m.id === "t-echo" && decode(m).includes(key)
        );
        const started = performance.now();
        view.write("t-echo", key);
        await echoed;
        return performance.now() - started;
      };

      const idle: number[] = [];
      for (let i = 0; i < 50; i++) idle.push(await keystroke(`i${String(i).padStart(4, "0")}`));

      // Bulk: back-to-back 32 MiB uploads over the link for the whole measurement.
      const payload = crypto.randomBytes(32 * 1024 * 1024);
      const source = bytesTransferSource(payload);
      let bulkBytes = 0;
      let loaded = true;
      const bulk = (async () => {
        while (loaded) {
          const result = await r.clientSession().transfers.send(source, {
            name: "bulk.bin",
            destination: { kind: "inbox", bucket: "files" },
            onProgress: (p) => {
              if (p.bytes === p.totalBytes) bulkBytes += p.totalBytes;
            },
          });
          expect(result.bytes).toBe(payload.byteLength);
        }
      })();

      // Flood: as fast as the pty-host's flow control lets it (512 KiB unacked).
      const floodChunk = "y".repeat(32 * 1024);
      let floodFramesSent = 0;
      const flood = () => {
        if (!loaded) return;
        while (r.pty.unacked("t-flood") < 512 * 1024) {
          r.pty.emit("t-flood", floodChunk);
          floodFramesSent++;
        }
        setImmediate(flood);
      };
      flood();
      await waitUntil(
        () =>
          view.dataFrames("t-flood").length > 64 && r.clientSession().transfers.activeOutgoing > 0,
        "the flood and the bulk transfer to be under way"
      );

      const floodBefore = view.dataFrames("t-flood").length;
      const loadedStarted = performance.now();
      const underLoad: number[] = [];
      let duringTransfer = 0;
      for (let i = 0; i < 200; i++) {
        underLoad.push(await keystroke(`k${String(i).padStart(4, "0")}`));
        if (r.clientSession().transfers.activeOutgoing > 0) duringTransfer++;
      }
      const loadedMs = performance.now() - loadedStarted;
      const floodDelivered = view.dataFrames("t-flood").length - floodBefore;
      loaded = false;
      await bulk;

      const sortedIdle = [...idle].sort((x, y) => x - y);
      const sorted = [...underLoad].sort((x, y) => x - y);
      const report = {
        idle: {
          p50: percentile(sortedIdle, 50),
          p95: percentile(sortedIdle, 95),
          max: sortedIdle.at(-1)!,
        },
        loaded: {
          p50: percentile(sorted, 50),
          p95: percentile(sorted, 95),
          p99: percentile(sorted, 99),
          max: sorted.at(-1)!,
        },
        keystrokes: underLoad.length,
        duringTransfer,
        bulkMiBps: bulkBytes / 1024 / 1024 / (loadedMs / 1000),
        floodMiBps: (floodDelivered * floodChunk.length) / 1024 / 1024 / (loadedMs / 1000),
        floodFramesSent,
      };
      const line = `[remote-harness] keystroke RTT ms ${JSON.stringify(report, (_k, v: unknown) =>
        typeof v === "number" ? Math.round(v * 100) / 100 : v
      )}`;
      console.info(line);
      // vitest.config drops console output; the integrator reads this line from the run.
      process.stdout.write(`${line}\n`);

      // The measurement only means something if the load was really there.
      expect(duringTransfer).toBeGreaterThan(underLoad.length / 2);
      expect(floodDelivered).toBeGreaterThan(0);
      expect(report.loaded.p95).toBeLessThan(50);
    },
    TEST_TIMEOUT_MS * 2
  );
});
