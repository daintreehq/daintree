import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/clients", () => ({ terminalClient: {} }));
vi.mock("@/hooks/useTerminalAppearance", () => ({
  getTerminalAppearanceSnapshot: () => ({
    fontSize: 13,
    fontFamily: "monospace",
    performanceMode: false,
    scrollbackLines: 1000,
    projectScrollback: undefined,
    effectiveTheme: {},
    screenReaderMode: false,
  }),
}));

import { terminalRegistryController } from "../TerminalRegistryController";
import { __testing, register } from "@/services/terminal/terminalInstanceServiceAccessor";
import { makeSurface } from "@/services/terminal/paintFabric/__tests__/fakePaintPlane";

describe("TerminalRegistryController.prewarm", () => {
  afterEach(() => {
    __testing.reset();
  });

  // The mount path and prewarm race to claim the instance in getOrCreate, so
  // prewarm must not yield a microtask before reaching it once the service is
  // already loaded.
  it("calls prewarmTerminal synchronously when the service is already registered", () => {
    const { surface, plane } = makeSurface("primary");
    register(surface.plane);

    void terminalRegistryController.prewarm("t1", "grid");

    expect(plane.prewarmTerminal).toHaveBeenCalledTimes(1);
    expect(plane.prewarmTerminal.mock.calls[0]?.[0]).toBe("t1");
  });
});
