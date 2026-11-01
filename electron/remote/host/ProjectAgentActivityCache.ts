import { ACTIVE_AGENT_STATES, type AgentState } from "../../../shared/types/agent.js";

/** The slice of PtyClient the cache reads: its spawn registry, inventory and lifecycle events. */
export interface AgentActivityPty {
  getTerminalProjectId(id: string): string | null;
  getAllTerminalsWithCompletenessAsync(): Promise<{
    terminals: ReadonlyArray<{ id: string; projectId?: string; agentState?: AgentState }>;
    degraded: boolean;
  }>;
  on(event: "exit" | "host-crash", listener: (id: string) => void): unknown;
  off(event: "exit" | "host-crash", listener: (id: string) => void): unknown;
}

/**
 * Which of this host's projects have an agent working, waiting or directing,
 * so the host can tell a Shell which of its views to rank with its own
 * active-agent views (#13359). Agent state reaches main only as
 * `agent:state-changed` events, which carry no project; the owner comes from
 * the PTY client's spawn registry, or from the inventory the cache seeds from
 * when main isn't tracking the terminal.
 *
 * Seeded from the pty-host's inventory on attach, after a pty-host crash and
 * on every {@link reconcile}, so agents already running when the host starts
 * serving count and a missed event or failed read is repaired. A seed never
 * overwrites the state of a terminal an event touched while it was in flight,
 * nor brings back one that exited meanwhile; an incomplete inventory adds what
 * it saw but never takes a terminal away.
 *
 * The inventory is read only while `wanted` says something will read the
 * answers (#15907). Events keep the cache following meanwhile, and the owner
 * reconciles when reading resumes.
 */
export class ProjectAgentActivityCache {
  private readonly states = new Map<string, AgentState>();
  private readonly seededProjects = new Map<string, string>();
  /** Terminals whose state an event changed since the in-flight seed asked for the inventory. */
  private readonly touched = new Set<string>();
  /** Terminals that exited since the in-flight seed asked for the inventory. */
  private readonly exited = new Set<string>();
  private pty: AgentActivityPty | null = null;
  private seeding = false;
  private seedAgain = false;
  private disposed = false;

  constructor(
    private readonly onChange: () => void,
    private readonly wanted: () => boolean = () => true
  ) {}

  /** Start following `pty`. Later calls are ignored: there is one client per process. */
  attach(pty: AgentActivityPty): void {
    if (this.disposed || this.pty) return;
    this.pty = pty;
    pty.on("exit", this.onExit);
    pty.on("host-crash", this.onHostCrash);
    void this.seed();
  }

  /** Read the inventory again, to repair what events missed. */
  reconcile(): void {
    void this.seed();
  }

  noteState(terminalId: string, state: AgentState): void {
    if (this.disposed) return;
    // Only a read in flight needs it, and a host nobody reads can go days between reads.
    if (this.seeding) this.touched.add(terminalId);
    if (this.states.get(terminalId) === state) return;
    this.states.set(terminalId, state);
    this.onChange();
  }

  isProjectActive(projectId: string): boolean {
    for (const [terminalId, state] of this.states) {
      if (!ACTIVE_AGENT_STATES.has(state)) continue;
      const owner =
        this.pty?.getTerminalProjectId(terminalId) ?? this.seededProjects.get(terminalId);
      if (owner === projectId) return true;
    }
    return false;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.pty?.off("exit", this.onExit);
    this.pty?.off("host-crash", this.onHostCrash);
    this.pty = null;
    this.states.clear();
    this.seededProjects.clear();
    this.touched.clear();
    this.exited.clear();
  }

  private readonly onExit = (terminalId: string) => {
    if (this.disposed) return;
    if (this.seeding) this.exited.add(terminalId);
    this.seededProjects.delete(terminalId);
    if (this.states.delete(terminalId)) this.onChange();
  };

  private readonly onHostCrash = () => void this.seed();

  private async seed(): Promise<void> {
    const pty = this.pty;
    if (!pty || this.disposed || !this.wanted()) return;
    if (this.seeding) {
      this.seedAgain = true;
      return;
    }
    this.seeding = true;
    try {
      const { terminals, degraded } = await pty.getAllTerminalsWithCompletenessAsync();
      if (this.disposed || this.pty !== pty) return;
      let changed = false;
      const seen = new Set<string>();
      for (const terminal of terminals) {
        seen.add(terminal.id);
        if (this.exited.has(terminal.id)) continue;
        // Learned even for a terminal whose state moved on: an event carries no
        // project, and main may not be tracking this one's spawn.
        if (terminal.projectId && this.seededProjects.get(terminal.id) !== terminal.projectId) {
          this.seededProjects.set(terminal.id, terminal.projectId);
          // An owner newly known can make a state already held count.
          changed = true;
        }
        if (this.touched.has(terminal.id)) continue;
        if (terminal.agentState === undefined) {
          // Still running, but no longer an agent: a shell reusing the id, say.
          if (this.states.delete(terminal.id)) changed = true;
        } else if (this.states.get(terminal.id) !== terminal.agentState) {
          this.states.set(terminal.id, terminal.agentState);
          changed = true;
        }
      }
      if (!degraded) {
        for (const terminalId of [...this.states.keys()]) {
          if (seen.has(terminalId) || this.touched.has(terminalId)) continue;
          this.states.delete(terminalId);
          this.seededProjects.delete(terminalId);
          changed = true;
        }
      }
      if (changed) this.onChange();
    } catch (error) {
      console.error("[ProjectAgentActivityCache] inventory seed failed:", error);
    } finally {
      this.seeding = false;
      this.touched.clear();
      this.exited.clear();
      if (this.seedAgain && !this.disposed) {
        this.seedAgain = false;
        void this.seed();
      }
    }
  }
}
