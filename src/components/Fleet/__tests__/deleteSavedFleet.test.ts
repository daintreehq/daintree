// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FleetSavedScope, ProjectSettings } from "@shared/types";

const saveSettings = vi.fn();
const getSettings = vi.fn();
vi.mock("@/clients", () => ({
  projectClient: {
    saveSettings: (...args: unknown[]) => saveSettings(...args),
    getSettings: (...args: unknown[]) => getSettings(...args),
  },
}));

const dispatch = vi.fn();
vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: (...args: unknown[]) => dispatch(...args) },
}));

const mockNotify = vi.fn();
vi.mock("@/lib/notify", () => ({ notify: (...args: unknown[]) => mockNotify(...args) }));

const { useProjectStore } = await import("@/store/projectStore");
const { useProjectSettingsStore } = await import("@/store/projectSettingsStore");
const { deleteSavedFleetWithUndo, restoreSavedFleet } = await import("../deleteSavedFleet");
const { positionOf } = await import("@/lib/undoToast");

const scope = (id: string, name: string): FleetSavedScope => ({
  kind: "snapshot",
  id,
  name,
  terminalIds: [],
  createdAt: 1,
});
const A = scope("a", "Alpha");
const B = scope("b", "Beta");
const C = scope("c", "Gamma");

function seed(scopes: FleetSavedScope[]) {
  useProjectStore.setState({ currentProject: { id: "p1" } } as never);
  useProjectSettingsStore.setState({
    projectId: "p1",
    settings: { fleetSavedScopes: scopes } as ProjectSettings,
  });
}

const scopes = () => useProjectSettingsStore.getState().settings?.fleetSavedScopes ?? [];

beforeEach(() => {
  saveSettings.mockReset().mockResolvedValue(undefined);
  getSettings.mockReset();
  mockNotify.mockReset();
  dispatch.mockReset().mockImplementation(async (_id: string, args: { id: string }) => {
    useProjectSettingsStore.setState((s) => ({
      settings: {
        ...s.settings!,
        fleetSavedScopes: (s.settings!.fleetSavedScopes ?? []).filter((f) => f.id !== args.id),
      },
    }));
    return { ok: true };
  });
});

describe("deleteSavedFleetWithUndo", () => {
  it("deletes through the action and offers an Undo that restores the fleet in place", async () => {
    seed([A, B, C]);
    await deleteSavedFleetWithUndo(B);

    expect(dispatch).toHaveBeenCalledWith(
      "fleet.deleteNamedFleet",
      { id: "b" },
      { source: "user" }
    );
    expect(scopes().map((s) => s.id)).toEqual(["a", "c"]);
    const payload = mockNotify.mock.calls[0]![0] as {
      action: { label: string; onClick: () => Promise<void> };
    };
    expect(payload.action.label).toBe("Undo");

    await payload.action.onClick();
    expect(scopes()).toEqual([A, B, C]);
    expect(saveSettings).toHaveBeenCalledWith("p1", { fleetSavedScopes: [A, B, C] });
  });

  it("offers no Undo when the fleet is still there afterwards", async () => {
    seed([A, B]);
    dispatch.mockResolvedValue({ ok: true });
    await deleteSavedFleetWithUndo(B);
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it("offers no Undo when the action fails", async () => {
    seed([A, B]);
    dispatch.mockResolvedValue({ ok: false, error: { message: "nope" } });
    await deleteSavedFleetWithUndo(B);
    expect(mockNotify).not.toHaveBeenCalled();
  });
});

describe("restoreSavedFleet", () => {
  it("does not duplicate a fleet that is already back", async () => {
    seed([A, B]);
    await restoreSavedFleet("p1", B, positionOf([A, B], "b"));
    expect(scopes()).toEqual([A, B]);
    expect(saveSettings).not.toHaveBeenCalled();
  });

  it("restores the original order whichever of two deletions is undone first", async () => {
    for (const order of [
      ["a", "b"],
      ["b", "a"],
    ]) {
      seed([A, B, C]);
      const toasts: Array<() => Promise<void>> = [];
      mockNotify.mockImplementation((p: { action: { onClick: () => Promise<void> } }) =>
        toasts.push(p.action.onClick)
      );
      await deleteSavedFleetWithUndo(A);
      await deleteSavedFleetWithUndo(B);
      const undo = { a: toasts[0]!, b: toasts[1]! } as Record<string, () => Promise<void>>;
      for (const id of order) await undo[id]!();
      expect(scopes().map((s) => s.id)).toEqual(["a", "b", "c"]);
    }
  });

  it("takes back only its own insertion when the save fails, and offers a Retry", async () => {
    seed([A]);
    let rejectSave: (error: Error) => void = () => {};
    saveSettings.mockImplementationOnce(() => new Promise((_, reject) => (rejectSave = reject)));
    const restoring = restoreSavedFleet("p1", B, { prevId: "a", nextId: null, index: 1 });
    // Another fleet is saved while this write is still in flight.
    useProjectSettingsStore.setState((s) => ({
      settings: { ...s.settings!, fleetSavedScopes: [...scopes(), C] },
    }));
    rejectSave(new Error("disk full"));
    await restoring;

    expect(scopes()).toEqual([A, C]);
    const error = mockNotify.mock.calls.at(-1)![0] as {
      type: string;
      action: { label: string; onClick: () => Promise<void> };
    };
    expect(error.type).toBe("error");
    expect(error.action.label).toBe("Retry");
    await error.action.onClick();
    expect(scopes().map((s) => s.id)).toEqual(["a", "b", "c"]);
  });
});
