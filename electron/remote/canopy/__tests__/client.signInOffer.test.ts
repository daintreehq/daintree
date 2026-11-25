import { afterEach, describe, expect, it, vi } from "vitest";
import type { CanopyHostEvent } from "../../../../shared/types/ipc/canopyHost.js";
import { wrapSuccess } from "../../../../shared/utils/ipcErrorSerialization.js";
import { AppError } from "../../../utils/errorTypes.js";
import { CanopyHostsClient, SIGN_IN_OFFER_MS } from "../client.js";
import { CanopyLinkMethod } from "../linkMethods.js";
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
      onViewerEvent: () => () => {},
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
  };
}

/** Lets the start's answer and its offer go out. */
async function settleStart(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

afterEach(() => {
  vi.useRealTimers();
});

describe("CanopyHostsClient sign-ins started for an assistant (#18197)", () => {
  it("starts it for the asking view, offers it there, and answers shown once that view has it live", async () => {
    const s = setup();
    let shown = true;
    const answer = s.client.offerSignIn(VIEW, "studio", "codex", { stillShown: () => shown });
    await settleStart();

    expect(s.starts()).toEqual([
      { method: CanopyLinkMethod.SIGN_IN, payload: { viewerId: "v1", op: "start", agentId: "codex" } },
    ]);
    const [offer] = s.offers();
    expect(offer).toMatchObject({
      webContentsId: VIEW,
      event: {
        kind: "sign-in-offer",
        hostId: "studio",
        agentId: "codex",
        terminal: { terminalId: "daintree-sign-in-1", spawnedAt: 100 },
      },
    });
    if (offer?.event.kind !== "sign-in-offer") throw new Error("no offer");
    const { consumer, expiresAt } = offer.event;
    expect(expiresAt).toBeGreaterThan(Date.now());

    // Only the view it was started in, while it is on screen, can say so.
    s.client.signInShown(OTHER_VIEW, consumer);
    shown = false;
    s.client.signInShown(VIEW, consumer);
    shown = true;
    s.client.signInShown(VIEW, consumer);
    await expect(answer).resolves.toBe("shown");

    // Handed to the person now: it keeps running, and that view watches it as its own.
    expect(s.releases()).toEqual([]);
    await expect(s.client.signInStep(VIEW, consumer, { op: "watch" })).resolves.toMatchObject({
      watchId: 9,
    });
  });

  it("starts none over a sign-in already open in that view", async () => {
    const s = setup();
    await s.client.startSignIn(VIEW, "dialog-1", "studio", "claude");
    await expect(
      s.client.offerSignIn(VIEW, "studio", "codex", { stillShown: () => true })
    ).resolves.toBe("busy");
    expect(s.starts()).toHaveLength(1);
    expect(s.offers()).toEqual([]);
  });

  it("ends one nobody opened in time on its host", async () => {
    vi.useFakeTimers();
    const s = setup();
    const answer = s.client.offerSignIn(VIEW, "studio", "codex", { stillShown: () => false });
    await settleStart();
    const consumer = (s.offers()[0]?.event as { consumer: string }).consumer;
    // A view no longer on screen shows it to nobody.
    s.client.signInShown(VIEW, consumer);
    await vi.advanceTimersByTimeAsync(SIGN_IN_OFFER_MS);
    await expect(answer).resolves.toBe("expired");
    expect(s.releases()).toEqual([
      { method: CanopyLinkMethod.RELEASE, payload: { viewerId: "v1" } },
    ]);
    await expect(s.client.signInStep(VIEW, consumer, { op: "watch" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
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
    const answer = s.client.offerSignIn(VIEW, "studio", "codex", { stillShown: () => true });
    await vi.advanceTimersByTimeAsync(SIGN_IN_OFFER_MS);
    await expect(answer).resolves.toBe("expired");
    finishStart({ terminalId: "daintree-sign-in-1", spawnedAt: 100 });
    await settleStart();
    // Started for nobody: ended on its host, and never offered.
    expect(s.offers()).toEqual([]);
    expect(s.releases()).toHaveLength(1);
  });

  it("answers withdrawn when it ends before it is live: let go in the view, the view gone, or its link reopened", async () => {
    const endings: Array<(s: ReturnType<typeof setup>, consumer: string) => void> = [
      (s, consumer) => s.client.releaseSignIn(VIEW, consumer),
      (s) => s.goneView(VIEW),
      (s) => s.linkReopened(),
    ];
    for (const end of endings) {
      const s = setup();
      const answer = s.client.offerSignIn(VIEW, "studio", "codex", { stillShown: () => true });
      await settleStart();
      const consumer = (s.offers()[0]?.event as { consumer: string }).consumer;
      end(s, consumer);
      await expect(answer).resolves.toBe("withdrawn");
      // Saying shown afterwards changes nothing.
      s.client.signInShown(VIEW, consumer);
    }
  });

  it("ends it when the call is cancelled before the view opens it, and starts none once cancelled", async () => {
    const s = setup();
    const abort = new AbortController();
    const answer = s.client.offerSignIn(VIEW, "studio", "codex", {
      stillShown: () => true,
      signal: abort.signal,
    });
    await settleStart();
    abort.abort();
    await expect(answer).resolves.toBe("cancelled");
    expect(s.releases()).toHaveLength(1);

    const before = s.starts().length;
    await expect(
      s.client.offerSignIn(VIEW, "studio", "codex", { stillShown: () => true, signal: abort.signal })
    ).resolves.toBe("cancelled");
    expect(s.starts()).toHaveLength(before);
  });

  it("leaves a sign-in the view has live running when the call is cancelled after", async () => {
    const s = setup();
    const abort = new AbortController();
    const answer = s.client.offerSignIn(VIEW, "studio", "codex", {
      stillShown: () => true,
      signal: abort.signal,
    });
    await settleStart();
    s.client.signInShown(VIEW, (s.offers()[0]?.event as { consumer: string }).consumer);
    await expect(answer).resolves.toBe("shown");
    abort.abort();
    expect(s.releases()).toEqual([]);
  });

  it("ends one the view can no longer be told of", async () => {
    const s = setup({ send: () => false });
    await expect(
      s.client.offerSignIn(VIEW, "studio", "codex", { stillShown: () => true })
    ).resolves.toBe("no_window");
    expect(s.releases()).toHaveLength(1);
  });

  it("says why a start failed, by its code alone, and offers nothing", async () => {
    const cases: Array<[string, string]> = [
      ["UNSUPPORTED", "unsupported"],
      ["RATE_LIMITED", "rate_limited"],
      ["INTERNAL", "failed"],
    ];
    for (const [code, expected] of cases) {
      const s = setup({
        answer: () => {
          throw new AppError({ code: code as "INTERNAL", message: "SENTINEL from the host" });
        },
      });
      await expect(
        s.client.offerSignIn(VIEW, "studio", "codex", { stillShown: () => true })
      ).resolves.toBe(expected);
      expect(s.offers()).toEqual([]);
    }
    const s = setup();
    s.connections.delete("studio");
    await expect(
      s.client.offerSignIn(VIEW, "studio", "codex", { stillShown: () => true })
    ).resolves.toBe("disconnected");
  });
});
