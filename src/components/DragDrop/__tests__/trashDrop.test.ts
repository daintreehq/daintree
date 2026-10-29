import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/utils/logger", () => ({ logError: vi.fn() }));

const store = vi.hoisted(() => ({
  trashPanelGroup: vi.fn(),
  getPanelGroup: vi.fn(),
  panelsById: {} as Record<string, { location: string }>,
}));

const closing = vi.hoisted(() => new Set<string>());

vi.mock("@/services/terminal/optimisticPanelClose", () => ({
  isOptimisticallyClosing: (id: string) => closing.has(id),
}));

vi.mock("@/store", () => ({
  usePanelStore: {
    getState: () => ({
      trashPanelGroup: store.trashPanelGroup,
      getPanelGroup: store.getPanelGroup,
      panelsById: store.panelsById,
    }),
  },
}));

import {
  __resetPanelCloseGuardsForTests,
  registerPanelCloseGuard,
  type PanelCloseVerdict,
} from "@/services/panelCloseGuard";
import { trashDroppedPanel } from "../trashDrop";

function deferredGuard() {
  let answer!: (verdict: PanelCloseVerdict) => void;
  const guard = vi.fn(
    () =>
      new Promise<PanelCloseVerdict>((resolve) => {
        answer = resolve;
      })
  );
  return { guard, answer: (verdict: PanelCloseVerdict) => answer(verdict) };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("trashDroppedPanel (#14943)", () => {
  beforeEach(() => {
    __resetPanelCloseGuardsForTests();
    store.trashPanelGroup.mockReset();
    store.getPanelGroup.mockReset();
    closing.clear();
    store.panelsById = {
      p1: { location: "grid" },
      p2: { location: "grid" },
      p3: { location: "grid" },
    };
  });

  it("trashes an unguarded panel synchronously", () => {
    trashDroppedPanel("p1");

    expect(store.trashPanelGroup).toHaveBeenCalledWith("p1");
  });

  it("trashes a clean group synchronously while unrelated work is dirty", () => {
    store.getPanelGroup.mockReturnValue({ id: "g1", panelIds: ["p1", "p2"] });
    registerPanelCloseGuard(
      "p3",
      vi.fn(async (): Promise<PanelCloseVerdict> => "cancel")
    );

    trashDroppedPanel("p1");

    expect(store.trashPanelGroup).toHaveBeenCalledTimes(1);
    expect(store.trashPanelGroup).toHaveBeenCalledWith("p1");
  });

  it("asks a dirty panel's guard first and trashes only once it proceeds", async () => {
    const { guard, answer } = deferredGuard();
    registerPanelCloseGuard("p1", guard);

    trashDroppedPanel("p1");
    await flush();

    expect(guard).toHaveBeenCalledTimes(1);
    expect(store.trashPanelGroup).not.toHaveBeenCalled();

    answer("proceed");
    await flush();

    expect(store.trashPanelGroup).toHaveBeenCalledWith("p1");
  });

  it("leaves the panel where it was on cancel", async () => {
    registerPanelCloseGuard("p1", async () => "cancel");

    trashDroppedPanel("p1");
    await flush();

    expect(store.trashPanelGroup).not.toHaveBeenCalled();
  });

  it("keeps the panel when its guard throws", async () => {
    registerPanelCloseGuard("p1", async () => {
      throw new Error("prompt failed");
    });

    trashDroppedPanel("p1");
    await flush();

    expect(store.trashPanelGroup).not.toHaveBeenCalled();
  });

  it("asks each dirty group member in turn and keeps the whole group on a cancel", async () => {
    store.getPanelGroup.mockReturnValue({ id: "g1", panelIds: ["p1", "p2", "p3"] });
    const first = deferredGuard();
    const second = deferredGuard();
    registerPanelCloseGuard("p2", first.guard);
    registerPanelCloseGuard("p3", second.guard);

    // Dragging the clean tab still consults its dirty siblings.
    trashDroppedPanel("p1");
    await flush();

    expect(first.guard).toHaveBeenCalledTimes(1);
    expect(second.guard).not.toHaveBeenCalled();

    first.answer("proceed");
    await flush();

    expect(second.guard).toHaveBeenCalledTimes(1);
    expect(store.trashPanelGroup).not.toHaveBeenCalled();

    second.answer("cancel");
    await flush();

    expect(store.trashPanelGroup).not.toHaveBeenCalled();
  });

  it("stops asking after the first cancel", async () => {
    store.getPanelGroup.mockReturnValue({ id: "g1", panelIds: ["p1", "p2"] });
    const first = deferredGuard();
    const second = deferredGuard();
    registerPanelCloseGuard("p1", first.guard);
    registerPanelCloseGuard("p2", second.guard);

    trashDroppedPanel("p1");
    await flush();
    first.answer("cancel");
    await flush();

    expect(second.guard).not.toHaveBeenCalled();
    expect(store.trashPanelGroup).not.toHaveBeenCalled();
  });

  it("trashes the group once, after every dirty member proceeds", async () => {
    store.getPanelGroup.mockReturnValue({ id: "g1", panelIds: ["p1", "p2"] });
    const first = deferredGuard();
    const second = deferredGuard();
    registerPanelCloseGuard("p1", first.guard);
    registerPanelCloseGuard("p2", second.guard);

    trashDroppedPanel("p1");
    await flush();
    first.answer("proceed");
    await flush();

    expect(store.trashPanelGroup).not.toHaveBeenCalled();

    second.answer("proceed");
    await flush();

    expect(store.trashPanelGroup).toHaveBeenCalledTimes(1);
    expect(store.trashPanelGroup).toHaveBeenCalledWith("p1");
  });

  it("ignores a second drop while the prompt is still open", async () => {
    const { guard, answer } = deferredGuard();
    registerPanelCloseGuard("p1", guard);

    trashDroppedPanel("p1");
    await flush();
    trashDroppedPanel("p1");
    answer("proceed");
    await flush();

    expect(guard).toHaveBeenCalledTimes(1);
    expect(store.trashPanelGroup).toHaveBeenCalledTimes(1);
  });

  it("does nothing when the panel was trashed while the prompt was open", async () => {
    const { guard, answer } = deferredGuard();
    registerPanelCloseGuard("p1", guard);

    trashDroppedPanel("p1");
    await flush();
    store.panelsById = { ...store.panelsById, p1: { location: "trash" } };
    answer("proceed");
    await flush();

    expect(store.trashPanelGroup).not.toHaveBeenCalled();
  });

  it("does nothing when the panel was removed while the prompt was open", async () => {
    const { guard, answer } = deferredGuard();
    registerPanelCloseGuard("p1", guard);

    trashDroppedPanel("p1");
    await flush();
    const { p1: _removed, ...rest } = store.panelsById;
    store.panelsById = rest;
    answer("proceed");
    await flush();

    expect(store.trashPanelGroup).not.toHaveBeenCalled();
  });

  it("does nothing when a member was queued to close while the prompt was open", async () => {
    store.getPanelGroup.mockReturnValue({ id: "g1", panelIds: ["p1", "p2"] });
    const { guard, answer } = deferredGuard();
    registerPanelCloseGuard("p1", guard);

    trashDroppedPanel("p1");
    await flush();
    closing.add("p2");
    answer("proceed");
    await flush();

    expect(store.trashPanelGroup).not.toHaveBeenCalled();
  });

  it("ignores a drop on another member while a sibling's prompt is open", async () => {
    store.getPanelGroup.mockReturnValue({ id: "g1", panelIds: ["p1", "p2"] });
    const { guard, answer } = deferredGuard();
    registerPanelCloseGuard("p2", guard);

    trashDroppedPanel("p2");
    await flush();
    trashDroppedPanel("p1");
    answer("proceed");
    await flush();

    expect(guard).toHaveBeenCalledTimes(1);
    expect(store.trashPanelGroup).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["gained a member", ["p1", "p2", "p3"]],
    ["swapped a member", ["p1", "p3"]],
    ["lost a member", ["p1"]],
  ])("does nothing when the group %s while the prompt was open", async (_label, after) => {
    store.getPanelGroup.mockReturnValue({ id: "g1", panelIds: ["p1", "p2"] });
    const { guard, answer } = deferredGuard();
    registerPanelCloseGuard("p1", guard);

    trashDroppedPanel("p1");
    await flush();
    store.getPanelGroup.mockReturnValue(
      after.length > 1 ? { id: "g1", panelIds: after } : undefined
    );
    answer("proceed");
    await flush();

    expect(store.trashPanelGroup).not.toHaveBeenCalled();
  });
});
