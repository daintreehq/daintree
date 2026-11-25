import { describe, expect, it } from "vitest";
import { createAnsweringViewProbe, type AnsweringViewDeps } from "../answeringView.js";
import type { RendererConnection, TerminalWorkerConnection } from "../handlers/types.js";
import type { TerminalInfo } from "../../services/pty/types.js";

const LOCAL_WINDOW = 1;
const REMOTE = -7;

/** `null` stands for a terminal the shard does not know. */
function harness(terminal: Partial<TerminalInfo> | null = { projectId: "p1" }) {
  const rendererConnections = new Map<number, RendererConnection>();
  const terminalWorkerConnections = new Map<number, Map<string, TerminalWorkerConnection>>();
  const windowProjectMap = new Map<number, string | null>();
  const fallbackEligibleProjects = new Set<string>();
  const frozenViewProjects = new Set<string>();
  const refused = new Set<number>();
  let localRefused = false;
  let hiddenSkipped = false;

  const deps: AnsweringViewDeps = {
    getTerminal: () => (terminal ?? undefined) as TerminalInfo | undefined,
    rendererConnections,
    terminalWorkerConnections,
    windowProjectMap,
    fallbackEligibleProjects,
    frozenViewProjects,
    mayDriveFrom: (_id, connectionId) => !refused.has(connectionId),
    mayDriveLocally: () => !localRefused,
    isHiddenCopySkipped: () => hiddenSkipped,
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
    skipHiddenCopies: () => {
      hiddenSkipped = true;
    },
    routeToParseWorker(connectionId: number, engaged: boolean) {
      const perWindow = new Map<string, TerminalWorkerConnection>();
      perWindow.set("t1", { engaged } as TerminalWorkerConnection);
      terminalWorkerConnections.set(connectionId, perWindow);
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

  it("counts the unbound window for a projectless terminal, and no project's window", () => {
    const h = harness({ projectId: undefined });
    h.connect(LOCAL_WINDOW, "p1");
    expect(h.answers()).toBe(false);

    h.connect(2, null);
    expect(h.answers()).toBe(true);
  });

  it("does not count a window whose renderer parses the terminal on a worker", () => {
    const h = harness();
    h.connect(LOCAL_WINDOW, "p1");
    h.routeToParseWorker(LOCAL_WINDOW, true);
    expect(h.answers()).toBe(false);

    h.routeToParseWorker(LOCAL_WINDOW, false);
    expect(h.answers()).toBe(true);
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

  it("does not count views off the port path while their copies are being skipped", () => {
    const h = harness();
    h.fallbackEligibleProjects.add("p1");
    h.skipHiddenCopies();
    expect(h.answers()).toBe(false);
  });

  it("does not count views off the port path while a remote endpoint holds the lease", () => {
    const h = harness();
    h.fallbackEligibleProjects.add("p1");
    h.refuseLocal();
    expect(h.answers()).toBe(false);
  });

  it("leaves the mirror to answer for a terminal it does not know", () => {
    const h = harness(null);
    h.connect(LOCAL_WINDOW, "p1");
    h.connect(2, null);
    h.fallbackEligibleProjects.add("p1");
    expect(h.answers()).toBe(false);
  });
});
