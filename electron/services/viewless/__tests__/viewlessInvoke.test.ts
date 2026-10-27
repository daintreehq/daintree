import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _resetIpcDispatcherForTesting, getIpcDispatcher } from "../../../ipc/dispatcher.js";
import type { IpcContext } from "../../../ipc/types.js";
import type { IpcEnvelope } from "../../../../shared/types/ipc/errors.js";
import { invokeHostChannel, ViewlessInvokeError } from "../viewlessInvoke.js";

const CHANNEL = "terminal:spawn";

describe("invokeHostChannel", () => {
  beforeEach(() => {
    _resetIpcDispatcherForTesting();
    getIpcDispatcher().setInvokeEnveloper(async (_channel, _args, run) => {
      try {
        return { __daintreeIpcEnvelope: true, ok: true, data: await run() } as IpcEnvelope;
      } catch (err) {
        const error = err as Error & { code?: string };
        return {
          __daintreeIpcEnvelope: true,
          ok: false,
          error: { name: error.name, message: error.message, code: error.code },
        } as IpcEnvelope;
      }
    });
  });

  afterEach(() => {
    _resetIpcDispatcherForTesting();
  });

  it("runs the registered host handler as the project, with no window or sender", async () => {
    let seen: IpcContext | undefined;
    getIpcDispatcher().registerInvoke(CHANNEL, (ctx, ...args) => {
      seen = ctx as IpcContext;
      return { echoed: args };
    });

    const data = await invokeHostChannel<{ echoed: unknown[] }>("proj-1", CHANNEL, [{ a: 1 }]);

    expect(data).toEqual({ echoed: [{ a: 1 }] });
    expect(seen?.projectId).toBe("proj-1");
    expect(seen?.senderWindow).toBeNull();
    expect(seen?.event).toBeNull();
    // Neither a WebContents id nor a remote handle: nothing keys a launch view
    // or a remote-caller gate on it.
    expect(seen?.webContentsId).toBe(0);
    expect(seen?.endpoint.kind).toBe("local-view");
  });

  it("surfaces the handler's failure with its code", async () => {
    getIpcDispatcher().registerInvoke(CHANNEL, () => {
      throw Object.assign(new Error("nope"), { code: "RATE_LIMITED" });
    });

    const err = await invokeHostChannel("proj-1", CHANNEL, []).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ViewlessInvokeError);
    expect((err as ViewlessInvokeError).message).toBe("nope");
    expect((err as ViewlessInvokeError).code).toBe("RATE_LIMITED");
  });
});
