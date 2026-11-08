import { afterEach, describe, expect, it, vi } from "vitest";

const syncFromHost = vi.hoisted(() => vi.fn(async () => {}));
const onCopiesChanged = vi.hoisted(() =>
  vi.fn<(callback: (change: { agentId: string }) => void) => () => void>()
);

vi.mock("@/clients", () => ({ cliAvailabilityClient: { onCopiesChanged } }));
vi.mock("@/store/cliAvailabilityStore", () => ({
  useCliAvailabilityStore: { getState: () => ({ syncFromHost }) },
}));

import { initAgentCliChoiceSync } from "../agentCliChoiceSync";

describe("initAgentCliChoiceSync (#16399)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("rereads this view's launch details whenever any view changes a choice", () => {
    vi.stubGlobal("window", { electron: { agentCliCopies: { onChanged: vi.fn() } } });
    const unsubscribe = vi.fn();
    onCopiesChanged.mockReturnValue(unsubscribe);

    const dispose = initAgentCliChoiceSync();
    onCopiesChanged.mock.calls[0]![0]({ agentId: "claude" });

    expect(syncFromHost).toHaveBeenCalledTimes(1);
    dispose();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("does nothing where the bridge has no such event", () => {
    vi.stubGlobal("window", { electron: {} });

    const dispose = initAgentCliChoiceSync();

    expect(onCopiesChanged).not.toHaveBeenCalled();
    expect(() => dispose()).not.toThrow();
  });
});
