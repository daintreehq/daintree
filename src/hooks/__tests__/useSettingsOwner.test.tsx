// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

const platform = vi.hoisted(() => ({ mac: true }));

vi.mock("@/lib/platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/platform")>()),
  isMac: () => platform.mac,
}));

import { _resetHostPlatformForTests, setHostPlatformInfo } from "../useHostPlatform";
import {
  _resetSettingOwnersShownForTests,
  forgeNotConnectedLabel,
  joinBadges,
  settingsOwnerHeaderLabel,
  settingsOwnerMarker,
  useOwnerContext,
  useRemoteHostName,
  useSettingsOwnerMarker,
  useSettingsRowOwnerNote,
  type OwnerContext,
} from "../useSettingsOwner";

const HOST = "agentSettings";
const DEVICE = "keybindingOverrides";

const local: OwnerContext = { remoteHostName: null, shown: false };
const remote: OwnerContext = { remoteHostName: "studio-01", shown: true };
const hosting: OwnerContext = { remoteHostName: null, shown: true };

beforeEach(() => {
  platform.mac = true;
  _resetHostPlatformForTests();
  _resetSettingOwnersShownForTests();
});

afterEach(() => {
  delete window.__DAINTREE_HOST_ID__;
  delete (window as { electron?: unknown }).electron;
  _resetHostPlatformForTests();
});

describe("settings owner labels", () => {
  it("say nothing in a local window with no hosts in use", () => {
    expect(renderHook(() => useRemoteHostName()).result.current).toBeNull();
    for (const owner of ["host", "device", "mixed"] as const) {
      expect(settingsOwnerHeaderLabel(owner, local)).toBeNull();
    }
    expect(settingsOwnerMarker([HOST], local)).toBeUndefined();
    expect(renderHook(() => useSettingsOwnerMarker()).result.current(DEVICE)).toBeUndefined();
    const note = renderHook(() => useSettingsRowOwnerNote()).result.current;
    expect(note("Uses the GPU.", "gpu")).toBe("Uses the GPU.");
    expect(joinBadges("New terminals", undefined)).toBe("New terminals");
    expect(joinBadges(undefined, undefined)).toBeUndefined();
  });

  it("name the host and this machine in a remote window", () => {
    window.__DAINTREE_HOST_ID__ = { id: "studio" };
    setHostPlatformInfo({ hostName: "studio-01" });
    expect(renderHook(() => useRemoteHostName()).result.current).toBe("studio-01");
    expect(settingsOwnerHeaderLabel("host", remote)).toBe("Settings on studio-01");
    expect(settingsOwnerHeaderLabel("device", remote)).toBe("This Mac");
    expect(settingsOwnerHeaderLabel("mixed", remote)).toBeNull();
    const marker = renderHook(() => useSettingsOwnerMarker()).result.current;
    expect(marker(HOST)).toBe("On studio-01");
    expect(marker(DEVICE)).toBe("This Mac");
    expect(joinBadges("New terminals", marker(HOST))).toBe("New terminals · On studio-01");
    expect(forgeNotConnectedLabel("GitHub", "studio-01")).toBe(
      "GitHub isn't connected on studio-01"
    );
  });

  it("name nothing for settings whose owners differ", () => {
    expect(settingsOwnerMarker([HOST, DEVICE], remote)).toBeUndefined();
  });

  it("tell a host's own settings from the ones its Shells don't share", () => {
    expect(settingsOwnerMarker([HOST], hosting)).toBe("Shared with Shells");
    expect(settingsOwnerMarker([DEVICE], hosting)).toBe("This Mac");
    expect(settingsOwnerHeaderLabel("host", hosting)).toBe("Shared with Shells");
  });

  it("append a row's owner in the description's own punctuation", () => {
    window.__DAINTREE_HOST_ID__ = { id: "studio" };
    setHostPlatformInfo({ hostName: "studio-01" });
    const note = renderHook(() => useSettingsRowOwnerNote()).result.current;
    expect(note("Uses the GPU.", "gpu")).toBe("Uses the GPU. Set on this Mac.");
    expect(note("Checks your PATH", HOST)).toBe("Checks your PATH · Set on studio-01");
  });

  it("call this machine by what it is", () => {
    platform.mac = false;
    expect(settingsOwnerMarker([DEVICE], remote)).toBe("This machine");
  });
});

describe("owners shown in a local window", () => {
  const inUse = (value: boolean) => {
    Object.assign(window, {
      electron: { remoteHosts: { isInUse: vi.fn(() => Promise.resolve(value)) } },
    });
  };

  it("turn on once a host is configured or Host mode is on", async () => {
    inUse(true);
    const { result } = renderHook(() => useOwnerContext());
    expect(result.current.shown).toBe(false);
    await waitFor(() => expect(result.current.shown).toBe(true));
    expect(result.current.remoteHostName).toBeNull();
  });

  it("stay off with no hosts and Host mode off", async () => {
    inUse(false);
    const { result } = renderHook(() => useOwnerContext());
    await act(async () => {});
    expect(result.current.shown).toBe(false);
  });

  it("are always on in a remote window, without asking", () => {
    window.__DAINTREE_HOST_ID__ = { id: "studio" };
    setHostPlatformInfo({ hostName: "studio-01" });
    expect(renderHook(() => useOwnerContext()).result.current.shown).toBe(true);
  });
});
