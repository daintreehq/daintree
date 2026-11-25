// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

const svc = vi.hoisted(() => ({
  running: false,
  startFails: false,
  setEnabled: null as unknown as (enabled: boolean) => Promise<void>,
}));
svc.setEnabled = vi.fn(async (enabled: boolean) => {
  if (enabled && !svc.startFails) svc.running = true;
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

function linkedHost() {
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
  let listener: ((ctx: { session: LinkSession }) => void) | null = null;
  const dispose = installMcpServerEnableHost({
    onSession: (next) => {
      listener = next;
      return () => (listener = null);
    },
  });
  listener!({ session });
  /** As the link would: the payload checked against the method's schema, then handled. */
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
  return { call, close, dispose, attached: () => listener !== null };
}

describe("installMcpServerEnableHost", () => {
  it("turns the server on and answers that it runs, in the shape the Shell reads", async () => {
    svc.running = false;
    svc.startFails = false;
    vi.mocked(svc.setEnabled).mockClear();
    const host = linkedHost();

    const answer = await host.call(LinkMethod.ENABLE_MCP_SERVER, null);

    expect(svc.setEnabled).toHaveBeenCalledExactlyOnceWith(true);
    expect(McpServerEnabledAnswerSchema.parse(answer)).toEqual({ running: true });
  });

  it("answers not running when the server was turned on but didn't start", async () => {
    svc.running = false;
    svc.startFails = true;
    const host = linkedHost();

    await expect(host.call(LinkMethod.ENABLE_MCP_SERVER, null)).resolves.toEqual({
      running: false,
    });
  });

  it("takes no arguments, so a Shell can never ask it to turn the server off", async () => {
    vi.mocked(svc.setEnabled).mockClear();
    const host = linkedHost();

    await expect(host.call(LinkMethod.ENABLE_MCP_SERVER, { enabled: false })).rejects.toThrow(
      "VALIDATION"
    );
    expect(svc.setEnabled).not.toHaveBeenCalled();
  });

  it("stops answering on a closed link, and stops attaching once disposed", async () => {
    const host = linkedHost();
    host.close();
    await expect(host.call(LinkMethod.ENABLE_MCP_SERVER, null)).rejects.toThrow("UNSUPPORTED");

    host.dispose();
    expect(host.attached()).toBe(false);
  });
});
