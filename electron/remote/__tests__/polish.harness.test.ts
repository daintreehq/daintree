import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * This machine's clipboard and URL handler, the two OS surfaces these
 * scenarios read and write. Everything else is the shared harness's Electron.
 */
const os = vi.hoisted(() => ({
  image: null as null | { png: Buffer },
  written: [] as string[],
  opened: [] as string[],
}));

vi.mock("electron", async () => {
  const { electronMock } = await import("./harness/fakeElectron.js");
  return {
    ...electronMock,
    clipboard: {
      readImage: () => {
        const png = os.image?.png ?? null;
        return {
          isEmpty: () => png === null,
          toPNG: () => png ?? Buffer.alloc(0),
          getSize: () => ({ width: 800, height: 400 }),
          resize: () => ({ toPNG: () => Buffer.from("thumb") }),
        };
      },
      writeText: (text: string) => void os.written.push(text),
    },
    shell: {
      openExternal: async (url: string) => {
        os.opened.push(url);
        throw new Error("No application knows how to open this URL");
      },
    },
  };
});

vi.mock("../../../shared/utils/trustedRenderer.js", () => ({
  isTrustedRendererUrl: () => true,
}));

vi.mock("../../services/TelemetryService.js", () => ({
  getCurrentCorrelationId: () => "corr-harness",
}));

vi.mock("../../store.js", async () => ({
  store: (await import("./harness/harnessState.js")).memoryStore,
}));

vi.mock("../../services/ProjectStore.js", async () => ({
  projectStore: (await import("./harness/harnessState.js")).memoryProjectStore,
}));

vi.mock("../../boot/hostServices.js", () => ({
  isWorkspaceClientStarting: () => false,
  ensureWorkspaceClient: async () => undefined,
}));

vi.mock("../host/hostCommands.js", async () => {
  const { harnessState } = await import("./harness/harnessState.js");
  return {
    runCommand: async () => ({ code: 1, stdout: "", stderr: "not in the harness" }),
    spawnOwnedProcess: (file: string, args: readonly string[]) => {
      const record = { file, args, killed: false };
      harnessState.spawned.push(record);
      return { kill: () => (record.killed = true), onExit: () => undefined };
    },
  };
});

// Observe, not replace: the harness reads bridges to know a view's streams are flowing.
vi.mock("../terminal/TerminalStreamBridge.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../terminal/TerminalStreamBridge.js")>();
  const { harnessState } = await import("./harness/harnessState.js");
  class ObservedTerminalStreamBridge extends original.TerminalStreamBridge {
    constructor(options: ConstructorParameters<typeof original.TerminalStreamBridge>[0]) {
      super(options);
      harnessState.bridges.set(options.endpointId, this);
    }
  }
  return { ...original, TerminalStreamBridge: ObservedTerminalStreamBridge };
});

vi.mock("../client/initClient.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../client/initClient.js")>();
  const { harnessState } = await import("./harness/harnessState.js");
  return {
    ...original,
    initRemoteHostsClient: (...args: Parameters<typeof original.initRemoteHostsClient>) => {
      const client = original.initRemoteHostsClient(...args);
      harnessState.client = client;
      return client;
    },
  };
});

vi.mock("../../ipc/handlers/app/state.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../ipc/handlers/app/state.js")>()),
  readShellHydrateFields: () => ({ safeMode: false, crashCount: 0 }),
}));

vi.mock("../../services/PluginService.js", async () => ({
  pluginService: (await import("./harness/fakePluginService.js")).fakePluginService,
}));

vi.mock("../../window/webContentsRegistry.js", async () => {
  const { liveViews, projectKeys } = await import("./harness/fakeView.js");
  return {
    getWindowForWebContents: () => null,
    getProjectForWebContents: (id: number) => projectKeys.get(id) ?? null,
    getAppWebContents: () => null,
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
import type { FileTransferEvent } from "../../../shared/types/ipc/fileTransfer.js";
import type { ForgeProviderImpl } from "../../../shared/types/forge.js";
import type { HostMetricsSummary, MaterializeFn } from "../../../shared/types/remoteHosts.js";
import { CHANNELS } from "../../ipc/channels.js";
import type { IpcContext } from "../../ipc/types.js";
import { typedHandleWithContext } from "../../ipc/utils.js";
import {
  registerForgeProviderImpl,
  registerForgeProviders,
  unregisterForgeProviders,
} from "../../services/forgeProviderRegistry.js";
import { requireRemoteService } from "../runtime.js";
import type { FakeView } from "./harness/fakeView.js";
import { harnessState } from "./harness/harnessState.js";
import { waitUntil } from "./harness/poll.js";
import { HOST_ID, startRemoteHarness, type RemoteHarness } from "./harness/remoteHarness.js";

const VIEW = 21;
const TEST_TIMEOUT_MS = 60_000;

let h: RemoteHarness | null = null;
const cleanups: Array<() => unknown> = [];

async function harness() {
  h = await startRemoteHarness();
  await h.connect();
  return h;
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  await h?.dispose();
  h = null;
  os.image = null;
  os.written.length = 0;
  os.opened.length = 0;
});

function unwrap<T>(envelope: IpcEnvelope): T {
  if (envelope.ok) return envelope.data as T;
  throw Object.assign(new Error(envelope.error.message), { code: envelope.error.code });
}

/** A local handler that must never answer for a remote view. */
function localMustNotRun(channel: string): () => void {
  return typedHandleWithContext(
    channel as never,
    (() => {
      throw new Error(`${channel} ran on this machine's handler`);
    }) as never
  );
}

/** The view's `fileTransfer.onEvent`: what the Shell pushes to it, as it arrives. */
function transferEvents(view: FakeView) {
  const listeners = new Set<(event: FileTransferEvent) => void>();
  const send = view.webContents.send.bind(view.webContents);
  view.webContents.send = (channel: string, ...args: unknown[]) => {
    send(channel, ...args);
    if (channel !== CHANNELS.FILE_TRANSFER_EVENT) return;
    for (const listener of [...listeners]) listener(args[0] as FileTransferEvent);
  };
  return (callback: (event: FileTransferEvent) => void) => {
    listeners.add(callback);
    return () => listeners.delete(callback);
  };
}

async function listFiles(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch {
    return [];
  }
}

describe("Remote Hosts polish over the real link", () => {
  it(
    "upload: a pasted image shows real progress and Cancel stops the transfer mid-way, leaving nothing to insert",
    async () => {
      const r = await harness();
      const view = r.addView(VIEW, "proj-1");
      await r.openStreams(view);
      cleanups.push(localMustNotRun(CHANNELS.CLIPBOARD_SAVE_IMAGE));
      // Large enough that the credit window makes the transfer take many round trips.
      os.image = { png: crypto.randomBytes(16 * 1024 * 1024) };

      const modulePath = "../../../src/services/remoteMaterializer.ts";
      const { createRemoteMaterializer } = (await import(/* @vite-ignore */ modulePath)) as {
        createRemoteMaterializer: (deps: Record<string, unknown>) => MaterializeFn;
      };
      const call =
        (channel: string) =>
        async (payload: unknown): Promise<unknown> =>
          unwrap(await r.invoke(channel, view, payload));
      const failures: unknown[] = [];
      const materialize = createRemoteMaterializer({
        hostId: HOST_ID,
        hostLabel: () => HOST_ID,
        localLabel: "This Mac",
        fileTransfer: {
          statLocalFile: call(CHANNELS.FILE_TRANSFER_STAT_LOCAL_FILE),
          uploadLocalFile: call(CHANNELS.FILE_TRANSFER_UPLOAD_LOCAL_FILE),
          uploadBytes: call(CHANNELS.FILE_TRANSFER_UPLOAD_BYTES),
          cancel: call(CHANNELS.FILE_TRANSFER_CANCEL),
          onEvent: transferEvents(view),
        },
        saveClipboardImage: call(CHANNELS.CLIPBOARD_SAVE_IMAGE),
        confirmLargeUpload: async () => true,
        confirmReplace: async () => false,
        reportFailure: (failure: unknown) => failures.push(failure),
        mintOperationId: () => "op-paste-cancel",
      });

      // Cancel as soon as the chip has shown real progress, as the person would.
      const controller = new AbortController();
      const fractions: number[] = [];
      const pasted = materialize(
        { kind: "clipboard-image" },
        {
          signal: controller.signal,
          onProgress: (fraction) => {
            fractions.push(fraction);
            if (!controller.signal.aborted) controller.abort();
          },
        }
      );

      await expect(pasted).rejects.toMatchObject({ code: "CANCELLED" });
      expect(fractions.length).toBeGreaterThan(0);
      expect(fractions[0]!).toBeGreaterThan(0);
      expect(fractions[0]!).toBeLessThan(1);
      expect(failures).toEqual([]);
      // The transfer stopped: no image landed in the host's clipboard inbox.
      const clipboardInbox = path.join(r.hostTmpDir, "daintree-inbox", "clipboard");
      await new Promise((resolve) => setTimeout(resolve, 200));
      const landed = (await listFiles(clipboardInbox)).filter((name) => name.endsWith(".png"));
      expect(landed).toEqual([]);

      // Pasting again, uncancelled, puts the image on the host.
      const again = await createRemoteMaterializer({
        hostId: HOST_ID,
        hostLabel: () => HOST_ID,
        localLabel: "This Mac",
        fileTransfer: {
          statLocalFile: call(CHANNELS.FILE_TRANSFER_STAT_LOCAL_FILE),
          uploadLocalFile: call(CHANNELS.FILE_TRANSFER_UPLOAD_LOCAL_FILE),
          uploadBytes: call(CHANNELS.FILE_TRANSFER_UPLOAD_BYTES),
          cancel: call(CHANNELS.FILE_TRANSFER_CANCEL),
          onEvent: transferEvents(view),
        },
        saveClipboardImage: call(CHANNELS.CLIPBOARD_SAVE_IMAGE),
        confirmLargeUpload: async () => true,
        confirmReplace: async () => false,
        reportFailure: (failure: unknown) => failures.push(failure),
        mintOperationId: () => "op-paste-whole",
      })({ kind: "clipboard-image" });
      expect(again.hostPath.startsWith(clipboardInbox + path.sep)).toBe(true);
      const placed = await fs.readFile(again.hostPath);
      expect(placed.byteLength).toBe(os.image.png.byteLength);
    },
    TEST_TIMEOUT_MS
  );

  it(
    "editor: with no editor here for the host's file, the host path is copied on this machine and the window is told, naming the host",
    async () => {
      const r = await harness();
      const view = r.addView(VIEW, "proj-1");
      await r.openStreams(view);
      cleanups.push(localMustNotRun(CHANNELS.SYSTEM_OPEN_IN_EDITOR));

      const result = unwrap(
        await r.invoke(CHANNELS.SYSTEM_OPEN_IN_EDITOR, view, {
          path: "/srv/proj/src/a.ts",
          line: 4,
        })
      );

      expect(os.opened).toEqual([
        "vscode://vscode-remote/ssh-remote+studio.example/srv/proj/src/a.ts:4",
      ]);
      expect(os.written).toEqual(["/srv/proj/src/a.ts"]);
      expect(result).toEqual({
        outcome: "copied-host-path",
        path: "/srv/proj/src/a.ts",
        hostName: HOST_ID,
      });
    },
    TEST_TIMEOUT_MS
  );

  it(
    "log levels: a remote window's overrides are this machine's, and the host never hears of them",
    async () => {
      const r = await harness();
      const view = r.addView(VIEW, "proj-1");
      await r.openStreams(view);
      const calls: Array<{ channel: string; ctx: IpcContext }> = [];
      for (const channel of [
        CHANNELS.LOGS_GET_LEVEL_OVERRIDES,
        CHANNELS.LOGS_SET_LEVEL_OVERRIDES,
        CHANNELS.LOGS_CLEAR_LEVEL_OVERRIDES,
      ]) {
        cleanups.push(
          typedHandleWithContext(
            channel as never,
            ((ctx: IpcContext) => {
              calls.push({ channel, ctx });
              return channel === CHANNELS.LOGS_GET_LEVEL_OVERRIDES
                ? { "main:*": "debug" }
                : undefined;
            }) as never
          )
        );
      }

      expect(unwrap(await r.invoke(CHANNELS.LOGS_GET_LEVEL_OVERRIDES, view))).toEqual({
        "main:*": "debug",
      });
      unwrap(await r.invoke(CHANNELS.LOGS_SET_LEVEL_OVERRIDES, view, { "main:*": "warn" }));
      unwrap(await r.invoke(CHANNELS.LOGS_CLEAR_LEVEL_OVERRIDES, view));

      expect(calls.map((call) => call.channel)).toEqual([
        CHANNELS.LOGS_GET_LEVEL_OVERRIDES,
        CHANNELS.LOGS_SET_LEVEL_OVERRIDES,
        CHANNELS.LOGS_CLEAR_LEVEL_OVERRIDES,
      ]);
      // Each ran for the view on this machine, never as a link call on the host.
      for (const { ctx } of calls) {
        expect(ctx.webContentsId).toBe(VIEW);
        expect(ctx.endpoint?.kind).not.toBe("remote-view");
      }
    },
    TEST_TIMEOUT_MS
  );

  it(
    "forges: the host reports each forge's connection in its summary, and the Shell receives it without the credential",
    async () => {
      registerForgeProviders("daintree.github", [
        { id: "github", name: "GitHub", matches: ["github.com"] },
      ]);
      registerForgeProviders("daintree.gitlab", [
        { id: "gitlab", name: "GitLab", matches: ["gitlab.com"] },
      ]);
      registerForgeProviderImpl("daintree.github", "github", {
        identity: { getCurrentUser: async () => ({ login: "greg", rawData: null }) },
      } as unknown as ForgeProviderImpl);
      cleanups.push(() => {
        unregisterForgeProviders("daintree.github");
        unregisterForgeProviders("daintree.gitlab");
      });
      await harness();
      // The host's own settings, read on its next sample.
      harnessState.store.set("forgeCredentials", {
        "daintree.github.github": JSON.stringify({ token: "ghp_never_leaves_the_host" }),
      });
      const metrics = requireRemoteService("hostMetrics") as {
        latest(hostId: string): HostMetricsSummary | null;
      };
      await waitUntil(
        () => metrics.latest(HOST_ID)?.forges?.[0]?.account === "greg",
        "the host's summary with its forges",
        20_000
      );
      const summary = metrics.latest(HOST_ID)!;
      expect(summary.forges).toEqual([
        {
          providerId: "daintree.github.github",
          name: "GitHub",
          hasCredential: true,
          account: "greg",
        },
        {
          providerId: "daintree.gitlab.gitlab",
          name: "GitLab",
          hasCredential: false,
          account: null,
        },
      ]);
      expect(JSON.stringify(summary)).not.toContain("ghp_never_leaves_the_host");
    },
    TEST_TIMEOUT_MS
  );
});
