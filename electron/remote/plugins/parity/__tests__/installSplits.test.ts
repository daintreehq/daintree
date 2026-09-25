// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

const sentMock = vi.hoisted(() => vi.fn());
vi.mock("electron", () => ({
  BrowserWindow: { getFocusedWindow: vi.fn(() => null), fromWebContents: vi.fn(() => null) },
  dialog: { showOpenDialog: vi.fn() },
  webContents: {
    fromId: vi.fn((id: number) => (id === 5 ? { isDestroyed: () => false, send: sentMock } : null)),
  },
}));

import { CHANNELS } from "../../../../ipc/channels.js";
import { registerRemoteService } from "../../../runtime.js";
import type { ClientPluginParity } from "../ClientPluginParity.js";
import { createPluginInstallSplits } from "../install.js";

const disposers: Array<() => void> = [];

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
});

function withParity() {
  const installLocalPackageOnHost = vi.fn(async (..._args: unknown[]) => ({
    status: "installed" as const,
    pluginId: "acme.md",
  }));
  disposers.push(
    registerRemoteService("pluginParityClient", {
      installLocalPackageOnHost,
    } as unknown as ClientPluginParity)
  );
  return installLocalPackageOnHost;
}

function call(split: ReturnType<typeof createPluginInstallSplits>[string], args: unknown[]) {
  return split({
    hostId: "studio-01",
    webContentsId: 5,
    args,
    local: vi.fn(async () => {
      throw new Error("must not install on this machine");
    }),
    remote: vi.fn(async () => {
      throw new Error("the host has no leg for this");
    }),
  });
}

describe("plugin install in a window attached to a host", () => {
  it("installs a dropped .dntr on the host, never on this machine", async () => {
    const install = withParity();
    const splits = createPluginInstallSplits(async () => null);
    await expect(
      call(splits[CHANNELS.PLUGIN_INSTALL_FROM_PATH]!, ["/Users/me/Downloads/md.dntr", "job-1"])
    ).resolves.toEqual({ status: "installed", pluginId: "acme.md" });
    // Not a job id the local handlers would accept either: installed without one.
    expect(install).toHaveBeenCalledWith("studio-01", "/Users/me/Downloads/md.dntr", {});
  });

  it("picks the file on this machine, then installs it on the host", async () => {
    const install = withParity();
    const pick = vi.fn(async () => "/Users/me/md.dntr");
    const splits = createPluginInstallSplits(pick);
    await call(splits[CHANNELS.PLUGIN_INSTALL_FROM_FILE]!, ["job-2"]);
    expect(pick).toHaveBeenCalledWith(5);
    expect(install).toHaveBeenCalledWith("studio-01", "/Users/me/md.dntr", {});
  });

  it("carries the window's job to the host and relays its phases to that window", async () => {
    const install = withParity();
    const jobId = "0f8fad5b-d9cb-469f-a165-70867728950e";
    const splits = createPluginInstallSplits(async () => "/Users/me/md.dntr");
    await call(splits[CHANNELS.PLUGIN_INSTALL_FROM_FILE]!, [jobId]);
    const job = install.mock.calls[0]![2] as { jobId: string; onPhase: (phase: string) => void };
    expect(job.jobId).toBe(jobId);
    job.onPhase("extracting");
    job.onPhase("activating");
    expect(sentMock.mock.calls).toEqual([
      [
        CHANNELS.PLUGIN_INSTALL_PROGRESS,
        { jobId, phase: "extracting", cancellable: true, source: "md.dntr" },
      ],
      [
        CHANNELS.PLUGIN_INSTALL_PROGRESS,
        { jobId, phase: "activating", cancellable: false, source: "md.dntr" },
      ],
    ]);

    await call(splits[CHANNELS.PLUGIN_INSTALL_FROM_PATH]!, ["/Users/me/other.dntr", jobId]);
    expect(install.mock.calls[1]![2]).toMatchObject({ jobId });
  });

  it("answers a dismissed picker as cancelled", async () => {
    const install = withParity();
    const splits = createPluginInstallSplits(async () => null);
    await expect(call(splits[CHANNELS.PLUGIN_INSTALL_FROM_FILE]!, [])).resolves.toEqual({
      status: "cancelled",
    });
    expect(install).not.toHaveBeenCalled();
  });

  it("refuses a malformed path without sending anything", async () => {
    const install = withParity();
    const splits = createPluginInstallSplits(async () => null);
    await expect(call(splits[CHANNELS.PLUGIN_INSTALL_FROM_PATH]!, [42])).resolves.toMatchObject({
      status: "failed",
    });
    expect(install).not.toHaveBeenCalled();
  });
});
