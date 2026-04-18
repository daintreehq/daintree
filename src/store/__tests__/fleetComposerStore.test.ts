import { describe, it, expect, beforeEach } from "vitest";
import { useFleetComposerStore } from "../fleetComposerStore";
import { useFleetArmingStore } from "../fleetArmingStore";

function resetStore() {
  useFleetComposerStore.setState({ draft: "" });
}

describe("fleetComposerStore", () => {
  beforeEach(() => {
    resetStore();
  });

  it("starts with an empty draft", () => {
    expect(useFleetComposerStore.getState().draft).toBe("");
  });

  it("setDraft updates the draft", () => {
    useFleetComposerStore.getState().setDraft("hello fleet");
    expect(useFleetComposerStore.getState().draft).toBe("hello fleet");
  });

  it("clearDraft resets the draft to empty", () => {
    useFleetComposerStore.getState().setDraft("something");
    useFleetComposerStore.getState().clearDraft();
    expect(useFleetComposerStore.getState().draft).toBe("");
  });

  it("is independent from fleetArmingStore", () => {
    useFleetComposerStore.getState().setDraft("typing");
    useFleetArmingStore.getState().armIds(["a", "b"]);
    // Draft survives arming changes
    expect(useFleetComposerStore.getState().draft).toBe("typing");
    // Arming persists regardless of composer draft changes
    useFleetComposerStore.getState().clearDraft();
    expect(useFleetArmingStore.getState().armedIds.size).toBe(2);
    useFleetArmingStore.getState().clear();
  });
});
