import { describe, expect, it } from "vitest";
import { shouldPlayUiFeedbackSound } from "../uiFeedbackSound.js";

describe("shouldPlayUiFeedbackSound", () => {
  it("plays when both soundEnabled and uiFeedbackSoundEnabled are true", () => {
    expect(shouldPlayUiFeedbackSound({ soundEnabled: true, uiFeedbackSoundEnabled: true })).toBe(
      true
    );
  });

  it("stays silent when soundEnabled is off, even with uiFeedbackSoundEnabled on (#12185)", () => {
    expect(shouldPlayUiFeedbackSound({ soundEnabled: false, uiFeedbackSoundEnabled: true })).toBe(
      false
    );
  });

  it("stays silent when uiFeedbackSoundEnabled is off, even with soundEnabled on", () => {
    expect(shouldPlayUiFeedbackSound({ soundEnabled: true, uiFeedbackSoundEnabled: false })).toBe(
      false
    );
  });

  it("stays silent when both are off", () => {
    expect(shouldPlayUiFeedbackSound({ soundEnabled: false, uiFeedbackSoundEnabled: false })).toBe(
      false
    );
  });
});
