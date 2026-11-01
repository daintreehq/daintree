import os from "node:os";
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { isPackaged: true, on: vi.fn(), getPath: vi.fn(() => os.tmpdir()) },
  protocol: { handle: vi.fn() },
  session: { fromPartition: vi.fn() },
  shell: { openExternal: vi.fn() },
  webContents: { fromId: vi.fn(() => null), getAllWebContents: vi.fn(() => []) },
  BrowserWindow: { fromWebContents: vi.fn(() => null), getAllWindows: vi.fn(() => []) },
}));

import type { FileTransferEvent } from "../../../../shared/types/ipc/fileTransfer.js";
import type { AppError } from "../../../utils/errorTypes.js";
import type { ClientFileTransport, DownloadOptions } from "../ClientFileTransport.js";
import { createHostFileClient } from "../clientInstall.js";
import type { HostPickerBridge } from "../HostPickerBridge.js";
import { ViewFileCapabilities } from "../viewCapabilities.js";

function setup(bound: string | null = "studio-01") {
  const events: FileTransferEvent[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const download = vi.fn(async (_host: string, _path: string, options: DownloadOptions) => {
    options.onProgress?.(10, 100);
    options.onProgress?.(20, 100);
    await gate;
    if (options.signal?.aborted) throw Object.assign(new Error("cancelled"), { code: "CANCELLED" });
    options.onProgress?.(100, 100);
    return { localPath: `${options.destinationDir}/report.bin`, bytes: 100 };
  });
  const grantClicked = vi.fn(async () => {});
  const client = createHostFileClient({
    transport: { download, grantClicked } as unknown as ClientFileTransport,
    pickers: {} as HostPickerBridge,
    capabilities: new ViewFileCapabilities(() => () => {}),
    hostForView: () => bound,
    sendToView: (_wc, event) => events.push(event),
    downloadsDir: () => "/Users/greg/Downloads",
    tempDir: () => os.tmpdir(),
  });
  return { client, download, grantClicked, events, release };
}

const payload = { hostId: "studio-01", hostPath: "/srv/app/report.bin", opId: "op-1" };

describe("createHostFileClient.download", () => {
  it("saves into Downloads and reports progress to the asking view", async () => {
    const { client, events, release } = setup();
    const pending = client.download(7, payload);
    release();
    await expect(pending).resolves.toEqual({
      localPath: "/Users/greg/Downloads/report.bin",
      bytes: 100,
    });
    const progress = events.filter((event) => event.type === "progress");
    expect(progress[0]).toEqual({
      type: "progress",
      opId: "op-1",
      transferredBytes: 10,
      totalBytes: 100,
    });
    // Throttled in between, but the final byte count always goes out.
    expect(progress.at(-1)).toMatchObject({ transferredBytes: 100 });
    expect(progress.length).toBeLessThan(3 + 1);
  });

  it("joins a retry carrying the same operation id instead of downloading twice", async () => {
    const { client, download, release } = setup();
    const first = client.download(7, payload);
    const second = client.download(7, payload);
    release();
    await Promise.all([first, second]);
    expect(download).toHaveBeenCalledTimes(1);
  });

  it("cancels by operation id, only for the view that started it", async () => {
    const { client, release } = setup();
    const pending = client.download(7, payload);
    expect(client.cancel("op-1", 8)).toBe(false);
    expect(client.cancel("op-1", 7)).toBe(true);
    release();
    await expect(pending).rejects.toMatchObject({ code: "CANCELLED" });
    expect(client.cancel("op-1", 7)).toBe(false);
  });

  it("refuses another view's operation id, or the same id for another file", async () => {
    const { client, download, release } = setup();
    const first = client.download(7, payload);
    await expect(client.download(8, payload)).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(
      client.download(7, { ...payload, hostPath: `${payload.hostPath}.other` })
    ).rejects.toMatchObject({ code: "VALIDATION" });
    release();
    await first;
    expect(download).toHaveBeenCalledTimes(1);
  });

  it("refuses a file on a host the view isn't attached to", async () => {
    const { client, download } = setup("studio-02");
    expect(() => client.download(7, payload)).toThrow(/not attached/);
    const local = setup(null);
    expect(() => local.client.download(7, payload)).toThrow();
    expect(download).not.toHaveBeenCalled();
  });

  it("validates the request", () => {
    const { client } = setup();
    for (const bad of [
      { ...payload, hostId: "local" },
      { ...payload, hostPath: "relative/path" },
      { ...payload, hostPath: "/a\0b" },
      { ...payload, opId: "" },
    ]) {
      expect(() => client.download(7, bad)).toThrow();
    }
  });
});

function dropped(): Error {
  return Object.assign(new Error("Host studio-01 is not connected"), { code: "HOST_DISCONNECTED" });
}

/** A transport whose attempts play out in order; the last one repeats. */
function setupDrops(
  attempts: Array<(options: DownloadOptions) => Promise<{ localPath: string; bytes: number }>>,
  whenReachable: (
    hostId: string,
    webContentsId: number,
    timeoutMs: number,
    signal?: AbortSignal
  ) => Promise<boolean> = async () => true
) {
  let bound: string | null = "studio-01";
  const download = vi.fn(async (_host: string, _path: string, options: DownloadOptions) =>
    attempts[Math.min(download.mock.calls.length - 1, attempts.length - 1)](options)
  );
  const reachable = vi.fn(whenReachable);
  const client = createHostFileClient({
    transport: { download, whenReachable: reachable } as unknown as ClientFileTransport,
    pickers: {} as HostPickerBridge,
    capabilities: new ViewFileCapabilities(() => () => {}),
    hostForView: () => bound,
    sendToView: () => {},
    downloadsDir: () => "/Users/greg/Downloads",
    tempDir: () => os.tmpdir(),
    reconnectWaitMs: 1_000,
  });
  const moveView = (hostId: string | null) => {
    bound = hostId;
  };
  return { client, download, reachable, moveView };
}

const saved = async (options: DownloadOptions) => ({
  localPath: `${options.destinationDir}/report.bin`,
  bytes: 100,
});

describe("a download its link drops", () => {
  it("starts over once the view is back on the host, under the caller's one promise", async () => {
    const { client, download, reachable } = setupDrops([
      async () => {
        throw dropped();
      },
      saved,
    ]);
    await expect(client.download(7, payload)).resolves.toEqual({
      localPath: "/Users/greg/Downloads/report.bin",
      bytes: 100,
    });
    expect(download).toHaveBeenCalledTimes(2);
    expect(reachable).toHaveBeenCalledWith("studio-01", 7, 1_000, expect.any(AbortSignal));
  });

  it("lets a repeat of the same operation join while it waits for the host", async () => {
    let comeBack!: (reachable: boolean) => void;
    const { client, download } = setupDrops(
      [
        async () => {
          throw dropped();
        },
        saved,
      ],
      () =>
        new Promise((resolve) => {
          comeBack = resolve;
        })
    );
    const first = client.download(7, payload);
    await vi.waitFor(() => expect(comeBack).toBeTypeOf("function"));
    const second = client.download(7, payload);
    comeBack(true);
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(download).toHaveBeenCalledTimes(2);
  });

  it("fails as disconnected, saying the host didn't come back, when the wait runs out", async () => {
    const { client, download } = setupDrops(
      [
        async () => {
          throw dropped();
        },
      ],
      async () => false
    );
    const failure = await client.download(7, payload).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "HOST_DISCONNECTED" });
    expect((failure as AppError).userMessage).toMatch(/didn't reconnect/);
    expect(download).toHaveBeenCalledTimes(1);
  });

  it("stops starting over after two restarts on a link that keeps dropping", async () => {
    const { client, download } = setupDrops([
      async () => {
        throw dropped();
      },
    ]);
    const failure = await client.download(7, payload).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "HOST_DISCONNECTED" });
    expect((failure as AppError).userMessage).toMatch(/kept dropping/);
    expect(download).toHaveBeenCalledTimes(3);
  });

  it("is cancelled, not restarted, while it waits for the host", async () => {
    const { client, download } = setupDrops(
      [
        async () => {
          throw dropped();
        },
        saved,
      ],
      (_host, _view, _ms, signal) =>
        new Promise((resolve) => signal?.addEventListener("abort", () => resolve(false)))
    );
    const pending = client.download(7, payload);
    await vi.waitFor(() => expect(client.cancel("op-1", 7)).toBe(true));
    await expect(pending).rejects.toMatchObject({ code: "CANCELLED" });
    expect(download).toHaveBeenCalledTimes(1);
  });

  it("doesn't start over for a view that moved to another host meanwhile", async () => {
    const harness = setupDrops([
      async () => {
        throw dropped();
      },
      saved,
    ]);
    harness.reachable.mockImplementation(async () => {
      harness.moveView("studio-02");
      return true;
    });
    await expect(harness.client.download(7, payload)).rejects.toMatchObject({
      code: "VALIDATION",
    });
    expect(harness.download).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a checksum failure", "INTERNAL"],
    ["a file the host refuses", "NOT_FOUND"],
    ["a host that didn't answer in time", "OUTCOME_UNKNOWN"],
  ])("never waits for the host or starts over after %s", async (_name, code) => {
    const { client, download, reachable } = setupDrops([
      async () => {
        throw Object.assign(new Error(code), { code });
      },
      saved,
    ]);
    await expect(client.download(7, payload)).rejects.toMatchObject({ code });
    expect(download).toHaveBeenCalledTimes(1);
    expect(reachable).not.toHaveBeenCalled();
  });

  it("starts a temp download over too", async () => {
    const { client, download } = setupDrops([
      async () => {
        throw dropped();
      },
      saved,
    ]);
    await expect(
      client.downloadToTemp("studio-01", "/srv/app/report.bin", 7)
    ).resolves.toMatchObject({ bytes: 100 });
    expect(download).toHaveBeenCalledTimes(2);
    expect(new Set(download.mock.calls.map(([, , options]) => options.destinationDir)).size).toBe(
      1
    );
  });
});

describe("preview capabilities", () => {
  it("mints one capability per remote view and has none for a local view", () => {
    const { client } = setup();
    const token = client.previewCapability(7);
    expect(token).toMatch(/^[0-9a-f]{32}$/);
    expect(client.previewCapability(7)).toBe(token);
    expect(client.previewCapability(8)).not.toBe(token);
    expect(setup(null).client.previewCapability(7)).toBeNull();
  });

  it("forgets a view's capability once the view is gone", () => {
    const gone = new Map<number, () => void>();
    const capabilities = new ViewFileCapabilities((webContentsId, onGone) => {
      gone.set(webContentsId, onGone);
      return () => gone.delete(webContentsId);
    });
    const token = capabilities.capabilityFor(7);
    expect(capabilities.viewFor(token)).toBe(7);
    gone.get(7)!();
    expect(capabilities.viewFor(token)).toBeNull();
    expect(capabilities.capabilityFor(7)).not.toBe(token);
    capabilities.dispose();
    expect(gone.size).toBe(0);
  });
});

describe("createHostFileClient.grantClickedFile", () => {
  it("asks the view's own host to let it open the clicked file", async () => {
    const { client, grantClicked } = setup();
    await client.grantClickedFile(7, { hostId: "studio-01", hostPath: "/tmp/shot.png" });
    expect(grantClicked).toHaveBeenCalledWith("studio-01", "/tmp/shot.png", 7);
  });

  it("refuses another host than the view's, and a path that isn't absolute", async () => {
    const { client, grantClicked } = setup();
    await expect(
      client.grantClickedFile(7, { hostId: "studio-02", hostPath: "/tmp/shot.png" })
    ).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(
      client.grantClickedFile(7, { hostId: "studio-01", hostPath: "shot.png" })
    ).rejects.toMatchObject({ code: "VALIDATION" });
    expect(grantClicked).not.toHaveBeenCalled();
  });
});
