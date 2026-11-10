import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ComposerHoldResult, HeldComposerSend } from "@shared/types/ipc/composerHold";

const client = vi.hoisted(() => ({
  submit: vi.fn<(id: string, text: string) => Promise<void>>(),
  submitWithImages: vi.fn<(id: string, text: string, imagePaths: string[]) => Promise<void>>(),
}));
vi.mock("@/clients", () => ({ terminalClient: client }));

const holdClient = vi.hoisted(() => ({
  hold: vi.fn<(id: string, text: string, imagePaths?: string[]) => Promise<ComposerHoldResult>>(),
}));
vi.mock("@/clients/composerHoldClient", () => ({ composerHoldClient: holdClient }));

vi.mock("@/utils/logger", () => ({ logWarn: vi.fn(), logError: vi.fn() }));

const service = vi.hoisted(() => ({
  managed: null as null | { isInputLocked?: boolean },
  notifyUserInput: vi.fn(),
}));
vi.mock("@/services/terminal/terminalInstanceServiceAccessor", () => ({
  peek: () => ({ get: () => service.managed }),
  with: (fn: (s: { notifyUserInput: (id: string) => void }) => void) =>
    fn({ notifyUserInput: service.notifyUserInput }),
}));

const panels = await vi.hoisted(async () => {
  const { create } = await import("zustand");
  return create(() => ({ panelsById: {} as Record<string, Record<string, unknown>> }));
});
vi.mock("@/store/panelStore", () => ({ usePanelStore: panels }));

import { setHostInputBlock } from "@/services/terminal/inputGate";
import { useHeldComposerSendStore } from "@/store/heldComposerSendStore";
import {
  claimComposerSendSeq,
  noteLastComposerSend,
  useLastComposerSendStore,
} from "@/store/lastComposerSendStore";
import { useTerminalInputStore } from "@/store/terminalInputStore";
import {
  NOTHING_SENT_REASON,
  readResendReadiness,
  resendLastComposerSend,
  resendUnavailableReason,
} from "../resendLastComposerSend";

const HELD: HeldComposerSend = {
  terminalId: "t1",
  token: "token-1",
  text: "ship it",
  imagePaths: [],
  heldAt: 1,
  expiresAt: 2,
  status: "held",
};

function pane(fields: Record<string, unknown> = {}): void {
  panels.setState({ panelsById: { t1: { id: "t1", kind: "terminal", ...fields } } });
}

function reason(): string | undefined {
  return resendUnavailableReason(readResendReadiness("t1"));
}

beforeEach(() => {
  client.submit.mockReset().mockResolvedValue(undefined);
  client.submitWithImages.mockReset().mockResolvedValue(undefined);
  holdClient.hold.mockReset();
  service.managed = null;
  service.notifyUserInput.mockReset();
  setHostInputBlock(null);
  useLastComposerSendStore.setState({ sends: {} });
  useHeldComposerSendStore.setState({ held: {}, dropped: {}, refused: {} });
  pane();
});

describe("resendLastComposerSend (#16746)", () => {
  it("sends the last message again as it went, images included", async () => {
    noteLastComposerSend("t1", "expanded text /a.png", ["/a.png"], claimComposerSendSeq());

    await expect(resendLastComposerSend("t1")).resolves.toBe(true);

    expect(client.submitWithImages).toHaveBeenCalledWith("t1", "expanded text /a.png", ["/a.png"]);
    expect(service.notifyUserInput).toHaveBeenCalledWith("t1");
  });

  it("leaves the composer's draft as it is", async () => {
    useTerminalInputStore.getState().setDraftInput("t1", "half-typed next prompt");
    noteLastComposerSend("t1", "the last one", [], claimComposerSendSeq());

    await resendLastComposerSend("t1");

    expect(useTerminalInputStore.getState().getDraftInput("t1")).toBe("half-typed next prompt");
    expect(client.submit).toHaveBeenCalledWith("t1", "the last one");
  });

  it("is held for a working agent that doesn't queue input, as a typed send is", async () => {
    pane({ agentState: "working", detectedAgentId: "gemini" });
    noteLastComposerSend("t1", "ship it", [], claimComposerSendSeq());
    holdClient.hold.mockResolvedValue({ held: true, send: HELD });

    await expect(resendLastComposerSend("t1")).resolves.toBe(true);

    expect(holdClient.hold).toHaveBeenCalledWith("t1", "ship it", undefined);
    expect(client.submit).not.toHaveBeenCalled();
    expect(useHeldComposerSendStore.getState().held.t1).toEqual(HELD);
  });

  it("is refused, not sent ahead, while a message is already held", async () => {
    noteLastComposerSend("t1", "again", [], claimComposerSendSeq());
    useHeldComposerSendStore.getState().noteHeld(HELD);

    await expect(resendLastComposerSend("t1")).resolves.toBe(false);

    expect(client.submit).not.toHaveBeenCalled();
    expect(useHeldComposerSendStore.getState().refused.t1).toBe(true);
  });

  it("is refused while the pane's input is locked or it is restarting", async () => {
    noteLastComposerSend("t1", "again", [], claimComposerSendSeq());

    pane({ isInputLocked: true });
    await expect(resendLastComposerSend("t1")).resolves.toBe(false);
    pane({ isRestarting: true });
    await expect(resendLastComposerSend("t1")).resolves.toBe(false);
    pane();
    service.managed = { isInputLocked: true };
    await expect(resendLastComposerSend("t1")).resolves.toBe(false);

    expect(client.submit).not.toHaveBeenCalled();
  });

  it("sends nothing when nothing was sent to the pane", async () => {
    await expect(resendLastComposerSend("t1")).resolves.toBe(false);
    expect(client.submit).not.toHaveBeenCalled();
  });
});

describe("resendUnavailableReason", () => {
  it("says nothing was sent before anything else", () => {
    pane({ isInputLocked: true });
    expect(reason()).toBe(NOTHING_SENT_REASON);
  });

  it("says why a message on record can't go now, and nothing once it can", () => {
    noteLastComposerSend("t1", "again", [], claimComposerSendSeq());
    expect(reason()).toBeUndefined();

    // A working agent that doesn't queue input is no reason: the resend is held.
    pane({ agentState: "working", detectedAgentId: "gemini" });
    expect(reason()).toBeUndefined();

    pane({ isRestarting: true });
    expect(reason()).toMatch(/isn't running/);
    pane({ isInputLocked: true });
    expect(reason()).toMatch(/locked/);
    pane();
    setHostInputBlock({ kind: "disconnected", hostName: "studio" });
    expect(reason()).toMatch(/studio/);
    setHostInputBlock(null);
    useHeldComposerSendStore.getState().noteHeld(HELD);
    expect(reason()).toMatch(/already held/);
  });
});
