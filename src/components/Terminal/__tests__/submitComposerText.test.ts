import { beforeEach, describe, expect, it, vi } from "vitest";

const client = vi.hoisted(() => ({
  submit: vi.fn<(id: string, text: string) => Promise<void>>(),
  submitWithImages: vi.fn<(id: string, text: string, imagePaths: string[]) => Promise<void>>(),
}));
vi.mock("@/clients", () => ({ terminalClient: client }));

const logWarn = vi.hoisted(() => vi.fn());
vi.mock("@/utils/logger", () => ({ logWarn }));

import { submitComposerText, submitPaneComposerText } from "../submitComposerText";

beforeEach(() => {
  client.submit.mockReset();
  client.submitWithImages.mockReset();
  logWarn.mockReset();
});

describe("submitComposerText", () => {
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
