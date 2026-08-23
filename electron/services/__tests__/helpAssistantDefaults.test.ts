import { describe, it, expect, vi } from "vitest";

// A MUTABLE stand-in for Electron's `app`, so the packaged and unpackaged answers can
// both be exercised in one file. `defaultDebugLogging` reads the flag when called rather
// than at import, which is what makes that possible — and is also what stops a test that
// stubs `electron` without `app` from taking a whole suite down at import time.
const electronMock = vi.hoisted(() => ({ app: { isPackaged: false } }));
vi.mock("electron", () => electronMock);

import { defaultDebugLogging } from "../helpAssistantDefaults.js";

describe("defaultDebugLogging", () => {
  it("is on in a development build and off in a packaged one", () => {
    electronMock.app.isPackaged = false;
    expect(defaultDebugLogging()).toBe(true);

    electronMock.app.isPackaged = true;
    expect(defaultDebugLogging()).toBe(false);
  });

  it("is off when the packaging state cannot be read at all", () => {
    // The shape a unit test produces with `vi.mock("electron", () => ({ ipcMain }))`.
    // "Cannot tell" must resolve to OFF: the trace holds the conversation, terminal
    // output and file excerpts, so an unknown build is not one that should quietly start
    // writing them to disk.
    const saved = electronMock.app;
    // @ts-expect-error deliberately reproducing the partial mock other suites install
    electronMock.app = undefined;
    try {
      expect(defaultDebugLogging()).toBe(false);
    } finally {
      electronMock.app = saved;
    }
  });
});
