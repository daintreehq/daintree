import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ClaimDecisionsRelayPayload,
  DecisionsConnectResult,
  DecisionsExportResult,
  DecisionsLocalDeleteResult,
  DecisionsPolicy,
  DecisionsRelayCheck,
  DecisionsRelayDeleteResult,
  DecisionsStatus,
  DeleteDecisionsRelayDataPayload,
  ExportDecisionsDataPayload,
  PaneDecisionState,
  RestoreDecisionsIdentityPayload,
  SetDecisionsEnabledPayload,
} from "../../../../shared/types/decisions.js";

const ipcMainMock = vi.hoisted(() => ({
  handle: vi.fn(),
  removeHandler: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
}));
const saved = vi.hoisted(() => ({ value: undefined as unknown }));
// Counts evaluation of Decisions' entry module and of each library, none of
// which an off read may load.
const decisionsEntry = vi.hoisted(() => ({
  evaluated: 0,
  libraries: 0,
  getDecisionsStatus: vi.fn(async (): Promise<DecisionsStatus> => ({ state: "not-connected" })),
  getDecisionsPaneState: vi.fn((): PaneDecisionState | null => null),
  setDecisionsEnabled: vi.fn(async (enabled: boolean): Promise<DecisionsStatus> => ({
    state: enabled ? "not-connected" : "off",
  })),
  checkRelay: vi.fn(async (): Promise<DecisionsRelayCheck> => ({
    result: "invalid-url",
    reason: "not-https",
  })),
  claimRelay: vi.fn(
    async (_payload: ClaimDecisionsRelayPayload): Promise<DecisionsConnectResult> => ({
      result: "saved",
      status: { state: "not-connected", relayOrigin: "https://relay.example.com" },
    })
  ),
  restoreIdentity: vi.fn(
    async (_payload: RestoreDecisionsIdentityPayload): Promise<DecisionsConnectResult> => ({
      result: "saved",
      status: { state: "not-connected", relayOrigin: "https://relay.example.com" },
    })
  ),
  disconnectRelay: vi.fn(async (): Promise<DecisionsStatus> => ({ state: "not-connected" })),
  exportData: vi.fn(
    async (
      _payload: ExportDecisionsDataPayload,
      _choose: (fileName: string) => Promise<string | null>
    ): Promise<DecisionsExportResult> => ({ result: "cancelled" })
  ),
  deleteRelayData: vi.fn(
    async (_payload: DeleteDecisionsRelayDataPayload): Promise<DecisionsRelayDeleteResult> => ({
      result: "deleted",
      origin: "https://relay.example.com",
    })
  ),
  deleteLocalData: vi.fn(async (): Promise<DecisionsLocalDeleteResult> => ({
    result: "deleted",
    status: { state: "not-connected" },
  })),
  getDecisionsPolicy: vi.fn((): DecisionsPolicy => ({
    gates: [],
    proxyAllowlisted: false,
    defaultQuestionExpiryMs: 1,
  })),
  setDecisionsProxyAllowlisted: vi.fn(async (allowed: boolean): Promise<DecisionsPolicy> => ({
    gates: [],
    proxyAllowlisted: allowed,
    defaultQuestionExpiryMs: 1,
  })),
}));
const dialogMock = vi.hoisted(() => ({
  showSaveDialog: vi.fn<(...args: unknown[]) => Promise<{ canceled: boolean; filePath?: string }>>(
    async () => ({ canceled: true })
  ),
}));

vi.mock("electron", () => ({ ipcMain: ipcMainMock, dialog: dialogMock }));
vi.mock("../../../store.js", () => ({
  store: {
    get: vi.fn((key: string) => (key === "decisions" ? saved.value : undefined)),
    set: vi.fn(),
  },
}));
vi.mock("../../../services/decisions/index.js", () => {
  decisionsEntry.evaluated += 1;
  return {
    getDecisionsStatus: decisionsEntry.getDecisionsStatus,
    getDecisionsPaneState: decisionsEntry.getDecisionsPaneState,
    setDecisionsEnabled: decisionsEntry.setDecisionsEnabled,
    checkRelay: decisionsEntry.checkRelay,
    claimRelay: decisionsEntry.claimRelay,
    restoreIdentity: decisionsEntry.restoreIdentity,
    disconnectRelay: decisionsEntry.disconnectRelay,
    exportData: decisionsEntry.exportData,
    deleteRelayData: decisionsEntry.deleteRelayData,
    deleteLocalData: decisionsEntry.deleteLocalData,
    getDecisionsPolicy: decisionsEntry.getDecisionsPolicy,
    setDecisionsProxyAllowlisted: decisionsEntry.setDecisionsProxyAllowlisted,
  };
});
vi.mock("@daintreehq/decisions-protocol", () => {
  decisionsEntry.libraries += 1;
  return {};
});
vi.mock("@daintreehq/decisions-crypto", () => {
  decisionsEntry.libraries += 1;
  return {};
});
vi.mock("@daintreehq/decisions-client", () => {
  decisionsEntry.libraries += 1;
  return {};
});
vi.mock("@daintreehq/decisions-model", () => {
  decisionsEntry.libraries += 1;
  return {};
});

import { CHANNELS } from "../../channels.js";
import { store } from "../../../store.js";
import { decisionsNamespace, registerDecisionsHandlers } from "../deviceAnswer.js";
import {
  _resetDecisionsModuleForTesting,
  sealDecisionsModule,
} from "../../../window/serviceRefs.js";

const getStatus = decisionsNamespace.ops.getStatus
  .handler as unknown as () => Promise<DecisionsStatus>;
const getPaneState = decisionsNamespace.ops.getPaneState.handler as unknown as (
  terminalId: string
) => Promise<PaneDecisionState | null>;
const setEnabled = decisionsNamespace.ops.setEnabled.handler as unknown as (
  payload: SetDecisionsEnabledPayload
) => Promise<DecisionsStatus>;

const checkRelay = decisionsNamespace.ops.checkRelay.handler as unknown as (
  url: string
) => Promise<DecisionsRelayCheck>;

const claimRelay = decisionsNamespace.ops.claimRelay.handler as unknown as (
  payload: ClaimDecisionsRelayPayload
) => Promise<DecisionsConnectResult>;
const restoreIdentity = decisionsNamespace.ops.restoreIdentity.handler as unknown as (
  payload: RestoreDecisionsIdentityPayload
) => Promise<DecisionsConnectResult>;
const disconnectRelay = decisionsNamespace.ops.disconnectRelay
  .handler as unknown as () => Promise<DecisionsStatus>;
const getPolicy = decisionsNamespace.ops.getPolicy
  .handler as unknown as () => Promise<DecisionsPolicy>;
const setProxyAllowlisted = decisionsNamespace.ops.setProxyAllowlisted.handler as unknown as (
  allowed: boolean
) => Promise<DecisionsPolicy>;

type ExportHandler = (
  ctx: { senderWindow: unknown },
  payload: ExportDecisionsDataPayload
) => Promise<DecisionsExportResult>;
const exportData = decisionsNamespace.ops.exportData.handler as unknown as ExportHandler;
const deleteRelayData = decisionsNamespace.ops.deleteRelayData.handler as unknown as (
  payload: DeleteDecisionsRelayDataPayload
) => Promise<DecisionsRelayDeleteResult>;
const deleteLocalData = decisionsNamespace.ops.deleteLocalData
  .handler as unknown as () => Promise<DecisionsLocalDeleteResult>;
const EXPORT: ExportDecisionsDataPayload = { passphrase: "a long export passphrase" };
const RELAY_ORIGIN = "https://relay.example.com";

const SECRET = "claim-secret-0123456789abcdef";
const PASSPHRASE = "correct horse battery staple";
const CLAIM: ClaimDecisionsRelayPayload = { url: "relay.example.com", claimSecret: SECRET };
const RESTORE: RestoreDecisionsIdentityPayload = {
  url: "relay.example.com",
  kit: '{"v":1}',
  passphrase: PASSPHRASE,
};

type SafeParse = { safeParse(value: unknown): { success: boolean } };

const DECISIONS_CHANNELS = [
  CHANNELS.DECISIONS_GET_STATUS,
  CHANNELS.DECISIONS_GET_PANE_STATE,
  CHANNELS.DECISIONS_SET_ENABLED,
  CHANNELS.DECISIONS_CHECK_RELAY,
  CHANNELS.DECISIONS_CLAIM_RELAY,
  CHANNELS.DECISIONS_RESTORE_IDENTITY,
  CHANNELS.DECISIONS_DISCONNECT_RELAY,
  CHANNELS.DECISIONS_EXPORT_DATA,
  CHANNELS.DECISIONS_DELETE_RELAY_DATA,
  CHANNELS.DECISIONS_DELETE_LOCAL_DATA,
  CHANNELS.DECISIONS_GET_POLICY,
  CHANNELS.DECISIONS_SET_PROXY_ALLOWLISTED,
];

describe("decisions IPC", () => {
  beforeEach(() => {
    saved.value = undefined;
    _resetDecisionsModuleForTesting();
    decisionsEntry.getDecisionsStatus.mockClear();
    decisionsEntry.getDecisionsPaneState.mockClear();
    decisionsEntry.setDecisionsEnabled.mockClear();
    decisionsEntry.checkRelay.mockClear();
    decisionsEntry.claimRelay.mockClear();
    decisionsEntry.restoreIdentity.mockClear();
    decisionsEntry.disconnectRelay.mockClear();
    decisionsEntry.exportData.mockClear();
    decisionsEntry.deleteRelayData.mockClear();
    decisionsEntry.deleteLocalData.mockClear();
    dialogMock.showSaveDialog.mockClear();
    decisionsEntry.getDecisionsPolicy.mockClear();
    decisionsEntry.setDecisionsProxyAllowlisted.mockClear();
    vi.mocked(store.set).mockClear();
  });
  afterEach(() => {
    _resetDecisionsModuleForTesting();
  });

  it("registers the reads and the switch, and removes them on cleanup", () => {
    const cleanup = registerDecisionsHandlers();
    for (const channel of DECISIONS_CHANNELS) {
      expect(ipcMainMock.handle).toHaveBeenCalledWith(channel, expect.any(Function));
    }

    cleanup();
    for (const channel of DECISIONS_CHANNELS) {
      expect(ipcMainMock.removeHandler).toHaveBeenCalledWith(channel);
    }
  });

  // These run before the positive control below (vitest keeps declared order):
  // a module, once evaluated, stays evaluated.
  it.each([
    ["absent", undefined],
    ["off", { enabled: false }],
    ["a non-boolean switch", { enabled: "true" }],
  ])(
    "answers off from the store with the setting %s, loading none of Decisions",
    async (_label, value) => {
      saved.value = value;

      await expect(getStatus()).resolves.toEqual({ state: "off" });

      expect(decisionsEntry.evaluated).toBe(0);
      expect(decisionsEntry.libraries).toBe(0);
      expect(store.set).not.toHaveBeenCalled();
    }
  );

  it.each([
    ["absent", undefined],
    ["off", { enabled: false }],
    ["a non-boolean switch", { enabled: "true" }],
  ])(
    "reads no pane state with the setting %s, loading none of Decisions",
    async (_label, value) => {
      saved.value = value;

      await expect(getPaneState("pane-a")).resolves.toBeNull();

      expect(decisionsEntry.evaluated).toBe(0);
      expect(decisionsEntry.libraries).toBe(0);
    }
  );

  it("reads no pane state once quit has sealed the loader, without loading it", async () => {
    saved.value = { enabled: true };
    sealDecisionsModule();

    await expect(getPaneState("pane-a")).resolves.toBeNull();

    expect(decisionsEntry.evaluated).toBe(0);
    expect(decisionsEntry.getDecisionsPaneState).not.toHaveBeenCalled();
  });

  it("reports a saved consent time with the switch off, loading none of Decisions", async () => {
    saved.value = { enabled: false, consentedAt: 1_761_955_200_000 };

    await expect(getStatus()).resolves.toEqual({ state: "off", consentedAt: 1_761_955_200_000 });

    expect(decisionsEntry.evaluated).toBe(0);
  });

  it("turns off with nothing on by answering from the store, loading none of Decisions", async () => {
    saved.value = { enabled: false };

    await expect(setEnabled({ enabled: false })).resolves.toEqual({ state: "off" });

    expect(decisionsEntry.evaluated).toBe(0);
    expect(decisionsEntry.libraries).toBe(0);
    expect(store.set).not.toHaveBeenCalled();
  });

  it("refuses to turn on before the person has agreed, loading none of Decisions", async () => {
    for (const value of [undefined, { enabled: false }, { enabled: false, consentedAt: "yes" }]) {
      saved.value = value;

      await expect(setEnabled({ enabled: true })).rejects.toThrow(/agree/);
      await expect(setEnabled({ enabled: true, consent: false })).rejects.toThrow(/agree/);
    }

    expect(decisionsEntry.evaluated).toBe(0);
    expect(decisionsEntry.libraries).toBe(0);
    expect(store.set).not.toHaveBeenCalled();
  });

  it("refuses to check a relay while off, loading none of Decisions", async () => {
    for (const value of [undefined, { enabled: false }, { enabled: "true" }]) {
      saved.value = value;

      await expect(checkRelay("https://relay.example.com")).rejects.toMatchObject({
        code: "PERMISSION",
      });
    }

    expect(decisionsEntry.evaluated).toBe(0);
    expect(decisionsEntry.libraries).toBe(0);
  });

  it("refuses to check a relay once quit has sealed the loader, without loading it", async () => {
    saved.value = { enabled: true };
    sealDecisionsModule();

    await expect(checkRelay("https://relay.example.com")).rejects.toMatchObject({
      code: "CANCELLED",
    });

    expect(decisionsEntry.evaluated).toBe(0);
    expect(decisionsEntry.checkRelay).not.toHaveBeenCalled();
  });

  it("refuses to claim, restore or disconnect while off, loading none of Decisions", async () => {
    for (const value of [undefined, { enabled: false }, { enabled: "true" }]) {
      saved.value = value;

      await expect(claimRelay(CLAIM)).rejects.toMatchObject({ code: "PERMISSION" });
      await expect(restoreIdentity(RESTORE)).rejects.toMatchObject({ code: "PERMISSION" });
      await expect(disconnectRelay()).rejects.toMatchObject({ code: "PERMISSION" });
    }

    expect(decisionsEntry.evaluated).toBe(0);
    expect(decisionsEntry.libraries).toBe(0);
  });

  it("refuses to read the policy or change the allowlist while off, loading none of Decisions", async () => {
    for (const value of [undefined, { enabled: false }, { enabled: "true" }]) {
      saved.value = value;

      await expect(getPolicy()).rejects.toMatchObject({ code: "PERMISSION" });
      await expect(setProxyAllowlisted(true)).rejects.toMatchObject({ code: "PERMISSION" });
    }

    expect(decisionsEntry.evaluated).toBe(0);
    expect(decisionsEntry.libraries).toBe(0);
    expect(store.set).not.toHaveBeenCalled();
  });

  it("refuses to claim, restore or disconnect once quit has sealed the loader", async () => {
    saved.value = { enabled: true };
    sealDecisionsModule();

    await expect(claimRelay(CLAIM)).rejects.toMatchObject({ code: "CANCELLED" });
    await expect(restoreIdentity(RESTORE)).rejects.toMatchObject({ code: "CANCELLED" });
    await expect(disconnectRelay()).rejects.toMatchObject({ code: "CANCELLED" });

    expect(decisionsEntry.evaluated).toBe(0);
  });

  it("refuses to export or delete data while off, loading none of Decisions", async () => {
    for (const value of [undefined, { enabled: false }, { enabled: "true" }]) {
      saved.value = value;

      await expect(exportData({ senderWindow: null }, EXPORT)).rejects.toMatchObject({
        code: "PERMISSION",
      });
      await expect(deleteRelayData({ origin: RELAY_ORIGIN })).rejects.toMatchObject({
        code: "PERMISSION",
      });
      await expect(deleteLocalData()).rejects.toMatchObject({ code: "PERMISSION" });
    }

    expect(decisionsEntry.evaluated).toBe(0);
    expect(decisionsEntry.libraries).toBe(0);
    expect(dialogMock.showSaveDialog).not.toHaveBeenCalled();
  });

  it("refuses to export or delete data once quit has sealed the loader", async () => {
    saved.value = { enabled: true };
    sealDecisionsModule();

    await expect(exportData({ senderWindow: null }, EXPORT)).rejects.toMatchObject({
      code: "CANCELLED",
    });
    await expect(deleteRelayData({ origin: RELAY_ORIGIN })).rejects.toMatchObject({
      code: "CANCELLED",
    });
    await expect(deleteLocalData()).rejects.toMatchObject({ code: "CANCELLED" });

    expect(decisionsEntry.evaluated).toBe(0);
  });

  it("answers off once quit has sealed the loader, without loading it", async () => {
    saved.value = { enabled: true };
    sealDecisionsModule();

    await expect(getStatus()).resolves.toEqual({ state: "off" });

    expect(decisionsEntry.evaluated).toBe(0);
    expect(decisionsEntry.libraries).toBe(0);
  });

  it("asks Decisions itself once the setting is on, loading its entry once", async () => {
    saved.value = { enabled: true };
    decisionsEntry.getDecisionsStatus
      .mockResolvedValueOnce({ state: "not-connected" })
      .mockResolvedValueOnce({ state: "revoked" });

    await expect(getStatus()).resolves.toEqual({ state: "not-connected" });
    await expect(getStatus()).resolves.toEqual({ state: "revoked" });

    expect(decisionsEntry.evaluated).toBe(1);
    expect(store.set).not.toHaveBeenCalled();
  });

  it("asks Decisions itself for a pane's state once the setting is on", async () => {
    saved.value = { enabled: true };
    const state: PaneDecisionState = {
      terminalId: "pane-a",
      openQuestions: [],
      waitingAnswers: [],
      needsAttention: [],
      revision: 4,
    };
    decisionsEntry.getDecisionsPaneState.mockReturnValueOnce(state);

    await expect(getPaneState("pane-a")).resolves.toBe(state);
    await expect(getPaneState("pane-b")).resolves.toBeNull();

    expect(decisionsEntry.getDecisionsPaneState.mock.calls).toEqual([["pane-a"], ["pane-b"]]);
  });

  it("checks a relay through Decisions itself once the setting is on", async () => {
    saved.value = { enabled: true };
    const observed: DecisionsRelayCheck = {
      result: "unreachable",
      origin: "https://relay.example.com",
      endpoint: "health",
      reason: "dns",
    };
    decisionsEntry.checkRelay.mockResolvedValueOnce(observed);

    await expect(checkRelay("relay.example.com")).resolves.toBe(observed);

    expect(decisionsEntry.checkRelay).toHaveBeenCalledExactlyOnceWith("relay.example.com");
    expect(store.set).not.toHaveBeenCalled();
  });

  it("takes only a bounded string as the relay URL", () => {
    const schema = decisionsNamespace.ops.checkRelay.schema as {
      safeParse(value: unknown): { success: boolean };
    };

    expect(schema.safeParse("https://relay.example.com").success).toBe(true);
    for (const value of [undefined, 42, { url: "https://relay.example.com" }, "x".repeat(2049)]) {
      expect(schema.safeParse(value).success).toBe(false);
    }
  });

  it("claims, restores and disconnects through Decisions itself once the setting is on", async () => {
    saved.value = { enabled: true };

    await expect(claimRelay(CLAIM)).resolves.toMatchObject({ result: "saved" });
    await expect(restoreIdentity(RESTORE)).resolves.toMatchObject({ result: "saved" });
    await expect(disconnectRelay()).resolves.toEqual({ state: "not-connected" });

    expect(decisionsEntry.claimRelay).toHaveBeenCalledExactlyOnceWith(CLAIM);
    expect(decisionsEntry.restoreIdentity).toHaveBeenCalledExactlyOnceWith(RESTORE);
    expect(decisionsEntry.disconnectRelay).toHaveBeenCalledOnce();
    expect(store.set).not.toHaveBeenCalled();
  });

  it("exports through Decisions itself, picking the file over the window that asked", async () => {
    saved.value = { enabled: true };
    const window = { isDestroyed: () => false };
    let chosen: Array<string | null> = [];
    decisionsEntry.exportData.mockImplementationOnce(async (_payload, choose) => {
      dialogMock.showSaveDialog
        .mockResolvedValueOnce({ canceled: false, filePath: "/exports/history.dxz.json" })
        .mockResolvedValueOnce({ canceled: true, filePath: "/exports/ignored.json" });
      chosen = [
        await choose("decisions-export-2026-11-01.dxz.json"),
        await choose("decisions-export-2026-11-01.dxz.json"),
      ];
      return { result: "cancelled" };
    });

    await exportData({ senderWindow: window }, EXPORT);

    expect(decisionsEntry.exportData).toHaveBeenCalledWith(EXPORT, expect.any(Function));
    expect(chosen).toEqual(["/exports/history.dxz.json", null]);
    expect(dialogMock.showSaveDialog).toHaveBeenCalledWith(
      window,
      expect.objectContaining({ defaultPath: "decisions-export-2026-11-01.dxz.json" })
    );
  });

  it("opens the export's dialog on its own when the window that asked has gone, or there is none", async () => {
    saved.value = { enabled: true };
    const choosing = async (
      _payload: ExportDecisionsDataPayload,
      choose: (fileName: string) => Promise<string | null>
    ): Promise<DecisionsExportResult> => {
      await choose("decisions-export-2026-11-01.dxz.json");
      return { result: "cancelled" };
    };
    decisionsEntry.exportData.mockImplementationOnce(choosing).mockImplementationOnce(choosing);

    await exportData({ senderWindow: { isDestroyed: () => true } }, EXPORT);
    await exportData({ senderWindow: null }, EXPORT);

    expect(dialogMock.showSaveDialog).toHaveBeenCalledTimes(2);
    for (const call of dialogMock.showSaveDialog.mock.calls) {
      expect(call).toEqual([
        expect.objectContaining({ defaultPath: "decisions-export-2026-11-01.dxz.json" }),
      ]);
    }
  });

  it("deletes relay and local data through Decisions itself once the setting is on", async () => {
    saved.value = { enabled: true };

    await expect(deleteRelayData({ origin: RELAY_ORIGIN })).resolves.toMatchObject({
      result: "deleted",
    });
    await expect(deleteLocalData()).resolves.toMatchObject({ result: "deleted" });

    expect(decisionsEntry.deleteRelayData).toHaveBeenCalledExactlyOnceWith({
      origin: RELAY_ORIGIN,
    });
    expect(decisionsEntry.deleteLocalData).toHaveBeenCalledOnce();
    expect(store.set).not.toHaveBeenCalled();
  });

  it("takes an export passphrase and a relay to delete from only within their bounds", () => {
    const exportSchema = decisionsNamespace.ops.exportData.schema as SafeParse;
    const deleteSchema = decisionsNamespace.ops.deleteRelayData.schema as SafeParse;

    expect(exportSchema.safeParse(EXPORT).success).toBe(true);
    for (const value of [
      { passphrase: "" },
      { passphrase: "x".repeat(1025) },
      { ...EXPORT, plaintext: true },
      {},
    ]) {
      expect(exportSchema.safeParse(value).success).toBe(false);
    }
    expect(deleteSchema.safeParse({ origin: RELAY_ORIGIN }).success).toBe(true);
    for (const value of [
      { origin: "x".repeat(2049) },
      { origin: RELAY_ORIGIN, scope: "everything" },
      {},
    ]) {
      expect(deleteSchema.safeParse(value).success).toBe(false);
    }
  });

  it("reads the policy and changes the allowlist through Decisions itself once on", async () => {
    saved.value = { enabled: true };

    await expect(getPolicy()).resolves.toMatchObject({ proxyAllowlisted: false });
    await expect(setProxyAllowlisted(true)).resolves.toMatchObject({ proxyAllowlisted: true });

    expect(decisionsEntry.getDecisionsPolicy).toHaveBeenCalledOnce();
    expect(decisionsEntry.setDecisionsProxyAllowlisted).toHaveBeenCalledExactlyOnceWith(true);
    expect(store.set).not.toHaveBeenCalled();
  });

  it("takes only a boolean for the allowlist, and nothing that could carry a gate", () => {
    const schema = decisionsNamespace.ops.setProxyAllowlisted.schema as SafeParse;

    expect(schema.safeParse(true).success).toBe(true);
    expect(schema.safeParse(false).success).toBe(true);
    for (const value of [undefined, "true", 1, { proxyAllowlisted: true }, { gates: [] }]) {
      expect(schema.safeParse(value).success).toBe(false);
    }
  });

  it("takes a claim secret only within the relay's own bounds", () => {
    const schema = decisionsNamespace.ops.claimRelay.schema as SafeParse;

    expect(schema.safeParse(CLAIM).success).toBe(true);
    expect(schema.safeParse({ ...CLAIM, acceptWeakStorage: true }).success).toBe(true);
    for (const value of [
      { ...CLAIM, claimSecret: "too-short" },
      { ...CLAIM, claimSecret: "x".repeat(257) },
      { ...CLAIM, url: "x".repeat(2049) },
      { ...CLAIM, extra: true },
      { url: CLAIM.url },
    ]) {
      expect(schema.safeParse(value).success).toBe(false);
    }
  });

  it("takes a recovery kit only up to its size cap", () => {
    const schema = decisionsNamespace.ops.restoreIdentity.schema as SafeParse;

    expect(schema.safeParse(RESTORE).success).toBe(true);
    for (const value of [
      { ...RESTORE, kit: "" },
      { ...RESTORE, kit: "x".repeat(256 * 1024 + 1) },
      { ...RESTORE, passphrase: "" },
      { ...RESTORE, extra: true },
    ]) {
      expect(schema.safeParse(value).success).toBe(false);
    }
  });

  it("logs and answers a malformed claim without the secret it carried", async () => {
    saved.value = { enabled: true };
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const cleanup = registerDecisionsHandlers();
    const registered = ipcMainMock.handle.mock.calls.find(
      ([channel]) => channel === CHANNELS.DECISIONS_CLAIM_RELAY
    )?.[1] as (event: unknown, payload: unknown) => Promise<unknown>;
    try {
      const failure = await registered(
        { sender: { id: 1 }, senderFrame: null },
        { ...CLAIM, unexpected: SECRET }
      ).then(
        () => null,
        (error: unknown) => error
      );

      expect(failure).toBeInstanceOf(Error);
      expect(errors.mock.calls.map(([first]) => String(first))).toContain(
        `[IPC] Validation failed for ${CHANNELS.DECISIONS_CLAIM_RELAY}:`
      );
      expect(String((failure as Error).message)).not.toContain(SECRET);
      expect(JSON.stringify(errors.mock.calls)).not.toContain(SECRET);
      expect(decisionsEntry.claimRelay).not.toHaveBeenCalled();
    } finally {
      cleanup();
      errors.mockRestore();
    }
  });

  it("turns on with consent through Decisions itself, recording the consent", async () => {
    saved.value = { enabled: false };

    await expect(setEnabled({ enabled: true, consent: true })).resolves.toEqual({
      state: "not-connected",
    });

    expect(decisionsEntry.setDecisionsEnabled).toHaveBeenCalledWith(true, { consent: true });
  });

  it("turns on again without asking once consent is saved, and off through Decisions", async () => {
    saved.value = { enabled: false, consentedAt: 1_761_955_200_000 };
    await expect(setEnabled({ enabled: true })).resolves.toEqual({ state: "not-connected" });
    expect(decisionsEntry.setDecisionsEnabled).toHaveBeenLastCalledWith(true, { consent: false });

    saved.value = { enabled: true, consentedAt: 1_761_955_200_000 };
    await expect(setEnabled({ enabled: false })).resolves.toEqual({ state: "off" });
    expect(decisionsEntry.setDecisionsEnabled).toHaveBeenLastCalledWith(false, { consent: false });
  });

  it("answers off without loading once quit has sealed the loader", async () => {
    saved.value = { enabled: false, consentedAt: 1_761_955_200_000 };
    sealDecisionsModule();

    await expect(setEnabled({ enabled: true })).resolves.toEqual({
      state: "off",
      consentedAt: 1_761_955_200_000,
    });
    expect(decisionsEntry.setDecisionsEnabled).not.toHaveBeenCalled();
  });
});
