// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { CANOPY_BETA_TERMS } from "@/components/Canopy/canopyTerms";
import { fireEvent, render, waitFor } from "@testing-library/react";
import type { CanopySnapshot } from "@shared/types/ipc/canopy";
import { useCanopyStore } from "@/store/canopyStore";
import { CanopySettingsTab } from "../CanopySettingsTab";

function snapshot(overrides: Partial<CanopySnapshot> = {}): CanopySnapshot {
  return {
    activated: false,
    tier: "free",
    dispositions: [],
    seen: [],
    reads: [],
    scope: null,
    active: false,
    busy: false,
    refreshedAt: null,
    cards: [],
    lastError: null,
    failedRuns: [],
    glances: [],
    ...overrides,
  };
}

function install() {
  const api = {
    getSnapshot: vi.fn().mockResolvedValue(snapshot()),
    activate: vi.fn(async (on: boolean) => snapshot({ activated: on })),
  };
  Object.defineProperty(window, "electron", {
    value: { canopy: api, system: { openExternal: vi.fn() } },
    configurable: true,
    writable: true,
  });
  return api;
}

afterEach(() => {
  vi.clearAllMocks();
  useCanopyStore.setState({ snapshot: null });
});

describe("CanopySettingsTab", () => {
  it("turns reading on and off, and states the beta's terms", async () => {
    const api = install();
    const { container } = render(<CanopySettingsTab />);
    await waitFor(() => expect(api.getSnapshot).toHaveBeenCalled());
    const toggle = () => container.querySelector<HTMLElement>("[role=switch]")!;
    await waitFor(() => expect(toggle().getAttribute("aria-checked")).toBe("false"));
    expect(container.textContent).toContain(CANOPY_BETA_TERMS);

    fireEvent.click(toggle());
    await waitFor(() => expect(api.activate).toHaveBeenCalledWith(true));
    await waitFor(() => expect(toggle().getAttribute("aria-checked")).toBe("true"));
    fireEvent.click(toggle());
    await waitFor(() => expect(api.activate).toHaveBeenLastCalledWith(false));
  });

  it("says the priority tier is paid instead of showing the beta", async () => {
    const api = install();
    api.getSnapshot.mockResolvedValue(snapshot({ tier: "priority" }));
    const { container } = render(<CanopySettingsTab />);
    await waitFor(() => expect(container.textContent).toContain("Paid"));
    expect(container.textContent).not.toContain(CANOPY_BETA_TERMS);
  });
});
