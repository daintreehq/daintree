import { afterEach, describe, expect, it, vi } from "vitest";
import {
  describeShellNames,
  getAttachedShells,
  isExitConfirmationPending,
  setAttachedShellsProvider,
  setExitConfirmationPending,
} from "../attachedShells.js";

afterEach(() => {
  setAttachedShellsProvider(null);
  setExitConfirmationPending(false);
  vi.restoreAllMocks();
});

describe("attachedShells", () => {
  it("reads nothing before a provider is registered", () => {
    expect(getAttachedShells()).toEqual([]);
  });

  it("returns what the provider reports", () => {
    setAttachedShellsProvider(() => [{ clientName: "MacBook Pro" }]);
    expect(getAttachedShells()).toEqual([{ clientName: "MacBook Pro" }]);
  });

  it("treats a throwing provider as nothing attached so a quit never hangs on it", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    setAttachedShellsProvider(() => {
      throw new Error("boom");
    });
    expect(getAttachedShells()).toEqual([]);
  });

  it("tracks one pending confirmation", () => {
    expect(isExitConfirmationPending()).toBe(false);
    setExitConfirmationPending(true);
    expect(isExitConfirmationPending()).toBe(true);
  });

  it("joins names once each, with a fallback for an unnamed machine", () => {
    expect(describeShellNames([{ clientName: "A" }])).toBe("A");
    expect(
      describeShellNames([{ clientName: "A" }, { clientName: "A" }, { clientName: "B" }])
    ).toBe("A and B");
    expect(
      describeShellNames([{ clientName: "A" }, { clientName: "B" }, { clientName: " " }])
    ).toBe("A, B and Another machine");
  });
});
