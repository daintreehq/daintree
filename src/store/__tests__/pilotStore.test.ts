import { beforeEach, describe, expect, it } from "vitest";
import { usePilotStore } from "../pilotStore";

const PROJECT = "a".repeat(64);
const OTHER = "b".repeat(64);

beforeEach(() => {
  usePilotStore.setState({ isOpen: false, scope: { kind: "fleet" }, fellBackFrom: null });
});

describe("pilotStore scope", () => {
  it("opens on the whole fleet", () => {
    usePilotStore.getState().open();

    expect(usePilotStore.getState().isOpen).toBe(true);
    expect(usePilotStore.getState().scope).toEqual({ kind: "fleet" });
  });

  it("opens straight into a project", () => {
    // The shortcut's whole job: `PilotView` is lazy-mounted on `isOpen`, so the
    // destination has to be recorded before the component that would show it
    // exists.
    usePilotStore.getState().openProject(PROJECT);

    expect(usePilotStore.getState().isOpen).toBe(true);
    expect(usePilotStore.getState().scope).toEqual({ kind: "project", workspaceId: PROJECT });
  });

  it("re-scopes an already-open overview without closing it", () => {
    usePilotStore.getState().open();
    usePilotStore.getState().openProject(PROJECT);
    usePilotStore.getState().openProject(OTHER);

    expect(usePilotStore.getState().isOpen).toBe(true);
    expect(usePilotStore.getState().scope).toEqual({ kind: "project", workspaceId: OTHER });
  });

  it("backs out to the fleet without closing", () => {
    usePilotStore.getState().openProject(PROJECT);
    usePilotStore.getState().showFleet();

    expect(usePilotStore.getState().isOpen).toBe(true);
    expect(usePilotStore.getState().scope).toEqual({ kind: "fleet" });
  });

  it("drops the scope on close", () => {
    // A project can be removed while the overview is shut. Reopening onto a
    // stale id would render a heading for a workspace that no longer exists.
    usePilotStore.getState().openProject(PROJECT);
    usePilotStore.getState().close();

    expect(usePilotStore.getState().scope).toEqual({ kind: "fleet" });
  });

  it("drops the scope when a toggle closes it", () => {
    usePilotStore.getState().openProject(PROJECT);
    usePilotStore.getState().toggle();

    expect(usePilotStore.getState().isOpen).toBe(false);
    expect(usePilotStore.getState().scope).toEqual({ kind: "fleet" });
  });

  it("reopens on the fleet after a scoped opening", () => {
    // `open` means the surface, not the last place the user was in it — a
    // reopening that hid most of the fleet would be narrowing the user never
    // asked for, with the reason two openings in the past.
    usePilotStore.getState().openProject(PROJECT);
    usePilotStore.getState().close();
    usePilotStore.getState().open();

    expect(usePilotStore.getState().scope).toEqual({ kind: "fleet" });
  });

  it("reopens on the fleet after a scoped opening was toggled shut", () => {
    usePilotStore.getState().openProject(PROJECT);
    usePilotStore.getState().toggle();
    usePilotStore.getState().toggle();

    expect(usePilotStore.getState().isOpen).toBe(true);
    expect(usePilotStore.getState().scope).toEqual({ kind: "fleet" });
  });
});

describe("pilotStore fallback context", () => {
  it("opens the fleet and records which project asked for a scope", () => {
    // The fleet it lands on is the same surface the unscoped chord gives, so
    // the workspace has to ride along or the two openings are indistinguishable.
    usePilotStore.getState().openFleetFallback(PROJECT);

    expect(usePilotStore.getState()).toMatchObject({
      isOpen: true,
      scope: { kind: "fleet" },
      fellBackFrom: PROJECT,
    });
  });

  it.each([
    ["open", (): void => usePilotStore.getState().open()],
    ["openProject", (): void => usePilotStore.getState().openProject(OTHER)],
    ["showFleet", (): void => usePilotStore.getState().showFleet()],
    ["close", (): void => usePilotStore.getState().close()],
    ["toggle", (): void => usePilotStore.getState().toggle()],
  ])("clears the explanation on %s", (_name, transition) => {
    // An explanation belongs to the opening that needed it. One surviving a
    // gesture would be describing something the user has already moved past.
    usePilotStore.getState().openFleetFallback(PROJECT);
    transition();

    expect(usePilotStore.getState().fellBackFrom).toBeNull();
  });

  it("does not carry the explanation into the next opening", () => {
    usePilotStore.getState().openFleetFallback(PROJECT);
    usePilotStore.getState().close();
    usePilotStore.getState().open();

    expect(usePilotStore.getState()).toMatchObject({ isOpen: true, fellBackFrom: null });
  });

  it("replaces rather than accumulates when a second project falls back", () => {
    usePilotStore.getState().openFleetFallback(PROJECT);
    usePilotStore.getState().openFleetFallback(OTHER);

    expect(usePilotStore.getState().fellBackFrom).toBe(OTHER);
  });
});
