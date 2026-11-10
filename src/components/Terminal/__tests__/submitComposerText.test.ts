import { beforeEach, describe, expect, it, vi } from "vitest";

const client = vi.hoisted(() => ({
  submit: vi.fn<(id: string, text: string) => Promise<void>>(),
  submitWithImages: vi.fn<(id: string, text: string, imagePaths: string[]) => Promise<void>>(),
}));
vi.mock("@/clients", () => ({ terminalClient: client }));

const logWarn = vi.hoisted(() => vi.fn());
vi.mock("@/utils/logger", () => ({ logWarn }));

const holdClient = vi.hoisted(() => ({
  hold: vi.fn<
    (
      id: string,
      text: string,
      imagePaths?: string[]
    ) => Promise<import("@shared/types/ipc/composerHold").ComposerHoldResult>
  >(),
}));
vi.mock("@/clients/composerHoldClient", () => ({ composerHoldClient: holdClient }));

const inputBlock = vi.hoisted(() => ({ blocked: null as null | { kind: string } }));
vi.mock("@/services/terminal/inputGate", () => ({
  getTerminalInputBlock: () => inputBlock.blocked,
}));

import { submitComposerText, submitPaneComposerText } from "../submitComposerText";
import { getLastComposerSend, useLastComposerSendStore } from "@/store/lastComposerSendStore";

beforeEach(() => {
  useLastComposerSendStore.setState({ sends: {} });
  client.submit.mockReset();
  client.submitWithImages.mockReset();
  holdClient.hold.mockReset();
  inputBlock.blocked = null;
  logWarn.mockReset();
});

describe("submitPaneComposerText", () => {
  it("passes a send's submission token on to the terminal", async () => {
    client.submit.mockResolvedValue(undefined);
    const pane = { canTakeInput: () => true, onSending: vi.fn(), onAccepted: vi.fn() };

    await submitPaneComposerText("t1", "notes", undefined, pane, "token-1");

    expect(client.submit).toHaveBeenCalledWith("t1", "notes", "token-1");
  });
});

describe("submitComposerText", () => {
  it("carries a submission token only when given one", async () => {
    client.submit.mockResolvedValue(undefined);
    client.submitWithImages.mockResolvedValue(undefined);

    await submitComposerText("t1", "plain", undefined);
    expect(client.submit).toHaveBeenLastCalledWith("t1", "plain");
    await submitComposerText("t1", "notes", undefined, "token-1");
    expect(client.submit).toHaveBeenLastCalledWith("t1", "notes", "token-1");
    await submitComposerText("t1", "notes", ["/a.png"], "token-2");
    expect(client.submitWithImages).toHaveBeenLastCalledWith("t1", "notes", ["/a.png"], "token-2");
  });

  it("says the terminal accepted it only once the submission resolves", async () => {
    let accept!: () => void;
    client.submit.mockReturnValue(
      new Promise<void>((resolve) => {
        accept = resolve;
      })
    );
    let settled: boolean | undefined;
    void submitComposerText("t1", "ship it", undefined).then((ok) => {
      settled = ok;
    });

    expect(client.submit).toHaveBeenCalledWith("t1", "ship it");
    await Promise.resolve();
    expect(settled).toBeUndefined();

    accept();
    await vi.waitFor(() => expect(settled).toBe(true));
  });

  it("reports a refused submission as not accepted, and logs it", async () => {
    const refusal = new Error("pty gone");
    client.submit.mockRejectedValue(refusal);

    await expect(submitComposerText("t1", "ship it", [])).resolves.toBe(false);
    expect(logWarn).toHaveBeenCalledWith("[TerminalPane] submit failed", {
      id: "t1",
      error: refusal,
    });
  });

  it("sends a draft's images alongside its text", async () => {
    client.submitWithImages.mockResolvedValue(undefined);

    await expect(submitComposerText("t1", "look /a.png", ["/a.png"])).resolves.toBe(true);
    expect(client.submitWithImages).toHaveBeenCalledWith("t1", "look /a.png", ["/a.png"]);
    expect(client.submit).not.toHaveBeenCalled();
  });
});

describe("submitPaneComposerText", () => {
  const pane = (canTakeInput = true) => ({
    canTakeInput: vi.fn(() => canTakeInput),
    onSending: vi.fn(),
    onAccepted: vi.fn(),
  });

  it("refuses without submitting when the pane can't take input as the text goes", async () => {
    const hooks = pane(false);

    await expect(submitPaneComposerText("t1", "ship it", [], hooks)).resolves.toBe(false);
    expect(client.submit).not.toHaveBeenCalled();
    expect(hooks.onSending).not.toHaveBeenCalled();
    expect(hooks.onAccepted).not.toHaveBeenCalled();
  });

  it("counts the send as the user's input only once the terminal has taken it", async () => {
    let accept!: () => void;
    client.submit.mockReturnValue(
      new Promise<void>((resolve) => {
        accept = resolve;
      })
    );
    const hooks = pane();

    const sent = submitPaneComposerText("t1", "ship it", undefined, hooks);
    expect(hooks.onSending).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    expect(hooks.onAccepted).not.toHaveBeenCalled();

    accept();
    await expect(sent).resolves.toBe(true);
    expect(hooks.onAccepted).toHaveBeenCalledTimes(1);
  });

  it("leaves a refused send uncounted", async () => {
    client.submit.mockRejectedValue(new Error("pty gone"));
    const hooks = pane();

    await expect(submitPaneComposerText("t1", "ship it", [], hooks)).resolves.toBe(false);
    expect(hooks.onSending).toHaveBeenCalledTimes(1);
    expect(hooks.onAccepted).not.toHaveBeenCalled();
  });

  it("hands the client its own copy of the draft's images", async () => {
    client.submitWithImages.mockResolvedValue(undefined);
    const imagePaths: readonly string[] = Object.freeze(["/a.png"]);

    await expect(submitPaneComposerText("t1", "look /a.png", imagePaths, pane())).resolves.toBe(
      true
    );
    const passed = client.submitWithImages.mock.calls[0]![2];
    expect(passed).toEqual(["/a.png"]);
    expect(passed).not.toBe(imagePaths);
  });
});

describe("submitPaneComposerText holding for a busy agent (#16379)", () => {
  const SEND = {
    terminalId: "t1",
    token: "token-1",
    text: "ship it",
    imagePaths: [],
    heldAt: 1,
    expiresAt: 2,
    status: "held" as const,
  };

  const pane = (hold: {
    isHolding?: boolean;
    mayHold?: boolean;
    canTakeInput?: () => boolean;
  }) => ({
    canTakeInput: vi.fn(hold.canTakeInput ?? (() => true)),
    onSending: vi.fn(),
    onAccepted: vi.fn(),
    hold: {
      isHolding: vi.fn(() => hold.isHolding ?? false),
      mayHold: vi.fn(() => hold.mayHold ?? true),
      onHeld: vi.fn(),
      onRefused: vi.fn(),
    },
  });

  it("holds the send instead of typing it, and counts it as taken", async () => {
    holdClient.hold.mockResolvedValue({ held: true, send: SEND });
    const hooks = pane({});

    await expect(submitPaneComposerText("t1", "ship it", [], hooks)).resolves.toBe(true);
    expect(holdClient.hold).toHaveBeenCalledWith("t1", "ship it", undefined);
    expect(hooks.hold.onHeld).toHaveBeenCalledWith(SEND);
    expect(client.submit).not.toHaveBeenCalled();
    // Nothing reached the terminal, so nothing counts as input to it yet.
    expect(hooks.onSending).not.toHaveBeenCalled();
    expect(hooks.onAccepted).not.toHaveBeenCalled();
  });

  it("refuses a second send while one is held, without asking main or typing", async () => {
    const hooks = pane({ isHolding: true });

    await expect(submitPaneComposerText("t1", "again", [], hooks)).resolves.toBe(false);
    expect(hooks.hold.onRefused).toHaveBeenCalledTimes(1);
    expect(holdClient.hold).not.toHaveBeenCalled();
    expect(client.submit).not.toHaveBeenCalled();
  });

  it("refuses when main already holds one this view hadn't heard of", async () => {
    holdClient.hold.mockResolvedValue({ held: false, reason: "already-held" });
    const hooks = pane({});

    await expect(submitPaneComposerText("t1", "again", [], hooks)).resolves.toBe(false);
    expect(hooks.hold.onRefused).toHaveBeenCalledTimes(1);
    expect(client.submit).not.toHaveBeenCalled();
  });

  it("neither holds nor types a send main couldn't hold", async () => {
    holdClient.hold.mockResolvedValue({ held: false, reason: "unavailable" });
    const hooks = pane({});

    await expect(submitPaneComposerText("t1", "ship it", [], hooks)).resolves.toBe(false);
    expect(client.submit).not.toHaveBeenCalled();
    expect(hooks.hold.onHeld).not.toHaveBeenCalled();
  });

  it("neither holds nor types a send when main can't be asked", async () => {
    holdClient.hold.mockRejectedValue(new Error("no handler"));
    const hooks = pane({});

    await expect(submitPaneComposerText("t1", "ship it", [], hooks)).resolves.toBe(false);
    expect(client.submit).not.toHaveBeenCalled();
  });

  it("sends at once when main finds the agent no longer busy", async () => {
    holdClient.hold.mockResolvedValue({ held: false, reason: "not-busy" });
    client.submit.mockResolvedValue(undefined);
    const hooks = pane({});

    await expect(submitPaneComposerText("t1", "ship it", [], hooks)).resolves.toBe(true);
    expect(client.submit).toHaveBeenCalledWith("t1", "ship it");
    expect(hooks.onAccepted).toHaveBeenCalledTimes(1);
  });

  it("keeps today's immediate send when the agent isn't one to hold for", async () => {
    client.submit.mockResolvedValue(undefined);
    const hooks = pane({ mayHold: false });

    await expect(submitPaneComposerText("t1", "ship it", [], hooks)).resolves.toBe(true);
    expect(holdClient.hold).not.toHaveBeenCalled();
    expect(client.submit).toHaveBeenCalledWith("t1", "ship it");
  });

  it("leaves blocked input to be refused the way it always was", async () => {
    inputBlock.blocked = { kind: "memory" };
    client.submit.mockRejectedValue(new Error("blocked"));
    const hooks = pane({});

    await expect(submitPaneComposerText("t1", "ship it", [], hooks)).resolves.toBe(false);
    expect(holdClient.hold).not.toHaveBeenCalled();
  });

  it("holds only the images that can be attachments", async () => {
    holdClient.hold.mockResolvedValue({ held: true, send: SEND });

    await submitPaneComposerText(
      "t1",
      "look /a.png relative.png",
      ["/a.png", "relative.png"],
      pane({})
    );
    expect(holdClient.hold).toHaveBeenCalledWith("t1", "look /a.png relative.png", ["/a.png"]);
  });

  it("reads again whether the pane takes input once main has answered", async () => {
    holdClient.hold.mockResolvedValue({ held: false, reason: "not-busy" });
    let open = true;
    const hooks = pane({
      canTakeInput: () => {
        const was = open;
        open = false;
        return was;
      },
    });

    await expect(submitPaneComposerText("t1", "ship it", [], hooks)).resolves.toBe(false);
    expect(client.submit).not.toHaveBeenCalled();
  });
});

describe("submitPaneComposerText noting the pane's last message (#16746)", () => {
  const pane = (hold?: { mayHold: boolean }) => ({
    canTakeInput: () => true,
    onSending: vi.fn(),
    onAccepted: vi.fn(),
    ...(hold && {
      hold: {
        isHolding: () => false,
        mayHold: () => hold.mayHold,
        onHeld: vi.fn(),
        onRefused: vi.fn(),
      },
    }),
  });

  it("notes a taken send as it went, with the images that went as attachments", async () => {
    client.submitWithImages.mockResolvedValue(undefined);

    await submitPaneComposerText(
      "t1",
      "expanded diff\nlook /a.png relative.png",
      ["/a.png", "relative.png"],
      pane()
    );

    expect(getLastComposerSend("t1")).toMatchObject({
      text: "expanded diff\nlook /a.png relative.png",
      imagePaths: ["/a.png"],
    });
  });

  it("notes a held send as main holds it, so a dropped or withdrawn one can go again", async () => {
    holdClient.hold.mockResolvedValue({
      held: true,
      send: {
        terminalId: "t1",
        token: "token-1",
        text: "ship it /a.png",
        imagePaths: ["/a.png"],
        heldAt: 1,
        expiresAt: 2,
        status: "held",
      },
    });

    await submitPaneComposerText("t1", "ship it /a.png", ["/a.png"], pane({ mayHold: true }));

    expect(getLastComposerSend("t1")).toMatchObject({
      text: "ship it /a.png",
      imagePaths: ["/a.png"],
    });
  });

  it("keeps the message on record when a later send is refused", async () => {
    client.submit.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("gone"));

    await submitPaneComposerText("t1", "first", undefined, pane());
    await expect(submitPaneComposerText("t1", "second", undefined, pane())).resolves.toBe(false);
    holdClient.hold.mockResolvedValue({ held: false, reason: "already-held" });
    await submitPaneComposerText("t1", "third", undefined, pane({ mayHold: true }));

    expect(getLastComposerSend("t1")?.text).toBe("first");
  });

  it("keeps a newer send when an older one is answered after it", async () => {
    let answerFirst!: () => void;
    client.submit
      .mockImplementationOnce(() => new Promise<void>((resolve) => (answerFirst = resolve)))
      .mockResolvedValueOnce(undefined);

    const first = submitPaneComposerText("t1", "first", undefined, pane());
    await submitPaneComposerText("t1", "second", undefined, pane());
    answerFirst();
    await first;

    expect(getLastComposerSend("t1")?.text).toBe("second");
  });
});
