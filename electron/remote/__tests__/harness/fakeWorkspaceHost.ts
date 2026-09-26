import type { FakeMessagePortMain } from "./fakeElectron.js";

/**
 * A project's workspace host as the port broker sees it: it adopts the port
 * the broker hands it and answers the worktree RPC protocol (`{id, action,
 * payload}` → `{id, result}`), and pushes `{type: "event", event}` to every
 * port it holds. Only `get-all-states` has a real answer; anything else is
 * recorded and answered with an error, as an unknown action would be.
 */
export class FakeWorkspaceHost {
  readonly requests: Array<{ id: unknown; action: string; payload: unknown }> = [];
  private readonly ports = new Set<FakeMessagePortMain>();

  constructor(readonly projectPath: string) {}

  get portCount(): number {
    return this.ports.size;
  }

  attachWorktreePort = (port: FakeMessagePortMain): boolean => {
    this.ports.add(port);
    port.on("close", () => this.ports.delete(port));
    port.on("message", (event: { data: unknown }) => this.answer(port, event.data));
    port.start();
    return true;
  };

  emit(event: { type: string } & Record<string, unknown>): void {
    for (const port of this.ports) port.postMessage({ type: "event", event });
  }

  private answer(port: FakeMessagePortMain, raw: unknown): void {
    const request = raw as { id: unknown; action: string; payload: unknown };
    this.requests.push(request);
    if (request.action === "get-all-states") {
      port.postMessage({
        id: request.id,
        result: {
          states: [{ id: this.projectPath, path: this.projectPath, branch: "main" }],
          watcherDegraded: false,
          topologyWatcherDark: false,
          lastAcknowledgedMutationIds: [],
          epoch: "epoch-1",
          seq: 1,
        },
      });
      return;
    }
    port.postMessage({ id: request.id, error: `unhandled ${request.action}` });
  }
}

/** The WorkspaceClient surface the remote modules reach, over one fake host per project path. */
export function createFakeWorkspaceClient(hosts: Map<string, FakeWorkspaceHost>) {
  return {
    getHostForProject: (projectPath: string) => hosts.get(projectPath) ?? null,
    prewarmProject: () => undefined,
    waitForReady: async () => undefined,
    isWorktreeOwnedByProject: async () => null,
  };
}
