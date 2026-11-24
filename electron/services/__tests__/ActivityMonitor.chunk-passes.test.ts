import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stripCosmeticParticles } from "../pty/CosmeticParticleFilter.js";
import { stripIdleTerminalSequences } from "../pty/IdleSequenceFilter.js";
import { filteredOutputBytesUpTo } from "../pty/filteredOutputBytes.js";
import { OutputVolumeDetector } from "../pty/OutputVolumeDetector.js";

vi.mock("../pty/CosmeticParticleFilter.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../pty/CosmeticParticleFilter.js")>();
  return { ...actual, stripCosmeticParticles: vi.fn(actual.stripCosmeticParticles) };
});
vi.mock("../pty/filteredOutputBytes.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../pty/filteredOutputBytes.js")>();
  return { ...actual, filteredOutputBytesUpTo: vi.fn(actual.filteredOutputBytesUpTo) };
});
vi.mock("../pty/IdleSequenceFilter.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../pty/IdleSequenceFilter.js")>();
  return { ...actual, stripIdleTerminalSequences: vi.fn(actual.stripIdleTerminalSequences) };
});

const { ActivityMonitor } = await import("../ActivityMonitor.js");

// A status-line rewrite in a truecolor frame: it reaches the particle pass
// through both the status-line check and the volume count.
const STATUS_FRAME = "\r\x1b[38;2;200;120;50m⠋ Working (12s • esc to interrupt)\x1b[0m";
// The same rewrite under a composer particle field the particle pass removes.
const SPARKLING_STATUS_FRAME =
  STATUS_FRAME +
  "\x1b[3;7H\x1b[38;2;80;80;80m⠁\x1b[4;9H\x1b[38;2;90;90;90m⠂\x1b[5;2H\x1b[38;2;100;100;100m⠄";

function cursorAddressedRepaint(): string {
  let repaint = "";
  for (let row = 1; repaint.length < 32 * 1024; row = (row % 40) + 1) {
    repaint += `\x1b[${row};3H\x1b[2K\x1b[38;2;200;120;50m│\x1b[0m step ${row}: reading files`;
  }
  return repaint;
}

function simpleMonitor(volumeEnabled: boolean, simpleOutputState = true) {
  return new ActivityMonitor("t", 1000, vi.fn(), {
    agentId: "claude",
    simpleOutputState,
    initialState: "idle",
    skipInitialStateEmit: true,
    simpleOutputVolumeRecovery: {
      enabled: volumeEnabled,
      leakRatePerMs: 0.1,
      activationThreshold: 512,
      maxBytesPerFrame: 256,
    },
  });
}

describe("ActivityMonitor per-chunk filter passes", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(stripCosmeticParticles).mockClear();
    vi.mocked(stripIdleTerminalSequences).mockClear();
    vi.mocked(filteredOutputBytesUpTo).mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("runs the particle pass once per chunk for the status check and the volume count", () => {
    const monitor = simpleMonitor(true);
    monitor.onData(STATUS_FRAME);
    monitor.onData(STATUS_FRAME);

    expect(stripCosmeticParticles).toHaveBeenCalledTimes(2);
    monitor.dispose();
  });

  it("measures no volume when the simple floor is disabled", () => {
    const update = vi.spyOn(OutputVolumeDetector.prototype, "update");
    const monitor = simpleMonitor(false);
    monitor.onData(cursorAddressedRepaint());

    expect(filteredOutputBytesUpTo).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(stripIdleTerminalSequences).not.toHaveBeenCalled();
    monitor.dispose();
  });

  it("credits a large repaint the frame cap without stripping it", () => {
    const update = vi.spyOn(OutputVolumeDetector.prototype, "update");
    const monitor = simpleMonitor(true);
    monitor.onData(cursorAddressedRepaint());

    expect(filteredOutputBytesUpTo).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith(256, expect.any(Number));
    expect(stripIdleTerminalSequences).not.toHaveBeenCalled();
    monitor.dispose();
  });

  it("hands the non-simple path's idle filter the chunk's particle pass", () => {
    const monitor = simpleMonitor(false, false);
    monitor.onData(SPARKLING_STATUS_FRAME);

    expect(stripCosmeticParticles).toHaveBeenCalledTimes(1);
    const particleFree = vi.mocked(stripCosmeticParticles).mock.results[0].value;
    expect(particleFree).not.toBe(SPARKLING_STATUS_FRAME);
    expect(stripIdleTerminalSequences).toHaveBeenCalledWith(SPARKLING_STATUS_FRAME, particleFree);
    monitor.dispose();
  });
});
