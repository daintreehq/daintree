// @vitest-environment node
import { describe, expect, it, vi, type Mock } from "vitest";
import type { HostDescriptor } from "../../../../shared/types/remoteHosts.js";
import { AppError } from "../../../utils/errorTypes.js";
import { LinkMethod } from "../../host/linkMethods.js";
import type { LinkSession } from "../../link/session.js";
import { CloudMcpServerOnConnect, mcpServerUnconfirmedToast } from "../CloudMcpServerOnConnect.js";
import { CloudHostStore, type CloudHostsValue } from "../CloudHostStore.js";

const ACCOUNT = "ca_abcdefgh";
const BINDING = "cb_abcdefgh";
const HOST = "build";

type Call = Mock<(method: string, payload: unknown, options?: unknown) => Promise<unknown>>;

function setup(options: { asked?: boolean; connection?: HostDescriptor["connection"] } = {}) {
  let backendValue: unknown;
  const store = new CloudHostStore({
    get: () => backendValue,
    set: (_key: "cloudHosts", value: CloudHostsValue) => {
      backendValue = JSON.parse(JSON.stringify(value));
    },
  });
  store.putBinding({
    id: BINDING,
    hostId: HOST,
    accountId: ACCOUNT,
    providerId: "agent37",
    resourceId: "inst-1",
    ownership: "created-by-daintree",
    createdFor: null,
    worktreeCleanup: null,
    provisioning: null,
    creation: null,
    lifetimeSeconds: null,
    intent: null,
    observation: null,
    access: null,
    trustedHostKey: null,
    offeredHostKey: null,
    lastError: null,
    createdAt: 0,
    ...(options.asked === false ? {} : { mcpServerOnConnect: true as const }),
  });
  const host = {
    id: HOST,
    name: "Build box",
    connection: options.connection ?? { kind: "cloud", bindingId: BINDING },
  } as HostDescriptor;
  const makeSession = (answer: (method: string) => Promise<unknown>, isOpen = true) => {
    const call: Call = vi.fn((method: string) => answer(method));
    return { link: { isOpen, call } as unknown as LinkSession, call };
  };
  let current = makeSession(async () => ({ running: true }));
  const unconfirmed = vi.fn();
  const onConnect = new CloudMcpServerOnConnect({
    store,
    hosts: { get: (hostId) => (hostId === HOST ? host : null) },
    sessionFor: (hostId) => (hostId === HOST ? current.link : null),
    unconfirmed,
  });
  return {
    store,
    host,
    onConnect,
    unconfirmed,
    asked: () => store.binding(BINDING)?.mcpServerOnConnect === true,
    connect(
      answer: (method: string) => Promise<unknown> = async () => ({ running: true }),
      isOpen = true
    ) {
      current = makeSession(answer, isOpen);
      onConnect.sessionOpened(HOST, current.link);
      return current;
    },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("CloudMcpServerOnConnect", () => {
  it("asks the host once, on its first link, and never on a later one", async () => {
    const t = setup();

    const first = t.connect();
    await settle();
    expect(first.call).toHaveBeenCalledExactlyOnceWith(LinkMethod.ENABLE_MCP_SERVER, null, {
      timeoutMs: expect.any(Number),
    });
    // A deadline, so a host that never answers doesn't hold the ask open.
    const { timeoutMs } = first.call.mock.calls[0]![2] as { timeoutMs: number };
    expect(timeoutMs).toBeGreaterThan(0);
    expect(Number.isFinite(timeoutMs)).toBe(true);
    expect(t.asked()).toBe(false);
    expect(t.unconfirmed).not.toHaveBeenCalled();

    const second = t.connect();
    await settle();
    expect(second.call).not.toHaveBeenCalled();
  });

  it("takes the ask off the binding before the host answers, so a lost answer is never asked again", async () => {
    const t = setup();
    let release!: () => void;
    let askedAtSend: boolean | null = null;
    const first = t.connect(() => {
      askedAtSend = t.asked();
      return new Promise((resolve) => (release = () => resolve(null)));
    });

    expect(first.call).toHaveBeenCalledTimes(1);
    expect(askedAtSend).toBe(false);
    expect(t.asked()).toBe(false);

    // The link drops before the answer, and the host comes back.
    const again = t.connect();
    await settle();
    expect(again.call).not.toHaveBeenCalled();
    release();
  });

  it("asks nothing of a host whose person didn't ask for it", async () => {
    const t = setup({ asked: false });
    const session = t.connect();
    await settle();
    expect(session.call).not.toHaveBeenCalled();
  });

  it("leaves the ask for the link that replaced one already gone", async () => {
    const t = setup();
    const stale = { isOpen: true, call: vi.fn() } as unknown as LinkSession;
    t.onConnect.sessionOpened(HOST, stale);
    expect(stale.call).not.toHaveBeenCalled();
    expect(t.asked()).toBe(true);

    const session = t.connect();
    await settle();
    expect(session.call).toHaveBeenCalledTimes(1);
  });

  it("leaves the ask for a later link when the current one is already closed", async () => {
    const t = setup();
    const closed = t.connect(undefined, false);
    await settle();
    expect(closed.call).not.toHaveBeenCalled();
    expect(t.asked()).toBe(true);
  });

  it.each([
    ["names another binding", { kind: "cloud", bindingId: "cb_otherone" }],
    ["is no longer a cloud host", { kind: "ssh", target: "build.local" }],
  ])("asks nothing when the host %s", async (_case, connection) => {
    const t = setup({ connection: connection as HostDescriptor["connection"] });
    const session = t.connect();
    await settle();
    expect(session.call).not.toHaveBeenCalled();
    expect(t.asked()).toBe(true);
  });

  it("asks nothing while the ask can't be taken off, and leaves it for the next link", async () => {
    const t = setup();
    const update = vi.spyOn(t.store, "updateBinding").mockImplementationOnce(() => {
      throw new Error("ENOSPC");
    });
    const first = t.connect();
    await settle();
    expect(first.call).not.toHaveBeenCalled();
    expect(t.unconfirmed).toHaveBeenCalledExactlyOnceWith(t.host, "WRITE_FAILED");
    expect(t.asked()).toBe(true);

    update.mockRestore();
    const second = t.connect();
    await settle();
    expect(second.call).toHaveBeenCalledTimes(1);
    expect(t.asked()).toBe(false);
  });

  it.each([
    ["answers that the server didn't start", async () => ({ running: false }), null],
    ["answers something it can't read", async () => ({ running: "yes" }), "VALIDATION"],
    [
      "is too old to know the call",
      async () => {
        throw new AppError({ code: "UNSUPPORTED", message: "Unknown method" });
      },
      "UNSUPPORTED",
    ],
    [
      "can't be reached as the call is sent",
      async () => {
        throw new AppError({ code: "HOST_DISCONNECTED", message: "gone" });
      },
      "HOST_DISCONNECTED",
    ],
    [
      "drops the link after the call reached it",
      async () => {
        throw new AppError({ code: "OUTCOME_UNKNOWN", message: "closed before an answer" });
      },
      "OUTCOME_UNKNOWN",
    ],
    [
      "fails in a way that names no code",
      async () => {
        throw new Error("boom");
      },
      null,
    ],
  ])(
    "says the server wasn't confirmed when the host %s, and doesn't ask again",
    async (_case, answer, code) => {
      const t = setup();
      t.connect(answer);
      await settle();
      expect(t.unconfirmed).toHaveBeenCalledExactlyOnceWith(t.host, code);

      const again = t.connect();
      await settle();
      expect(again.call).not.toHaveBeenCalled();
    }
  );

  it("asks nothing once disposed, and says nothing for a call that settles after", async () => {
    const t = setup();
    let release!: () => void;
    t.connect(() => new Promise((resolve) => (release = () => resolve({ running: false }))));
    t.onConnect.dispose();
    release();
    await settle();
    expect(t.unconfirmed).not.toHaveBeenCalled();

    const fresh = setup();
    fresh.onConnect.dispose();
    const session = fresh.connect();
    await settle();
    expect(session.call).not.toHaveBeenCalled();
    expect(fresh.asked()).toBe(true);
  });

  it("names the host and where to check in an inbox notice, one per host whatever it's called", () => {
    const t = setup();
    const toast = mcpServerUnconfirmedToast(t.host);
    expect(toast.priority).toBe("low");
    expect(toast.message).toContain("Build box");
    expect(toast.message).toContain("Settings → Integrations → MCP server");
    expect(mcpServerUnconfirmedToast({ ...t.host, name: "Renamed" }).replaceKey).toBe(
      toast.replaceKey
    );
    expect(toast.replaceKey).not.toBe(
      mcpServerUnconfirmedToast({ ...t.host, id: "other" }).replaceKey
    );
  });
});
