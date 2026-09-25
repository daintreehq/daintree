import { afterEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  override: null as ((wc: Electron.WebContents) => boolean) | null,
  postTerminalPortToView: vi.fn(() => null),
}));

vi.mock("../../../window/portDistribution.js", () => ({
  postTerminalPortToView: m.postTerminalPortToView,
  setTerminalPortOverride: (fn: (wc: Electron.WebContents) => boolean) => {
    m.override = fn;
    return () => {
      if (m.override === fn) m.override = null;
    };
  },
}));

import {
  attachClientTerminalRelay,
  detachClientTerminalRelayFor,
  disposeAllClientTerminalRelays,
  getClientTerminalRelay,
  installClientTerminalPortOverride,
} from "../clientAttach.js";
import { fakeSession, fakeWebContents } from "./fakeSession.js";

const hosts = new Map<number, string>();
const hostForView = (id: number) => hosts.get(id) ?? null;

afterEach(() => {
  disposeAllClientTerminalRelays();
  hosts.clear();
  m.postTerminalPortToView.mockClear();
});

describe("client terminal port override", () => {
  it("decides by the view's host: local views keep their local port", () => {
    const uninstall = installClientTerminalPortOverride(hostForView);
    try {
      expect(m.override!(fakeWebContents(11))).toBe(false);
    } finally {
      uninstall();
    }
  });

  it("claims a remote view with no relay yet and waits instead of going local", () => {
    const uninstall = installClientTerminalPortOverride(hostForView);
    try {
      hosts.set(11, "studio-01");
      expect(m.override!(fakeWebContents(11))).toBe(true);
      expect(m.postTerminalPortToView).not.toHaveBeenCalled();
    } finally {
      uninstall();
    }
  });

  it("re-delivers the relayed port for a view on its relay's host", () => {
    const uninstall = installClientTerminalPortOverride(hostForView);
    try {
      hosts.set(11, "studio-01");
      const wc = fakeWebContents(11);
      attachClientTerminalRelay(fakeSession(), wc, "view-11", "studio-01");
      m.postTerminalPortToView.mockClear();
      expect(m.override!(wc)).toBe(true);
      expect(m.postTerminalPortToView).toHaveBeenCalledWith(wc);
    } finally {
      uninstall();
    }
  });

  it("retires a relay from a host the view no longer belongs to", () => {
    const uninstall = installClientTerminalPortOverride(hostForView);
    try {
      const wc = fakeWebContents(11);
      const relay = attachClientTerminalRelay(fakeSession(), wc, "view-11", "studio-01");
      hosts.set(11, "studio-02");
      m.postTerminalPortToView.mockClear();
      expect(m.override!(wc)).toBe(true);
      expect(relay.isDisposed).toBe(true);
      expect(getClientTerminalRelay(11)).toBeUndefined();
      expect(m.postTerminalPortToView).not.toHaveBeenCalled();
    } finally {
      uninstall();
    }
  });
});

describe("client terminal relays", () => {
  it("replaces a view's relay when it attaches for another host", () => {
    const wc = fakeWebContents(11);
    const first = attachClientTerminalRelay(fakeSession(), wc, "view-11", "studio-01");
    const second = attachClientTerminalRelay(fakeSession(), wc, "view-11", "studio-02");
    expect(first).not.toBe(second);
    expect(first.isDisposed).toBe(true);
    expect(second.hostId).toBe("studio-02");
  });

  it("retires a relay only for the endpoint it belongs to", () => {
    const wc = fakeWebContents(11);
    const relay = attachClientTerminalRelay(fakeSession(), wc, "view-11", "studio-01");
    detachClientTerminalRelayFor(11, "studio-02", "view-11");
    expect(relay.isDisposed).toBe(false);
    detachClientTerminalRelayFor(11, "studio-01", "view-11");
    expect(relay.isDisposed).toBe(true);
  });

  it("disposes every relay at once for a stop", () => {
    const a = attachClientTerminalRelay(fakeSession(), fakeWebContents(11), "view-11", "h");
    const b = attachClientTerminalRelay(fakeSession(), fakeWebContents(12), "view-12", "h");
    disposeAllClientTerminalRelays();
    expect(a.isDisposed && b.isDisposed).toBe(true);
    expect(getClientTerminalRelay(11)).toBeUndefined();
  });
});
