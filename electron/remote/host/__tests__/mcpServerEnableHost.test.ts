// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const svc = vi.hoisted(() => ({
  running: false,
  /** How the next start goes: bound, couldn't bind (left off, no error), or threw. */
  start: "binds" as "binds" | "fails" | "throws",
  /** Held until released, when set: the start is still under way. */
  hold: null as Promise<void> | null,
  setEnabled: null as unknown as (enabled: boolean) => Promise<void>,
}));
svc.setEnabled = vi.fn(async (enabled: boolean) => {
  if (svc.hold) await svc.hold;
  if (!enabled) return;
  if (svc.start === "throws") throw new Error("No free port between 45454 and 45464");
  if (svc.start === "binds") svc.running = true;
});

vi.mock("../../../services/McpServerService.js", () => ({
  mcpServerService: {
    setEnabled: (enabled: boolean) => svc.setEnabled(enabled),
    get isRunning() {
      return svc.running;
    },
  },
}));

import type { LinkSession } from "../../link/session.js";
import { LinkMethod, McpServerEnabledAnswerSchema } from "../linkMethods.js";
import { installMcpServerEnableHost } from "../mcpServerEnableHost.js";

type Handler = (payload: unknown) => unknown;
type Schema = { safeParse(v: unknown): { success: boolean; data?: unknown } };

/** One link: the payload checked against the method's schema, then handled, as the link would. */
function link() {
  const handlers = new Map<string, { schema: Schema; handler: Handler }>();
  const closers: Array<() => void> = [];
  const session = {
    registerCallHandler: (method: string, schema: Schema, handler: Handler) => {
      const entry = { schema, handler };
      handlers.set(method, entry);
      return () => {
        if (handlers.get(method) === entry) handlers.delete(method);
      };
    },
    onClose: (listener: () => void) => {
      closers.push(listener);
      return () => {};
    },
  } as unknown as LinkSession;
  const call = async (method: string, payload: unknown) => {
    const entry = handlers.get(method);
    if (!entry) throw new Error("UNSUPPORTED");
    const parsed = entry.schema.safeParse(payload);
    if (!parsed.success) throw new Error("VALIDATION");
    return entry.handler(parsed.data);
  };
  const close = () => {
    for (const closer of closers.splice(0)) closer();
  };
  return { session, call, close };
}

function host() {
  let listener: ((ctx: { session: LinkSession }) => void) | null = null;
  const dispose = installMcpServerEnableHost({
    onSession: (next) => {
      listener = next;
      return () => (listener = null);
    },
  });
  const attach = () => {
    const next = link();
    listener?.({ session: next.session });
    return next;
  };
  return { attach, dispose };
}

beforeEach(() => {
  svc.running = false;
  svc.start = "binds";
  svc.hold = null;
  vi.mocked(svc.setEnabled).mockClear();
});

describe("installMcpServerEnableHost", () => {
  it("answers only once the start has finished, in the shape the Shell reads", async () => {
    let release!: () => void;
    svc.hold = new Promise((resolve) => (release = resolve));
    const shell = host().attach();

    let answered = false;
    const answer = shell.call(LinkMethod.ENABLE_MCP_SERVER, null).then((value) => {
      answered = true;
      return value;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(answered).toBe(false);

    release();
    expect(McpServerEnabledAnswerSchema.parse(await answer)).toEqual({ running: true });
    expect(svc.setEnabled).toHaveBeenCalledExactlyOnceWith(true);
  });

  it.each([
    ["couldn't bind", "fails" as const],
    ["threw, keeping why to itself", "throws" as const],
  ])("answers not running when the start %s", async (_case, start) => {
    svc.start = start;
    const shell = host().attach();

    const answer = await shell.call(LinkMethod.ENABLE_MCP_SERVER, null);

    expect(answer).toEqual({ running: false });
    expect(JSON.stringify(answer)).not.toContain("45454");
    expect(svc.setEnabled).toHaveBeenCalledExactlyOnceWith(true);
  });

  it.each([{ enabled: false }, { enabled: true }])(
    "takes no arguments, so a Shell can never say which way to switch it (%o)",
    async (payload) => {
      const shell = host().attach();
      await expect(shell.call(LinkMethod.ENABLE_MCP_SERVER, payload)).rejects.toThrow("VALIDATION");
      expect(svc.setEnabled).not.toHaveBeenCalled();
    }
  );

  it("stops answering on a closed link, answers the next one, and attaches none once disposed", async () => {
    const installed = host();
    const first = installed.attach();
    first.close();
    await expect(first.call(LinkMethod.ENABLE_MCP_SERVER, null)).rejects.toThrow("UNSUPPORTED");

    const second = installed.attach();
    await expect(second.call(LinkMethod.ENABLE_MCP_SERVER, null)).resolves.toEqual({
      running: true,
    });

    installed.dispose();
    const third = installed.attach();
    await expect(third.call(LinkMethod.ENABLE_MCP_SERVER, null)).rejects.toThrow("UNSUPPORTED");
  });
});
