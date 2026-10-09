// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { CANOPY_BETA_TERMS } from "@/components/Canopy/canopyTerms";
import { fireEvent, render, waitFor } from "@testing-library/react";
import type { CanopyMode, CanopySnapshot } from "@shared/types/ipc/canopy";
import { useCanopyStore } from "@/store/canopyStore";
import { CanopySettingsTab } from "../CanopySettingsTab";

function snapshot(overrides: Partial<CanopySnapshot> = {}): CanopySnapshot {
  return {
    mode: "unset",
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

function install(mode: CanopyMode = "unset", overrides: Partial<CanopySnapshot> = {}) {
  const api = {
    setMode: vi.fn(async (next: CanopyMode) => snapshot({ mode: next, activated: next === "on" })),
  };
  Object.defineProperty(window, "electron", {
    value: { canopy: api, system: { openExternal: vi.fn() } },
    configurable: true,
    writable: true,
  });
  useCanopyStore.setState({
    mode,
    snapshot: snapshot({ mode, activated: mode === "on", ...overrides }),
  });
  return api;
}

afterEach(() => {
  vi.clearAllMocks();
  useCanopyStore.setState({ snapshot: null, mode: "unset" });
});

function switchFor(container: HTMLElement, title: string): HTMLElement {
  const row = [...container.querySelectorAll<HTMLElement>("[role=switch]")].find((control) =>
    control.getAttribute("aria-labelledby")
      ? document.getElementById(control.getAttribute("aria-labelledby")!)?.textContent === title
      : control.getAttribute("aria-label") === title
  );
  if (!row) throw new Error(`No switch named ${title}`);
  return row;
}

describe("CanopySettingsTab", () => {
  it("turns reading on and off, and states the beta's terms", async () => {
    const api = install();
    const { container } = render(<CanopySettingsTab />);
    const read = () => switchFor(container, "Read agent terminals");
    expect(read().getAttribute("aria-checked")).toBe("false");
    expect(container.textContent).toContain(CANOPY_BETA_TERMS);

    fireEvent.click(read());
    await waitFor(() => expect(api.setMode).toHaveBeenCalledWith("on"));
    await waitFor(() => expect(read().getAttribute("aria-checked")).toBe("true"));
    fireEvent.click(read());
    await waitFor(() => expect(api.setMode).toHaveBeenLastCalledWith("unset"));
  });

  it("hides Canopy, holding reading off until it is shown again", async () => {
    const api = install("on");
    const { container } = render(<CanopySettingsTab />);
    const show = () => switchFor(container, "Show Canopy");
    const read = () => switchFor(container, "Read agent terminals");
    expect(show().getAttribute("aria-checked")).toBe("true");
    expect(container.textContent).not.toContain("Show Canopy to turn it on");

    fireEvent.click(show());
    await waitFor(() => expect(api.setMode).toHaveBeenCalledWith("hidden"));
    await waitFor(() => expect(show().getAttribute("aria-checked")).toBe("false"));
    expect(read().getAttribute("aria-checked")).toBe("false");
    expect(read().hasAttribute("disabled") || read().getAttribute("aria-disabled") === "true").toBe(
      true
    );
    expect(container.textContent).toContain("Show Canopy to turn it on");

    fireEvent.click(show());
    await waitFor(() => expect(api.setMode).toHaveBeenLastCalledWith("unset"));
    await waitFor(() => expect(container.textContent).not.toContain("Show Canopy to turn it on"));
  });

  it("says when a change fails, keeps the switch where it was, and retries it", async () => {
    const api = install("unset");
    api.setMode.mockRejectedValueOnce(
      new Error("Slow down — too many requests in a short window.")
    );
    const { container, getByRole } = render(<CanopySettingsTab />);
    const read = () => switchFor(container, "Read agent terminals");
    fireEvent.click(read());
    await waitFor(() => expect(container.textContent).toContain("Couldn't change Canopy"));
    expect(container.textContent).toContain("too many requests");
    expect(read().getAttribute("aria-checked")).toBe("false");

    fireEvent.click(getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(read().getAttribute("aria-checked")).toBe("true"));
    expect(api.setMode).toHaveBeenLastCalledWith("on");
    expect(container.textContent).not.toContain("Couldn't change Canopy");
  });

  it("takes one change at a time, so a second switch can't act on the mode the first replaces", async () => {
    const api = install("on");
    let land: (snapshot: CanopySnapshot) => void = () => {};
    api.setMode.mockImplementationOnce(() => new Promise((resolve) => (land = resolve)));
    const { container } = render(<CanopySettingsTab />);
    fireEvent.click(switchFor(container, "Show Canopy"));
    // Before the hide lands, Read still looks on: turning it off must not unhide Canopy.
    fireEvent.click(switchFor(container, "Read agent terminals"));
    expect(api.setMode.mock.calls).toEqual([["hidden"]]);
    land(snapshot({ mode: "hidden", activated: false }));
    await waitFor(() =>
      expect(switchFor(container, "Show Canopy").getAttribute("aria-checked")).toBe("false")
    );
  });

  it("says the priority tier is paid instead of showing the beta", async () => {
    install("unset", { tier: "priority" });
    const { container } = render(<CanopySettingsTab />);
    expect(container.textContent).toContain("Paid");
    expect(container.textContent).not.toContain(CANOPY_BETA_TERMS);
  });
});
