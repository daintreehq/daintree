// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HandshakeMismatch, HostConnectionState } from "@shared/types/remoteHosts";

const notify = vi.hoisted(() => vi.fn());
vi.mock("@/lib/notify", () => ({ notify }));
const runHostUpdate = vi.hoisted(() => vi.fn());
vi.mock("../hostUpdate", () => ({ runHostUpdate }));

import { useHostConnectionStore } from "@/store/hostConnectionStore";
import { _resetBuildSkewNoticesForTesting, noticeBuildSkew } from "../buildSkew";

const WHY =
  "studio-01 runs Daintree 1.3.0 and this machine runs 1.4.0. This needs both on the same build.";

function connectedTo(buildMismatch?: HandshakeMismatch, commit = "c0ffee0") {
  const connection: HostConnectionState = {
    status: "connected",
    rttMs: null,
    handshake: { version: "1.3.0", commit, protocolVersion: 1, platform: "darwin", arch: "arm64" },
    ...(buildMismatch ? { buildMismatch } : {}),
  };
  useHostConnectionStore.setState({ hostId: "h1", hostName: "studio-01", connection });
}

afterEach(() => {
  notify.mockReset();
  runHostUpdate.mockReset();
  _resetBuildSkewNoticesForTesting();
  useHostConnectionStore.getState().reset();
});

describe("noticeBuildSkew", () => {
  it("says why once per host build, and offers to update the side that's behind", () => {
    connectedTo({ kind: "version", local: "1.4.0", remote: "1.3.0" });
    noticeBuildSkew("Plugin setup unavailable", WHY);
    noticeBuildSkew("Plugin setup unavailable", WHY);

    expect(notify).toHaveBeenCalledTimes(1);
    const payload = notify.mock.calls[0]![0];
    expect(payload).toMatchObject({
      type: "warning",
      placement: "grid-bar",
      title: "Plugin setup unavailable",
      message: WHY,
      supersedeKey: "host-build-mismatch:h1",
    });
    expect(payload.action.label).toBe("Update studio-01");
    payload.action.onClick();
    expect(runHostUpdate).toHaveBeenCalledWith("host", "h1");

    // The host moving to another build is worth saying again.
    connectedTo({ kind: "version", local: "1.4.0", remote: "1.3.0" }, "deadbee");
    noticeBuildSkew("Plugin setup unavailable", WHY);
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it("offers to update this machine when the host is ahead", () => {
    connectedTo({ kind: "version", local: "1.2.0", remote: "1.3.0" });
    noticeBuildSkew("Plugin setup unavailable", WHY);
    expect(notify.mock.calls[0]![0].action.label).toBe("Update this machine");
  });

  it("stays quiet when the builds match", () => {
    connectedTo();
    noticeBuildSkew("Plugin setup unavailable", WHY);
    expect(notify).not.toHaveBeenCalled();
  });

  it("says it once the view hears how its link stands, if the builds still differ", () => {
    noticeBuildSkew("Plugin setup unavailable", WHY);
    noticeBuildSkew("Plugin setup unavailable", WHY);
    expect(notify).not.toHaveBeenCalled();

    connectedTo({ kind: "version", local: "1.4.0", remote: "1.3.0" });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]![0].message).toBe(WHY);
  });

  it("lets a held notice go when the link comes up on matching builds", () => {
    noticeBuildSkew("Plugin setup unavailable", WHY);
    connectedTo();
    connectedTo({ kind: "version", local: "1.4.0", remote: "1.3.0" });
    expect(notify).not.toHaveBeenCalled();
  });
});
