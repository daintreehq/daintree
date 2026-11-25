import { afterEach, describe, expect, it, vi } from "vitest";
import type { CanopyHostEvent } from "../../../../shared/types/ipc/canopyHost.js";
import { wrapSuccess } from "../../../../shared/utils/ipcErrorSerialization.js";
import { AppError } from "../../../utils/errorTypes.js";
import { CanopyHostsClient, SIGN_IN_OFFER_MS } from "../client.js";
import { CANOPY_VIEWER_ENDPOINT_PREFIX, CanopyLinkMethod } from "../linkMethods.js";
import type { EventMessage } from "../../link/messages.js";
import { CanopyViewers } from "../viewer.js";

const VIEW = 7;
const OTHER_VIEW = 8;

type HostAnswer = (method: string, payload: Record<string, unknown>) => unknown;

function setup(options: { answer?: HostAnswer; send?: () => boolean } = {}) {
  const calls: Array<{ method: string; payload: Record<string, unknown> }> = [];
  const answer: HostAnswer =
    options.answer ??
    ((method, payload) => {
      if (method !== CanopyLinkMethod.SIGN_IN) return null;
      if (payload.op === "start") return { terminalId: "daintree-sign-in-1", spawnedAt: 100 };
      if (payload.op === "watch") return { watchId: 9, snapshot: { data: "", cols: 80, rows: 24 } };
      return null;
    });
  const connections = new Map<string, { callHost: (m: string, p: unknown) => Promise<unknown> }>();
  connections.set("studio", {
    callHost: vi.fn(async (method: string, payload: unknown) => {
      calls.push({ method, payload: payload as Record<string, unknown> });
      return answer(method, payload as Record<string, unknown>);
    }),
  });
  const sessionListeners: Array<(hostId: string, session: unknown) => void> = [];
  const viewerListeners: Array<(hostId: string, event: EventMessage) => void> = [];
  const viewGone = new Map<number, () => void>();
  const sent: Array<{ webContentsId: number; event: CanopyHostEvent }> = [];
  let viewerCount = 0;
  const client = new CanopyHostsClient({
    manager: {
      get: (hostId) => connections.get(hostId),
      connect: vi.fn(),
      touch: () => {},
      addUseCheck: () => () => {},
      onSessionOpened: (listener) => {
        sessionListeners.push(listener as (typeof sessionListeners)[number]);
        return () => {};
      },
      onViewerEvent: (listener) => {
        viewerListeners.push(listener);
        return () => {};
      },
    },
    registry: {
      get: (hostId) => (hostId === "studio" ? { id: hostId } : null),
      onChange: () => () => {},
    },
    hostForView: () => null,
    local: new CanopyViewers({
      source: { observeCanopy: () => () => {}, observeFleet: () => null },
      invoke: async () => wrapSuccess(null),
    }),
    localClient: { clientId: "local", clientName: "mbp", platform: "darwin", kind: "local" },
    send: (webContentsId, event) => {
      sent.push({ webContentsId, event });
      return options.send?.() ?? true;
    },
    watchView: (webContentsId, onGone) => {
      viewGone.set(webContentsId, onGone);
      return () => viewGone.delete(webContentsId);
    },
    newViewerId: () => `v${++viewerCount}`,
  });
  client.start();
  const offers = () =>
    sent.flatMap(({ webContentsId, event }) =>
      event.kind === "sign-in-offer" ? [{ webContentsId, event }] : []
    );
  const releases = () => calls.filter((call) => call.method === CanopyLinkMethod.RELEASE);
  const starts = () => calls.filter((call) => call.payload.op === "start");
  return {
    client,
    connections,
    offers,
    releases,
    starts,
    goneView: (webContentsId: number) => viewGone.get(webContentsId)?.(),
    linkReopened: () =>
      sessionListeners.forEach((listener) =>
        listener("studio", { registerCallHandler: () => () => {} })
      ),
    /** The host saying the viewer's stream ended. */
    streamEnded: (viewerId: string, watchId: number) =>
      viewerListeners.forEach((listener) =>
        listener("studio", {
          endpointId: `${CANOPY_VIEWER_ENDPOINT_PREFIX}${viewerId}`,
          channel: "canopy:terminal-data",
          args: [{ kind: "ended", watchId, runId: "daintree-sign-in-1" }],
        } as unknown as EventMessage)
      ),
  };
}

/** Lets the start's answer and its offer go out. */
async function settleStart(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

const PENDING = "still pending";
/** What a promise has settled to by now, or PENDING. */
async function peek<T>(promise: Promise<T>): Promise<T | typeof PENDING> {
  return Promise.race<T | typeof PENDING>([promise, settleStart().then(() => PENDING)]);
}

function opts(
  extra: { canDeliver?: () => boolean; stillShown?: () => boolean; signal?: AbortSignal } = {}
) {
  return { hostName: "Studio", canDeliver: () => true, stillShown: () => true, ...extra };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("CanopyHostsClient sign-ins started for an assistant (#18197)", () => {
  it("starts it for the asking view, offers it there, and answers shown once that view has it live on screen", async () => {
    const s = setup();
    let shown = true;
    const answer = s.client.offerSignIn(VIEW, "studio", "codex", opts({ stillShown: () => shown }));
    await settleStart();

    expect(s.starts()).toEqual([
      {
        method: CanopyLinkMethod.SIGN_IN,
        payload: { viewerId: "v1", op: "start", agentId: "codex" },
      },
    ]);
    const [offer] = s.offers();
    expect(offer).toMatchObject({
      webContentsId: VIEW,
      event: {
        hostId: "studio",
        hostName: "Studio",
        agentId: "codex",
        terminal: { terminalId: "daintree-sign-in-1", spawnedAt: 100 },
      },
    });
    const { consumer, expiresAt } = offer!.event as { consumer: string; expiresAt: number };
    expect(expiresAt).toBeGreaterThan(Date.now());

    // Before its stream is open there, nothing is shown yet.
    expect(s.client.signInShown(VIEW, consumer)).toBe("not_shown");
    await s.client.signInStep(VIEW, consumer, { op: "watch" });
    // Another view never speaks for it.
    expect(s.client.signInShown(OTHER_VIEW, consumer)).toBe("gone");
    shown = false;
    expect(s.client.signInShown(VIEW, consumer)).toBe("not_shown");
    expect(await peek(answer)).toBe(PENDING);

    shown = true;
    expect(s.client.signInShown(VIEW, consumer)).toBe("shown");
    await expect(answer).resolves.toBe("shown");
    expect(s.client.signInShown(VIEW, consumer)).toBe("gone");

    // Handed to the person now: it keeps running for that view.
    expect(s.releases()).toEqual([]);
    await expect(s.client.signInStep(VIEW, consumer, { op: "watch" })).resolves.toMatchObject({
      watchId: 9,
    });
  });

  it("takes no word of a stream that ended, or opened with no screen, or after its deadline", async () => {
    const watches: unknown[] = [
      { watchId: 9, snapshot: { data: "", cols: 80, rows: 24 } },
      { watchId: 10, snapshot: null },
    ];
    const s = setup({
      answer: (method, payload) => {
        if (method !== CanopyLinkMethod.SIGN_IN) return null;
        if (payload.op === "start") return { terminalId: "daintree-sign-in-1", spawnedAt: 100 };
        if (payload.op === "watch") return watches.shift() ?? null;
        return null;
      },
    });
    const answer = s.client.offerSignIn(VIEW, "studio", "codex", opts());
    await settleStart();
    const consumer = (s.offers()[0]?.event as { consumer: string }).consumer;
    await s.client.signInStep(VIEW, consumer, { op: "watch" });
    s.streamEnded("v1", 9);
    expect(s.client.signInShown(VIEW, consumer)).toBe("not_shown");
    await s.client.signInStep(VIEW, consumer, { op: "watch" });
    expect(s.client.signInShown(VIEW, consumer)).toBe("not_shown");
    expect(await peek(answer)).toBe(PENDING);

    // Past its deadline, before the timer has run, it is no longer taken.
    const later = setup();
    const lateAnswer = later.client.offerSignIn(VIEW, "studio", "codex", opts());
    await settleStart();
    const lateConsumer = (later.offers()[0]?.event as { consumer: string }).consumer;
    await later.client.signInStep(VIEW, lateConsumer, { op: "watch" });
    const now = vi.spyOn(Date, "now").mockReturnValue(Date.now() + SIGN_IN_OFFER_MS);
    expect(later.client.signInShown(VIEW, lateConsumer)).toBe("gone");
    now.mockRestore();
    expect(await peek(lateAnswer)).toBe(PENDING);
  });

  it("counts a stream still open when an older overlapping one is let go", async () => {
    let next = 20;
    const s = setup({
      answer: (method, payload) => {
        if (method !== CanopyLinkMethod.SIGN_IN) return null;
        if (payload.op === "start") return { terminalId: "daintree-sign-in-1", spawnedAt: 100 };
        if (payload.op === "watch") {
          return { watchId: next++, snapshot: { data: "", cols: 80, rows: 24 } };
        }
        return null;
      },
    });
    const answer = s.client.offerSignIn(VIEW, "studio", "codex", opts());
    await settleStart();
    const consumer = (s.offers()[0]?.event as { consumer: string }).consumer;
    // StrictMode's replay: two watches overlap, and the first is let go last.
    await s.client.signInStep(VIEW, consumer, { op: "watch" });
    await s.client.signInStep(VIEW, consumer, { op: "watch" });
    await s.client.signInStep(VIEW, consumer, { op: "unwatch", watchId: 20 });
    expect(s.client.signInShown(VIEW, consumer)).toBe("shown");
    await expect(answer).resolves.toBe("shown");
  });

  it("isn't told to a view that no longer shows the assistant when it starts", async () => {
    const s = setup();
    await expect(
      s.client.offerSignIn(VIEW, "studio", "codex", opts({ canDeliver: () => false }))
    ).resolves.toBe("undelivered");
    expect(s.offers()).toEqual([]);
    expect(s.releases()).toHaveLength(1);
  });

  it("takes no word of a stream the view has let go", async () => {
    const s = setup();
    const answer = s.client.offerSignIn(VIEW, "studio", "codex", opts());
    await settleStart();
    const consumer = (s.offers()[0]?.event as { consumer: string }).consumer;
    await s.client.signInStep(VIEW, consumer, { op: "watch" });
    await s.client.signInStep(VIEW, consumer, { op: "unwatch", watchId: 9 });
    expect(s.client.signInShown(VIEW, consumer)).toBe("not_shown");
    expect(await peek(answer)).toBe(PENDING);
  });

  it("starts none over a sign-in already open in that view, and isn't held up by one in another", async () => {
    const s = setup();
    await s.client.startSignIn(OTHER_VIEW, "dialog-0", "studio", "claude");
    void s.client.offerSignIn(VIEW, "studio", "codex", opts());
    await settleStart();
    expect(s.starts()).toHaveLength(2);

    await expect(s.client.offerSignIn(VIEW, "studio", "codex", opts())).resolves.toBe("busy");
    expect(s.starts()).toHaveLength(2);
    expect(s.offers()).toHaveLength(1);
  });

  it("lets one nobody opened go at its deadline, and takes no word of it after", async () => {
    vi.useFakeTimers();
    const s = setup();
    const answer = s.client.offerSignIn(VIEW, "studio", "codex", opts({ stillShown: () => false }));
    await settleStart();
    const consumer = (s.offers()[0]?.event as { consumer: string }).consumer;
    await s.client.signInStep(VIEW, consumer, { op: "watch" });
    // A view no longer on screen shows it to nobody.
    expect(s.client.signInShown(VIEW, consumer)).toBe("not_shown");
    await vi.advanceTimersByTimeAsync(SIGN_IN_OFFER_MS - 1);
    expect(await peek(answer)).toBe(PENDING);
    await vi.advanceTimersByTimeAsync(1);
    await expect(answer).resolves.toBe("expired");
    expect(s.releases()).toEqual([
      { method: CanopyLinkMethod.RELEASE, payload: { viewerId: "v1" } },
    ]);
    expect(s.client.signInShown(VIEW, consumer)).toBe("gone");
  });

  it("holds a slow start to the same deadline", async () => {
    vi.useFakeTimers();
    let finishStart: (value: unknown) => void = () => {};
    const s = setup({
      answer: (_method, payload) =>
        payload.op === "start"
          ? new Promise((resolve) => {
              finishStart = resolve;
            })
          : null,
    });
    const answer = s.client.offerSignIn(VIEW, "studio", "codex", opts());
    await vi.advanceTimersByTimeAsync(SIGN_IN_OFFER_MS - 1);
    expect(await peek(answer)).toBe(PENDING);
    await vi.advanceTimersByTimeAsync(1);
    await expect(answer).resolves.toBe("expired");
    // Let go while it started: the host is told at once.
    expect(s.releases()).toHaveLength(1);
    finishStart({ terminalId: "daintree-sign-in-1", spawnedAt: 100 });
    await settleStart();
    expect(s.offers()).toEqual([]);
  });

  it("answers withdrawn, and lets it go on the host, when it ends before it is live", async () => {
    const endings: Array<[string, (s: ReturnType<typeof setup>, consumer: string) => void]> = [
      ["let go in the view", (s, consumer) => s.client.releaseSignIn(VIEW, consumer)],
      ["the view gone", (s) => s.goneView(VIEW)],
    ];
    for (const [name, end] of endings) {
      const s = setup();
      const answer = s.client.offerSignIn(VIEW, "studio", "codex", opts());
      await settleStart();
      const consumer = (s.offers()[0]?.event as { consumer: string }).consumer;
      end(s, consumer);
      await expect(answer, name).resolves.toBe("withdrawn");
      expect(s.releases(), name).toHaveLength(1);
      expect(s.client.signInShown(VIEW, consumer), name).toBe("gone");
    }
    // A link that comes back has already ended it on the host.
    const s = setup();
    const answer = s.client.offerSignIn(VIEW, "studio", "codex", opts());
    await settleStart();
    s.linkReopened();
    await expect(answer).resolves.toBe("withdrawn");
  });

  it("ends it when the call is cancelled, a start still in flight included, and starts none once cancelled", async () => {
    let finishStart: (value: unknown) => void = () => {};
    const s = setup({
      answer: (_method, payload) =>
        payload.op === "start"
          ? new Promise((resolve) => {
              finishStart = resolve;
            })
          : null,
    });
    const abort = new AbortController();
    const answer = s.client.offerSignIn(VIEW, "studio", "codex", opts({ signal: abort.signal }));
    await settleStart();
    abort.abort();
    await expect(answer).resolves.toBe("cancelled");
    expect(s.releases()).toHaveLength(1);
    finishStart({ terminalId: "daintree-sign-in-1", spawnedAt: 100 });
    await settleStart();
    expect(s.offers()).toEqual([]);

    const before = s.starts().length;
    await expect(
      s.client.offerSignIn(VIEW, "studio", "codex", opts({ signal: abort.signal }))
    ).resolves.toBe("cancelled");
    expect(s.starts()).toHaveLength(before);
  });

  it("leaves a sign-in the view has live running when the call is cancelled after", async () => {
    const s = setup();
    const abort = new AbortController();
    const answer = s.client.offerSignIn(VIEW, "studio", "codex", opts({ signal: abort.signal }));
    await settleStart();
    const consumer = (s.offers()[0]?.event as { consumer: string }).consumer;
    await s.client.signInStep(VIEW, consumer, { op: "watch" });
    s.client.signInShown(VIEW, consumer);
    await expect(answer).resolves.toBe("shown");
    abort.abort();
    expect(s.releases()).toEqual([]);
  });

  it("lets go of one the view couldn't be told of, after trying to tell it", async () => {
    const s = setup({ send: () => false });
    await expect(s.client.offerSignIn(VIEW, "studio", "codex", opts())).resolves.toBe(
      "undelivered"
    );
    expect(s.offers()).toHaveLength(1);
    expect(s.releases()).toHaveLength(1);
  });

  it("says why a start failed, by its code alone, and offers nothing", async () => {
    const cases: Array<[string, string]> = [
      ["UNSUPPORTED", "unsupported"],
      ["RATE_LIMITED", "rate_limited"],
      ["OUTCOME_UNKNOWN", "disconnected"],
      ["CANCELLED", "withdrawn"],
      ["NOT_FOUND", "withdrawn"],
      ["INTERNAL", "failed"],
    ];
    for (const [code, expected] of cases) {
      const s = setup({
        answer: () => {
          throw new AppError({ code: code as "INTERNAL", message: "SENTINEL from the host" });
        },
      });
      await expect(s.client.offerSignIn(VIEW, "studio", "codex", opts()), code).resolves.toBe(
        expected
      );
      expect(s.offers(), code).toEqual([]);
    }
    const s = setup();
    s.connections.delete("studio");
    await expect(s.client.offerSignIn(VIEW, "studio", "codex", opts())).resolves.toBe(
      "disconnected"
    );
  });

  it("settles a waiting offer when the client is disposed", async () => {
    const s = setup();
    const answer = s.client.offerSignIn(VIEW, "studio", "codex", opts());
    await settleStart();
    s.client.dispose();
    await expect(answer).resolves.toBe("cancelled");
  });
});
