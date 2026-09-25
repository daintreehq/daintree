import { describe, expect, it, vi } from "vitest";
import type { HostHandshakeInfo } from "../../../../shared/types/remoteHosts.js";
import {
  HostAdvertiser,
  advertiseCommand,
  advertiseInstanceName,
  advertiseTxtRecords,
} from "../advertise.js";
import type { OwnedProcess } from "../hostCommands.js";

const HANDSHAKE: HostHandshakeInfo = {
  version: "0.38.0",
  commit: "abc1234",
  protocolVersion: 1,
  platform: "darwin",
  arch: "arm64",
};

function fakeProcess() {
  let exit: ((info: { code: number | null; notFound: boolean }) => void) | null = null;
  const proc: OwnedProcess & { exit(info: { code: number | null; notFound: boolean }): void } = {
    kill: vi.fn(),
    onExit: (listener) => {
      exit = listener;
    },
    exit: (info) => exit?.(info),
  };
  return proc;
}

describe("advertise commands", () => {
  it("carries the build in TXT records and nothing else", () => {
    expect(advertiseTxtRecords(HANDSHAKE)).toEqual([
      "txtvers=1",
      "version=0.38.0",
      "commit=abc1234",
      "platform=darwin",
      "arch=arm64",
      "transport=ssh",
    ]);
  });

  it("uses dns-sd on macOS and avahi-publish-service on Linux", () => {
    expect(
      advertiseCommand({ platform: "darwin", instanceName: "studio-01", handshake: HANDSHAKE })
    ).toEqual({
      file: "dns-sd",
      args: ["-R", "studio-01", "_daintree._tcp", "local", "22", ...advertiseTxtRecords(HANDSHAKE)],
    });
    expect(
      advertiseCommand({ platform: "linux", instanceName: "rack-1", handshake: HANDSHAKE })
    ).toEqual({
      file: "avahi-publish-service",
      args: ["rack-1", "_daintree._tcp", "22", ...advertiseTxtRecords(HANDSHAKE)],
    });
    expect(
      advertiseCommand({ platform: "win32", instanceName: "x", handshake: HANDSHAKE })
    ).toBeNull();
  });

  it("drops .local and caps the instance name at 63 bytes", () => {
    expect(advertiseInstanceName("studio-01.local")).toBe("studio-01");
    expect(Buffer.byteLength(advertiseInstanceName("é".repeat(60)))).toBeLessThanOrEqual(63);
  });
});

describe("HostAdvertiser", () => {
  it("starts the tool once and kills it on stop", () => {
    const proc = fakeProcess();
    const spawn = vi.fn((_file: string, _args: readonly string[]) => proc);
    const onChange = vi.fn();
    const advertiser = new HostAdvertiser({
      platform: "darwin",
      hostName: "studio-01.local",
      handshake: HANDSHAKE,
      spawn,
      onChange,
    });
    advertiser.start();
    advertiser.start();
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0]![0]).toBe("dns-sd");
    expect(advertiser.getState()).toEqual({
      status: "advertising",
      tool: "dns-sd",
      instanceName: "studio-01",
    });

    advertiser.stop();
    expect(proc.kill).toHaveBeenCalledTimes(1);
    expect(advertiser.getState()).toEqual({ status: "off" });
    // A late exit from the killed child changes nothing.
    proc.exit({ code: null, notFound: false });
    expect(advertiser.getState()).toEqual({ status: "off" });
    expect(onChange).toHaveBeenCalled();
  });

  it("reports a missing Avahi rather than failing", () => {
    const proc = fakeProcess();
    const advertiser = new HostAdvertiser({
      platform: "linux",
      hostName: "rack-1",
      handshake: HANDSHAKE,
      spawn: () => proc,
    });
    advertiser.start();
    proc.exit({ code: null, notFound: true });
    expect(advertiser.getState()).toEqual({
      status: "unavailable",
      reason: "avahi-publish-service isn't installed",
    });
  });
});
