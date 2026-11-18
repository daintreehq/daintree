import { describe, expect, it } from "vitest";
import { parkedLinkError } from "../parkedLinkError.js";

describe("parkedLinkError", () => {
  it("says an ssh refusal in ssh's words", () => {
    expect(
      parkedLinkError("studio-01", { kind: "ssh-access" }, "greg@studio-01: Permission denied.")
    ).toMatchObject({
      code: "HOST_SSH_ACCESS_DENIED",
      userMessage: "ssh couldn't log in to studio-01: greg@studio-01: Permission denied.",
    });
  });

  it("names the missing WSL distribution, and the host when its name differs", () => {
    const missing = (distro: string, host: string) =>
      parkedLinkError(host, { kind: "wsl-distro-missing", distro }, "no such distribution");
    expect(missing("Debian", "Debian")).toMatchObject({
      code: "HOST_CONNECTION_UNUSABLE",
      userMessage: "WSL couldn't find Debian. Restore it under that name, then try again.",
    });
    expect(missing("Ubuntu-24.04", "Build").userMessage).toBe(
      "WSL couldn't find Ubuntu-24.04 for Build. Restore it under that name, then try again."
    );
    expect(missing("Ubuntu-24.04", "Build").userMessage).not.toMatch(/ssh/i);
  });

  it("says an unusable connection in the transport's words, as one sentence", () => {
    const unusable = (message: string) =>
      parkedLinkError("Dev", { kind: "unusable", message }, null).userMessage;
    expect(parkedLinkError("Dev", { kind: "unusable", message: "x" }, null).code).toBe(
      "HOST_CONNECTION_UNUSABLE"
    );
    expect(unusable("  The provider is still checking…  ")).toBe(
      "Couldn't connect to Dev. The provider is still checking…"
    );
    expect(unusable("WSL isn't available on this PC")).toBe(
      "Couldn't connect to Dev. WSL isn't available on this PC."
    );
    expect(unusable("The cloud machine was deleted.")).toBe(
      "Couldn't connect to Dev. The cloud machine was deleted."
    );
    // No words from the transport: no empty sentence after the first.
    expect(unusable("  ")).toBe("Couldn't connect to Dev, and automatic retries have stopped.");
  });

  it("says only that retries stopped when nothing said why", () => {
    expect(parkedLinkError("Dev", undefined, "Permission denied")).toMatchObject({
      code: "HOST_CONNECTION_UNUSABLE",
      userMessage: "Couldn't connect to Dev, and automatic retries have stopped.",
    });
  });
});
