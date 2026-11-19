import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  values: {} as Record<string, unknown>,
}));

vi.mock("../../../store.js", () => ({
  store: {
    get: vi.fn((key: string) => state.values[key]),
    set: vi.fn((key: string, value: unknown) => {
      state.values[key] = value;
    }),
  },
}));

import { store } from "../../../store.js";
import {
  prepareAssistantDelegation,
  readAssistantConfirmationsSkipped,
} from "../assistantConfirmationsPreference.js";

function setAssistant(helpAssistant: Record<string, unknown>, globalSkipPermissions = false) {
  state.values = {
    helpAssistant,
    agentSettings: { agents: {}, globalSkipPermissions },
  };
}

function storedAssistant(): Record<string, unknown> {
  return state.values.helpAssistant as Record<string, unknown>;
}

describe("the confirm dialog's hand-over (#16752)", () => {
  beforeEach(() => {
    vi.mocked(store.set).mockClear();
  });

  it("offers only an action that can be handed over, keyed on the id called", () => {
    setAssistant({ daintreeConfirmations: "always-ask" });
    expect(prepareAssistantDelegation(null, "worktree.delete")).toBeNull();
    expect(prepareAssistantDelegation(null, "terminal.killBatch")).toBeNull();
    expect(prepareAssistantDelegation(null, "terminal.restartOnPresetOwned")).toBeNull();
    const prepared = prepareAssistantDelegation(null, "worktree.deleteOwned");
    expect(prepared?.offer).toEqual({
      label: "Delete a worktree it created",
      detail: expect.stringContaining("Only a clean one"),
      switchesMode: true,
    });
  });

  it("offers nothing where the mode already skips everything, host settings included", () => {
    setAssistant({ daintreeConfirmations: "never-ask" });
    expect(prepareAssistantDelegation(null, "host.settings")).toBeNull();
    setAssistant({ daintreeConfirmations: "inherit" }, true);
    expect(prepareAssistantDelegation(null, "host.settings")).toBeNull();
  });

  it("offers nothing for an action already handed over", () => {
    setAssistant({
      daintreeConfirmations: "ask-except",
      daintreeConfirmationsExcept: ["worktree.deleteOwned"],
    });
    expect(prepareAssistantDelegation(null, "worktree.deleteOwned")).toBeNull();
  });

  it("adds the action to the list under Ask, except for…, keeping the others in catalog order", () => {
    setAssistant({
      agentId: "claude",
      daintreeConfirmations: "ask-except",
      daintreeConfirmationsExcept: ["host.settings"],
    });
    const prepared = prepareAssistantDelegation(null, "worktree.deleteOwned");
    expect(prepared?.offer.switchesMode).toBeUndefined();
    expect(prepared?.commit()).toBe(true);
    expect(storedAssistant()).toEqual({
      agentId: "claude",
      daintreeConfirmations: "ask-except",
      daintreeConfirmationsExcept: ["worktree.deleteOwned", "host.settings"],
    });
    expect(readAssistantConfirmationsSkipped(null, "worktree.deleteOwned")).toBe(true);
    expect(readAssistantConfirmationsSkipped(null, "worktree.delete")).toBe(false);
  });

  it("switches from Always ask with only this action, dropping ticks Settings kept", () => {
    setAssistant({
      daintreeConfirmations: "always-ask",
      daintreeConfirmationsExcept: ["host.settings"],
    });
    expect(prepareAssistantDelegation(null, "worktree.retireOwned")?.commit()).toBe(true);
    expect(storedAssistant()).toMatchObject({
      daintreeConfirmations: "ask-except",
      daintreeConfirmationsExcept: ["worktree.retireOwned"],
    });
    expect(readAssistantConfirmationsSkipped(null, "host.settings")).toBe(false);
  });

  it("switches from Follow agent setting while that agent asks", () => {
    setAssistant({ daintreeConfirmations: "inherit" });
    const prepared = prepareAssistantDelegation(null, "host.settings");
    expect(prepared?.offer.switchesMode).toBe(true);
    expect(prepared?.commit()).toBe(true);
    expect(storedAssistant()).toMatchObject({
      daintreeConfirmations: "ask-except",
      daintreeConfirmationsExcept: ["host.settings"],
    });
  });

  it("writes nothing when the mode changed while the dialog was up", () => {
    setAssistant({ daintreeConfirmations: "always-ask" });
    const prepared = prepareAssistantDelegation(null, "worktree.deleteOwned");
    storedAssistant().daintreeConfirmations = "never-ask";
    expect(prepared?.commit()).toBe(false);
    expect(store.set).not.toHaveBeenCalled();
    expect(storedAssistant().daintreeConfirmations).toBe("never-ask");
  });

  it("writes nothing when the followed agent started skipping while the dialog was up", () => {
    setAssistant({ daintreeConfirmations: "inherit" });
    const prepared = prepareAssistantDelegation(null, "host.settings");
    (state.values.agentSettings as { globalSkipPermissions: boolean }).globalSkipPermissions = true;
    expect(prepared?.commit()).toBe(false);
    expect(store.set).not.toHaveBeenCalled();
  });

  it("doesn't write twice for an action ticked from two dialogs", () => {
    setAssistant({ daintreeConfirmations: "ask-except", daintreeConfirmationsExcept: [] });
    const first = prepareAssistantDelegation(null, "worktree.deleteOwned");
    const second = prepareAssistantDelegation(null, "worktree.deleteOwned");
    expect(first?.commit()).toBe(true);
    expect(second?.commit()).toBe(true);
    expect(store.set).toHaveBeenCalledTimes(1);
  });

  it("offers nothing when the preference can't be read", () => {
    vi.mocked(store.get).mockImplementationOnce(() => {
      throw new Error("config unreadable");
    });
    expect(prepareAssistantDelegation(null, "worktree.deleteOwned")).toBeNull();
  });
});
