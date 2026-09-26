import { describe, expect, it } from "vitest";
import {
  isHostModeRequested,
  resolveHostModeLaunch,
  isAttachStdioRequested,
  shouldUseHeadlessOzone,
} from "../hostModeLaunch.js";

describe("hostModeLaunch", () => {
  it("recognises the --host-mode switch", () => {
    expect(isHostModeRequested(["daintree", "--host-mode"])).toBe(true);
    expect(isHostModeRequested(["daintree"])).toBe(false);
    expect(isHostModeRequested(["daintree", "--host-mode=1"])).toBe(false);
  });

  describe("resolveHostModeLaunch", () => {
    it("starts windowless for --host-mode even with Host mode off", () => {
      expect(
        resolveHostModeLaunch({
          argv: ["daintree", "--host-mode"],
          hostModeEnabled: false,
          openedAsHidden: false,
        })
      ).toBe(true);
    });

    it("starts windowless for a hidden launch with Host mode on", () => {
      expect(
        resolveHostModeLaunch({ argv: ["daintree"], hostModeEnabled: true, openedAsHidden: true })
      ).toBe(true);
      expect(
        resolveHostModeLaunch({
          argv: ["daintree", "--hidden"],
          hostModeEnabled: true,
          openedAsHidden: false,
        })
      ).toBe(true);
    });

    it("opens windows for a visible launch even with Host mode on", () => {
      expect(
        resolveHostModeLaunch({ argv: ["daintree"], hostModeEnabled: true, openedAsHidden: false })
      ).toBe(false);
    });

    it("ignores a hidden launch when Host mode is off", () => {
      expect(
        resolveHostModeLaunch({
          argv: ["daintree", "--hidden"],
          hostModeEnabled: false,
          openedAsHidden: true,
        })
      ).toBe(false);
    });
  });

  describe("shouldUseHeadlessOzone", () => {
    const hostArgv = ["daintree", "--host-mode"];

    it("applies on Linux in Host mode with no display server", () => {
      expect(shouldUseHeadlessOzone({ platform: "linux", argv: hostArgv, env: {} })).toBe(true);
    });

    it("applies to an --attach-stdio launch from an ssh session with no display server", () => {
      const argv = ["daintree", "--attach-stdio"];
      expect(isAttachStdioRequested(argv)).toBe(true);
      expect(isAttachStdioRequested(["daintree"])).toBe(false);
      expect(shouldUseHeadlessOzone({ platform: "linux", argv, env: {} })).toBe(true);
      expect(shouldUseHeadlessOzone({ platform: "linux", argv, env: { DISPLAY: ":0" } })).toBe(
        false
      );
      expect(shouldUseHeadlessOzone({ platform: "darwin", argv, env: {} })).toBe(false);
    });

    it("keeps auto-detection when X11 or Wayland is reachable", () => {
      expect(
        shouldUseHeadlessOzone({ platform: "linux", argv: hostArgv, env: { DISPLAY: ":0" } })
      ).toBe(false);
      expect(
        shouldUseHeadlessOzone({
          platform: "linux",
          argv: hostArgv,
          env: { WAYLAND_DISPLAY: "wayland-0" },
        })
      ).toBe(false);
    });

    it("never applies without --host-mode or off Linux", () => {
      expect(shouldUseHeadlessOzone({ platform: "linux", argv: ["daintree"], env: {} })).toBe(
        false
      );
      expect(shouldUseHeadlessOzone({ platform: "darwin", argv: hostArgv, env: {} })).toBe(false);
      expect(shouldUseHeadlessOzone({ platform: "win32", argv: hostArgv, env: {} })).toBe(false);
    });
  });
});

describe("host setup flags", () => {
  it("treats --enable-host-mode as a Host mode launch that also switches it on", async () => {
    const { isHostModeEnableRequested, isHostModeHandoffOnly } =
      await import("../hostModeLaunch.js");
    expect(isHostModeRequested(["daintree", "--enable-host-mode"])).toBe(true);
    expect(isHostModeEnableRequested(["daintree", "--host-mode", "--enable-host-mode"])).toBe(true);
    expect(isHostModeEnableRequested(["daintree", "--host-mode"])).toBe(false);
    expect(isHostModeHandoffOnly(["daintree", "--host-mode", "--host-mode-handoff"])).toBe(true);
    expect(isHostModeHandoffOnly(["daintree", "--host-mode"])).toBe(false);
    expect(
      resolveHostModeLaunch({
        argv: ["daintree", "--enable-host-mode"],
        hostModeEnabled: false,
        openedAsHidden: false,
      })
    ).toBe(true);
  });
});
