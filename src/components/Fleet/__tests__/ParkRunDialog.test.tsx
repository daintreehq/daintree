// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FleetRunRow, FleetSnapshot } from "@shared/types/ipc/fleet";
import { useFleetSnapshotStore } from "@/store/fleetSnapshotStore";
import { ParkRunDialog } from "../ParkRunDialog";

vi.mock("@/store", () => ({
  usePortalStore: () => ({ isOpen: false, width: 0 }),
}));

vi.mock("@/hooks", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, useOverlayState: () => {} };
});

vi.mock("@/hooks/useAnimatedPresence", () => ({
  useAnimatedPresence: ({ isOpen }: { isOpen: boolean }) => ({
    isVisible: isOpen,
    shouldRender: isOpen,
  }),
}));

vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
);

const parkRun = vi.fn();
const unparkRun = vi.fn();

function run(runId: string, extra: Partial<FleetRunRow> = {}): FleetRunRow {
  return {
    runId,
    workspaceId: "ws-1",
    agentId: "claude",
    agentState: "waiting",
    spawnedAt: 1,
    title: `Task ${runId}`,
    titleMode: "user",
    cwd: `/repo/${runId}`,
    ...extra,
  } as FleetRunRow;
}

function setRuns(runs: FleetRunRow[]) {
  act(() => {
    useFleetSnapshotStore.setState({
      snapshot: {
        runs,
        changedAt: 1,
        degraded: false,
        lastSuccessfulAt: null,
      } satisfies FleetSnapshot,
    });
  });
}

function gateIds(): string[] {
  return Array.from(
    document.querySelectorAll<HTMLInputElement>('input[type="radio"][name="park-run-gate"]')
  ).map((input) => input.value);
}

beforeEach(() => {
  vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));
  parkRun.mockReset().mockResolvedValue({ parkedAt: 1 });
  unparkRun.mockReset().mockResolvedValue(true);
  Object.defineProperty(window, "electron", {
    value: { fleet: { parkRun, unparkRun } },
    writable: true,
    configurable: true,
  });
});

afterEach(() => {
  cleanup();
  useFleetSnapshotStore.setState({ snapshot: null });
});

describe("ParkRunDialog", () => {
  it("offers only runs in the target's own workspace as release gates", () => {
    setRuns([run("a"), run("b"), run("c", { workspaceId: "ws-2" })]);
    render(<ParkRunDialog runId="a" onClose={vi.fn()} />);

    expect(gateIds()).toEqual(["__none__", "b"]);
  });

  it("parks with the trimmed note and the chosen gate", async () => {
    setRuns([run("a"), run("b")]);
    const onClose = vi.fn();
    render(<ParkRunDialog runId="a" onClose={onClose} />);

    fireEvent.change(screen.getByTestId("park-run-note"), {
      target: { value: "  after the migration  " },
    });
    fireEvent.click(
      document.querySelector<HTMLInputElement>('input[name="park-run-gate"][value="b"]')!
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Park" }));
    });

    expect(parkRun).toHaveBeenCalledWith("a", { note: "after the migration", gateRunId: "b" });
    expect(onClose).toHaveBeenCalled();
  });

  it("parks manually with no note when the form is left as it opened", async () => {
    setRuns([run("a")]);
    render(<ParkRunDialog runId="a" onClose={vi.fn()} />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Park" }));
    });

    expect(parkRun).toHaveBeenCalledWith("a", {});
  });

  it("keeps the typed note and says why when the park is rejected", async () => {
    setRuns([run("a")]);
    parkRun.mockRejectedValueOnce(new Error("Too many parked runs"));
    const onClose = vi.fn();
    render(<ParkRunDialog runId="a" onClose={onClose} />);

    fireEvent.change(screen.getByTestId("park-run-note"), { target: { value: "later" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Park" }));
    });

    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain("Too many parked runs");
    expect((screen.getByTestId("park-run-note") as HTMLInputElement).value).toBe("later");
  });

  it("opens an existing park with its note and gate, and offers Unpark", async () => {
    setRuns([run("a", { park: { parkedAt: 1, note: "waiting on CI", gateRunId: "b" } }), run("b")]);
    const onClose = vi.fn();
    render(<ParkRunDialog runId="a" onClose={onClose} />);

    expect((screen.getByTestId("park-run-note") as HTMLInputElement).value).toBe("waiting on CI");
    expect(
      document.querySelector<HTMLInputElement>('input[name="park-run-gate"][value="b"]')!.checked
    ).toBe(true);
    expect(screen.getByRole("button", { name: "Update park" })).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Unpark" }));
    });
    expect(unparkRun).toHaveBeenCalledWith("a");
    expect(onClose).toHaveBeenCalled();
  });

  it("offers no Unpark for a run that isn't parked", () => {
    setRuns([run("a")]);
    render(<ParkRunDialog runId="a" onClose={vi.fn()} />);

    expect(screen.queryByRole("button", { name: "Unpark" })).toBeNull();
  });

  it("falls back to a manual park, and says so, when the chosen gate's run closes", async () => {
    setRuns([run("a"), run("b")]);
    render(<ParkRunDialog runId="a" onClose={vi.fn()} />);
    fireEvent.click(
      document.querySelector<HTMLInputElement>('input[name="park-run-gate"][value="b"]')!
    );

    setRuns([run("a")]);
    expect(screen.getByTestId("park-run-gate-lost")).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Park" }));
    });
    expect(parkRun).toHaveBeenCalledWith("a", {});
  });

  it("closes when its run leaves the fleet", () => {
    setRuns([run("a")]);
    const onClose = vi.fn();
    render(<ParkRunDialog runId="a" onClose={onClose} />);

    setRuns([]);
    expect(onClose).toHaveBeenCalled();
  });
});
