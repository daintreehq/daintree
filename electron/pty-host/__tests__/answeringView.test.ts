import { describe, expect, it } from "vitest";
import { createAnsweringViewProbe, type AnsweringViewDeps } from "../answeringView.js";
import type { RendererConnection } from "../handlers/types.js";
import type { TerminalInfo } from "../../services/pty/types.js";

const LOCAL_WINDOW = 1;
const REMOTE = -7;

/** `null` stands for a terminal the shard does not know. */
function harness(terminal: Partial<TerminalInfo> | null = { projectId: "p1" }) {
  const rendererConnections = new Map<number, RendererConnection>();
  const windowProjectMap = new Map<number, string | null>();
  const fallbackEligibleProjects = new Set<string>();
  const frozenViewProjects = new Set<string>();
  const refused = new Set<number>();
  let localRefused = false;

  const deps: AnsweringViewDeps = {
    getTerminal: () => (terminal ?? undefined) as TerminalInfo | undefined,
    rendererConnections,
    windowProjectMap,
    fallbackEligibleProjects,
    frozenViewProjects,
    mayDriveFrom: (_id, connectionId) => !refused.has(connectionId),
    mayDriveLocally: () => !localRefused,
  };
  const answers = createAnsweringViewProbe(deps);

  return {
    answers: () => answers("t1"),
    connect(connectionId: number, projectId: string | null, clientAway?: boolean) {
      rendererConnections.set(connectionId, { clientAway } as RendererConnection);
      windowProjectMap.set(connectionId, projectId);
    },
    fallbackEligibleProjects,
    frozenViewProjects,
    refuse: (connectionId: number) => refused.add(connectionId),
    refuseLocal: () => {
      localRefused = true;
    },
  };
}

describe("createAnsweringViewProbe (#18185)", () => {
  it("leaves the mirror to answer when no view is connected", () => {
    expect(harness().answers()).toBe(false);
  });

  it("counts a window showing the terminal's project", () => {
    const h = harness();
    h.connect(LOCAL_WINDOW, "p1");
    expect(h.answers()).toBe(true);
  });

  it("does not count a window showing another project", () => {
    const h = harness();
    h.connect(LOCAL_WINDOW, "p2");
    expect(h.answers()).toBe(false);
  });

  it("does not count a window with no project, which is routed the bytes but parses none", () => {
    const h = harness();
    h.connect(LOCAL_WINDOW, null);
    expect(h.answers()).toBe(false);
  });

  it("counts a remote client only while it is reading the stream", () => {
    const h = harness();
    h.connect(REMOTE, "p1", true);
    expect(h.answers()).toBe(false);

    h.connect(REMOTE, "p1", false);
    expect(h.answers()).toBe(true);
  });

  it("does not count a view whose replies the drive lease would refuse", () => {
    const h = harness();
    h.connect(REMOTE, "p1", false);
    h.refuse(REMOTE);
    expect(h.answers()).toBe(false);

    h.connect(LOCAL_WINDOW, "p1");
    expect(h.answers()).toBe(true);
  });

  it("counts a view off the port path unless every view of the project may be frozen", () => {
    const h = harness();
    h.fallbackEligibleProjects.add("p1");
    expect(h.answers()).toBe(true);

    h.frozenViewProjects.add("p1");
    expect(h.answers()).toBe(false);
  });

  it("keeps counting a frozen audience for an agent, whose copies still reach it", () => {
    const h = harness({ projectId: "p1", detectedAgentId: "claude" });
    h.fallbackEligibleProjects.add("p1");
    h.frozenViewProjects.add("p1");
    expect(h.answers()).toBe(true);
  });

  it("does not count views off the port path while a remote endpoint holds the lease", () => {
    const h = harness();
    h.fallbackEligibleProjects.add("p1");
    h.refuseLocal();
    expect(h.answers()).toBe(false);
  });

  it("leaves the mirror to answer for a terminal it does not know or with no project", () => {
    const unknown = harness(null);
    unknown.connect(LOCAL_WINDOW, "p1");
    expect(unknown.answers()).toBe(false);

    const unplaced = harness({ projectId: undefined });
    unplaced.connect(LOCAL_WINDOW, null);
    expect(unplaced.answers()).toBe(false);
  });
});
