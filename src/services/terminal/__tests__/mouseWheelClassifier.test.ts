import { describe, expect, it } from "vitest";
import { MouseWheelClassifier } from "../mouseWheelClassifier";

// Behavioral tests: feed a realistic device's wheel-event stream and assert the
// trackpad-vs-physical-wheel verdict. Inputs are device signatures (integer
// single-axis repeating = wheel; fractional / dual-axis = trackpad), not the
// algorithm's internal scores, so these are regression guards, not change
// detectors.
describe("MouseWheelClassifier", () => {
  function feed(c: MouseWheelClassifier, events: Array<[number, number]>): void {
    let t = 0;
    for (const [dx, dy] of events) c.accept((t += 16), dx, dy);
  }

  it("reports trackpad (false) before any event is seen", () => {
    // No evidence yet → assume the gentler-pacing device until a discrete wheel
    // detent proves otherwise.
    expect(new MouseWheelClassifier().isPhysicalMouseWheel()).toBe(false);
  });

  it("classifies a single clean integer single-axis detent as a physical wheel", () => {
    const c = new MouseWheelClassifier();
    feed(c, [[0, 120]]);
    expect(c.isPhysicalMouseWheel()).toBe(true);
  });

  it("classifies a stream of repeating integer single-axis detents as a physical wheel", () => {
    const c = new MouseWheelClassifier();
    feed(c, [
      [0, 120],
      [0, 120],
      [0, 120],
      [0, 120],
    ]);
    expect(c.isPhysicalMouseWheel()).toBe(true);
  });

  it("classifies line-mode integer steps (Windows/Linux mice) as a physical wheel", () => {
    const c = new MouseWheelClassifier();
    feed(c, [
      [0, 3],
      [0, 3],
      [0, 3],
    ]);
    expect(c.isPhysicalMouseWheel()).toBe(true);
  });

  it("classifies dual-axis motion as a trackpad", () => {
    const c = new MouseWheelClassifier();
    // Both axes moving at once is the trackpad/Magic-Mouse signature.
    feed(c, [
      [2.5, 8.2],
      [1.1, 11.7],
      [0.4, 6.3],
    ]);
    expect(c.isPhysicalMouseWheel()).toBe(false);
  });

  it("classifies fractional single-axis deltas as a trackpad", () => {
    const c = new MouseWheelClassifier();
    feed(c, [
      [0, 4.5],
      [0, 7.25],
      [0, 2.75],
    ]);
    expect(c.isPhysicalMouseWheel()).toBe(false);
  });

  it("flips from wheel to trackpad as the device changes mid-stream", () => {
    const c = new MouseWheelClassifier();
    feed(c, [
      [0, 120],
      [0, 120],
    ]);
    expect(c.isPhysicalMouseWheel()).toBe(true);
    // Switch to trackpad motion; the weighted average tips within a few events.
    feed(c, [
      [3.3, 9.1],
      [1.7, 12.4],
      [0.9, 5.6],
    ]);
    expect(c.isPhysicalMouseWheel()).toBe(false);
  });

  it("recovers from trackpad to wheel when the device changes back", () => {
    const c = new MouseWheelClassifier();
    feed(c, [
      [3.3, 9.1],
      [1.7, 12.4],
    ]);
    expect(c.isPhysicalMouseWheel()).toBe(false);
    // Switch to clean wheel detents; the weighted average tips back within a few.
    feed(c, [
      [0, 120],
      [0, 120],
      [0, 120],
    ]);
    expect(c.isPhysicalMouseWheel()).toBe(true);
  });

  it("stays trackpad through an occasional integer single-axis delta in a trackpad stream", () => {
    const c = new MouseWheelClassifier();
    feed(c, [
      [2.4, 8.1],
      [0, 9], // one clean-looking integer delta mid-gesture
      [1.6, 11.3],
      [0.7, 6.9],
    ]);
    expect(c.isPhysicalMouseWheel()).toBe(false);
  });

  it("weighs recent events more than older ones (a wheel streak survives one trackpad blip)", () => {
    const c = new MouseWheelClassifier();
    // A single trackpad-looking event at the END of a wheel streak shouldn't flip
    // the verdict on its own — recency is weighted, but one event isn't a majority.
    feed(c, [
      [0, 120],
      [0, 120],
      [0, 120],
      [0, 120],
      [0, 5.5], // lone fractional blip (newest)
    ]);
    expect(c.isPhysicalMouseWheel()).toBe(true);
  });

  it("resets to an empty verdict, forgetting prior device history", () => {
    const c = new MouseWheelClassifier();
    feed(c, [
      [0, 120],
      [0, 120],
    ]);
    expect(c.isPhysicalMouseWheel()).toBe(true);
    c.reset();
    expect(c.isPhysicalMouseWheel()).toBe(false); // empty again
    // After reset a single trackpad event classifies as trackpad immediately,
    // unbiased by the prior wheel streak.
    feed(c, [[3.1, 8.8]]);
    expect(c.isPhysicalMouseWheel()).toBe(false);
  });

  it("keeps per-instance state independent (two panes, two devices)", () => {
    const wheel = new MouseWheelClassifier();
    const trackpad = new MouseWheelClassifier();
    feed(wheel, [
      [0, 120],
      [0, 120],
    ]);
    feed(trackpad, [
      [2.1, 7.7],
      [1.4, 9.2],
    ]);
    expect(wheel.isPhysicalMouseWheel()).toBe(true);
    expect(trackpad.isPhysicalMouseWheel()).toBe(false);
  });
});
