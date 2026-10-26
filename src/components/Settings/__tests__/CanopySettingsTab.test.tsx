// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { CANOPY_LOCAL } from "@/components/Canopy/canopyTerms";
import { fireEvent, render, waitFor, within } from "@testing-library/react";
import type { CanopyMode, CanopyModelInfo, CanopySnapshot } from "@shared/types/ipc/canopy";
import { useCanopyStore } from "@/store/canopyStore";
import { CanopySettingsTab } from "../CanopySettingsTab";

// The real dialog pulls in the app's icons and portals; what matters here is what it is given.
vi.mock("@/components/ui/ConfirmDialog", () => ({
  ConfirmDialog: (props: {
    isOpen: boolean;
    variant: string;
    title: string;
    description: string;
    confirmLabel: string;
    cancelLabel: string;
    onClose: () => void;
    onConfirm: () => void;
  }) =>
    props.isOpen ? (
      <div role="dialog" data-variant={props.variant}>
        <h2>{props.title}</h2>
        <p>{props.description}</p>
        <button onClick={props.onClose}>{props.cancelLabel}</button>
        <button onClick={props.onConfirm}>{props.confirmLabel}</button>
      </div>
    ) : null,
}));
const LIGHT: CanopyModelInfo = {
  id: "daintreehq/canopy-reader-17m",
  name: "Light",
  bytes: 21_000_000,
  installed: true,
};

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
  let info: CanopyModelInfo = LIGHT;
  const api = {
    setMode: vi.fn(async (next: CanopyMode) => snapshot({ mode: next, activated: next === "on" })),
    getModel: vi.fn(async () => info),
    retryModel: vi.fn(async () => snapshot({ mode, activated: mode === "on" })),
    // Deleting while on turns Canopy off, as the real handler does.
    removeModels: vi.fn(async () => {
      info = { ...info, installed: false };
      return mode === "on" ? snapshot({ mode: "unset", activated: false }) : snapshot({ mode });
    }),
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

  it("offers no choice of model: there is one", async () => {
    install("on");
    const { findByRole, queryByRole } = render(<CanopySettingsTab />);
    await findByRole("button", { name: "Delete model" });
    expect(queryByRole("radio")).toBeNull();
    expect(queryByRole("radiogroup")).toBeNull();
  });

  it("shows a download's progress, and a failed one with a way to retry it", async () => {
    const api = install("on", {
      model: { id: LIGHT.id, status: "downloading", received: 8_200_000, total: 20_900_000 },
    });
    const { container, getByRole, rerender } = render(<CanopySettingsTab />);
    expect(container.textContent).toContain("8.2 MB of 21 MB");
    useCanopyStore.setState({
      snapshot: snapshot({
        mode: "on",
        activated: true,
        model: { id: LIGHT.id, status: "failed", error: "The download failed." },
      }),
    });
    rerender(<CanopySettingsTab />);
    await waitFor(() => expect(container.textContent).toContain("Download failed"));
    fireEvent.click(getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(api.retryModel).toHaveBeenCalled());
  });

  it("deletes a downloaded model only after a confirm that names it, whether Canopy is on or off", async () => {
    for (const mode of ["unset", "on"] as const) {
      const api = install(mode);
      const { findByRole, getByRole, queryByRole, unmount } = render(<CanopySettingsTab />);
      fireEvent.click(await findByRole("button", { name: "Delete model" }));
      // Nothing is deleted by the first press: the dialog says what goes, and what happens to Canopy.
      expect(api.removeModels).not.toHaveBeenCalled();
      const dialog = await findByRole("dialog");
      // Destructive, so the action is named and styled as one.
      expect(dialog.getAttribute("data-variant")).toBe("destructive");
      expect(dialog.textContent).toContain("Delete 'Light'?");
      expect(dialog.textContent).toContain("Frees 21 MB");
      expect(dialog.textContent).toContain(
        mode === "on" ? "Canopy turns off" : "Turning Canopy on again downloads the model"
      );
      fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
      expect(api.removeModels).not.toHaveBeenCalled();
      await waitFor(() => expect(queryByRole("dialog")).toBeNull());
      fireEvent.click(getByRole("button", { name: "Delete model" }));
      fireEvent.click(
        within(await findByRole("dialog")).getByRole("button", { name: "Delete model" })
      );
      await waitFor(() => expect(api.removeModels).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(queryByRole("button", { name: "Delete model" })).toBeNull());
      // Deleting while it was on is the one thing that turns it off, and the page shows it.
      expect(useCanopyStore.getState().mode).toBe("unset");
      unmount();
    }
  });
});
