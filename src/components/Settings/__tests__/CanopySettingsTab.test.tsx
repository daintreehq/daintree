// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { CANOPY_LOCAL } from "@/components/Canopy/canopyTerms";
import { fireEvent, render, waitFor } from "@testing-library/react";
import type { CanopyMode, CanopySnapshot } from "@shared/types/ipc/canopy";
import { useCanopyStore } from "@/store/canopyStore";
import { CanopySettingsTab } from "../CanopySettingsTab";
import { getSettingsTabEntry } from "../settingsTabRegistry";
import { SETTINGS_SEARCH_INDEX } from "../settingsSearchIndex";
import { filterSettings } from "../settingsSearchUtils";

const MODEL_ID = "daintreehq/canopy-reader-17m";

function snapshot(overrides: Partial<CanopySnapshot> = {}): CanopySnapshot {
  return {
    mode: "unset",
    activated: false,
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
    getModel: vi.fn(),
    retryModel: vi.fn(),
    removeModels: vi.fn(),
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
  it("turns reading on and off, and says it all happens on this computer", async () => {
    const api = install();
    const { container } = render(<CanopySettingsTab />);
    const read = () => switchFor(container, "Read agent terminals");
    expect(read().getAttribute("aria-checked")).toBe("false");
    expect(container.textContent).toContain(CANOPY_LOCAL);
    expect(container.textContent).not.toMatch(/paid|beta|privacy policy|servers/i);

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

  it("offers no choice of model and nothing to download or delete: the model ships with Daintree", () => {
    for (const mode of ["unset", "on", "hidden"] as const) {
      for (const model of [undefined, { id: MODEL_ID, status: "ready" as const }]) {
        const api = install(mode, { model });
        const { container, queryByRole, unmount } = render(<CanopySettingsTab />);
        expect(queryByRole("radio")).toBeNull();
        expect(queryByRole("radiogroup")).toBeNull();
        // The two switches, and no other control.
        expect(queryByRole("button")).toBeNull();
        expect(container.textContent).not.toMatch(/download|delete model|\bMB\b/i);
        expect(api.getModel).not.toHaveBeenCalled();
        unmount();
      }
    }
  });

  it("says when the model that ships with Daintree fails its check, offering no download", () => {
    const error = "The model that comes with Daintree is missing or damaged.";
    const api = install("on", { model: { id: MODEL_ID, status: "failed", error } });
    const { container, queryByRole, rerender } = render(<CanopySettingsTab />);
    expect(container.textContent).toContain("Model unavailable");
    expect(container.textContent).toContain(error);
    expect(queryByRole("button")).toBeNull();
    expect(api.retryModel).not.toHaveBeenCalled();

    // Off, there is nothing it would read with, so nothing to say.
    useCanopyStore.setState({
      mode: "unset",
      snapshot: snapshot({ model: { id: MODEL_ID, status: "failed", error } }),
    });
    rerender(<CanopySettingsTab />);
    expect(container.textContent).not.toContain("Model unavailable");
  });

  it("is searched for by what the page says and shows, not by the hosted reader it replaced", () => {
    const sections = getSettingsTabEntry("canopy")?.sections ?? [];
    expect(sections.length).toBeGreaterThan(0);
    expect(sections.find((s) => s.id === "canopy-read-terminals")?.description).toBe(CANOPY_LOCAL);
    for (const section of sections) {
      expect(`${section.description} ${section.keywords?.join(" ")}`).not.toMatch(
        /servers?\b|paid|beta|plan\b|pricing|subscription/i
      );
    }

    // Search lands in a layout effect, on the first render, with Canopy off: each
    // result's row has to be there then.
    install("unset");
    const { container } = render(<CanopySettingsTab />);
    const rendered = new Set([...container.querySelectorAll("[id]")].map((el) => el.id));
    expect(sections.map((s) => s.id).filter((id) => !rendered.has(id))).toEqual([]);

    for (const query of ["model", "local model"]) {
      expect(
        filterSettings(SETTINGS_SEARCH_INDEX, query).some((r) => r.tab === "canopy"),
        query
      ).toBe(true);
    }
  });
});
