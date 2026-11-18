// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderResource } from "../../cloud/provider.js";

const driver = vi.hoisted(() => ({
  inspect: null as null | (() => Promise<unknown>),
}));

vi.mock("electron", () => ({
  app: { isPackaged: true, getPath: () => "/nonexistent/daintree-test-user-data" },
}));
vi.mock("../../cloud/boat/boatMachineDriver.js", () => ({
  boatMachineDriver: () => ({
    inspect: () => driver.inspect!(),
    renew: vi.fn(),
    stop: vi.fn(),
    failure: () => ({ kind: "retry" }),
  }),
}));

import { BOAT_PRODUCTION_API_URL } from "../../cloud/boat/BoatClient.js";
import { GUEST_POWER_OFF_METHOD, MachineKeeperLinkMethod } from "../../cloud/machineKeeperLink.js";
import type { GuestPowerOffSystem, StoredGuestPowerOff } from "../guestPowerOffSystem.js";
import type { LinkSession } from "../../link/session.js";
import { _resetRemoteServicesForTest, registerRemoteService } from "../../runtime.js";
import { installMachineKeeperHost } from "../machineKeeperHost.js";

type Handler = (payload: unknown) => unknown;

function linkedHost(guestSystem?: GuestPowerOffSystem) {
  const handlers = new Map<
    string,
    { schema: { safeParse(v: unknown): { success: boolean; data?: unknown } }; handler: Handler }
  >();
  const session = {
    registerCallHandler: (method: string, schema: never, handler: Handler) => {
      handlers.set(method, { schema, handler });
      return () => handlers.delete(method);
    },
    onClose: () => () => {},
  } as unknown as LinkSession;
  let listener: ((ctx: { session: LinkSession }) => void) | null = null;
  const dispose = installMachineKeeperHost(
    {
      onSession: (next) => {
        listener = next;
        return () => (listener = null);
      },
    },
    guestSystem ? { guestSystem } : {}
  );
  listener!({ session });
  /** As the link would: the payload checked against the method's schema, then handled. */
  const call = async (method: string, payload: unknown) => {
    const entry = handlers.get(method)!;
    const parsed = entry.schema.safeParse(payload);
    if (!parsed.success) throw new Error("VALIDATION");
    return entry.handler(parsed.data);
  };
  return { call, dispose };
}

const request = (overrides: Record<string, unknown> = {}) => ({
  grantId: "mk_1",
  provider: "boat",
  apiUrl: BOAT_PRODUCTION_API_URL,
  scope: "personal",
  resourceId: "bx_23456789",
  secret: "boat_live_machinesecret",
  expiresAt: Date.now() + 86_400_000,
  ...overrides,
});

beforeEach(() => {
  _resetRemoteServicesForTest();
  registerRemoteService("hostIdle", {
    observation: () => ({ idleAfterMinutes: 30, lastWorkAt: 0, busy: true, idleEndsAt: null }),
    checkFresh: async () => {},
    noteWork: () => {},
  } as never);
  driver.inspect = async () => ({ machine: "running", stop: null }) as unknown as ProviderResource;
});

afterEach(() => {
  _resetRemoteServicesForTest();
});

describe("installMachineKeeperHost (#17361)", () => {
  it("refuses a key for another provider, another Boat, or something that isn't a Boat machine", async () => {
    const host = linkedHost();
    for (const bad of [
      { provider: "acme" },
      { apiUrl: "https://boat.example/api/v1" },
      { resourceId: "i-0123456789" },
    ]) {
      await expect(host.call(MachineKeeperLinkMethod.ARM, request(bad))).rejects.toMatchObject({
        code: "VALIDATION",
      });
    }
    await expect(host.call(MachineKeeperLinkMethod.STATUS, null)).resolves.toMatchObject({
      grantId: null,
    });
    host.dispose();
  });

  it("answers what it holds only once a key handed over before the question is settled", async () => {
    let release: (() => void) | null = null;
    driver.inspect = () =>
      new Promise((resolve) => {
        release = () => resolve({ machine: "running", stop: null });
      });
    const host = linkedHost();
    const armed = host.call(MachineKeeperLinkMethod.ARM, request());
    const status = host.call(MachineKeeperLinkMethod.STATUS, null);
    await vi.waitFor(() => expect(release).not.toBeNull());
    release!();
    await armed;
    await expect(status).resolves.toMatchObject({ grantId: "mk_1" });
    host.dispose();
  });

  it("takes the power-off permission for an EC2 or Compute Engine machine, and nothing else, over the link", async () => {
    const system = guestSystem();
    const host = linkedHost(system);
    const aws = {
      provider: "aws",
      accountId: "123456789012",
      region: "eu-west-1",
      instanceId: "i-0abc0000000000001",
    };
    const gce = {
      provider: "gce",
      project: "daintree-build",
      zone: "us-central1-a",
      instanceId: "9007199254740993123",
    };
    for (const target of [aws, gce]) {
      await expect(host.call(GUEST_POWER_OFF_METHOD, { target, enabled: true })).resolves.toEqual({
        armed: true,
        problem: null,
      });
      await expect(host.call(GUEST_POWER_OFF_METHOD, { target, enabled: false })).resolves.toEqual({
        armed: false,
        problem: null,
      });
    }
    // Anything that could carry a credential, or a machine named loosely, is turned away by the schema.
    for (const bad of [
      { target: aws, enabled: true, secret: "x" },
      { target: { ...aws, accessKeyId: "AKIA" }, enabled: true },
      { target: { ...aws, instanceId: "i-../../etc" }, enabled: true },
      { target: { ...gce, instanceId: "12ab" }, enabled: true },
      { target: { ...gce, serviceAccountKey: "{}" }, enabled: true },
      { target: { ...aws, provider: "boat" }, enabled: true },
    ]) {
      await expect(host.call(GUEST_POWER_OFF_METHOD, bad)).rejects.toThrow("VALIDATION");
    }
    expect(system.verifyIdentity).toHaveBeenCalledTimes(2);
    host.dispose();
  });

  it("takes back up, with no Shell, a permission saved earlier in this boot", async () => {
    const target = {
      provider: "aws" as const,
      accountId: "123456789012",
      region: "eu-west-1",
      instanceId: "i-0abc0000000000001",
    };
    const system = guestSystem({ bootId: "boot-a", target });
    const host = linkedHost(system);
    await vi.waitFor(() =>
      expect(system.verifyIdentity).toHaveBeenCalledWith(target, expect.anything())
    );
    await expect(host.call(GUEST_POWER_OFF_METHOD, { target, enabled: false })).resolves.toEqual({
      armed: false,
      problem: null,
    });
    host.dispose();
  });
});

function guestSystem(saved: StoredGuestPowerOff | null = null) {
  return {
    unsupported: () => null,
    verifyIdentity: vi.fn(async () => ({ ok: true as const })),
    probePowerOff: async () => null,
    preparePowerOff: vi.fn(async () => async () => ({ kind: "accepted" as const })),
    bootId: async () => saved?.bootId ?? "boot-a",
    loadArm: async () => saved,
    saveArm: async () => {},
  } satisfies GuestPowerOffSystem;
}
