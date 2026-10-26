import { beforeEach, describe, expect, it, vi } from "vitest";

const client = vi.hoisted(() => ({
  submit: vi.fn<(id: string, text: string) => Promise<void>>(),
  submitWithImages: vi.fn<(id: string, text: string, imagePaths: string[]) => Promise<void>>(),
}));
vi.mock("@/clients", () => ({ terminalClient: client }));

const logWarn = vi.hoisted(() => vi.fn());
vi.mock("@/utils/logger", () => ({ logWarn }));

import { submitComposerText } from "../submitComposerText";

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
