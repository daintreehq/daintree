import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: { isPackaged: true }, dialog: {} }));

import {
  hostUnitFromCgroup,
  isHeadlessHostCommandLine,
  processStartTime,
  userDataDirArg,
  wantsDesktopWindow,
} from "../headlessHostTakeover.js";

describe("headless Host takeover", () => {
  it("is only for a launch that wants a window, on a desktop that can show one", () => {
    const desktop = { DISPLAY: ":0" };
    expect(wantsDesktopWindow(["daintree"], desktop)).toBe(true);
    expect(
      wantsDesktopWindow(["daintree", "/home/greg/project"], { WAYLAND_DISPLAY: "wayland-0" })
    ).toBe(true);
    // An SSH session has no display: setup's handoff and the attach bridge never ask.
    expect(wantsDesktopWindow(["daintree"], {})).toBe(false);
    expect(wantsDesktopWindow(["daintree", "--host-mode"], desktop)).toBe(false);
    expect(wantsDesktopWindow(["daintree", "--attach-stdio"], desktop)).toBe(false);
    expect(
      wantsDesktopWindow(
        ["daintree", "--host-mode", "--enable-host-mode", "--host-mode-handoff"],
        desktop
      )
    ).toBe(false);
  });

  it("recognises the Host its service starts, and nothing else", () => {
    expect(
      isHeadlessHostCommandLine("/opt/Daintree/daintree\0--host-mode\0--ozone-platform=headless\0")
    ).toBe(true);
    // As Chromium leaves it after setting its process title: one string, spaces between.
    expect(
      isHeadlessHostCommandLine("/opt/Daintree/daintree --host-mode --ozone-platform=headless ")
    ).toBe(true);
    // A host listening with a window, and a plain app, are not headless hosts.
    expect(isHeadlessHostCommandLine("/opt/Daintree/daintree\0--host-mode\0")).toBe(false);
    expect(isHeadlessHostCommandLine("/opt/Daintree/daintree\0--ozone-platform=headless\0")).toBe(
      false
    );
    expect(isHeadlessHostCommandLine("")).toBe(false);
  });

  it("finds the Daintree unit in a cgroup path, for this build only", () => {
    const cgroup =
      "0::/user.slice/user-1000.slice/user@1000.service/app.slice/daintree-host.service\n";
    expect(hostUnitFromCgroup(cgroup, true)).toBe("daintree-host.service");
    expect(hostUnitFromCgroup(cgroup, false)).toBeNull();
    expect(hostUnitFromCgroup("0::/user.slice/user-1000.slice/session-3.scope\n", true)).toBeNull();
  });

  it("leaves a launch that asked to stay hidden alone", () => {
    expect(wantsDesktopWindow(["daintree", "--hidden"], { DISPLAY: ":0" })).toBe(false);
  });

  it("reads a process's start time past a command name with spaces and parentheses", () => {
    const fields = Array.from({ length: 30 }, (_, i) => String(i + 4)).join(" ");
    // pid (comm) state, then fields 4 onwards, each holding its own number.
    expect(processStartTime(`4242 (daintree (x) y) S ${fields}`)).toBe("22");
  });

  it("tells a host on another profile from one on this launch's", () => {
    expect(userDataDirArg(["daintree", "--host-mode"])).toBeNull();
    expect(userDataDirArg(["daintree", "--user-data-dir=/tmp/p", "--host-mode"])).toBe("/tmp/p");
  });
});
