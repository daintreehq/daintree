import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { serializeTerminal, serializeTerminalAsync } from "../terminalSerialization.js";
import { disposeTerminalSerializerService } from "../TerminalSerializerService.js";
import type { TerminalInfo } from "../types.js";

type AddonStub = { serialize: ReturnType<typeof vi.fn> };

function makeTerminalInfo(overrides: Partial<TerminalInfo>): TerminalInfo {
  return overrides as unknown as TerminalInfo;
}

function makeAddon(impl: () => string = () => "snapshot"): AddonStub {
  return { serialize: vi.fn(impl) };
}

describe("terminalSerialization guards", () => {
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    errSpy.mockRestore();
    disposeTerminalSerializerService();
  });

  it("serializeTerminal returns null without logging when the addon is gone", () => {
    const info = makeTerminalInfo({ serializeAddon: undefined, preservedSnapshot: undefined });
    expect(serializeTerminal("t1", info)).toBeNull();
    expect(errSpy).not.toHaveBeenCalled();
  });

  it("serializeTerminalAsync returns null without logging when the headless terminal is gone", async () => {
    const info = makeTerminalInfo({
      headlessTerminal: undefined,
      serializeAddon: undefined,
      preservedSnapshot: undefined,
    });
    await expect(serializeTerminalAsync("t1", info)).resolves.toBeNull();
    expect(errSpy).not.toHaveBeenCalled();
  });

  it("serializeTerminalAsync still logs genuine serialize failures on a live terminal", async () => {
    const addon = makeAddon(() => {
      throw new Error("serialize boom");
    });
    const info = makeTerminalInfo({
      headlessTerminal: {
        buffer: { active: { length: 10 } },
      } as unknown as TerminalInfo["headlessTerminal"],
      serializeAddon: addon as unknown as TerminalInfo["serializeAddon"],
      preservedSnapshot: undefined,
    });
    await expect(serializeTerminalAsync("t1", info)).resolves.toBeNull();
    expect(errSpy).toHaveBeenCalledTimes(1);
  });

  it("serializeTerminal stamps preservedSnapshotLastAccessedAt when serving a preserved snapshot", () => {
    const info = makeTerminalInfo({
      preservedSnapshot: { data: "cached", cols: 80, rows: 24 },
      preservedSnapshotLastAccessedAt: 0,
    });
    const before = Date.now();
    expect(serializeTerminal("t1", info)).toEqual({ data: "cached", cols: 80, rows: 24 });
    expect(info.preservedSnapshotLastAccessedAt).toBeGreaterThanOrEqual(before);
  });

  it("serializeTerminalAsync stamps preservedSnapshotLastAccessedAt when serving a preserved snapshot", async () => {
    const info = makeTerminalInfo({
      preservedSnapshot: { data: "cached", cols: 80, rows: 24 },
      preservedSnapshotLastAccessedAt: 0,
    });
    const before = Date.now();
    await expect(serializeTerminalAsync("t1", info)).resolves.toEqual({
      data: "cached",
      cols: 80,
      rows: 24,
    });
    expect(info.preservedSnapshotLastAccessedAt).toBeGreaterThanOrEqual(before);
  });

  it("does not stamp preservedSnapshotLastAccessedAt on the non-preserved path", () => {
    const info = makeTerminalInfo({
      // The live mirror is the only source for the capture grid on this path,
      // so serializing without one yields null rather than a geometry-less
      // payload that would replay at whatever width it lands in (#11552).
      headlessTerminal: {
        cols: 120,
        rows: 40,
        buffer: { active: { length: 10 } },
      } as unknown as TerminalInfo["headlessTerminal"],
      serializeAddon: makeAddon() as unknown as TerminalInfo["serializeAddon"],
      preservedSnapshot: undefined,
      preservedSnapshotLastAccessedAt: undefined,
    });
    expect(serializeTerminal("t1", info)).toEqual({ data: "snapshot", cols: 120, rows: 40 });
    expect(info.preservedSnapshotLastAccessedAt).toBeUndefined();
  });

  it("serializeTerminalAsync yields null without logging when disposal clears the addon mid-flight", async () => {
    const addon = makeAddon();
    // Large buffer forces the async (deferred) serialize path.
    const info = makeTerminalInfo({
      headlessTerminal: {
        buffer: { active: { length: 2000 } },
      } as unknown as TerminalInfo["headlessTerminal"],
      serializeAddon: addon as unknown as TerminalInfo["serializeAddon"],
      preservedSnapshot: undefined,
    });

    const pending = serializeTerminalAsync("t1", info);
    // Simulate disposeHeadless() running before the deferred callback fires.
    info.serializeAddon = undefined;
    info.headlessTerminal = undefined;

    await expect(pending).resolves.toBeNull();
    expect(addon.serialize).not.toHaveBeenCalled();
    expect(errSpy).not.toHaveBeenCalled();
  });
});
