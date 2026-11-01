// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act, render } from "@testing-library/react";
import type { CanopyCard, CanopySnapshot } from "@shared/types/ipc/canopy";
import type { FleetRunRow } from "@shared/types/ipc/fleet";
import { useCanopyStore } from "@/store/canopyStore";
import { useFleetSnapshotStore } from "@/store/fleetSnapshotStore";
import { TooltipProvider } from "@/components/ui/tooltip";
import { CanopyToolbarButton } from "../CanopyToolbarButton";

function snapshot(activated: boolean, cards: CanopyCard[] = []): CanopySnapshot {
  return {
    mode: activated ? "on" : "unset",
    activated,
    dispositions: [],
    seen: [],
    reads: [],
    scope: null,
    active: false,
    busy: false,
    refreshedAt: null,
    cards,
    lastError: null,
    failedRuns: [],
    glances: [],
  };
}

function run(runId: string, extra: Partial<FleetRunRow> = {}): FleetRunRow {
  return { runId, workspaceId: "p1", spawnedAt: 1, cwd: "/repo", ...extra };
}

/** A run stopped on a question Canopy read as asking the user, seen or not by its read mark. */
function asking(runId: string, seen = false, extra: Partial<FleetRunRow> = {}): FleetRunRow {
  return run(runId, {
    agentState: "waiting",
    waitingReason: "question",
    canopy: { kind: "asked", quote: "Apply the migration?", readAt: 1, seen },
    ...extra,
  });
}

function setFleet(runs: FleetRunRow[], degraded = false) {
  useFleetSnapshotStore.setState({
    snapshot: { runs, changedAt: 1, degraded, lastSuccessfulAt: 1 },
  });
}

afterEach(() => {
  useCanopyStore.setState({ isOpen: false, snapshot: null });
  useFleetSnapshotStore.setState({ snapshot: null });
});

/** The button reads what the app-level syncs put in the stores. */
function renderButton(activated = true, cards: CanopyCard[] = []) {
  useCanopyStore.getState().applySnapshot(snapshot(activated, cards));
  return render(
    <TooltipProvider>
      <CanopyToolbarButton />
    </TooltipProvider>
  );
}

async function pip(activated = true, cards: CanopyCard[] = []) {
  const view = renderButton(activated, cards);
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
  it("lights for a run Canopy read asking the user, at any stop it may ask at", async () => {
    setFleet([
      asking("r1"),
      asking("r2", false, { agentState: "completed", waitingReason: undefined }),
      run("r3", { agentState: "working" }),
    ]);
    expect(await pip()).toEqual({ label: "Canopy — 2 urgent", visible: "true", glyph: "2" });
  });

  it("counts every unread ask, capping the glyph at 9+ but not the spoken count", async () => {
    const ids = Array.from({ length: 12 }, (_, i) => `u${i}`);
    setFleet(ids.slice(0, 3).map((id) => asking(id)));
    expect(await pip()).toMatchObject({ label: "Canopy — 3 urgent", glyph: "3" });
    setFleet(ids.map((id) => asking(id)));
    expect(await pip()).toMatchObject({ label: "Canopy — 12 urgent", glyph: "9+" });
  });

  it("follows the count on one mounted badge, and keeps the last one while it fades out", async () => {
    const ids = Array.from({ length: 10 }, (_, i) => `u${i}`);
    setFleet(ids.slice(0, 3).map((id) => asking(id)));
    const view = renderButton();
    await act(async () => {});
    const badge = view.container.querySelector(".toolbar-count")!;
    const read = () => [badge.getAttribute("data-visible"), badge.textContent];
    const unread = (n: number) => act(() => setFleet(ids.map((id, i) => asking(id, i >= n))));

    expect(badge.getAttribute("aria-hidden")).toBe("true");
    expect(read()).toEqual(["true", "3"]);
    unread(2);
    expect(read()).toEqual(["true", "2"]);
    unread(9);
    expect(read()).toEqual(["true", "9"]);
    unread(10);
    expect(read()).toEqual(["true", "9+"]);
    act(() => useCanopyStore.setState({ isOpen: true }));
    expect(read()).toEqual(["false", "9+"]);
    act(() => useCanopyStore.setState({ isOpen: false }));
    unread(2);
    expect(read()).toEqual(["true", "2"]);
    unread(0);
    expect(read()).toEqual(["false", "2"]);
  });

  it("clears once the ask is looked at, and lights again for a new ask from the same run", async () => {
    setFleet([asking("r1"), asking("r2")]);
    const view = renderButton();
    await act(async () => {});
    const button = view.container.querySelector("button")!;
    const badge = button.querySelector(".toolbar-count")!;
    const read = () => [button.getAttribute("aria-label"), badge.getAttribute("data-visible")];

    expect(read()).toEqual(["Canopy — 2 urgent", "true"]);
    // Main marks a turn read after a look of the read dwell, in the pane or in
    // Canopy's panel, and every view's fleet takes the same row: the panel
    // never has to have been open in this one.
    act(() => setFleet([asking("r1", true), asking("r2")]));
    expect(read()).toEqual(["Canopy — 1 urgent", "true"]);
    act(() => setFleet([asking("r1", true), asking("r2", true)]));
    expect(read()).toEqual(["Canopy", "false"]);

    // The next ask is a new turn, unread again.
    act(() =>
      setFleet([
        asking("r1", false, {
          canopy: { kind: "asked", quote: "Push it too?", readAt: 2, seen: false },
        }),
        asking("r2", true),
      ])
    );
    expect(read()).toEqual(["Canopy — 1 urgent", "true"]);
  });

  it("counts by the fleet's reading, whatever priority Canopy's cards rank the runs at", async () => {
    const card = (runId: string, priority: number) =>
      ({ runId, spawnedAt: 1, revision: 1, priority, handledAt: null }) as CanopyCard;
    setFleet([asking("r1"), run("r2", { agentState: "working" })]);
    expect(await pip(true, [card("r1", 60), card("r2", 95)])).toMatchObject({
      label: "Canopy — 1 urgent",
      glyph: "1",
    });
  });

  it("keeps counting the asks a degraded fleet retains, and drops them once seen", async () => {
    setFleet([asking("r1")], true);
    const view = renderButton();
    await act(async () => {});
    const button = view.container.querySelector("button")!;
    expect(button.getAttribute("aria-label")).toBe("Canopy — 1 urgent");
    act(() => setFleet([asking("r1", true)], true));
    expect(button.getAttribute("aria-label")).toBe("Canopy");
  });

  it("stays dark for a wait Canopy has no reading of, or read as asking nothing", async () => {
    setFleet([
      run("r1", { agentState: "waiting", waitingReason: "approval" }),
      run("r2", {
        agentState: "waiting",
        waitingReason: "question",
        canopy: { kind: "not-asking", quote: "Done.", readAt: 1, seen: false },
      }),
      run("r3", {
        agentState: "waiting",
        waitingReason: "question",
        wait: { stoppedAt: 1 },
      }),
    ]);
    expect(await pip()).toMatchObject({ label: "Canopy", visible: "false" });
  });

  it("stays dark for an ask read on a turn the run has since moved past", async () => {
    // A held verdict applies only to a stop that may ask: back at work, it doesn't.
    setFleet([asking("r1", false, { agentState: "working", waitingReason: undefined })]);
    expect(await pip()).toMatchObject({ label: "Canopy", visible: "false" });
  });

  it("stays dark for an asking run that is parked or snoozed", async () => {
    setFleet([asking("r1", false, { snooze: {} as never }), asking("r2", false, { park: {} as never })]);
    expect(await pip()).toMatchObject({ label: "Canopy", visible: "false" });
  });

  it("stays dark before the fleet is known", async () => {
    expect(await pip()).toMatchObject({ label: "Canopy", visible: "false" });
  });

  it("flags nothing until Canopy is turned on: the button opens the offer, not the inbox", async () => {
    setFleet([asking("r1")]);
    expect(await pip(false)).toMatchObject({ label: "Canopy", visible: "false" });
  });
});
