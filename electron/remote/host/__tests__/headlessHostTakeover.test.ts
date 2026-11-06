import { describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => ({
  app: { isPackaged: true, whenReady: vi.fn(async () => {}), exit: vi.fn() },
  dialog: { showMessageBox: vi.fn() },
}));
const armRelaunch = vi.hoisted(() => vi.fn());
const execFile = vi.hoisted(() => vi.fn());

vi.mock("electron", () => electron);
vi.mock("../../../lifecycle/armRelaunch.js", () => ({ armRelaunch }));
vi.mock("node:child_process", () => ({ execFile }));

import {
  TAKEOVER_PROMPT,
  offerHeadlessHostTakeover,
  hostUnitFromCgroup,
  isHeadlessHostCommandLine,
  processStartTime,
  userDataDirArg,
  wantsDesktopWindow,
} from "../headlessHostTakeover.js";

describe("headless Host takeover", () => {
  it("defaults to Cancel, so Enter never stops the Host and the work running in it", () => {
    const { buttons = [], defaultId, cancelId } = TAKEOVER_PROMPT;
    expect(defaultId).toBe(cancelId);
    expect(buttons[defaultId!]).toBe("Cancel");
    expect(buttons[0]).toBe("Restart with a window");
  });

  // Cancel, Escape and Enter on the default all answer with cancelId.
  it("leaves the Host and its work running when the prompt is cancelled", async () => {
    electron.dialog.showMessageBox.mockResolvedValueOnce({ response: TAKEOVER_PROMPT.cancelId });
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    try {
      await offerHeadlessHostTakeover(
        { pid: 424242, unit: "daintree-host.service", startTime: "1234" },
        ["daintree"]
      );
      expect(electron.dialog.showMessageBox).toHaveBeenLastCalledWith(TAKEOVER_PROMPT);
      expect(electron.app.exit).toHaveBeenLastCalledWith(0);
      expect(execFile).not.toHaveBeenCalled();
      expect(kill).not.toHaveBeenCalled();
      expect(armRelaunch).not.toHaveBeenCalled();
    } finally {
      kill.mockRestore();
    }
  });

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
    // An OS job running due schedules works in the background.
    expect(wantsDesktopWindow(["daintree", "--run-due-schedules"], desktop)).toBe(false);
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
