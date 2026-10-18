import { MAX_ASSISTANT_SLOTS } from "../../../shared/config/assistantSlots.js";
import type { HostId } from "../../../shared/types/remoteHosts.js";
import { readTailSnapshot, tailCapturedOutput } from "../../../shared/utils/artifactParser.js";
import type { HostProjectViewResult } from "../client/hostProjectViews.js";
import {
  READY_POLL_MS,
  READY_SCREEN_LINES,
  untilAssistantReady,
  type AssistantReadiness,
} from "./assistantReadiness.js";
import type {
  EnrollStartedPayload,
  EnrollStartedResult,
  LaneList,
  StartPayload,
  StartResult,
} from "./linkMethods.js";

/** What a view answered when an action was run in it. */
export type ViewDispatchResult =
  { ok: true; result: unknown } | { ok: false; code: string; message: string };

export interface HostAssistantStarterDeps {
  /** The lanes this Shell enrolled on the host, and every assistant running there. */
  listLanes(hostId: HostId): Promise<LaneList>;
  /** The same, with no hub needed: what `reattach` reads after a restart. Absent, `listLanes`. */
  listOwnLanes?(hostId: HostId): Promise<LaneList>;
  /** A host project's path, or null when the host has no such project. */
  projectPath(hostId: HostId, projectId: string): Promise<string | null>;
  prepareView(
    hostId: HostId,
    projectId: string,
    projectPath: string
  ): Promise<HostProjectViewResult>;
  /** Runs one of the view's own actions in it, as the person's click would. */
  dispatch(webContentsId: number, actionId: string, args: unknown): Promise<ViewDispatchResult>;
  /** Calls one of the host's handlers on the view's own connection, as its renderer would. */
  invoke(
    hostId: HostId,
    webContentsId: number,
    projectId: string,
    channel: string,
    args: unknown[]
  ): Promise<unknown>;
  /** Enrolls a run this Shell started, on the host, in one step (`assistant.enroll-started`). */
  enrollStarted(hostId: HostId, payload: EnrollStartedPayload): Promise<EnrollStartedResult>;
  /**
   * Has the host start the assistant itself, with no view there (#13511):
   * what a start comes to when the host has no window to open the project
   * in. Absent, such a start is refused `no-window`.
   */
  startWithoutView?(hostId: HostId, payload: StartPayload): Promise<StartResult>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export type HostStartRefusal =
  | "consent-withdrawn"
  | "no-project"
  | "no-slot"
  | "no-window"
  | "no-room"
  | "busy"
  | "driven-elsewhere"
  | "launch-failed"
  | "agent-error"
  | "not-enrolled"
  | "timed-out";

export type HostStartResult =
  | {
      status: "ready";
      projectId: string;
      slot: number;
      agentId: string | null;
      generation: string;
      available: boolean;
      /** False when an assistant already enrolled for this Shell there was the answer. */
      started: boolean;
    }
  | { status: "refused"; reason: HostStartRefusal };

export interface HostStartOptions {
  agentId?: string;
  startNew?: boolean;
  /** The help session asking, which a host starting it with no view records (#13511). */
  askingHelpSessionId?: string;
  /**
   * Asked again before every step that changes anything: the hub is still the
   * caller, both of the person's opt-ins still stand, and messaging isn't paused.
   */
  authorized(): boolean;
}

/** How long a hidden view gets to take the project's drive lease once it has loaded. */
const DRIVE_WAIT_MS = 10_000;

const SERIALIZED_STATE_CHANNEL = "terminal:get-serialized-state";
const DRIVE_LEASE_CHANNEL = "drive-lease:get";
const DRIVE_LEASE_TAKE_OVER_CHANNEL = "drive-lease:take-over";

interface LaunchedLane {
  slot: number;
  terminalId: string;
  sessionId: string;
  agentId: string;
  cwd: string;
}

function launchedLane(result: unknown): LaunchedLane | null {
  const record = result as Partial<LaunchedLane> | null | undefined;
  if (
    !record ||
    typeof record.slot !== "number" ||
    typeof record.terminalId !== "string" ||
    typeof record.sessionId !== "string" ||
    typeof record.agentId !== "string" ||
    typeof record.cwd !== "string"
  ) {
    return null;
  }
  return {
    slot: record.slot,
    terminalId: record.terminalId,
    sessionId: record.sessionId,
    agentId: record.agentId,
    cwd: record.cwd,
  };
}

const refused = (reason: HostStartRefusal): HostStartResult => ({ status: "refused", reason });

/**
 * Starts an assistant in one of a host's projects for this Shell's hub, and
 * enrolls it, with nobody at the host. The hub's tool call is the request and
 * the person's per-host settings are the consent, asked again before every
 * step; this does what their clicks in a window on that host would: open the
 * project's view (in the background), start the assistant in a lane no
 * assistant on the host is using, let it past its folder-trust question, and
 * accept messages for it. A host with no window to open the view in starts
 * the assistant itself (#13511), and its tool calls run on the host until a
 * view takes it over. It never ends, takes over or enrolls an assistant it
 * didn't start: the slot is picked from the host's own list of running
 * assistants and the launch refuses an occupied one, and enrolling names the
 * run it started and refuses a lane another Shell holds.
 */
export class HostAssistantStarter {
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  /** The start under way for each host project; the next waits for it. */
  private readonly queue = new Map<string, Promise<unknown>>();

  constructor(private readonly deps: HostAssistantStarterDeps) {
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = deps.now ?? Date.now;
  }

  /**
   * One start per host project at a time, in order: a second request waits
   * for the first, then runs with its own options, so it finds what the first
   * enrolled rather than racing it for a lane.
   */
  start(hostId: HostId, projectId: string, options: HostStartOptions): Promise<HostStartResult> {
    return this.inTurn(hostId, projectId, () => this.run(hostId, projectId, options));
  }

  /**
   * Gives every lane enrolled for this Shell on the host a view of its project
   * again, so an assistant left without one (the Shell restarted, or its hidden
   * view was closed) gets its Daintree tools back: the host hands a detached
   * assistant to the view that drives its project (#13389). Starts and enrolls
   * nothing. Answers the projects that still have no usable view, and why.
   */
  async reattach(
    hostId: HostId,
    authorized: () => boolean
  ): Promise<Array<{ projectId: string; reason: HostStartRefusal }>> {
    if (!authorized()) return [];
    const listed = await (this.deps.listOwnLanes ?? this.deps.listLanes)(hostId);
    const left: Array<{ projectId: string; reason: HostStartRefusal }> = [];
    for (const projectId of new Set(listed.lanes.map((lane) => lane.projectId))) {
      const reason = await this.inTurn(hostId, projectId, async () => {
        if (!authorized()) return "consent-withdrawn" as const;
        const path = await this.deps.projectPath(hostId, projectId);
        if (path === null) return "no-project" as const;
        if (!authorized()) return "consent-withdrawn" as const;
        const view = await this.view(hostId, projectId, path, authorized);
        return view.status === "ready" ? null : view.reason;
      });
      if (reason !== null) left.push({ projectId, reason });
    }
    return left;
  }

  private inTurn<T>(hostId: HostId, projectId: string, work: () => Promise<T>): Promise<T> {
    const key = `${hostId}\0${projectId}`;
    const previous = this.queue.get(key) ?? Promise.resolve();
    const run = previous.catch(() => {}).then(work);
    this.queue.set(key, run);
    void run
      .catch(() => {})
      .finally(() => {
        if (this.queue.get(key) === run) this.queue.delete(key);
      });
    return run;
  }

  private async run(
    hostId: HostId,
    projectId: string,
    { agentId, startNew = false, askingHelpSessionId, authorized }: HostStartOptions
  ): Promise<HostStartResult> {
    if (!authorized()) return refused("consent-withdrawn");
    const listed = await this.deps.listLanes(hostId);
    const path = await this.deps.projectPath(hostId, projectId);
    if (path === null) return refused("no-project");

    const mine = startNew
      ? undefined
      : listed.lanes.find(
          (lane) =>
            lane.projectId === projectId &&
            lane.available &&
            (agentId === undefined || lane.agentId === agentId)
        );
    if (mine) {
      // Its tool calls run through a view of the project when the host has a
      // window for one; with none, the host runs them itself (#13511).
      if (!authorized()) return refused("consent-withdrawn");
      const view = await this.view(hostId, projectId, path, authorized);
      if (view.status !== "ready" && view.reason !== "no-window") return refused(view.reason);
      if (!authorized()) return refused("consent-withdrawn");
      return {
        status: "ready",
        projectId,
        slot: mine.slot,
        agentId: mine.agentId ?? null,
        generation: mine.generation,
        available: true,
        started: false,
      };
    }

    const inProject = (listed.assistants ?? []).filter(
      (running) => running.projectId === projectId
    );
    const occupied = new Set(inProject.map((running) => running.slot));
    const slot = Array.from({ length: MAX_ASSISTANT_SLOTS }, (_, index) => index).find(
      (candidate) => !occupied.has(candidate)
    );
    if (slot === undefined) return refused("no-slot");

    if (!authorized()) return refused("consent-withdrawn");
    const view = await this.view(hostId, projectId, path, authorized);
    let started: { sessionId: string; agentId: string };
    if (view.status === "ready") {
      const wc = view.webContentsId;
      if (!authorized()) return refused("consent-withdrawn");
      const launch = await this.deps.dispatch(wc, "help.launchAgent", {
        ...(agentId === undefined ? {} : { agentId }),
        slot,
        vacantOnly: true,
        greeting: "hub",
      });
      const lane = launch.ok ? launchedLane(launch.result) : null;
      if (!lane || lane.slot !== slot) return refused("launch-failed");

      const ready = await this.untilReady(hostId, wc, projectId, lane, authorized);
      if (ready !== "ready") return refused(ready);
      started = lane;
    } else if (view.reason === "no-window") {
      // No window on the host to open the project in: the host starts it
      // itself, ready or refused when it answers.
      if (!this.deps.startWithoutView || askingHelpSessionId === undefined) {
        return refused("no-window");
      }
      if (!authorized()) return refused("consent-withdrawn");
      let answer: StartResult;
      try {
        answer = await this.deps.startWithoutView(hostId, {
          projectId,
          slot,
          ...(agentId === undefined ? {} : { agentId }),
          askingHelpSessionId,
        });
      } catch (err) {
        // A host from before this can't start one with no window.
        return refused(
          (err as { code?: unknown } | null)?.code === "UNSUPPORTED" ? "no-window" : "launch-failed"
        );
      }
      if (answer.status !== "started") return refused(answer.reason);
      if (answer.lane.slot !== slot) return refused("launch-failed");
      started = answer.lane;
    } else {
      return refused(view.reason);
    }

    if (!authorized()) return refused("consent-withdrawn");
    const enrolled = await this.deps.enrollStarted(hostId, {
      projectId,
      slot,
      sessionId: started.sessionId,
    });
    if (enrolled.status !== "enrolled" || !enrolled.lane) return refused("not-enrolled");
    return {
      status: "ready",
      projectId,
      slot,
      agentId: enrolled.lane.agentId ?? started.agentId,
      generation: enrolled.lane.generation,
      available: enrolled.lane.available,
      started: true,
    };
  }

  /** A loaded view of the project that drives it, so a launch there may provision. */
  private async view(
    hostId: HostId,
    projectId: string,
    path: string,
    authorized: () => boolean
  ): Promise<
    { status: "ready"; webContentsId: number } | { status: "refused"; reason: HostStartRefusal }
  > {
    const view = await this.deps.prepareView(hostId, projectId, path);
    if (view.status !== "ready") {
      return {
        status: "refused",
        reason: view.status === "failed" ? "launch-failed" : view.status,
      };
    }
    const deadline = this.now() + DRIVE_WAIT_MS;
    for (;;) {
      const lease = (await this.deps
        .invoke(hostId, view.webContentsId, projectId, DRIVE_LEASE_CHANNEL, [{ projectId }])
        .catch(() => null)) as { isHolderEndpoint?: boolean; holder?: unknown } | null;
      // The host hands a detached assistant only to the view that holds the lease.
      if (lease?.isHolderEndpoint === true) {
        return { status: "ready", webContentsId: view.webContentsId };
      }
      if (!authorized()) return { status: "refused", reason: "consent-withdrawn" };
      if (lease && lease.holder === null) {
        // Nobody drives it: take it, as opening the project would. Never from someone else.
        await this.deps
          .invoke(hostId, view.webContentsId, projectId, DRIVE_LEASE_TAKE_OVER_CHANNEL, [
            { projectId, ifLeaseId: null },
          ])
          .catch(() => null);
      }
      if (this.now() >= deadline) {
        return { status: "refused", reason: lease ? "driven-elsewhere" : "busy" };
      }
      if (!authorized()) return { status: "refused", reason: "consent-withdrawn" };
      await this.sleep(READY_POLL_MS);
    }
  }

  /** Until the new assistant is ready, read and answered through the view's own connection. */
  private untilReady(
    hostId: HostId,
    wc: number,
    projectId: string,
    lane: LaunchedLane,
    authorized: () => boolean
  ): Promise<AssistantReadiness> {
    return untilAssistantReady({
      agentId: lane.agentId,
      cwd: lane.cwd,
      screen: () => this.screen(hostId, wc, projectId, lane.terminalId),
      answerTrust: async (answer) => {
        await this.deps.dispatch(wc, "terminal.sendKeys", {
          terminalId: lane.terminalId,
          choose: answer,
        });
      },
      authorized,
      now: this.now,
      sleep: this.sleep,
    });
  }

  /**
   * The assistant terminal's screen, read from the host as the view's own
   * renderer reads it: `terminal.getStatus` keeps assistant terminals to
   * itself, and rightly, since they're no MCP caller's business.
   */
  private async screen(
    hostId: HostId,
    wc: number,
    projectId: string,
    terminalId: string
  ): Promise<string | null> {
    try {
      const snapshot = await readTailSnapshot(
        (options) =>
          this.deps.invoke(hostId, wc, projectId, SERIALIZED_STATE_CHANNEL, [
            terminalId,
            ...(options ? [options] : []),
          ]) as Promise<{ data: string; partial?: true } | null>,
        READY_SCREEN_LINES
      );
      return snapshot ? tailCapturedOutput(snapshot.data, READY_SCREEN_LINES, true).content : null;
    } catch {
      return null;
    }
  }
}
