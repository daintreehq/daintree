import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  DecisionsRelayCheck,
  DecisionsStatus,
  PaneDecisionState,
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
  getDecisionsStatus: vi.fn((): DecisionsStatus => ({ state: "not-connected" })),
  getDecisionsPaneState: vi.fn((): PaneDecisionState | null => null),
  setDecisionsEnabled: vi.fn(async (enabled: boolean): Promise<DecisionsStatus> => ({
    state: enabled ? "not-connected" : "off",
  })),
  checkRelay: vi.fn(
    async (): Promise<DecisionsRelayCheck> => ({ result: "invalid-url", reason: "not-https" })
  ),
}));

vi.mock("electron", () => ({ ipcMain: ipcMainMock }));
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

const DECISIONS_CHANNELS = [
  CHANNELS.DECISIONS_GET_STATUS,
  CHANNELS.DECISIONS_GET_PANE_STATE,
  CHANNELS.DECISIONS_SET_ENABLED,
  CHANNELS.DECISIONS_CHECK_RELAY,
];

describe("decisions IPC", () => {
  beforeEach(() => {
    saved.value = undefined;
    _resetDecisionsModuleForTesting();
    decisionsEntry.getDecisionsStatus.mockClear();
    decisionsEntry.getDecisionsPaneState.mockClear();
    decisionsEntry.setDecisionsEnabled.mockClear();
    decisionsEntry.checkRelay.mockClear();
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
      .mockReturnValueOnce({ state: "not-connected" })
      .mockReturnValueOnce({ state: "revoked" });

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
