// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { CANOPY_LOCAL } from "@/components/Canopy/canopyTerms";
import { fireEvent, render, waitFor, within } from "@testing-library/react";
import type {
  CanopyMode,
  CanopyModelCatalogue,
  CanopyModelVariant,
  CanopySnapshot,
} from "@shared/types/ipc/canopy";
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
import { modelComparison } from "@/components/Canopy/canopyModelCopy";

const LIGHT: CanopyModelVariant = {
  id: "daintreehq/canopy-reader-17m",
  name: "Light",
  downloadBytes: 20_883_689,
  installed: true,
  supported: true,
  bench: {
    goldCategory: 58,
    gold: 60,
    agentCategory: 89,
    agents: 93,
    headline: 0.758,
    options: 0.739,
    cardF1: 0.651,
    msPerScreen: 25,
  },
};
const BEST: CanopyModelVariant = {
  id: "daintreehq/canopy-reader-68m",
  name: "Best",
  downloadBytes: 73_334_713,
  installed: false,
  supported: true,
  bench: {
    goldCategory: 57,
    gold: 60,
    agentCategory: 89,
    agents: 93,
    headline: 0.817,
    options: 0.87,
    cardF1: 0.714,
    msPerScreen: 130,
  },
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
  let catalogue: CanopyModelCatalogue = { selected: LIGHT.id, variants: [LIGHT, BEST] };
  const api = {
    setMode: vi.fn(async (next: CanopyMode) => snapshot({ mode: next, activated: next === "on" })),
    getModels: vi.fn(async () => catalogue),
    setModel: vi.fn(async (id: string) => {
      catalogue = { ...catalogue, selected: id };
      return snapshot({ mode, activated: mode === "on" });
    }),
    retryModel: vi.fn(async () => snapshot({ mode, activated: mode === "on" })),
    // Deleting while on turns Canopy off, as the real handler does.
    removeModels: vi.fn(async () => {
      catalogue = {
        ...catalogue,
        variants: catalogue.variants.map((v) => ({ ...v, installed: false })),
      };
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

  it("lists every model with what it costs, and marks the one downloaded", async () => {
    install("on");
    const { container, getByRole } = render(<CanopySettingsTab />);
    await waitFor(() => expect(getByRole("radio", { name: /Light/ })).toBeTruthy());
    const light = getByRole("radio", { name: /Light/ });
    const best = getByRole("radio", { name: /Best/ });
    expect(light.getAttribute("aria-checked")).toBe("true");
    expect(best.getAttribute("aria-checked")).toBe("false");
    expect(light.textContent).toContain("Downloaded");
    expect(best.textContent).not.toContain("Downloaded");
    expect(best.textContent).toContain("73 MB download");
    expect(container.textContent).toContain("Both read an agent's state equally well");
  });

  it("chooses another model, which Canopy then downloads", async () => {
    const api = install("on");
    const { getByRole } = render(<CanopySettingsTab />);
    await waitFor(() => expect(getByRole("radio", { name: /Best/ })).toBeTruthy());
    fireEvent.click(getByRole("radio", { name: /Best/ }));
    await waitFor(() => expect(api.setModel).toHaveBeenCalledWith(BEST.id));
    await waitFor(() =>
      expect(getByRole("radio", { name: /Best/ }).getAttribute("aria-checked")).toBe("true")
    );
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
        mode === "on" ? "Canopy turns off" : "Turning Canopy on again downloads a model"
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

  it("says plainly how little the models differ, in their own numbers", () => {
    const said = modelComparison([LIGHT, BEST])!;
    expect(said).toContain("Both read an agent's state equally well: 89 of 93");
    expect(said).toContain("82% against 76%");
    expect(said).toContain("87% against 74%");
    // 73.3 MB over 20.9 MB, and 130 ms over 25: never rounded up to a rounder claim.
    expect(said).toContain("3.5x the download");
    expect(said).toContain("about 5.2x the work");
    expect(said).toContain("For most people Light is enough");
    // One model, or none measured, has nothing to compare.
    expect(modelComparison([LIGHT])).toBeNull();
    expect(modelComparison([{ ...LIGHT, bench: null }, BEST])).toBeNull();
  });

  it("follows the numbers it is given, never calling a larger model better when it isn't", () => {
    const worse: CanopyModelVariant = {
      ...BEST,
      name: "150M",
      downloadBytes: LIGHT.downloadBytes * 10,
      bench: { ...BEST.bench!, agentCategory: 80, agents: 90, headline: 0.7, msPerScreen: 300 },
    };
    const said = modelComparison([LIGHT, worse])!;
    expect(said).toContain("Light reads an agent's state right on 89 of 93");
    expect(said).toContain("150M on 80 of 90");
    expect(said).not.toContain("more often");
    expect(said).not.toContain("is enough");
    expect(said).toContain("150M 70%, Light 76%");
    expect(said).toContain("10x the download and about 12x the work");
    // On x86 Light downloads its FP32 weights, about as big as Best's INT8.
    const heavy = { ...LIGHT, downloadBytes: BEST.downloadBytes - 2_000_000 };
    expect(modelComparison([heavy, BEST])!).toContain("about the same download");
    // A larger model that downloads much less is not "about the same".
    const big = { ...LIGHT, downloadBytes: BEST.downloadBytes * 2.5 };
    const said2 = modelComparison([big, BEST])!;
    expect(said2).toContain("2.5x smaller to download");
    expect(said2).not.toContain("about the same download");
  });
});
