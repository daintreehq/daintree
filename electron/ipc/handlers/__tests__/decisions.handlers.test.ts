import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DecisionsStatus } from "../../../../shared/types/decisions.js";

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
  return { getDecisionsStatus: decisionsEntry.getDecisionsStatus };
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

describe("decisions IPC", () => {
  beforeEach(() => {
    saved.value = undefined;
    _resetDecisionsModuleForTesting();
    decisionsEntry.getDecisionsStatus.mockClear();
    vi.mocked(store.set).mockClear();
  });
  afterEach(() => {
    _resetDecisionsModuleForTesting();
  });

  it("registers the status read and removes it on cleanup", () => {
    const cleanup = registerDecisionsHandlers();
    expect(ipcMainMock.handle).toHaveBeenCalledWith(
      CHANNELS.DECISIONS_GET_STATUS,
      expect.any(Function)
    );

    cleanup();
    expect(ipcMainMock.removeHandler).toHaveBeenCalledWith(CHANNELS.DECISIONS_GET_STATUS);
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
});
