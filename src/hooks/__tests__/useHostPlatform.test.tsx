// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";

const platform = vi.hoisted(() => ({ mac: true, linux: false, windows: false }));

vi.mock("@/lib/platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/platform")>()),
  isMac: () => platform.mac,
  isLinux: () => platform.linux,
  isWindows: () => platform.windows,
}));

import {
  _resetHostPlatformForTests,
  currentHostId,
  getHostPlatform,
  getHostPlatformInfo,
  hostFileManagerRevealLabel,
  hostScopedKey,
  hostShellDialect,
  isHostLinux,
  isHostMac,
  isRemoteWindow,
  resolveHostTmpDir,
  setHostPlatformInfo,
} from "../useHostPlatform";
import { revealCopy } from "@/components/FileViewer/revealCopy";
import { resolveAgentLaunchBaseCommand } from "@/utils/agentLaunchCommand";
import { TerminalHostSuffix } from "@/components/Terminal/TerminalHostSuffix";
import type { AgentCliDetail } from "@shared/types/ipc";

const readyDetail = (resolvedPath: string): AgentCliDetail => ({
  state: "ready",
  resolvedPath,
  via: null,
});

beforeEach(() => {
  platform.mac = true;
  platform.linux = false;
  platform.windows = false;
  _resetHostPlatformForTests();
});

afterEach(() => {
  delete window.__DAINTREE_HOST_ID__;
  _resetHostPlatformForTests();
});

describe("host platform on a local window", () => {
  it("answers with the client's own platform until main reports a host", () => {
    expect(getHostPlatform()).toBe("darwin");
    expect(isHostMac()).toBe(true);
    expect(hostShellDialect()).toBeUndefined();
    expect(hostFileManagerRevealLabel()).toBe("Show in Finder");
    expect(revealCopy().label).toBe("Reveal in Finder");
    expect(getHostPlatformInfo()).toEqual({
      platform: "darwin",
      homeDir: null,
      tmpDir: null,
      hostName: null,
      connection: null,
    });
  });

  it("builds the same launch command as before once seeded with this machine's platform", () => {
    const before = resolveAgentLaunchBaseCommand("claude", readyDetail("/opt/my tools/claude"));
    setHostPlatformInfo({ platform: "darwin", tmpDir: "/var/folders/x/T" });
    expect(resolveAgentLaunchBaseCommand("claude", readyDetail("/opt/my tools/claude"))).toBe(
      before
    );
  });

  it("keeps persisted keys bare", () => {
    expect(currentHostId()).toBe("local");
    expect(isRemoteWindow()).toBe(false);
    expect(hostScopedKey("abc123")).toBe("abc123");
  });

  it("resolves the tmp dir through the fallback until the host reports one", async () => {
    const fallback = vi.fn().mockResolvedValue("/tmp");
    await expect(resolveHostTmpDir(fallback)).resolves.toBe("/tmp");
    expect(fallback).toHaveBeenCalledTimes(1);
  });

  it("renders no host suffix on terminal titles", () => {
    const { container } = render(<TerminalHostSuffix />);
    expect(container.textContent).toBe("");
  });
});

describe("a Linux host from a Mac client", () => {
  beforeEach(() => {
    setHostPlatformInfo({ platform: "linux", homeDir: "/home/greg", tmpDir: "/tmp/host" });
  });

  it("names the host's file manager, not the client's", () => {
    expect(isHostMac()).toBe(false);
    expect(isHostLinux()).toBe(true);
    expect(hostFileManagerRevealLabel()).toBe("Show in file manager");
    expect(revealCopy().label).toBe("Show in folder");
  });

  it("uses the host tmp dir without asking main", async () => {
    const fallback = vi.fn().mockResolvedValue("/var/folders/client/T");
    await expect(resolveHostTmpDir(fallback)).resolves.toBe("/tmp/host");
    expect(fallback).not.toHaveBeenCalled();
  });

  it("escapes launch commands for a POSIX shell even from a Windows client", () => {
    platform.mac = false;
    platform.windows = true;
    expect(hostShellDialect()).toBe("posix");
    expect(resolveAgentLaunchBaseCommand("claude", readyDetail("/opt/my tools/claude"))).toBe(
      "'/opt/my tools/claude'"
    );
  });
});

describe("a remote window", () => {
  beforeEach(() => {
    window.__DAINTREE_HOST_ID__ = { id: "studio-01" };
  });

  it("prefixes persisted keys with the host id", () => {
    expect(isRemoteWindow()).toBe(true);
    expect(hostScopedKey("abc123")).toBe("studio-01:abc123");
  });

  it("offers to copy the host path instead of revealing it", () => {
    expect(hostFileManagerRevealLabel()).toBe("Copy host path");
    expect(revealCopy()).toEqual({
      label: "Copy host path",
      errorTitle: "Couldn't copy host path",
      retryAriaLabel: "Retry copying host path",
    });
  });

  it("carries @<host> on terminal titles once the host is named", () => {
    const { container } = render(<TerminalHostSuffix />);
    expect(container.textContent).toBe("");
    act(() =>
      setHostPlatformInfo({
        hostName: "studio-01",
        connection: { kind: "ssh", target: "greg@studio-01" },
      })
    );
    expect(container.textContent).toBe("@studio-01");
  });

  it("treats a malformed host id as this machine", () => {
    window.__DAINTREE_HOST_ID__ = { id: "bad:id" };
    expect(currentHostId()).toBe("local");
    expect(hostScopedKey("abc123")).toBe("abc123");
  });
});
