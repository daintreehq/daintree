import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionCallbacks, ActionRegistry, AnyActionDefinition } from "../../actionTypes";
import type { ActionContext } from "@shared/types/actions";

const resend = vi.hoisted(() => ({
  reasons: {} as Record<string, string | undefined>,
  resendLastComposerSend: vi.fn(async (_id: string) => true),
}));
vi.mock("@/components/Terminal/resendLastComposerSend", () => ({
  readResendReadiness: (terminalId: string) => terminalId,
  resendUnavailableReason: (terminalId: string) => resend.reasons[terminalId],
  resendLastComposerSend: resend.resendLastComposerSend,
}));

const notify = vi.hoisted(() => vi.fn());
vi.mock("@/lib/notify", () => ({ notify }));

import { registerTerminalInputActions } from "../terminalInputActions";
import { UnactionableTargetError } from "@/services/actions/unactionableTarget";
import { useHeldComposerSendStore } from "@/store/heldComposerSendStore";

function definition(): AnyActionDefinition {
  const actions: ActionRegistry = new Map();
  registerTerminalInputActions(actions, {} as ActionCallbacks);
  return actions.get("terminal.resendLastMessage")!() as AnyActionDefinition;
}

beforeEach(() => {
  resend.reasons = { idle: undefined, empty: "Nothing sent to this panel yet" };
  resend.resendLastComposerSend.mockReset().mockResolvedValue(true);
  notify.mockReset();
  useHeldComposerSendStore.setState({ held: {}, dropped: {}, refused: {} });
});

describe("terminal.resendLastMessage (#16746)", () => {
  it("is available for the focused panel only while its message can go, and says why not", () => {
    const def = definition();
    const at = (focusedTerminalId?: string): ActionContext => ({ focusedTerminalId });

    expect(def.isEnabled?.(at("idle"))).toBe(true);
    expect(def.disabledReason?.(at("idle"))).toBeUndefined();
    expect(def.isEnabled?.(at("empty"))).toBe(false);
    expect(def.disabledReason?.(at("empty"))).toBe("Nothing sent to this panel yet");
    expect(def.isEnabled?.(at())).toBe(false);
    expect(def.disabledReason?.(at())).toMatch(/focused/);
  });

  it("resends to the focused panel when none is named, as the palette does", async () => {
    await definition().run(undefined, { focusedTerminalId: "idle", dispatchSource: "user" });
    expect(resend.resendLastComposerSend).toHaveBeenCalledWith("idle");
    expect(notify).not.toHaveBeenCalled();
  });

  it("says so when the panel turns the resend down, and fails the dispatch", async () => {
    resend.resendLastComposerSend.mockResolvedValue(false);

    await expect(
      definition().run(undefined, { focusedTerminalId: "idle", dispatchSource: "keybinding" })
    ).rejects.toThrow();
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ type: "error" }));
  });

  it("says so when another message was held first, which a hidden panel can't show", async () => {
    resend.resendLastComposerSend.mockImplementation(async (id: string) => {
      useHeldComposerSendStore.getState().noteHeld({
        terminalId: id,
        token: "elsewhere",
        text: "held from another screen",
        imagePaths: [],
        heldAt: 1,
        expiresAt: 2,
        status: "held",
      });
      return false;
    });

    await expect(
      definition().run(undefined, { focusedTerminalId: "idle", dispatchSource: "user" })
    ).rejects.toThrow();
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("resends to a named panel over the focused one", async () => {
    await definition().run(
      { terminalId: "idle" },
      {
        focusedTerminalId: "empty",
        dispatchSource: "context-menu",
      }
    );
    expect(resend.resendLastComposerSend).toHaveBeenCalledWith("idle");
  });

  it("refuses a panel whose message can't go, with the reason", async () => {
    await expect(
      definition().run({ terminalId: "empty" }, { dispatchSource: "user" })
    ).rejects.toThrow("Nothing sent to this panel yet");
    expect(resend.resendLastComposerSend).not.toHaveBeenCalled();
  });

  it.each(["agent", "plugin", undefined] as const)(
    "replays nobody's message for a %s dispatch",
    async (dispatchSource) => {
      for (const args of [undefined, { terminalId: "idle" }]) {
        await expect(
          definition().run(args, { focusedTerminalId: "idle", dispatchSource })
        ).rejects.toBeInstanceOf(UnactionableTargetError);
      }
      expect(resend.resendLastComposerSend).not.toHaveBeenCalled();
    }
  );
});
