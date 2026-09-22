import { describe, expect, it } from "vitest";
import {
  decideProjectOpenTarget,
  type OpenWorld,
  type OpenWorldWindow,
  type ProjectOpenRequest,
} from "../windowOpenPolicy.js";

function win(windowId: number, overrides: Partial<OpenWorldWindow> = {}): OpenWorldWindow {
  const activeProjectId = overrides.activeProjectId ?? null;
  return {
    windowId,
    activeProjectId,
    bridgeProjectId: null,
    viewProjectIds: activeProjectId ? [activeProjectId] : [],
    ready: true,
    reservations: [],
    ...overrides,
  };
}

function occupied(windowId: number, projectId = `p${windowId}`): OpenWorldWindow {
  return win(windowId, { activeProjectId: projectId, viewProjectIds: [projectId] });
}

function world(windows: OpenWorldWindow[], preference: OpenWorld["preference"] = "default") {
  return { preference, windows };
}

function external(overrides: Partial<ProjectOpenRequest> = {}): ProjectOpenRequest {
  return {
    projectId: "dropped",
    projectPath: "/work/dropped",
    source: "external",
    intent: "open",
    disposition: "default",
    initiatingWindowId: null,
    ...overrides,
  };
}

function inApp(
  initiatingWindowId: number,
  overrides: Partial<ProjectOpenRequest> = {}
): ProjectOpenRequest {
  return external({ source: "in-app", initiatingWindowId, ...overrides });
}

describe("decideProjectOpenTarget — external opens (#12593 acceptance)", () => {
  it("opens a sixth window when five occupied windows are open", () => {
    const five = [1, 2, 3, 4, 5].map((id) => occupied(id));
    expect(decideProjectOpenTarget(external(), world(five))).toEqual({ kind: "create" });
  });

  it("fills the one empty window instead of creating another", () => {
    expect(decideProjectOpenTarget(external(), world([occupied(1), win(2)]))).toEqual({
      kind: "activate",
      windowId: 2,
      reason: "empty",
    });
  });

  it("creates a window when there are none", () => {
    expect(decideProjectOpenTarget(external(), world([]))).toEqual({ kind: "create" });
  });

  it("never replaces the most recently focused window", () => {
    const decision = decideProjectOpenTarget(external(), world([occupied(7), occupied(3)]));
    expect(decision).toEqual({ kind: "create" });
  });

  it("picks the most recently focused of several empty windows", () => {
    expect(decideProjectOpenTarget(external(), world([occupied(1), win(4), win(2)]))).toEqual({
      kind: "activate",
      windowId: 4,
      reason: "empty",
    });
  });

  it("routes a folder that resolved to no project (not a repository) the same way", () => {
    const request = external({ projectId: null, projectPath: null });
    expect(decideProjectOpenTarget(request, world([occupied(1)]))).toEqual({ kind: "create" });
    expect(decideProjectOpenTarget(request, world([occupied(1), win(2)]))).toEqual({
      kind: "activate",
      windowId: 2,
      reason: "empty",
    });
  });
});

describe("decideProjectOpenTarget — what counts as empty", () => {
  it("treats a window showing a scratch as occupied", () => {
    const scratch = win(1, { activeProjectId: "scratch-1", viewProjectIds: ["scratch-1"] });
    expect(decideProjectOpenTarget(external(), world([scratch]))).toEqual({ kind: "create" });
  });

  it("never picks a window that is still booting", () => {
    expect(decideProjectOpenTarget(external(), world([win(1, { ready: false })]))).toEqual({
      kind: "create",
    });
  });

  it("never picks a window with an open in flight", () => {
    const claimed = win(1, { reservations: [{ projectId: null, projectPath: "/work/other" }] });
    expect(decideProjectOpenTarget(external(), world([claimed]))).toEqual({ kind: "create" });
  });

  it("never picks a window whose outgoing workspace is still painted behind a switch", () => {
    const bridging = win(1, { bridgeProjectId: "leaving" });
    expect(decideProjectOpenTarget(external(), world([bridging]))).toEqual({ kind: "create" });
  });

  it("still reuses a picker window that holds cached views", () => {
    const picker = win(1, { viewProjectIds: ["cached-elsewhere"] });
    expect(decideProjectOpenTarget(external(), world([picker]))).toEqual({
      kind: "activate",
      windowId: 1,
      reason: "empty",
    });
  });
});

describe("decideProjectOpenTarget — rule 1: an existing owner wins", () => {
  it("focuses the window already showing the project", () => {
    const decision = decideProjectOpenTarget(
      external(),
      world([occupied(1), occupied(2, "dropped"), win(3)])
    );
    expect(decision).toEqual({ kind: "focus", windowId: 2 });
  });

  it("activates the cached view in the window that owns it", () => {
    const owner = win(2, { activeProjectId: "p2", viewProjectIds: ["p2", "dropped"] });
    expect(decideProjectOpenTarget(external(), world([occupied(1), owner, win(3)]))).toEqual({
      kind: "activate",
      windowId: 2,
      reason: "owner",
    });
  });

  it("focuses a window whose open of the same folder is still in flight", () => {
    const claimed = win(2, { reservations: [{ projectId: null, projectPath: "/work/dropped" }] });
    expect(decideProjectOpenTarget(external(), world([occupied(1), claimed]))).toEqual({
      kind: "focus",
      windowId: 2,
    });
  });

  it("matches an in-flight open by project id when the path differs", () => {
    const claimed = win(2, { reservations: [{ projectId: "dropped", projectPath: "/elsewhere" }] });
    expect(decideProjectOpenTarget(external(), world([claimed]))).toEqual({
      kind: "focus",
      windowId: 2,
    });
  });

  it("beats an explicit new-window request", () => {
    const decision = decideProjectOpenTarget(
      inApp(1, { disposition: "new" }),
      world([occupied(1), occupied(2, "dropped"), win(3)])
    );
    expect(decision).toEqual({ kind: "focus", windowId: 2 });
  });

  it("beats the preference", () => {
    const decision = decideProjectOpenTarget(
      inApp(1),
      world([occupied(1), occupied(2, "dropped")], "on")
    );
    expect(decision).toEqual({ kind: "focus", windowId: 2 });
  });

  it("prefers the foreground owner over a cached duplicate", () => {
    const cached = win(1, { activeProjectId: "p1", viewProjectIds: ["p1", "dropped"] });
    expect(
      decideProjectOpenTarget(external(), world([cached, occupied(2, "dropped")]))
    ).toEqual({ kind: "focus", windowId: 2 });
  });

  it("prefers the asking window among duplicate foreground owners", () => {
    const decision = decideProjectOpenTarget(
      inApp(2),
      world([occupied(1, "dropped"), occupied(2, "dropped")])
    );
    expect(decision).toEqual({ kind: "focus", windowId: 2 });
  });
});

describe("decideProjectOpenTarget — rule 2: explicit disposition beats the preference", () => {
  it("new reuses an empty window before creating", () => {
    expect(
      decideProjectOpenTarget(inApp(1, { disposition: "new" }), world([occupied(1), win(2)], "off"))
    ).toEqual({ kind: "activate", windowId: 2, reason: "empty" });
    expect(
      decideProjectOpenTarget(inApp(1, { disposition: "new" }), world([occupied(1)], "off"))
    ).toEqual({ kind: "create" });
  });

  it("new from an empty window reuses that window", () => {
    expect(
      decideProjectOpenTarget(inApp(2, { disposition: "new" }), world([win(1), win(2)]))
    ).toEqual({ kind: "activate", windowId: 2, reason: "empty" });
  });

  it("current stays in the asking window even when the preference says new", () => {
    expect(
      decideProjectOpenTarget(
        inApp(1, { disposition: "current" }),
        world([occupied(1), win(2)], "on")
      )
    ).toEqual({ kind: "activate", windowId: 1, reason: "current" });
  });

  it("current on an external open uses the most recently focused ready window", () => {
    expect(
      decideProjectOpenTarget(
        external({ disposition: "current" }),
        world([{ ...occupied(1), ready: false }, occupied(2)])
      )
    ).toEqual({ kind: "activate", windowId: 2, reason: "current" });
  });
});

describe("decideProjectOpenTarget — rule 3: navigation keeps its window", () => {
  it("a switch stays in the asking window whatever the preference", () => {
    for (const preference of ["default", "on", "off"] as const) {
      expect(
        decideProjectOpenTarget(inApp(1, { intent: "switch" }), world([occupied(1), win(2)], preference))
      ).toEqual({ kind: "activate", windowId: 1, reason: "current" });
    }
  });

  it("restore keeps its assigned window", () => {
    expect(
      decideProjectOpenTarget(
        external({ source: "restore", initiatingWindowId: 1 }),
        world([occupied(1), win(2)], "on")
      )
    ).toEqual({ kind: "activate", windowId: 1, reason: "current" });
  });

  it("a switch redirects to an existing owner", () => {
    expect(
      decideProjectOpenTarget(
        inApp(1, { intent: "switch" }),
        world([occupied(1), occupied(2, "dropped")])
      )
    ).toEqual({ kind: "focus", windowId: 2 });
  });
});

describe("decideProjectOpenTarget — rule 4: preference and origin", () => {
  it("default keeps in-app opens in the asking window", () => {
    expect(decideProjectOpenTarget(inApp(1), world([occupied(1), win(2)]))).toEqual({
      kind: "activate",
      windowId: 1,
      reason: "current",
    });
  });

  it("on sends in-app opens to a new (or empty) window", () => {
    expect(decideProjectOpenTarget(inApp(1), world([occupied(1)], "on"))).toEqual({
      kind: "create",
    });
  });

  it("off sends external opens to the most recently focused window", () => {
    expect(decideProjectOpenTarget(external(), world([occupied(3), occupied(1)], "off"))).toEqual(
      { kind: "activate", windowId: 3, reason: "current" }
    );
  });

  it("off with no windows still creates one", () => {
    expect(decideProjectOpenTarget(external(), world([], "off"))).toEqual({ kind: "create" });
  });
});
