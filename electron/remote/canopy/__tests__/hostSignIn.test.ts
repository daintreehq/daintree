import { describe, expect, it, vi } from "vitest";
import { wrapSuccess } from "../../../../shared/utils/ipcErrorSerialization.js";
import { HOST_SIGN_IN_TERMINAL_PREFIX } from "../../../../shared/config/terminalScreenPersistence.js";
import type { ProjectPushTarget } from "../../../ipc/utils.js";
import type { LinkSession } from "../../link/session.js";
import { Lane } from "../../link/frames.js";
import { InteractiveKind } from "../../link/messages.js";
import { installCanopyHostWith, type CanopySessionContext } from "../host.js";
import { HostSignIns, MAX_HOST_SIGN_INS, type HostSignInDeps } from "../hostSignIn.js";
import { CANOPY_VIEWER_ENDPOINT_PREFIX, CanopyLinkMethod } from "../linkMethods.js";
import { CanopyViewers } from "../viewer.js";

function fakeDeps(options: { spawn?: HostSignInDeps["spawn"] } = {}) {
  let ids = 0;
  const watches = new Map<number, { target: ProjectPushTarget; terminalId: string }>();
  let nextWatch = 0;
  const deps = {
    newId: () => `id${++ids}`,
    spawn: vi.fn(options.spawn ?? (async () => ({ spawnedAt: 500 }))),
    kill: vi.fn(),
    watch: vi.fn(async (target: ProjectPushTarget, terminalId: string) => {
      const watchId = ++nextWatch;
      watches.set(watchId, { target, terminalId });
      return { watchId, snapshot: { data: "", cols: 80, rows: 24 }, holdsSize: true };
    }),
    watched: vi.fn((target: ProjectPushTarget, watchId: number) => {
      const watch = watches.get(watchId);
      return watch && watch.target.id === target.id ? watch.terminalId : null;
    }),
    write: vi.fn(),
    resize: vi.fn(),
    unwatch: vi.fn(),
    release: vi.fn(),
  } satisfies HostSignInDeps;
  return { deps, watches };
}

function setup(options: { spawn?: HostSignInDeps["spawn"]; withSignIns?: boolean } = {}) {
  const handlers = new Map<string, (payload: unknown) => unknown>();
  const closeListeners: Array<() => void> = [];
  const posts: Array<{ lane: number; kind: number; body: { endpointId: string } }> = [];
  const session = {
    isOpen: true,
    registerCallHandler: (method: string, _schema: unknown, handler: (p: unknown) => unknown) => {
      handlers.set(method, handler);
      return () => {};
    },
    post: (message: (typeof posts)[number]) => {
      posts.push(message);
      return "queued";
    },
    call: vi.fn(async () => null),
    onClose: (listener: () => void) => {
      closeListeners.push(listener);
      return () => {};
    },
  };
  const viewers = new CanopyViewers({
    source: { observeCanopy: () => () => {}, observeFleet: () => null },
    invoke: async () => wrapSuccess(null),
  });
  const { deps, watches } = fakeDeps(options);
  const signIns = new HostSignIns(deps);
  const ctx: CanopySessionContext = {
    session: session as unknown as LinkSession,
    client: { clientId: "shell-1", clientName: "mbp", platform: "darwin" },
    sessionId: "s1",
  };
  installCanopyHostWith(
    { sessions: [ctx], onSession: () => () => {} },
    viewers,
    options.withSignIns === false ? {} : { signIns }
  );
  const shell = (method: string, payload: unknown) => {
    const handler = handlers.get(method);
    if (!handler) throw new Error(`No handler for ${method}`);
    return handler(payload);
  };
  return {
    deps,
    watches,
    signIns,
    posts,
    handlers,
    signIn: (payload: Record<string, unknown>) => shell(CanopyLinkMethod.SIGN_IN, payload),
    release: (viewerId: string) => shell(CanopyLinkMethod.RELEASE, { viewerId }),
    closeLink: () => closeListeners.forEach((listener) => listener()),
  };
}

describe("a host's agent CLI sign-ins", () => {
  it("starts the named agent's sign-in under a sign-in terminal id, in no project", async () => {
    const s = setup();
    const started = (await s.signIn({ viewerId: "a", op: "start", agentId: "claude" })) as {
      terminalId: string;
      spawnedAt: number;
    };
    expect(started.terminalId.startsWith(HOST_SIGN_IN_TERMINAL_PREFIX)).toBe(true);
    expect(started.spawnedAt).toBe(500);
    expect(s.deps.spawn).toHaveBeenCalledWith({
      terminalId: started.terminalId,
      agentId: "claude",
    });
  });

  it("streams the terminal to the Shell's viewer on the interactive lane", async () => {
    const s = setup();
    const { terminalId } = (await s.signIn({ viewerId: "a", op: "start", agentId: "claude" })) as {
      terminalId: string;
    };
    const view = (await s.signIn({ viewerId: "a", op: "watch" })) as { watchId: number };
    expect(s.deps.watch.mock.calls[0]![1]).toBe(terminalId);
    const target = s.deps.watch.mock.calls[0]![0];
    target.send("canopy:terminal-data", { kind: "data", watchId: view.watchId, data: "hi" });
    // Nothing but the terminal's bytes ever reaches a sign-in's viewer.
    target.send("canopy:snapshot-updated", { runs: [] });
    expect(s.posts).toHaveLength(1);
    expect(s.posts[0]).toMatchObject({
      lane: Lane.INTERACTIVE,
      kind: InteractiveKind.CANOPY_TERMINAL,
      body: { endpointId: `${CANOPY_VIEWER_ENDPOINT_PREFIX}a` },
    });
  });

  it("types and sizes only through the stream it opened on its own terminal", async () => {
    const s = setup();
    const { terminalId } = (await s.signIn({ viewerId: "a", op: "start", agentId: "claude" })) as {
      terminalId: string;
    };
    const { watchId } = (await s.signIn({ viewerId: "a", op: "watch" })) as { watchId: number };
    await s.signIn({ viewerId: "a", op: "input", watchId, data: "code\r" });
    await s.signIn({ viewerId: "a", op: "resize", watchId, cols: 100, rows: 30 });
    expect(s.deps.write).toHaveBeenCalledWith(terminalId, "code\r");
    expect(s.deps.resize).toHaveBeenCalledWith(expect.anything(), watchId, 100, 30);

    await expect(
      s.signIn({ viewerId: "a", op: "input", watchId: watchId + 1, data: "x" })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    // Another viewer, with no sign-in of its own, can't reach this one.
    await expect(
      s.signIn({ viewerId: "b", op: "input", watchId, data: "x" })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(s.signIn({ viewerId: "b", op: "unwatch", watchId })).resolves.toBeNull();
    expect(s.deps.write).toHaveBeenCalledTimes(1);
  });

  it("ends the terminal when its viewer is released, and when the link drops", async () => {
    const s = setup();
    const first = (await s.signIn({ viewerId: "a", op: "start", agentId: "claude" })) as {
      terminalId: string;
    };
    const second = (await s.signIn({ viewerId: "b", op: "start", agentId: "codex" })) as {
      terminalId: string;
    };
    s.release("a");
    expect(s.deps.kill).toHaveBeenCalledWith(first.terminalId);
    expect(s.deps.release).toHaveBeenCalledTimes(1);
    s.closeLink();
    expect(s.deps.kill).toHaveBeenCalledWith(second.terminalId);
    expect(s.signIns.size).toBe(0);
  });

  it("ends a terminal that started after its viewer went", async () => {
    let finish: (value: { spawnedAt: number }) => void = () => {};
    const s = setup({
      spawn: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    });
    const started = s.signIn({ viewerId: "a", op: "start", agentId: "claude" }) as Promise<unknown>;
    await Promise.resolve();
    s.release("a");
    expect(s.deps.kill).not.toHaveBeenCalled();
    finish({ spawnedAt: 1 });
    await expect(started).rejects.toMatchObject({ code: "CANCELLED" });
    const terminalId = s.deps.spawn.mock.calls[0]![0].terminalId;
    expect(s.deps.kill).toHaveBeenCalledWith(terminalId);
    expect(s.signIns.size).toBe(0);
  });

  it("frees its place when the spawn fails", async () => {
    const s = setup({
      spawn: async () => {
        throw Object.assign(new Error("no shell"), { code: "INTERNAL" });
      },
    });
    await expect(s.signIn({ viewerId: "a", op: "start", agentId: "claude" })).rejects.toThrow(
      "no shell"
    );
    expect(s.signIns.size).toBe(0);
    await expect(s.signIn({ viewerId: "a", op: "watch" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("starts one sign-in per viewer, and a bounded number at once", async () => {
    const s = setup();
    await s.signIn({ viewerId: "a", op: "start", agentId: "claude" });
    await expect(
      s.signIn({ viewerId: "a", op: "start", agentId: "codex" })
    ).rejects.toMatchObject({ code: "VALIDATION" });
    for (let i = 1; i < MAX_HOST_SIGN_INS; i++) {
      await s.signIn({ viewerId: `v${i}`, op: "start", agentId: "claude" });
    }
    await expect(
      s.signIn({ viewerId: "over", op: "start", agentId: "claude" })
    ).rejects.toMatchObject({ code: "RATE_LIMITED" });
  });

  it("refuses every step but a start from a viewer that started none", async () => {
    const s = setup();
    await expect(s.signIn({ viewerId: "a", op: "watch" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(s.deps.spawn).not.toHaveBeenCalled();
  });

  it("isn't offered by a host that runs none", () => {
    const s = setup({ withSignIns: false });
    expect(s.handlers.has(CanopyLinkMethod.SIGN_IN)).toBe(false);
    expect(s.handlers.has(CanopyLinkMethod.INVOKE)).toBe(true);
  });
});
