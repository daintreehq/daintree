import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BridgeError,
  MemoryKeyStore,
  MemoryLocalStore,
  loadIdentity,
  paneIdentityOf,
  type DecisionsBridge,
  type Identity,
  type QuestionOrigin,
  type StoredIdentity,
} from "@daintreehq/decisions-client";
import {
  generateDeviceKeys,
  generateEpochKeyBytes,
  serializeDeviceKeys,
} from "@daintreehq/decisions-crypto";
import { bytesToBase64Url } from "@daintreehq/decisions-protocol";

vi.mock("electron", () => ({
  net: { isOnline: () => true },
  powerMonitor: { on: vi.fn(), off: vi.fn() },
}));

import { QuestionBridge } from "../questionBridge.js";
import type { QuestionSource } from "../relayConnection.js";

const ORIGIN: QuestionOrigin = {
  host_id: "host_a",
  pane_id: "pane-1",
  terminal_generation: 1,
  ownership_principal: "principal-1",
  agent_incarnation: "0",
  agent_kind: "claude",
  agent_session_id: null,
  project_id: "p1",
  worktree_id: "wt-1",
  worktree_root: "/repo",
  workflow_gate_id: null,
};

async function storedIdentity(): Promise<StoredIdentity> {
  return {
    v: 1,
    config: {
      relayOrigin: "https://decisions.example.workers.dev",
      installationId: "inst_12345678",
      deviceId: "dev_12345678",
      label: "Test desktop",
    },
    keys: await serializeDeviceKeys(await generateDeviceKeys(true)),
    epochs: [{ epoch: 1, raw: bytesToBase64Url(generateEpochKeyBytes()) }],
    currentEpoch: 1,
  };
}

async function identityOf(stored: StoredIdentity): Promise<Identity> {
  const keys = new MemoryKeyStore();
  await keys.save(stored);
  return loadIdentity(keys);
}

function liveBridge() {
  return {
    registerQuestion: vi.fn(async () => ({
      questionId: "q_live",
      alias: 1,
      requirement: "human-required" as const,
      status: "queued" as const,
      duplicate: false,
    })),
    getDecision: vi.fn(async () => ({ questionId: "q_live" })),
    cancelQuestion: vi.fn(async () => {}),
    listPending: vi.fn(async () => []),
  };
}

describe("QuestionBridge", () => {
  let store: MemoryLocalStore;
  let identity: Identity | null;
  let live: ReturnType<typeof liveBridge> | null;
  let current: boolean;
  let source: QuestionSource;
  let fetches: number;

  beforeEach(async () => {
    store = new MemoryLocalStore();
    identity = await identityOf(await storedIdentity());
    live = null;
    current = true;
    fetches = 0;
    source = {
      identity: () => identity,
      live: () => live as unknown as DecisionsBridge | null,
      store,
    };
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      fetches += 1;
      throw new Error("no network in this test");
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function bridge(): QuestionBridge {
    return new QuestionBridge({ source, isCurrent: () => current });
  }

  it("asks, reads and cancels through the live attempt's bridge when there is one", async () => {
    const b = bridge();
    live = liveBridge();
    const pane = paneIdentityOf(ORIGIN);

    await b.registerQuestion({ origin: ORIGIN, input: { question: "Now?" } });
    await b.getDecision("q_live", pane);
    await b.cancelQuestion("q_live", pane);

    expect(live.registerQuestion).toHaveBeenCalledWith({ origin: ORIGIN, input: { question: "Now?" } });
    expect(live.getDecision).toHaveBeenCalledWith("q_live", pane);
    expect(live.cancelQuestion).toHaveBeenCalledWith("q_live", pane);
    expect(await store.listQuestions()).toEqual([]);
  });

  it("commits locally between attempts and publishes nothing itself", async () => {
    const b = bridge();
    const result = await b.registerQuestion({ origin: ORIGIN, input: { question: "Later?" } });
    // Anything a pump would do runs on a later turn.
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(b.state).toBe("stopped");
    expect(fetches).toBe(0);
    const row = await store.getQuestion(result.questionId);
    expect(row?.origin).toEqual(ORIGIN);
    expect(row?.local_status).toBe("queued");
    expect((await store.outboxFor(result.questionId)).map((item) => item.kind)).toEqual(["create"]);

    // The next attempt's bridge sees the same question.
    live = liveBridge();
    await b.getDecision(result.questionId, paneIdentityOf(ORIGIN));
    expect(live.getDecision).toHaveBeenCalledWith(result.questionId, paneIdentityOf(ORIGIN));
  });

  it("asks under the identity the attempts last held", async () => {
    const b = bridge();
    const rotated = await identityOf(await storedIdentity());
    identity = rotated;
    await b.registerQuestion({ origin: ORIGIN, input: { question: "Rotated?" } });
    expect(b.ctx.identity).toBe(rotated);
  });

  it("never falls back to itself once the connection has ended, as after a revocation", async () => {
    const b = bridge();
    identity = null;
    await expect(b.registerQuestion({ origin: ORIGIN, input: { question: "Still?" } })).rejects.toThrow(
      BridgeError
    );
    await expect(b.getDecision("q_any", paneIdentityOf(ORIGIN))).rejects.toMatchObject({
      code: "forbidden",
    });
    expect(await store.listQuestions()).toEqual([]);
  });

  it("refuses a pane that is no longer the run it was let in as, and a call with no pane", async () => {
    const b = bridge();
    live = liveBridge();
    current = false;
    await expect(b.registerQuestion({ origin: ORIGIN, input: { question: "Mine?" } })).rejects.toMatchObject(
      { code: "forbidden" }
    );
    await expect(b.cancelQuestion("q_live", paneIdentityOf(ORIGIN))).rejects.toMatchObject({
      code: "forbidden",
    });
    current = true;
    await expect(b.getDecision("q_live")).rejects.toMatchObject({ code: "not_found" });
    expect(live.registerQuestion).not.toHaveBeenCalled();
    expect(live.cancelQuestion).not.toHaveBeenCalled();
    expect(live.getDecision).not.toHaveBeenCalled();
  });

  it("runs asks one at a time, so a refused one doesn't hold up the next", async () => {
    const b = bridge();
    live = liveBridge();
    let release!: () => void;
    live.registerQuestion.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          release = () => reject(new BridgeError("validation_error", "bad"));
        })
    );
    const first = b.registerQuestion({ origin: ORIGIN, input: { question: "One?" } });
    const second = b.registerQuestion({ origin: ORIGIN, input: { question: "Two?" } });
    await vi.waitFor(() => expect(live!.registerQuestion).toHaveBeenCalledTimes(1));
    release();
    await expect(first).rejects.toThrow("bad");
    await expect(second).resolves.toMatchObject({ questionId: "q_live" });
    expect(live.registerQuestion).toHaveBeenCalledTimes(2);
  });
});
