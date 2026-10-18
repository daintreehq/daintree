import { describe, expect, it, vi } from "vitest";
import type { HelpAdoptResult } from "../../../../shared/types/ipc/help.js";
import type { ClientEndpoint } from "../../endpoint.js";
import { adoptForReturningViews, installDetachedAdoption } from "../helpDetachedAdoption.js";

function endpoint(endpointId: string, projectId: string | null, handle: number) {
  let closed = false;
  const view = {
    endpointId,
    projectId,
    handle,
    kind: handle < 0 ? "remote-view" : "local-view",
    isClosed: () => closed,
    close: () => {
      closed = true;
    },
  };
  return view as unknown as ClientEndpoint & { close(): void; projectId: string | null };
}

const adopted = (sessionId: string): HelpAdoptResult => ({
  status: "adopted",
  lane: {
    sessionId,
    terminalId: `t-${sessionId}`,
    agentId: "codex",
    cwd: null,
    title: null,
    agentState: null,
    waitingReason: null,
    lastStateChange: null,
    cols: null,
    rows: null,
  },
});

function harness(options: {
  views: ReturnType<typeof endpoint>[];
  drivers: Record<string, string>;
}) {
  const detached = new Map<string, number[]>([["proj", [0, 1]]]);
  const deps = {
    detachedProjects: () => [...detached].filter(([, slots]) => slots.length > 0).map(([id]) => id),
    // As the registry answers it: open views of the project only.
    endpointsFor: (projectId: string) =>
      options.views.filter((view) => view.projectId === projectId && !view.isClosed()),
    drivingEndpointId: (projectId: string) => options.drivers[projectId] ?? null,
    detachedSlots: (projectId: string) => detached.get(projectId) ?? [],
    adopt: vi.fn(async (_projectId: string, slot: number, _endpoint: ClientEndpoint) =>
      adopted(`s${slot}`)
    ),
    release: vi.fn(async () => {}),
    adopted: vi.fn(),
  };
  return { deps, detached };
}

describe("adoptForReturningViews (#13389)", () => {
  it("hands every detached lane of a project to the view that drives it", async () => {
    const driver = endpoint("e-drive", "proj", -2);
    const { deps } = harness({ views: [driver], drivers: { proj: "e-drive" } });
    await adoptForReturningViews(deps);
    expect(deps.adopt.mock.calls.map(([projectId, slot, view]) => [projectId, slot, view])).toEqual(
      [
        ["proj", 0, driver],
        ["proj", 1, driver],
      ]
    );
    expect(deps.adopted).toHaveBeenCalledTimes(2);
  });

  it("hands them to one of this machine's own windows that drives the project (#13511)", async () => {
    const remote = endpoint("e-remote", "proj", -2);
    const local = endpoint("e-local", "proj", 42);
    const { deps } = harness({ views: [remote, local], drivers: { proj: "e-local" } });
    await adoptForReturningViews(deps);
    expect(deps.adopt.mock.calls.map(([, slot, view]) => [slot, view])).toEqual([
      [0, local],
      [1, local],
    ]);
  });

  it("never hands one to a watching view, a closed one or a view of another project", async () => {
    const watcher = endpoint("e-watch", "proj", -2);
    const closed = endpoint("e-closed", "proj", -3);
    closed.close();
    const other = endpoint("e-other", "other", -4);
    const { deps } = harness({
      views: [watcher, closed, other],
      drivers: { proj: "e-closed", other: "e-other" },
    });
    await adoptForReturningViews(deps);
    expect(deps.adopt).not.toHaveBeenCalled();
  });

  it("stops at the first lane once its view moves mid-take-over, leaving the rest detached", async () => {
    const view = endpoint("e-drive", "proj", -2);
    const { deps } = harness({ views: [view], drivers: { proj: "e-drive" } });
    deps.adopt.mockImplementationOnce(async () => {
      view.projectId = "other";
      return adopted("s0");
    });
    await adoptForReturningViews(deps);
    expect(deps.adopt).toHaveBeenCalledTimes(1);
    expect(deps.release).toHaveBeenCalledWith(view, "proj", adopted("s0"));
    expect(deps.adopted).not.toHaveBeenCalled();
  });

  it("re-checks the lease before each lane", async () => {
    const view = endpoint("e-drive", "proj", -2);
    const drivers: Record<string, string> = { proj: "e-drive" };
    const { deps } = harness({ views: [view], drivers });
    deps.adopt.mockImplementationOnce(async () => {
      drivers.proj = "e-someone-else";
      return adopted("s0");
    });
    await adoptForReturningViews(deps);
    expect(deps.adopt).toHaveBeenCalledTimes(1);
    expect(deps.adopted).toHaveBeenCalledTimes(1);
  });

  it("passes over a lane another view holds", async () => {
    const view = endpoint("e-drive", "proj", -2);
    const { deps } = harness({ views: [view], drivers: { proj: "e-drive" } });
    deps.adopt.mockResolvedValueOnce({ status: "occupied" });
    await adoptForReturningViews(deps);
    expect(deps.adopted).toHaveBeenCalledTimes(1);
    expect(deps.adopted.mock.calls[0]![2]).toBe(1);
  });
});

describe("installDetachedAdoption", () => {
  it("runs a pass on each change, queues one more for a change mid-pass, and stops when disposed", async () => {
    const view = endpoint("e-drive", "proj", -2);
    const { deps, detached } = harness({ views: [view], drivers: { proj: "e-drive" } });
    let fire: () => void = () => {};
    let release: () => void = () => {};
    deps.adopt.mockImplementationOnce(
      () =>
        new Promise<HelpAdoptResult>((resolve) => {
          release = () => resolve(adopted("s0"));
        })
    );
    const dispose = installDetachedAdoption({
      ...deps,
      onChange: (listener) => {
        fire = listener;
        return () => {
          fire = () => {};
        };
      },
      onFailure: vi.fn(),
    });
    detached.set("proj", [0]);
    fire();
    fire();
    release();
    await vi.waitFor(() => expect(deps.adopt).toHaveBeenCalledTimes(2));
    dispose();
    fire();
    await Promise.resolve();
    expect(deps.adopt).toHaveBeenCalledTimes(2);
  });

  it("reports a failed pass instead of throwing", async () => {
    const view = endpoint("e-drive", "proj", -2);
    const { deps } = harness({ views: [view], drivers: { proj: "e-drive" } });
    deps.adopt.mockRejectedValueOnce(new Error("probe exploded"));
    const onFailure = vi.fn();
    let fire: () => void = () => {};
    installDetachedAdoption({
      ...deps,
      onChange: (listener) => {
        fire = listener;
        return () => {};
      },
      onFailure,
    });
    fire();
    await vi.waitFor(() => expect(onFailure).toHaveBeenCalledTimes(1));
  });
});
