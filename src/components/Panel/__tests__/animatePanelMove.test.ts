// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type {
  TransitionRect,
  TransitionTarget,
  triggerPanelTransition,
} from "../PanelTransitionOverlay";

const trigger = vi.hoisted(() => vi.fn<typeof triggerPanelTransition>());
const state = vi.hoisted(() => ({
  current: {
    panelsById: {} as Record<string, { id: string; title: string; location: string }>,
    groups: {} as Record<string, { panelIds: string[] }>,
  },
}));

vi.mock("../PanelTransitionOverlay", () => ({ triggerPanelTransition: trigger }));
vi.mock("@/store/storeAccessors", () => ({
  getPanelStoreSnapshot: () => ({
    panelsById: state.current.panelsById,
    panelIds: Object.keys(state.current.panelsById),
    tabGroups: new Map(Object.entries(state.current.groups)),
  }),
}));

import { animatePanelMove } from "../animatePanelMove";

function place(id: string, location: string) {
  state.current.panelsById[id] = { id, title: id.toUpperCase(), location };
}

function mount(selectorAttrs: Record<string, string>, rect: TransitionRect): HTMLElement {
  const el = document.createElement("div");
  for (const [k, v] of Object.entries(selectorAttrs)) el.setAttribute(k, v);
  Object.defineProperty(el, "getBoundingClientRect", { value: () => ({ ...rect }) });
  document.body.appendChild(el);
  return el;
}

function resolve(target: TransitionTarget | undefined): TransitionRect | null {
  if (target === undefined) return null;
  return typeof target === "function" ? target() : target;
}

const paneBox = { x: 10, y: 10, width: 500, height: 300 };
const chipBox = { x: 200, y: 640, width: 120, height: 26 };

describe("animatePanelMove", () => {
  beforeEach(() => {
    trigger.mockReset();
    state.current = { panelsById: {}, groups: {} };
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));
    document.body.removeAttribute("data-reduce-animations");
    document.body.innerHTML = "";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("flies from the pane it was to the chip it became, once the store has it in the dock", () => {
    place("p1", "grid");
    mount({ "data-panel-id": "p1", "data-panel-location": "grid" }, paneBox);
    const move = vi.fn(() => {
      place("p1", "dock");
    });

    animatePanelMove("p1", "minimize", move);

    expect(move).toHaveBeenCalledTimes(1);
    expect(trigger).toHaveBeenCalledTimes(1);
    const [id, direction, source, target, title] = trigger.mock.calls[0]!;
    expect([id, direction, source, title]).toEqual(["p1", "minimize", paneBox, "P1"]);
    expect(resolve(target)).toBeNull();
    mount({ "data-dock-item-id": "p1" }, chipBox);
    expect(resolve(target)).toEqual(chipBox);
  });

  it("never aims at a chip for a move the store refused", () => {
    place("p1", "grid");
    mount({ "data-panel-id": "p1", "data-panel-location": "grid" }, paneBox);
    mount({ "data-dock-item-id": "p1" }, chipBox);

    animatePanelMove("p1", "minimize", () => {});

    expect(resolve(trigger.mock.calls[0]?.[3])).toBeNull();
  });

  it("takes a move that reports failure at its word", () => {
    place("p1", "dock");
    mount({ "data-dock-item-id": "p1" }, chipBox);
    const move = vi.fn(() => false);

    animatePanelMove("p1", "restore", move);

    expect(move).toHaveBeenCalledTimes(1);
    expect(trigger).not.toHaveBeenCalled();
  });

  it("still moves, without motion, when nothing is on screen to fly from", () => {
    place("p1", "grid");
    const move = vi.fn(() => place("p1", "dock"));

    animatePanelMove("p1", "minimize", move);

    expect(move).toHaveBeenCalledTimes(1);
    expect(trigger).not.toHaveBeenCalled();
  });

  it("still moves, without motion, under reduced motion", () => {
    document.body.setAttribute("data-reduce-animations", "true");
    place("p1", "grid");
    mount({ "data-panel-id": "p1", "data-panel-location": "grid" }, paneBox);
    const move = vi.fn(() => place("p1", "dock"));

    animatePanelMove("p1", "minimize", move);

    expect(move).toHaveBeenCalledTimes(1);
    expect(trigger).not.toHaveBeenCalled();
  });

  it("does not fly a pane that was not where the direction starts", () => {
    place("p1", "dock");
    mount({ "data-panel-id": "p1", "data-panel-location": "grid" }, paneBox);
    const move = vi.fn();

    animatePanelMove("p1", "minimize", move);

    expect(move).toHaveBeenCalledTimes(1);
    expect(trigger).not.toHaveBeenCalled();
  });

  it("finds a tab group by whichever member stands for it on each side", () => {
    place("a", "grid");
    place("b", "grid");
    state.current.groups.g = { panelIds: ["b", "a"] };
    // The grid shows the group through its active tab `a`; the dock chip is keyed
    // by the group's first member `b`.
    mount({ "data-panel-id": "a", "data-panel-location": "grid" }, paneBox);

    animatePanelMove("a", "minimize", () => {
      place("a", "dock");
      place("b", "dock");
    });
    mount({ "data-dock-item-id": "b" }, chipBox);

    const [, , source, target] = trigger.mock.calls[0]!;
    expect(source).toEqual(paneBox);
    expect(resolve(target)).toEqual(chipBox);
  });
});
