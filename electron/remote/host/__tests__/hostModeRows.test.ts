import { describe, expect, it } from "vitest";
import {
  driversRow,
  isWslKernel,
  parsePmset,
  sleepRow,
  socketRow,
  startAtLoginRow,
} from "../hostModeRows.js";
import type { StartAtLoginObservation } from "../startAtLogin.js";

const systemd: StartAtLoginObservation = {
  kind: "systemd-user",
  path: "/home/greg/.config/systemd/user/daintree-host.service",
  installed: true,
  current: true,
  unitState: "enabled",
  linger: "yes",
  userName: "greg",
};

describe("host mode status rows", () => {
  it("reads pmset values", () => {
    expect(parsePmset(" disksleep 0\n sleep 0\n displaysleep 10\n")).toEqual({
      sleep: 0,
      disksleep: 0,
    });
    expect(parsePmset("nothing")).toEqual({ sleep: null, disksleep: null });
  });

  it("reports sleep already off without a command", () => {
    expect(sleepRow("darwin", { code: 0, stdout: " sleep 0\n disksleep 0\n", stderr: "" })).toEqual(
      { id: "sleep", state: "ok", detail: "System sleep never, disk sleep never (pmset -g)" }
    );
  });

  it("points Linux at systemd-inhibit rather than guessing", () => {
    expect(sleepRow("linux", null).detail).toContain("systemd-inhibit");
    // A WSL distribution sleeps with its PC; there's nothing to hold off in it.
    expect(sleepRow("linux", null, true)).toEqual({
      id: "sleep",
      state: "ok",
      detail: "A WSL distribution sleeps only when its PC does",
    });
  });

  it("describes a systemd unit with linger", () => {
    expect(startAtLoginRow({ consented: true, observation: systemd, installError: null })).toEqual({
      id: "start-at-login",
      state: "ok",
      detail: "systemd user unit enabled; linger is on, so it starts at boot",
    });
    expect(
      startAtLoginRow({
        consented: true,
        observation: { ...systemd, linger: null },
        installError: null,
      })
    ).toMatchObject({ state: "unknown", command: "loginctl enable-linger greg" });
  });

  it("says nothing of linger in a WSL distribution, which holds the login while it runs", () => {
    expect(
      startAtLoginRow({
        consented: true,
        observation: { ...systemd, linger: "no" },
        installError: null,
        wsl: true,
      })
    ).toEqual({
      id: "start-at-login",
      state: "ok",
      detail: "systemd user unit enabled; it starts with this WSL distribution",
    });
    expect(isWslKernel("linux", "6.18.54.1-microsoft-standard-WSL2")).toBe(true);
    expect(isWslKernel("linux", "6.8.0-1021-azure")).toBe(false);
    expect(isWslKernel("darwin", "6.18.54.1-microsoft-standard-WSL2")).toBe(false);
  });

  it("describes a LaunchAgent", () => {
    expect(
      startAtLoginRow({
        consented: true,
        observation: {
          kind: "launch-agent",
          path: "/Users/g/Library/LaunchAgents/org.daintree.app.host.plist",
          installed: true,
          current: true,
          unitState: null,
          linger: null,
          userName: null,
        },
        installError: null,
      })
    ).toEqual({
      id: "start-at-login",
      state: "ok",
      detail: "LaunchAgent at /Users/g/Library/LaunchAgents/org.daintree.app.host.plist",
    });
  });

  it("flags a unit still on disk after start at login went off", () => {
    expect(
      startAtLoginRow({ consented: false, observation: systemd, installError: null })
    ).toMatchObject({ state: "warning" });
  });

  it("names attached machines and what they drive", () => {
    expect(
      driversRow([
        { clientId: "a", clientName: "greg-mbp", connectedAt: 1, drivingProjectIds: ["p1", "p2"] },
        { clientId: "b", clientName: "studio", connectedAt: 1, drivingProjectIds: [] },
      ])
    ).toEqual({
      id: "drivers",
      state: "ok",
      detail: "greg-mbp (driving 2 projects), studio",
    });
  });

  it("says a socket is off plainly", () => {
    expect(
      socketRow({
        enabled: false,
        listening: false,
        socketPath: "/x",
        listenError: null,
        advertise: { status: "off" },
      })
    ).toEqual({ id: "socket", state: "unknown", detail: "Not listening" });
  });
});
