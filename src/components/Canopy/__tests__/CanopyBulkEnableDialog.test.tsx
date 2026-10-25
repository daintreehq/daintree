// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { CanopyMode, CanopyModelCatalogue, CanopySnapshot } from "@shared/types/ipc/canopy";

vi.mock("react-dom", async () => {
  const actual = await vi.importActual<typeof import("react-dom")>("react-dom");
  return { ...actual, createPortal: (children: React.ReactNode) => children };
});
vi.mock("@/clients/systemClient", () => ({ systemClient: { openExternal: vi.fn() } }));

import { CanopyBulkEnableDialog } from "../CanopyBulkEnableDialog";
import type { BulkTarget, BulkTransport } from "@shared/utils/canopyBulkEnable";

const snap = (mode: CanopyMode, rev = 0): CanopySnapshot => ({
  mode,
  modeRevision: rev,
  hostEpoch: "e",
  activated: mode === "on",
  dispositions: [],
  seen: [],
  reads: [],
  scope: null,
  active: false,
  busy: false,
  refreshedAt: null,
  cards: [],
  glances: [],
  lastError: null,
  failedRuns: [],
});

const LIGHT = "daintreehq/canopy-reader-17m";
const BEST = "daintreehq/canopy-reader-68m";
const catalogue: CanopyModelCatalogue = {
  selected: LIGHT,
  variants: [
    {
      id: LIGHT,
      name: "Light",
      downloadBytes: 21_000_000,
      installed: false,
      supported: true,
      bench: null,
    },
    {
      id: BEST,
      name: "Best",
      downloadBytes: 73_000_000,
      installed: false,
      supported: true,
      bench: null,
    },
  ],
};

const targets: BulkTarget[] = [
  { hostId: "local", name: "This Mac" },
  { hostId: "studio-1", name: "Studio" },
  { hostId: "studio-2", name: "Basement" },
];

function setup(failStudio2 = true) {
  const modes: Record<string, CanopySnapshot> = {
    local: snap("unset"),
    "studio-1": snap("hidden"),
    "studio-2": snap("unset"),
  };
  const setMode = vi.fn();
  const setModel = vi.fn();
  const loadModels = vi.fn(async () => catalogue);
  let studio2Up = !failStudio2;
  const released: string[] = [];
  const transportFor = (target: BulkTarget): BulkTransport => ({
    getSnapshot: async () => {
      if (target.hostId === "studio-2" && !studio2Up) throw new Error("offline");
      return modes[target.hostId]!;
    },
    setModel: async (id) => {
      setModel(target.hostId, id);
    },
    setMode: async (mode, rev) => {
      setMode(target.hostId, mode, rev);
      modes[target.hostId] = snap(mode, rev + 1);
      return modes[target.hostId]!;
    },
    ...(target.hostId === "studio-2" ? { connect: async () => false } : {}),
    release: () => {
      released.push(target.hostId);
    },
  });
  return {
    setMode,
    setModel,
    loadModels,
    released,
    transportFor,
    bringUp: () => {
      studio2Up = true;
    },
  };
}

afterEach(cleanup);

describe("CanopyBulkEnableDialog", () => {
  it("names every target, makes no change until the one press, and retries only the failed host", async () => {
    const h = setup();
    render(
      <CanopyBulkEnableDialog
        isOpen
        onClose={() => {}}
        targets={targets}
        deps={{ transportFor: h.transportFor }}
        loadModels={h.loadModels}
      />
    );
    const text = document.body.textContent ?? "";
    for (const target of targets) expect(text).toContain(target.name);
    await act(async () => {});
    expect(document.body.textContent).toContain("Hidden there");
    expect(h.setMode).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("radio", { name: /Best/ }));

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Enable Canopy on all hosts" }));
    });
    expect(h.setMode.mock.calls.map(([id, mode]) => `${id}:${mode}`).sort()).toEqual([
      "local:on",
      "studio-1:on",
      "studio-1:unset",
    ]);
    const outcomes = [...document.querySelectorAll("[data-outcome]")].map((li) => [
      li.getAttribute("data-host-id"),
      li.getAttribute("data-outcome"),
    ]);
    expect(outcomes).toEqual([
      ["local", "enabled"],
      ["studio-1", "enabled"],
      ["studio-2", "inaccessible"],
    ]);
    expect(document.body.textContent).toContain("2 of 3 hosts on");

    h.setMode.mockClear();
    h.setModel.mockClear();
    h.bringUp();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry failed" }));
    });
    expect(h.setMode.mock.calls).toEqual([["studio-2", "on", 0]]);
    // The retried host takes the model that was chosen, not its own default.
    expect(h.setModel.mock.calls).toEqual([["studio-2", BEST]]);
    expect(screen.queryByRole("button", { name: "Retry failed" })).toBeNull();
    expect(h.released.filter((id) => id === "local")).toHaveLength(2);
  });

  it("holds the enable button until every host has been read", async () => {
    const h = setup(false);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = (target: BulkTarget) => {
      const transport = h.transportFor(target);
      return target.hostId === "studio-1"
        ? { ...transport, getSnapshot: () => gate.then(() => transport.getSnapshot()) }
        : transport;
    };
    render(
      <CanopyBulkEnableDialog
        isOpen
        onClose={() => {}}
        targets={targets}
        deps={{ transportFor: slow }}
        loadModels={h.loadModels}
      />
    );
    const enable = screen.getByRole("button", { name: "Enable Canopy on all hosts" });
    // The model list is in; one host is still being read.
    await act(async () => {});
    expect(screen.getByRole("radio", { name: /Light/ })).toBeTruthy();
    expect(enable.getAttribute("aria-disabled")).toBe("true");
    await act(async () => {
      release();
    });
    expect(enable.getAttribute("aria-disabled")).toBeNull();
    expect(document.body.textContent).toContain("Hidden there");
  });

  it("makes no change when closed without pressing the button", async () => {
    const h = setup(false);
    const onClose = vi.fn();
    render(
      <CanopyBulkEnableDialog
        isOpen
        onClose={onClose}
        targets={targets}
        deps={{ transportFor: h.transportFor }}
        loadModels={h.loadModels}
      />
    );
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalled();
    expect(h.setMode).not.toHaveBeenCalled();
    expect(h.setModel).not.toHaveBeenCalled();
  });

  it("asks for no model list while closed, and applies the chosen model to every host before turning it on", async () => {
    const h = setup(false);
    const props = {
      onClose: () => {},
      targets,
      deps: { transportFor: h.transportFor },
      loadModels: h.loadModels,
    };
    const view = render(<CanopyBulkEnableDialog isOpen={false} {...props} />);
    await act(async () => {});
    // A dialog nobody opened costs no request, here a model list.
    expect(h.loadModels).not.toHaveBeenCalled();
    view.rerender(<CanopyBulkEnableDialog isOpen {...props} />);
    await act(async () => {});
    expect(h.loadModels).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain("nothing downloads before you press");
    // Light is what each host would use; the person picks Best instead.
    expect((screen.getByRole("radio", { name: /Light/ }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole("radio", { name: /Best/ }));
    expect(h.setModel).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Enable Canopy on all hosts" }));
    });
    // Every host took the choice, each before its own first mode change.
    expect(h.setModel.mock.calls.map(([id]) => id).sort()).toEqual([
      "local",
      "studio-1",
      "studio-2",
    ]);
    expect(h.setModel.mock.calls.every((call) => call[1] === BEST)).toBe(true);
    for (const id of ["local", "studio-1", "studio-2"]) {
      const modelAt = h.setModel.mock.calls.findIndex((call) => call[0] === id);
      const modeAt = h.setMode.mock.calls.findIndex((call) => call[0] === id);
      expect(h.setModel.mock.invocationCallOrder[modelAt]!).toBeLessThan(
        h.setMode.mock.invocationCallOrder[modeAt]!
      );
    }
  });

  it("keeps Enable off until the model list is in", async () => {
    const h = setup(false);
    let release!: (value: CanopyModelCatalogue) => void;
    const slowList = vi.fn(() => new Promise<CanopyModelCatalogue>((r) => (release = r)));
    render(
      <CanopyBulkEnableDialog
        isOpen
        onClose={() => {}}
        targets={targets}
        deps={{ transportFor: h.transportFor }}
        loadModels={slowList}
      />
    );
    await act(async () => {});
    const enable = screen.getByRole("button", { name: "Enable Canopy on all hosts" });
    expect(enable.getAttribute("aria-disabled")).toBe("true");
    await act(async () => {
      release(catalogue);
    });
    expect(enable.getAttribute("aria-disabled")).toBeNull();
  });
});
