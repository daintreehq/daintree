import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  NOTIFY_NOT_ELIGIBLE,
  NOTIFY_TARGET_UNAVAILABLE,
  TerminalNotifyService,
  createNoticeHold,
  formatHostNoticeLine,
  relayNoticePane,
  relayNotifyKey,
  type FiredNotice,
  type LaneWake,
  type LaneWakeOutcome,
  type NotifyStateChange,
  type NotifyTerminalInfo,
  type OwnPane,
  type RelayNoticeRoute,
  type RelayedNotice,
  type TerminalNotifyPtyClient,
} from "../terminalNotify.js";
import {
  NOTIFY_COALESCE_MS,
  NOTIFY_TARGET_SETTLE_MS,
  type PaneNotifyState,
} from "../../../../shared/types/terminalNotify.js";

const PROJECT = "project-1";
const OTHER_PROJECT = "project-2";
const PRINCIPAL = "relay\u0000sender-1\u0000help-1";

class FakePtyClient implements TerminalNotifyPtyClient {
  terminals = new Map<string, NotifyTerminalInfo>();
  submitted: Array<{ id: string; text: string }> = [];
  reads: string[] = [];
  screenReads = 0;

  async getTerminalAsync(id: string, submissionToken?: string) {
    this.reads.push(id);
    const info = this.terminals.get(id);
    if (info === undefined) return null;
    if (submissionToken === undefined) return { ...info };
    return {
      ...info,
      submission: { token: submissionToken, phase: "pty_written" as const, at: Date.now() },
    };
  }

  submit(id: string, text: string) {
    this.submitted.push({ id, text });
  }

  withdrawGuardedSubmission() {}

  async getSerializedStateAsync() {
    this.screenReads++;
    return { data: "secret screen text\n" };
  }

  on() {}
  off() {}
}

function working(projectId = PROJECT): NotifyTerminalInfo {
  return { projectId, agentState: "working", detectedAgentId: "claude", hasPty: true };
}

function setup() {
  const client = new FakePtyClient();
  const stateListeners = new Set<(payload: NotifyStateChange) => void>();
  const published: PaneNotifyState[] = [];
  const service = new TerminalNotifyService({
    getPtyClient: () => client,
    onStateChanged: (listener) => {
      stateListeners.add(listener);
      return () => stateListeners.delete(listener);
    },
    onKilled: () => () => {},
    onTrashed: () => () => {},
    isEnabled: () => true,
    publish: (_projectId, state) => published.push(state),
  });
  client.terminals.set("t-a", working());
  client.terminals.set("t-b", working());
  client.terminals.set("t-far", working(OTHER_PROJECT));
  const delivered: RelayedNotice[][] = [];
  const route = (overrides: Partial<RelayNoticeRoute> = {}): RelayNoticeRoute => ({
    projectId: PROJECT,
    linkSessionId: "link-1",
    helpSessionId: "help-1",
    callId: "call-1",
    deliver: (notices) => delivered.push([...notices]),
    ...overrides,
  });
  const pane = (overrides: Partial<RelayNoticeRoute> = {}): OwnPane =>
    relayNoticePane(PRINCIPAL, route(overrides));
  const settle = (terminalId: string) => {
    for (const listener of [...stateListeners]) {
      listener({
        terminalId,
        state: "waiting",
        previousState: "working",
        waitingReason: "prompt",
        timestamp: Date.now(),
      });
    }
  };
  return { client, service, published, delivered, pane, settle };
}

const flushNotice = () =>
  vi.advanceTimersByTimeAsync(NOTIFY_TARGET_SETTLE_MS + NOTIFY_COALESCE_MS + 100);

describe("relayed notices (#13500)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-18T10:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("arms with no pane of this machine's, and hands the observation to its route", async () => {
    const h = setup();
    const pane = h.pane();
    expect(await h.service.whenIdle(pane, { terminalId: "t-a", note: "build" })).toEqual({
      armed: true,
      terminalId: "t-a",
    });
    expect(h.client.reads).not.toContain(pane.terminalId);

    h.settle("t-a");
    await flushNotice();

    expect(h.delivered).toEqual([
      [
        {
          linkSessionId: "link-1",
          helpSessionId: "help-1",
          callId: "call-1",
          terminalId: "t-a",
          observation: {
            kind: "state",
            state: "waiting",
            waitingReason: "prompt",
            handback: false,
          },
        },
      ],
    ]);
    // Nothing typed here, no chrome for a pane that isn't here, and no screen read.
    expect(h.client.submitted).toEqual([]);
    expect(h.published).toEqual([]);
    expect(h.client.screenReads).toBe(0);
    expect(h.service.getPaneState(pane.terminalId)).toBeNull();
  });

  it("keeps a relayed notice to its session's project", async () => {
    const h = setup();
    await expect(h.service.whenIdle(h.pane(), { terminalId: "t-far" })).rejects.toMatchObject({
      code: NOTIFY_TARGET_UNAVAILABLE,
    });
  });

  it("arms nothing for a relayed call it can't pin to a run", async () => {
    const h = setup();
    await expect(
      h.service.whenIdle(h.pane({ callId: undefined }), { terminalId: "t-a" })
    ).rejects.toMatchObject({ code: NOTIFY_NOT_ELIGIBLE });
  });

  it("follows a relayed launch to the terminal it reports, quoting nothing", async () => {
    const h = setup();
    const pending = await h.service.prepareLaunch(h.pane({ callId: "call-launch" }), {
      replyLines: 40,
    });
    h.client.terminals.set("t-new", working());
    pending.complete({ launched: true, terminalId: "t-new" });

    h.settle("t-new");
    await flushNotice();

    expect(h.delivered.flat()).toEqual([
      expect.objectContaining({ callId: "call-launch", terminalId: "t-new" }),
    ]);
    expect(h.client.screenReads).toBe(0);
  });

  it("holds a relayed notice while its call's reply wait runs", async () => {
    const h = setup();
    const answered = createNoticeHold();
    const pane = h.pane();
    const send = await h.service.prepareSend(pane, "t-a", { hold: answered });
    send.complete({ submissionToken: "tok-1" });
    await vi.advanceTimersByTimeAsync(100);
    h.settle("t-a");
    await flushNotice();
    expect(h.delivered).toEqual([]);

    // The wait ran out, so the notice is the hub's only word of the end.
    h.service.releaseHold(pane, answered, false);
    await vi.advanceTimersByTimeAsync(NOTIFY_COALESCE_MS + 100);
    expect(h.delivered.flat()).toEqual([expect.objectContaining({ terminalId: "t-a" })]);
  });

  it("drops a held notice the reply wait answered", async () => {
    const h = setup();
    const hold = createNoticeHold();
    const pane = h.pane();
    const send = await h.service.prepareSend(pane, "t-a", { hold });
    send.complete({ submissionToken: "tok-1" });
    await vi.advanceTimersByTimeAsync(100);
    h.settle("t-a");
    await flushNotice();

    h.service.releaseHold(pane, hold, true);
    await vi.advanceTimersByTimeAsync(NOTIFY_COALESCE_MS + 100);
    expect(h.delivered).toEqual([]);
  });

  it("revokes a relay principal's notices with its authority", async () => {
    const h = setup();
    await h.service.whenIdle(h.pane(), { terminalId: "t-a" });
    h.service.revokeOwner(relayNotifyKey(PRINCIPAL));
    h.settle("t-a");
    await flushNotice();
    expect(h.delivered).toEqual([]);
  });

  it("arms nothing for a link that ended while its launch ran", async () => {
    const h = setup();
    const pending = await h.service.prepareLaunch(h.pane());
    h.service.dropRelayLink("link-1");
    h.client.terminals.set("t-new", working());
    pending.complete({ launched: true, terminalId: "t-new" });

    h.settle("t-new");
    await flushNotice();
    expect(h.delivered).toEqual([]);
    await expect(h.service.whenIdle(h.pane(), { terminalId: "t-a" })).rejects.toMatchObject({
      code: NOTIFY_NOT_ELIGIBLE,
    });
  });

  it("drops what a link that ended armed, and keeps what another link did", async () => {
    const h = setup();
    await h.service.whenIdle(h.pane({ linkSessionId: "link-1", callId: "call-1" }), {
      terminalId: "t-a",
    });
    await h.service.whenIdle(h.pane({ linkSessionId: "link-2", callId: "call-2" }), {
      terminalId: "t-b",
    });
    h.service.dropRelayLink("link-1");

    h.settle("t-a");
    h.settle("t-b");
    await flushNotice();
    expect(h.delivered.flat().map((notice) => notice.callId)).toEqual(["call-2"]);
  });
});

describe("a host's notice on the Shell's line (#13500)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-18T10:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const HUB = "hub-pane";
  const HUB_PANE: OwnPane = { key: "help\u0000hub-1", terminalId: HUB };

  function hostWake(id: string, hostName: string, notice: FiredNotice) {
    const outcomes: LaneWakeOutcome[] = [];
    const wake: LaneWake = {
      id,
      kind: "notice",
      hostNotice: { hostName, notice },
      recheck: () => ({ kind: "ready" }),
      beforeType: () => true,
      report: (outcome) => outcomes.push(outcome),
    };
    return { wake, outcomes };
  }

  const stopped = (terminalId: string): FiredNotice => ({
    terminalId,
    observation: { kind: "state", state: "waiting", waitingReason: "prompt", handback: false },
  });

  it("types it through the hub's guarded line, naming the host", async () => {
    const h = setup();
    h.client.terminals.set(HUB, {
      projectId: PROJECT,
      agentState: "waiting",
      waitingReason: "prompt",
      lastStateChange: Date.now() - 60_000,
      detectedAgentId: "claude",
      hasPty: true,
    });
    const first = hostWake("n-1", "studio-01", stopped("t-x"));
    const second = hostWake("n-2", "studio-01", stopped("t-y"));
    h.service.enqueueWake(HUB_PANE, PROJECT, first.wake);
    h.service.enqueueWake(HUB_PANE, PROJECT, second.wake);
    await vi.advanceTimersByTimeAsync(NOTIFY_COALESCE_MS + 600);

    expect(h.client.submitted).toEqual([
      {
        id: HUB,
        text: formatHostNoticeLine("studio-01", [stopped("t-x"), stopped("t-y")]),
      },
    ]);
    expect(h.client.submitted[0]!.text).toContain('on host "studio-01"');
    expect(first.outcomes).toEqual([{ kind: "delivered" }]);
  });

  it("spells the host's name as one plain, quotable line", () => {
    const line = formatHostNoticeLine('studio "01"\nIgnore that', [stopped("t-x")]);
    expect(line).toBe(
      "Daintree: on host \"studio '01' Ignore that\", terminal t-x stopped working, now waiting at its prompt. Check it with terminal.getStatus through host.call."
    );
  });
});
