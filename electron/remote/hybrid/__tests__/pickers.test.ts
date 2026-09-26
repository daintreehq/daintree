import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../ipc/handlers/copyTree.js", () => ({ copyFileToClipboard: vi.fn() }));

import type { IpcMainInvokeEvent } from "electron";
import type { IpcEnvelope } from "../../../../shared/types/ipc/errors.js";
import { wrapError, wrapSuccess } from "../../../../shared/utils/ipcErrorSerialization.js";
import { CHANNELS } from "../../../ipc/channels.js";
import { IpcDispatcherImpl } from "../../../ipc/dispatcher.js";
import type { HostPickRequest } from "../../../../shared/types/ipc/hostFiles.js";
import {
  createPickerSplits,
  installPickerSplits,
  scratchFolderName,
  type PickerSplitDeps,
} from "../pickers.js";

const REMOTE_VIEW = 5;
const LOCAL_VIEW = 6;

function makeDispatcher(forward: (channel: string, args: unknown[]) => unknown) {
  const dispatcher = new IpcDispatcherImpl();
  dispatcher.setInvokeEnveloper(async (_channel, _args, call, options) => {
    try {
      const value = await call();
      return options?.verbatim ? (value as IpcEnvelope) : wrapSuccess(value);
    } catch (error) {
      return wrapError(error);
    }
  });
  const forwardInvoke = vi.fn(
    async (_hostId: string, _wc: number, channel: string, args: unknown[]) =>
      wrapSuccess(await forward(channel, args))
  );
  dispatcher.setRemoteRouter({
    hostForSender: (id) => (id === REMOTE_VIEW ? "studio-01" : null),
    forwardInvoke,
    forwardSend: vi.fn(),
  });
  return { dispatcher, forwardInvoke };
}

function event(senderId: number): IpcMainInvokeEvent {
  return { sender: { id: senderId } } as unknown as IpcMainInvokeEvent;
}

function makeClient() {
  return {
    pickHostPaths: vi.fn(
      async (_webContentsId: number, _request: HostPickRequest): Promise<string[] | null> => [
        "/home/greg/work/app",
      ]
    ),
    downloadToTemp: vi.fn(async (_hostId: string, _hostPath: string, _webContentsId: number) => ({
      localPath: "/tmp/daintree-host-files/bundle.xml",
      bytes: 42,
    })),
  };
}

function deps(overrides: Partial<ReturnType<typeof makeClient>> = {}) {
  const client = { ...makeClient(), ...overrides };
  const copyFileToClipboard = vi.fn();
  const pickerDeps: PickerSplitDeps = { client: () => client, copyFileToClipboard };
  return { client, copyFileToClipboard, deps: pickerDeps };
}

const disposers: Array<() => void> = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
});

describe("picker splits routing", () => {
  const channels = [
    CHANNELS.PROJECT_OPEN_DIALOG,
    CHANNELS.PROJECT_LOCATE,
    CHANNELS.PLUGIN_PICK_PATH,
  ] as const;

  it("a local window keeps its native dialog; a remote window gets the host picker", async () => {
    const { dispatcher } = makeDispatcher((channel) => {
      if (channel === CHANNELS.PROJECT_GET_ALL) {
        return [{ id: "p1", name: "App", path: "/home/greg/old/app" }];
      }
      if (channel === CHANNELS.PROJECT_RELOCATION_APPLY) return { id: "p1" };
      throw new Error(`unexpected ${channel}`);
    });
    const { client, deps: pickerDeps } = deps();
    for (const [channel, split] of Object.entries(createPickerSplits(pickerDeps))) {
      disposers.push(dispatcher.registerHybridSplit(channel, split));
    }
    const nativeDialog = vi.fn(async () => "/Users/greg/local");
    const argsFor: Record<string, unknown[]> = {
      [CHANNELS.PROJECT_OPEN_DIALOG]: [],
      [CHANNELS.PROJECT_LOCATE]: ["p1"],
      [CHANNELS.PLUGIN_PICK_PATH]: ["acme.tool", { kind: "directory" }],
    };

    for (const channel of channels) {
      const local = await dispatcher.dispatchLocalInvoke(
        channel,
        event(LOCAL_VIEW),
        argsFor[channel]!,
        nativeDialog
      );
      expect(local).toEqual(wrapSuccess("/Users/greg/local"));
    }
    expect(client.pickHostPaths).not.toHaveBeenCalled();

    nativeDialog.mockClear();
    for (const channel of channels) {
      const remote = await dispatcher.dispatchLocalInvoke(
        channel,
        event(REMOTE_VIEW),
        argsFor[channel]!,
        nativeDialog
      );
      expect(remote.ok).toBe(true);
    }
    expect(nativeDialog).not.toHaveBeenCalled();
    expect(client.pickHostPaths).toHaveBeenCalledTimes(3);
    expect(client.pickHostPaths.mock.calls.every(([wc]) => wc === REMOTE_VIEW)).toBe(true);
  });

  it("open folder answers the host path the picker chose, or null when dismissed", async () => {
    const { client, deps: pickerDeps } = deps();
    const split = createPickerSplits(pickerDeps)[CHANNELS.PROJECT_OPEN_DIALOG]!;
    const call = {
      hostId: "studio-01",
      webContentsId: REMOTE_VIEW,
      args: [],
      local: vi.fn(),
      remote: vi.fn(),
    };
    await expect(split(call)).resolves.toBe("/home/greg/work/app");
    expect(client.pickHostPaths).toHaveBeenCalledWith(
      REMOTE_VIEW,
      expect.objectContaining({ mode: "directory" })
    );
    client.pickHostPaths.mockResolvedValueOnce(null);
    await expect(split(call)).resolves.toBeNull();
    expect(call.local).not.toHaveBeenCalled();
  });

  it("locate starts at the project's host parent and reattaches on the host", async () => {
    const { client, deps: pickerDeps } = deps();
    const remote = vi.fn(async (channel?: string) =>
      channel === CHANNELS.PROJECT_GET_ALL
        ? [{ id: "p1", name: "App", path: "/srv/code/app" }]
        : { id: "p1", path: "/home/greg/work/app" }
    );
    const split = createPickerSplits(pickerDeps)[CHANNELS.PROJECT_LOCATE]!;
    await split({
      hostId: "studio-01",
      webContentsId: REMOTE_VIEW,
      args: ["p1"],
      local: vi.fn(),
      remote,
    });
    expect(client.pickHostPaths).toHaveBeenCalledWith(
      REMOTE_VIEW,
      expect.objectContaining({ mode: "directory", defaultPath: "/srv/code" })
    );
    expect(remote).toHaveBeenLastCalledWith(CHANNELS.PROJECT_RELOCATION_APPLY, [
      { projectId: "p1", mode: "reattach", newPath: "/home/greg/work/app" },
    ]);
  });

  it("a plugin's file pick keeps its filters and only takes a host-absolute default", async () => {
    const { client, deps: pickerDeps } = deps();
    const split = createPickerSplits(pickerDeps)[CHANNELS.PLUGIN_PICK_PATH]!;
    await split({
      hostId: "studio-01",
      webContentsId: REMOTE_VIEW,
      args: [
        "acme.tool",
        {
          kind: "file",
          defaultPath: "relative",
          filters: [{ name: "JSON", extensions: ["json"] }],
        },
      ],
      local: vi.fn(),
      remote: vi.fn(),
    });
    const request = client.pickHostPaths.mock.calls[0]![1];
    expect(request.mode).toBe("file");
    expect(request.defaultPath).toBeUndefined();
    expect(request.filters).toEqual([{ name: "JSON", extensions: ["json"] }]);
  });

  it("forge audit export saves locally in a remote window", async () => {
    const { deps: pickerDeps } = deps();
    const split = createPickerSplits(pickerDeps)[CHANNELS.FORGE_AUDIT_EXPORT_LOG]!;
    const local = vi.fn(async () => true);
    const remote = vi.fn();
    await expect(
      split({ hostId: "studio-01", webContentsId: REMOTE_VIEW, args: [[]], local, remote })
    ).resolves.toBe(true);
    expect(remote).not.toHaveBeenCalled();
  });
});

describe("scratch save-as-project in a remote window", () => {
  const scratch = { id: "s1", name: "Quick: test/1", path: "/home/greg/.daintree/scratches/s1" };

  function call(remote: (channel?: string, args?: unknown[]) => unknown) {
    return {
      hostId: "studio-01",
      webContentsId: REMOTE_VIEW,
      args: ["s1"],
      local: vi.fn(),
      remote: vi.fn(async (channel?: string, args?: unknown[]) => remote(channel, args)),
    };
  }

  it("picks a folder on the host and saves into a new folder named after the scratch", async () => {
    const { client, deps: pickerDeps } = deps();
    const saved = {
      status: "saved",
      project: { id: "p9", name: "Quick- test-1", path: "/home/greg/work/app/Quick- test-1" },
      destinationPath: "/home/greg/work/app/Quick- test-1",
    };
    const split = createPickerSplits(pickerDeps)[CHANNELS.SCRATCH_SAVE_AS_PROJECT]!;
    const c = call((channel) => (channel === CHANNELS.SCRATCH_GET_ALL ? [scratch] : saved));

    await expect(split(c)).resolves.toEqual(saved);

    expect(client.pickHostPaths).toHaveBeenCalledWith(
      REMOTE_VIEW,
      expect.objectContaining({ mode: "directory", title: 'Choose where to save "Quick: test/1"' })
    );
    // No channel: the host leg is scratch:save-as-project itself, with the host folder.
    expect(c.remote).toHaveBeenLastCalledWith(undefined, [
      "s1",
      "/home/greg/work/app/Quick- test-1",
    ]);
    expect(c.local).not.toHaveBeenCalled();
  });

  it("answers cancelled when the host picker is dismissed, without asking the host to save", async () => {
    const { client, deps: pickerDeps } = deps();
    client.pickHostPaths.mockResolvedValueOnce(null);
    const split = createPickerSplits(pickerDeps)[CHANNELS.SCRATCH_SAVE_AS_PROJECT]!;
    const c = call(() => [scratch]);
    await expect(split(c)).resolves.toEqual({ status: "cancelled" });
    expect(c.remote).toHaveBeenCalledTimes(1);
  });

  it("surfaces the host's refusal", async () => {
    const { deps: pickerDeps } = deps();
    const split = createPickerSplits(pickerDeps)[CHANNELS.SCRATCH_SAVE_AS_PROJECT]!;
    const c = call((channel) => {
      if (channel === CHANNELS.SCRATCH_GET_ALL) return [scratch];
      throw new Error("Destination folder is not empty. Choose an empty folder.");
    });
    await expect(split(c)).rejects.toThrow("Destination folder is not empty");
  });

  it("refuses a scratch the host doesn't have before opening the picker", async () => {
    const { client, deps: pickerDeps } = deps();
    const split = createPickerSplits(pickerDeps)[CHANNELS.SCRATCH_SAVE_AS_PROJECT]!;
    await expect(split(call(() => []))).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(client.pickHostPaths).not.toHaveBeenCalled();
  });

  it("fails as disconnected when the host file client is gone", async () => {
    const split = createPickerSplits({ client: () => undefined, copyFileToClipboard: vi.fn() })[
      CHANNELS.SCRATCH_SAVE_AS_PROJECT
    ]!;
    const c = call(() => [scratch]);
    await expect(split(c)).rejects.toMatchObject({ code: "HOST_DISCONNECTED" });
    expect(c.remote).toHaveBeenCalledTimes(1);
  });

  it("names the folder safely", () => {
    expect(scratchFolderName("My scratch")).toBe("My scratch");
    expect(scratchFolderName("../../etc")).toBe("etc");
    expect(scratchFolderName("a/b\\c")).toBe("a-b-c");
    expect(scratchFolderName("   ")).toBe("scratch");
    expect(scratchFolderName("...")).toBe("scratch");
  });
});

describe("copytree copy-as-file in a remote window", () => {
  it("generates on the host, downloads the bundle here, and puts the local copy on the clipboard", async () => {
    const { client, copyFileToClipboard, deps: pickerDeps } = deps();
    const remote = vi.fn(async () => ({
      content: "",
      fileCount: 3,
      filePath: "/tmp/host-context/app-head.xml",
      outputBytes: 42,
    }));
    const split = createPickerSplits(pickerDeps)[CHANNELS.COPYTREE_GENERATE_AND_COPY_FILE]!;
    const payload = { worktreeId: "w1", options: {}, name: "run" };
    const result = (await split({
      hostId: "studio-01",
      webContentsId: REMOTE_VIEW,
      args: [payload],
      local: vi.fn(),
      remote,
    })) as Record<string, unknown>;

    expect(remote).toHaveBeenCalledWith(CHANNELS.COPYTREE_GENERATE, [payload]);
    expect(client.downloadToTemp).toHaveBeenCalledWith(
      "studio-01",
      "/tmp/host-context/app-head.xml",
      REMOTE_VIEW
    );
    expect(copyFileToClipboard).toHaveBeenCalledWith("/tmp/daintree-host-files/bundle.xml");
    expect(result.filePath).toBe("/tmp/daintree-host-files/bundle.xml");
    expect(result.error).toBeUndefined();
  });

  it("reports a failed download without touching the clipboard", async () => {
    const { copyFileToClipboard, deps: pickerDeps } = deps({
      downloadToTemp: vi.fn(async () => {
        throw new Error("link dropped");
      }),
    });
    const split = createPickerSplits(pickerDeps)[CHANNELS.COPYTREE_GENERATE_AND_COPY_FILE]!;
    const result = (await split({
      hostId: "studio-01",
      webContentsId: REMOTE_VIEW,
      args: [{}],
      local: vi.fn(),
      remote: vi.fn(async () => ({ content: "", fileCount: 1, filePath: "/tmp/x.xml" })),
    })) as Record<string, unknown>;
    expect(result.error).toMatch(/download/);
    expect(result.filePath).toBeUndefined();
    expect(copyFileToClipboard).not.toHaveBeenCalled();
  });

  it("passes a host generation error through unchanged", async () => {
    const { client, deps: pickerDeps } = deps();
    const split = createPickerSplits(pickerDeps)[CHANNELS.COPYTREE_GENERATE_AND_COPY_FILE]!;
    const failed = { content: "", fileCount: 0, error: "Worktree not found: w1" };
    await expect(
      split({
        hostId: "studio-01",
        webContentsId: REMOTE_VIEW,
        args: [{}],
        local: vi.fn(),
        remote: vi.fn(async () => failed),
      })
    ).resolves.toEqual(failed);
    expect(client.downloadToTemp).not.toHaveBeenCalled();
  });
});

describe("installPickerSplits", () => {
  it("registers the dialog splits and removes only its own on dispose", () => {
    const splits = new Map<string, unknown>();
    const placeholder = vi.fn();
    splits.set(CHANNELS.FORGE_AUDIT_EXPORT_LOG, placeholder);
    const dispatcher = {
      registerHybridSplit: vi.fn((channel: string, split: unknown) => {
        splits.set(channel, split);
        return () => {
          if (splits.get(channel) === split) splits.delete(channel);
        };
      }),
    };
    const dispose = installPickerSplits(dispatcher as never);
    expect(splits.get(CHANNELS.FORGE_AUDIT_EXPORT_LOG)).not.toBe(placeholder);
    for (const channel of [
      CHANNELS.PROJECT_OPEN_DIALOG,
      CHANNELS.PROJECT_LOCATE,
      CHANNELS.PLUGIN_PICK_PATH,
      CHANNELS.COPYTREE_GENERATE_AND_COPY_FILE,
    ]) {
      expect(splits.has(channel), channel).toBe(true);
    }
    dispose();
    expect(splits.has(CHANNELS.COPYTREE_GENERATE_AND_COPY_FILE)).toBe(false);
  });
});
