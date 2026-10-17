// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";

const platform = vi.hoisted(() => ({ mac: true }));

vi.mock("@/lib/platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/platform")>()),
  isMac: () => platform.mac,
}));

import { _resetHostPlatformForTests, setHostPlatformInfo } from "../useHostPlatform";
import {
  forgeNotConnectedLabel,
  joinBadges,
  settingsOwnerHeaderLabel,
  settingsOwnerMarker,
  useRemoteHostName,
  useSettingsOwnerMarker,
  useSettingsRowOwnerNote,
} from "../useSettingsOwner";

beforeEach(() => {
  platform.mac = true;
  _resetHostPlatformForTests();
});

afterEach(() => {
  delete window.__DAINTREE_HOST_ID__;
  _resetHostPlatformForTests();
});

describe("settings owner labels", () => {
  it("say nothing in a local window", () => {
    expect(renderHook(() => useRemoteHostName()).result.current).toBeNull();
    for (const owner of ["host", "device", "mixed"] as const) {
      expect(settingsOwnerHeaderLabel(owner, null)).toBeNull();
    }
    expect(settingsOwnerMarker("host", null)).toBeUndefined();
    expect(renderHook(() => useSettingsOwnerMarker()).result.current("device")).toBeUndefined();
    const note = renderHook(() => useSettingsRowOwnerNote()).result.current;
    expect(note("Uses the GPU.", "device")).toBe("Uses the GPU.");
    expect(joinBadges("New terminals", undefined)).toBe("New terminals");
  });

  it("name the host and this machine in a remote window", () => {
    window.__DAINTREE_HOST_ID__ = { id: "studio" };
    setHostPlatformInfo({ hostName: "studio-01" });
    expect(renderHook(() => useRemoteHostName()).result.current).toBe("studio-01");
    expect(settingsOwnerHeaderLabel("host", "studio-01")).toBe("Settings on studio-01");
    expect(settingsOwnerHeaderLabel("device", "studio-01")).toBe("This Mac");
    expect(settingsOwnerHeaderLabel("mixed", "studio-01")).toBeNull();
    const marker = renderHook(() => useSettingsOwnerMarker()).result.current;
    expect(marker("host")).toBe("On studio-01");
    expect(marker("device")).toBe("This Mac");
    expect(joinBadges("New terminals", marker("host"))).toBe("New terminals · On studio-01");
    expect(forgeNotConnectedLabel("GitHub", "studio-01")).toBe(
      "GitHub isn't connected on studio-01"
    );
  });

  it("append a row's owner in the description's own punctuation", () => {
    window.__DAINTREE_HOST_ID__ = { id: "studio" };
    setHostPlatformInfo({ hostName: "studio-01" });
    const note = renderHook(() => useSettingsRowOwnerNote()).result.current;
    expect(note("Uses the GPU.", "device")).toBe("Uses the GPU. Set on this Mac.");
    expect(note("Checks your PATH", "host")).toBe("Checks your PATH · Set on studio-01");
    platform.mac = false;
    expect(settingsOwnerMarker("device", "studio-01")).toBe("This machine");
  });
});
