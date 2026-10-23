// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { CanopyMode, CanopySnapshot } from "@shared/types/ipc/canopy";

vi.mock("react-dom", async () => {
  const actual = await vi.importActual<typeof import("react-dom")>("react-dom");
  return { ...actual, createPortal: (children: React.ReactNode) => children };
});
vi.mock("@/clients/systemClient", () => ({ systemClient: { openExternal: vi.fn() } }));

import { CanopyBulkEnableDialog } from "../CanopyBulkEnableDialog";
import type { BulkTarget, BulkTransport } from "../bulkEnable";

const snap = (mode: CanopyMode, rev = 0): CanopySnapshot => ({
  mode,
  modeRevision: rev,
  hostEpoch: "e",
  activated: mode === "on",
  tier: "free",
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
  let studio2Up = !failStudio2;
  const released: string[] = [];
  const transportFor = (target: BulkTarget): BulkTransport => ({
    getSnapshot: async () => {
      if (target.hostId === "studio-2" && !studio2Up) throw new Error("offline");
      return modes[target.hostId]!;
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
      />
    );
    const text = document.body.textContent ?? "";
    for (const target of targets) expect(text).toContain(target.name);
    await act(async () => {});
    expect(document.body.textContent).toContain("Hidden there");
    expect(h.setMode).not.toHaveBeenCalled();

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
    h.bringUp();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry failed" }));
    });
    expect(h.setMode.mock.calls).toEqual([["studio-2", "on", 0]]);
    expect(screen.queryByRole("button", { name: "Retry failed" })).toBeNull();
    expect(h.released.filter((id) => id === "local").length).toBeGreaterThanOrEqual(2);
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
      />
    );
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalled();
    expect(h.setMode).not.toHaveBeenCalled();
  });
});
