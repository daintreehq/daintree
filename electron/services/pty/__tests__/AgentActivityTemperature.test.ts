import { describe, expect, it } from "vitest";
import { AgentActivityTemperature } from "../AgentActivityTemperature.js";
import { createVisibleContentSnapshot } from "../SustainedChangeTracker.js";

function snapshot(text: string) {
  return createVisibleContentSnapshot([text]);
}

describe("AgentActivityTemperature", () => {
  it("requires sustained visible changes before hinting busy", () => {
    const model = new AgentActivityTemperature();

    model.seedSnapshot(snapshot("waiting 0"), 1000);

    expect(model.observeSnapshot(1100, snapshot("tick 1")).stateHint).toBeUndefined();
    expect(model.observeSnapshot(1800, snapshot("tick 2")).stateHint).toBeUndefined();
    expect(model.observeSnapshot(2500, snapshot("tick 3")).stateHint).toBeUndefined();

    const result = model.observeSnapshot(3200, snapshot("tick 4"));
    expect(result.stateHint).toBe("busy");
    expect(result.temperature).toBeGreaterThanOrEqual(70);
  });

  it("does not hint busy for a fast burst that has not met working dwell", () => {
    const model = new AgentActivityTemperature();

    model.seedSnapshot(snapshot("waiting 0"), 1000);

    expect(model.observeSnapshot(1050, snapshot("tick 1")).stateHint).toBeUndefined();
    expect(model.observeSnapshot(1150, snapshot("tick 2")).stateHint).toBeUndefined();
    expect(model.observeSnapshot(1250, snapshot("tick 3")).stateHint).toBeUndefined();
    expect(model.observeSnapshot(1350, snapshot("tick 4")).stateHint).toBeUndefined();
    expect(model.getTemperature()).toBeGreaterThanOrEqual(70);
  });

  it("does not hint busy for sparse once-per-second changes", () => {
    const model = new AgentActivityTemperature();

    model.seedSnapshot(snapshot("waiting 0"), 1000);

    expect(model.observeSnapshot(2000, snapshot("layout 1")).stateHint).toBeUndefined();
    expect(model.observeSnapshot(3000, snapshot("layout 2")).stateHint).toBeUndefined();
    expect(model.observeSnapshot(4000, snapshot("layout 3")).stateHint).toBeUndefined();
    expect(model.observeSnapshot(5000, snapshot("layout 4")).stateHint).toBeUndefined();
    expect(model.getTemperature()).toBeGreaterThanOrEqual(70);
  });

  it("recovers to busy for once-per-second indicator changes", () => {
    const model = new AgentActivityTemperature();

    model.seedSnapshot(snapshot("retrying in 9s"), 1000);

    const opts = { signalKind: "indicator" as const };
    expect(model.observeSnapshot(2000, snapshot("retrying in 8s"), opts).stateHint).toBeUndefined();
    expect(model.observeSnapshot(3000, snapshot("retrying in 7s"), opts).stateHint).toBeUndefined();

    const result = model.observeSnapshot(4000, snapshot("retrying in 6s"), opts);
    expect(result.stateHint).toBe("busy");
    expect(result.temperature).toBeGreaterThanOrEqual(70);
  });

  it("does not recover for indicator changes spaced beyond the indicator gap", () => {
    const model = new AgentActivityTemperature();

    model.seedSnapshot(snapshot("tick 0"), 1000);

    const opts = { signalKind: "indicator" as const };
    expect(model.observeSnapshot(3500, snapshot("tick 1"), opts).stateHint).toBeUndefined();
    expect(model.observeSnapshot(6000, snapshot("tick 2"), opts).stateHint).toBeUndefined();
    expect(model.observeSnapshot(8500, snapshot("tick 3"), opts).stateHint).toBeUndefined();
    expect(model.observeSnapshot(11000, snapshot("tick 4"), opts).stateHint).toBeUndefined();
  });

  it("requires fresh indicator evidence after a resize", () => {
    const model = new AgentActivityTemperature();

    model.seedSnapshot(snapshot("retrying in 9s"), 1000);

    const opts = { signalKind: "indicator" as const };
    model.observeSnapshot(2000, snapshot("retrying in 8s"), opts);
    model.observeSnapshot(3000, snapshot("retrying in 7s"), opts);

    model.noteResize(3100);
    expect(model.observeSnapshot(3400, snapshot("reflowed"), opts).suppressed).toBe(true);
    expect(model.observeSnapshot(3700, snapshot("post resize baseline"), opts).seeded).toBe(true);

    expect(model.observeSnapshot(4700, snapshot("retrying in 5s"), opts).stateHint).toBeUndefined();
    expect(model.observeSnapshot(5700, snapshot("retrying in 4s"), opts).stateHint).toBeUndefined();
    expect(model.observeSnapshot(6700, snapshot("retrying in 3s"), opts).stateHint).toBe("busy");
  });

  it("cools through the waiting threshold only after six-second quiet dwell", () => {
    const model = new AgentActivityTemperature();

    model.seedSnapshot(snapshot("waiting 0"), 1000);
    model.observeSnapshot(1100, snapshot("working 1"));
    model.observeSnapshot(1800, snapshot("working 2"));
    model.observeSnapshot(2500, snapshot("working 3"));
    expect(model.observeSnapshot(3200, snapshot("working 4")).stateHint).toBe("busy");

    expect(model.observeSnapshot(3300, snapshot("working 4")).stateHint).toBeUndefined();
    expect(model.observeSnapshot(8000, snapshot("working 4")).stateHint).toBeUndefined();
    expect(model.observeSnapshot(9300, snapshot("working 4")).stateHint).toBe("idle");
    expect(model.getTemperature()).toBeLessThanOrEqual(40);
  });

  it("treats resize as dead-time and baseline-only reseed", () => {
    const model = new AgentActivityTemperature();

    model.seedSnapshot(snapshot("waiting 0"), 1000);
    model.observeSnapshot(1100, snapshot("working 1"));
    model.observeSnapshot(1800, snapshot("working 2"));

    const temperatureBeforeResize = model.getTemperature(1900);
    model.noteResize(1900);

    const suppressed = model.observeSnapshot(2300, snapshot("reflowed content"));
    expect(suppressed.suppressed).toBe(true);
    expect(suppressed.stateHint).toBeUndefined();
    expect(suppressed.temperature).toBe(temperatureBeforeResize);

    const seeded = model.observeSnapshot(2400, snapshot("post resize baseline"));
    expect(seeded.seeded).toBe(true);
    expect(seeded.stateHint).toBeUndefined();

    expect(model.observeSnapshot(3100, snapshot("post resize 1")).stateHint).toBeUndefined();
    expect(model.observeSnapshot(3800, snapshot("post resize 2")).stateHint).toBeUndefined();
    expect(model.observeSnapshot(4500, snapshot("post resize 3")).stateHint).toBeUndefined();
    expect(model.observeSnapshot(5200, snapshot("post resize 4")).stateHint).toBe("busy");
  });

  it("keeps resize suppressed until the last resize event settles", () => {
    const model = new AgentActivityTemperature();

    model.seedSnapshot(snapshot("waiting 0"), 1000);
    model.noteResize(1500);
    model.noteResize(2300);
    model.noteResize(3100);

    const stillResizing = model.observeSnapshot(3500, snapshot("reflow in progress"));
    expect(stillResizing.suppressed).toBe(true);
    expect(stillResizing.stateHint).toBeUndefined();

    const settled = model.observeSnapshot(3650, snapshot("baseline after resize"));
    expect(settled.seeded).toBe(true);
    expect(settled.suppressed).toBe(false);
  });

  it("keeps decorative spinner heat below the working threshold", () => {
    const model = new AgentActivityTemperature();

    for (let i = 0; i < 20; i += 1) {
      const result = model.observeDelta(1000 + i * 250, {
        changedChars: 1,
        decorative: true,
      });
      expect(result.stateHint).toBeUndefined();
    }

    expect(model.getTemperature()).toBeLessThan(70);
  });

  it("treats signalKind decorative like the decorative flag", () => {
    const model = new AgentActivityTemperature();

    for (let i = 0; i < 20; i += 1) {
      const result = model.observeDelta(1000 + i * 250, {
        changedChars: 1,
        signalKind: "decorative",
      });
      expect(result.stateHint).toBeUndefined();
    }

    expect(model.getTemperature()).toBeLessThan(70);
  });
});
