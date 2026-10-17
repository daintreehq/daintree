import { afterEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";

const { hostModeNamespace } = await import("../hostMode.js");
const { registerRemoteService, _resetRemoteServicesForTest } =
  await import("../../../remote/runtime.js");

type Handler = (...args: unknown[]) => Promise<unknown>;
const ops = hostModeNamespace.ops as unknown as Record<
  string,
  { handler: Handler; schema?: z.ZodTypeAny }
>;

afterEach(() => {
  _resetRemoteServicesForTest();
});

describe("hostMode handlers", () => {
  it("reports nothing listening before the remote runtime starts", async () => {
    await expect(ops.getStatus!.handler()).resolves.toEqual({
      supported: false,
      enabled: false,
      startAtLogin: false,
      socketPath: null,
      listening: false,
      attachedClients: [],
      rows: [],
    });
    await expect(ops.setEnabled!.handler({ enabled: true })).rejects.toMatchObject({
      code: "UNSUPPORTED",
    });
    await expect(ops.runKeychainPreflight!.handler()).rejects.toMatchObject({
      code: "UNSUPPORTED",
    });
  });

  it("delegates to the running service", async () => {
    const service = {
      getStatus: vi.fn(async () => ({ supported: true })),
      setEnabled: vi.fn(async () => ({ enabled: true })),
      runKeychainPreflight: vi.fn(async () => ({ rows: [] })),
    };
    registerRemoteService("hostMode", service as never);
    await expect(ops.getStatus!.handler()).resolves.toEqual({ supported: true });
    await ops.setEnabled!.handler({ enabled: true, startAtLogin: true });
    expect(service.setEnabled).toHaveBeenCalledWith({ enabled: true, startAtLogin: true });
    await ops.runKeychainPreflight!.handler();
    expect(service.runKeychainPreflight).toHaveBeenCalled();
  });

  it("accepts start at login only as an explicit boolean", () => {
    const schema = ops.setEnabled!.schema!;
    expect(schema.safeParse({ enabled: true }).success).toBe(true);
    expect(schema.safeParse({ enabled: false, startAtLogin: false }).success).toBe(true);
    expect(schema.safeParse({ enabled: true, startAtLogin: "yes" }).success).toBe(false);
    expect(schema.safeParse({ enabled: "true" }).success).toBe(false);
    expect(schema.safeParse({ enabled: true, extra: 1 }).success).toBe(false);
  });
});
