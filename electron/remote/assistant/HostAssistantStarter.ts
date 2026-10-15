import { MAX_ASSISTANT_SLOTS } from "../../../shared/config/assistantSlots.js";
import type { HostId } from "../../../shared/types/remoteHosts.js";
import { readTailSnapshot, tailCapturedOutput } from "../../../shared/utils/artifactParser.js";
import type { HostProjectViewResult } from "../client/hostProjectViews.js";
import type { EnrollStartedPayload, EnrollStartedResult, LaneList } from "./linkMethods.js";

/** What a view answered when an action was run in it. */
export type ViewDispatchResult =
  { ok: true; result: unknown } | { ok: false; code: string; message: string };

export interface HostAssistantStarterDeps {
  /** The lanes this Shell enrolled on the host, and every assistant running there. */
  listLanes(hostId: HostId): Promise<LaneList>;
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
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export type HostStartRefusal =
  | "consent-withdrawn"
  | "no-project"
  | "no-slot"
  | "agent-mismatch"
  | "no-window"
  | "no-room"
  | "busy"
  | "driven-elsewhere"
  | "launch-failed"
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
  /**
   * Asked again before every step that changes anything: the hub is still the
   * caller, both of the person's opt-ins still stand, and messaging isn't paused.
   */
  authorized(): boolean;
}

const POLL_MS = 1_000;
/** How long a new assistant gets to open its prompt, its trust question answered on the way. */
const READY_WAIT_MS = 45_000;
/** How long a hidden view gets to take the project's drive lease once it has loaded. */
const DRIVE_WAIT_MS = 10_000;
const SCREEN_LINES = 40;

const SERIALIZED_STATE_CHANNEL = "terminal:get-serialized-state";
const DRIVE_LEASE_CHANNEL = "drive-lease:get";

/**
 * The folder-trust question each agent CLI asks before it opens in a folder
 * it hasn't seen, and the answer that opens it. Only ever answered for the
 * assistant's own session folder (userData/help-sessions/…), which Daintree
 * made: Codex is told to trust it at launch already, and Claude Code asks
 * once per project.
 */
const TRUST_ANSWERS: Readonly<Record<string, { question: RegExp; answer: string }>> = {
  claude: { question: /Yes, I trust this folder/, answer: "Yes, I trust this folder" },
  codex: { question: /Do you trust the contents of this directory/i, answer: "Yes, continue" },
};

/** What a CLI's footer shows once it's at its own prompt, ready for input. */
const READY_MARKERS =
  /\? for shortcuts|bypass permissions|⏵⏵|context left|Ask Codex to do anything/;

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

/**
 * Whether a screen asks about the session folder itself. A wrapped path loses
 * its line breaks and indentation, so both sides are compared without spaces,
 * on the folder's last two segments (`help-sessions/<project hash>`).
 */
function namesFolder(screen: string, folder: string): boolean {
  const tail = folder.replace(/\/+$/, "").split("/").slice(-2).join("/");
  if (!tail.startsWith("help-sessions/")) return false;
  return screen.replace(/\s+/g, "").includes(tail.replace(/\s+/g, ""));
}

/** Whether the last lines of a screen are a CLI's own prompt footer. */
function atPrompt(screen: string): boolean {
  const lines = screen.split("\n").filter((line) => line.trim().length > 0);
  return READY_MARKERS.test(lines.slice(-8).join("\n"));
}

const refused = (reason: HostStartRefusal): HostStartResult => ({ status: "refused", reason });

/**
 * Starts an assistant in one of a host's projects for this Shell's hub, and
 * enrolls it, with nobody at the host. The hub's tool call is the request and
 * the person's per-host settings are the consent, asked again before every
 * step; this does what their clicks in a window on that host would: open the
 * project's view (in the background), start the assistant in a lane no
 * assistant on the host is using, let it past its folder-trust question, and
 * accept messages for it. It never ends, takes over or enrolls an assistant it
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
    const key = `${hostId}\0${projectId}`;
    const previous = this.queue.get(key) ?? Promise.resolve();
    const run = previous.catch(() => {}).then(() => this.run(hostId, projectId, options));
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
    { agentId, startNew = false, authorized }: HostStartOptions
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
      // Its tool calls run through a view of the project, so there has to be one.
      if (!authorized()) return refused("consent-withdrawn");
      const view = await this.view(hostId, projectId, path, authorized);
      if (view.status !== "ready") return refused(view.reason);
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
    // A project's assistants share one session folder and so one agent CLI.
    if (agentId !== undefined && inProject.some((running) => running.agentId !== agentId)) {
      return refused("agent-mismatch");
    }
    const occupied = new Set(inProject.map((running) => running.slot));
    const slot = Array.from({ length: MAX_ASSISTANT_SLOTS }, (_, index) => index).find(
      (candidate) => !occupied.has(candidate)
    );
    if (slot === undefined) return refused("no-slot");

    if (!authorized()) return refused("consent-withdrawn");
    const view = await this.view(hostId, projectId, path, authorized);
    if (view.status !== "ready") return refused(view.reason);
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

    if (!authorized()) return refused("consent-withdrawn");
    const enrolled = await this.deps.enrollStarted(hostId, {
      projectId,
      slot,
      sessionId: lane.sessionId,
    });
    if (enrolled.status !== "enrolled" || !enrolled.lane) return refused("not-enrolled");
    return {
      status: "ready",
      projectId,
      slot,
      agentId: enrolled.lane.agentId ?? lane.agentId,
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
        .catch(() => null)) as { drivingHere?: boolean } | null;
      if (lease?.drivingHere === true)
        return { status: "ready", webContentsId: view.webContentsId };
      if (this.now() >= deadline) {
        return { status: "refused", reason: lease ? "driven-elsewhere" : "busy" };
      }
      if (!authorized()) return { status: "refused", reason: "consent-withdrawn" };
      await this.sleep(POLL_MS);
    }
  }

  /** Until the new assistant is at its prompt, answering only its own folder-trust question. */
  private async untilReady(
    hostId: HostId,
    wc: number,
    projectId: string,
    lane: LaunchedLane,
    authorized: () => boolean
  ): Promise<"ready" | "timed-out" | "consent-withdrawn"> {
    const trust = TRUST_ANSWERS[lane.agentId];
    const deadline = this.now() + READY_WAIT_MS;
    while (this.now() < deadline) {
      const screen = await this.screen(hostId, wc, projectId, lane.terminalId);
      if (screen !== null) {
        if (trust && trust.question.test(screen) && namesFolder(screen, lane.cwd)) {
          if (!authorized()) return "consent-withdrawn";
          await this.deps.dispatch(wc, "terminal.sendKeys", {
            terminalId: lane.terminalId,
            choose: trust.answer,
          });
        } else if (atPrompt(screen)) {
          return "ready";
        }
      }
      await this.sleep(POLL_MS);
    }
    return "timed-out";
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
        SCREEN_LINES
      );
      return snapshot ? tailCapturedOutput(snapshot.data, SCREEN_LINES, true).content : null;
    } catch {
      return null;
    }
  }
}
