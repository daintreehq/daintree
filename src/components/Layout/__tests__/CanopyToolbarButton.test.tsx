// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, render } from "@testing-library/react";
import type { CanopyCard, CanopySnapshot } from "@shared/types/ipc/canopy";
import { CANOPY_ACKNOWLEDGED_STORAGE_KEY, useCanopyStore } from "@/store/canopyStore";
import { useFleetSnapshotStore } from "@/store/fleetSnapshotStore";
import { TooltipProvider } from "@/components/ui/tooltip";
import { CanopyToolbarButton } from "../CanopyToolbarButton";

function card(runId: string, priority: number, extra: Partial<CanopyCard> = {}): CanopyCard {
  return { runId, spawnedAt: 1, revision: 1, priority, handledAt: null, ...extra } as CanopyCard;
}

function snapshot(activated: boolean, extra: Partial<CanopySnapshot> = {}): CanopySnapshot {
  return {
    mode: activated ? "on" : "unset",
    activated,
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
    ...extra,
  };
}

let main: CanopySnapshot = snapshot(true);

beforeEach(() => {
  useFleetSnapshotStore.setState({
    snapshot: {
      runs: [
        {
          runId: "r1",
          workspaceId: "p1",
          spawnedAt: 1,
          cwd: "/repo",
          agentState: "waiting",
          waitingReason: "approval",
        },
        { runId: "r2", workspaceId: "p1", spawnedAt: 1, cwd: "/repo" },
      ],
      changedAt: 1,
      degraded: false,
      lastSuccessfulAt: 1,
    },
  });
});

afterEach(() => {
  useCanopyStore.setState({ isOpen: false, snapshot: null, acknowledged: {} });
  window.localStorage.clear();
  useFleetSnapshotStore.setState({ snapshot: null });
});

/** The button reads what the app-level sync (useCanopySnapshotSync) put in the store. */
function renderButton() {
  useCanopyStore.getState().applySnapshot(main);
  return render(
    <TooltipProvider>
      <CanopyToolbarButton />
    </TooltipProvider>
  );
}

async function pip() {
  const view = renderButton();
  await act(async () => {});
  const button = view.container.querySelector("button")!;
  const badge = button.querySelector(".toolbar-count")!;
  return {
    label: button.getAttribute("aria-label"),
    visible: badge.getAttribute("data-visible"),
    glyph: badge.textContent,
  };
}

describe("CanopyToolbarButton", () => {
  it("lights for an agent Canopy reads as blocked on the user", async () => {
    main = snapshot(true, { cards: [card("r1", 92), card("r2", 50)] });
    expect(await pip()).toEqual({ label: "Canopy, 1 urgent", visible: "true", glyph: "1" });
  });

  it("counts every urgent run, capping the glyph at 9+ but not the spoken count", async () => {
    const ids = Array.from({ length: 12 }, (_, i) => `u${i}`);
    useFleetSnapshotStore.setState({
      snapshot: {
        runs: ids.map((runId) => ({ runId, workspaceId: "p1", spawnedAt: 1, cwd: "/repo" })),
        changedAt: 1,
        degraded: false,
        lastSuccessfulAt: 1,
      },
    });
    main = snapshot(true, { cards: ids.slice(0, 3).map((id) => card(id, 92)) });
    expect(await pip()).toMatchObject({ label: "Canopy, 3 urgent", glyph: "3" });
    main = snapshot(true, { cards: ids.map((id) => card(id, 92)) });
    expect(await pip()).toMatchObject({ label: "Canopy, 12 urgent", glyph: "9+" });
  });

  it("follows the count on one mounted badge, and keeps the last one while it fades out", async () => {
    const ids = Array.from({ length: 10 }, (_, i) => `u${i}`);
    useFleetSnapshotStore.setState({
      snapshot: {
        runs: ids.map((runId) => ({ runId, workspaceId: "p1", spawnedAt: 1, cwd: "/repo" })),
        changedAt: 1,
        degraded: false,
        lastSuccessfulAt: 1,
      },
    });
    main = snapshot(true, { cards: ids.slice(0, 3).map((id) => card(id, 92)) });
    const view = renderButton();
    await act(async () => {});
    const badge = view.container.querySelector(".toolbar-count")!;
    const read = () => [badge.getAttribute("data-visible"), badge.textContent];
    const urgent = (n: number) =>
      act(() => {
        useCanopyStore.setState({
          snapshot: snapshot(true, { cards: ids.slice(0, n).map((id) => card(id, 92)) }),
        });
      });

    expect(badge.getAttribute("aria-hidden")).toBe("true");
    expect(read()).toEqual(["true", "3"]);
    urgent(2);
    expect(read()).toEqual(["true", "2"]);
    urgent(9);
    expect(read()).toEqual(["true", "9"]);
    urgent(10);
    expect(read()).toEqual(["true", "9+"]);
    act(() => useCanopyStore.setState({ isOpen: true }));
    expect(read()).toEqual(["false", "9+"]);
    act(() => useCanopyStore.setState({ isOpen: false }));
    urgent(2);
    expect(read()).toEqual(["true", "2"]);
    urgent(0);
    expect(read()).toEqual(["false", "2"]);
  });

  it("clears once the panel is opened, and lights again only for a new prompt", async () => {
    main = snapshot(true, { cards: [card("r1", 92), card("r2", 92)] });
    const view = renderButton();
    await act(async () => {});
    const button = view.container.querySelector("button")!;
    const badge = button.querySelector(".toolbar-count")!;
    const read = () => [button.getAttribute("aria-label"), badge.getAttribute("data-visible")];
    const apply = (cards: CanopyCard[]) =>
      act(() => useCanopyStore.getState().applySnapshot(snapshot(true, { cards })));

    expect(read()).toEqual(["Canopy, 2 urgent", "true"]);
    // The panel lists both runs, so both prompts count as seen.
    act(() => useCanopyStore.getState().open());
    act(() => useCanopyStore.getState().acknowledge(["r1", "r2"]));
    act(() => useCanopyStore.getState().close());
    expect(read()).toEqual(["Canopy", "false"]);

    // The same prompt re-read stays quiet; a new one on r1 lights it.
    apply([card("r1", 92), card("r2", 92)]);
    expect(read()).toEqual(["Canopy", "false"]);
    apply([card("r1", 92, { revision: 2 }), card("r2", 92)]);
    expect(read()).toEqual(["Canopy, 1 urgent", "true"]);

    // A prompt that arrives while the panel is open was shown there.
    act(() => useCanopyStore.getState().toggle());
    apply([card("r1", 92, { revision: 2 }), card("r2", 92, { revision: 3 })]);
    act(() => useCanopyStore.getState().acknowledge(["r1", "r2"]));
    act(() => useCanopyStore.getState().toggle());
    expect(read()).toEqual(["Canopy", "false"]);
  });

  it("does not swallow a prompt that turns urgent after the panel showed it calm", async () => {
    main = snapshot(true, { cards: [card("r1", 60)] });
    await pip();
    act(() => useCanopyStore.getState().open());
    act(() => useCanopyStore.getState().close());
    main = snapshot(true, { cards: [card("r1", 92)] });
    expect(await pip()).toMatchObject({ label: "Canopy, 1 urgent", visible: "true" });
  });

  it("keeps the asks of runs a scoped panel doesn't list", async () => {
    main = snapshot(true, { cards: [card("r1", 92), card("r2", 92)] });
    const view = renderButton();
    await act(async () => {});
    const button = view.container.querySelector("button")!;
    // A panel scoped to one project lists r1 alone: r2's ask stays on the badge.
    act(() => useCanopyStore.getState().open());
    act(() => useCanopyStore.getState().acknowledge(["r1"]));
    act(() => useCanopyStore.getState().close());
    expect(button.getAttribute("aria-label")).toBe("Canopy, 1 urgent");
  });

  it("clears when a sibling project view opened the panel", async () => {
    main = snapshot(true, { cards: [card("r1", 92)] });
    const view = renderButton();
    await act(async () => {});
    const badge = view.container.querySelector(".toolbar-count")!;
    expect(badge.getAttribute("data-visible")).toBe("true");
    act(() => {
      window.localStorage.setItem(CANOPY_ACKNOWLEDGED_STORAGE_KEY, JSON.stringify({ r1: "1:1" }));
      window.dispatchEvent(new StorageEvent("storage", { key: CANOPY_ACKNOWLEDGED_STORAGE_KEY }));
    });
    expect(badge.getAttribute("data-visible")).toBe("false");
  });

  it("stays dark for an agent Daintree sees waiting that Canopy does not rank urgent", async () => {
    main = snapshot(true, { cards: [card("r1", 55)] });
    expect(await pip()).toMatchObject({ label: "Canopy", visible: "false" });
  });

  it("stays dark for an urgent run the user answered or archived", async () => {
    main = snapshot(true, {
      cards: [card("r1", 92, { handledAt: 5 }), card("r2", 92)],
      dispositions: [{ runId: "r2", spawnedAt: 1, kind: "archived", at: 5 }],
    });
    expect(await pip()).toMatchObject({ label: "Canopy", visible: "false" });
  });

  it("stays dark for an urgent run that is snoozed, parked or gone from the fleet", async () => {
    useFleetSnapshotStore.setState({
      snapshot: {
        runs: [
          { runId: "r1", workspaceId: "p1", spawnedAt: 1, cwd: "/repo", snooze: {} as never },
          { runId: "r2", workspaceId: "p1", spawnedAt: 1, cwd: "/repo", park: {} as never },
          { runId: "r3", workspaceId: "p1", spawnedAt: 2, cwd: "/repo" },
        ],
        changedAt: 1,
        degraded: false,
        lastSuccessfulAt: 1,
      },
    });
    main = snapshot(true, { cards: [card("r1", 92), card("r2", 92), card("r3", 92)] });
    expect(await pip()).toMatchObject({ label: "Canopy", visible: "false" });
  });

  it("flags nothing until Canopy is turned on: the button opens the offer, not the inbox", async () => {
    main = snapshot(false, { cards: [card("r1", 92)] });
    expect(await pip()).toMatchObject({ label: "Canopy", visible: "false" });
  });
});
