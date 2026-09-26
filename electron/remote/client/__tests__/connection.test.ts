import { describe, expect, it } from "vitest";
import {
  formatHostConnection,
  readStoredHostConnection,
  sameHostConnection,
  sshConnection,
  type HostConnection,
} from "../../../../shared/types/remoteHosts.js";
import {
  connectionKey,
  parseHostConnection,
  requireHostConnection,
  requireSshTarget,
  sshTargetOf,
} from "../connection.js";

/** What a connection kind this build doesn't have yet looks like at runtime. */
const FUTURE_WSL = { kind: "wsl", distro: "Ubuntu" } as unknown as HostConnection;

describe("host connections", () => {
  it("shows an ssh host as the target the user typed", () => {
    expect(formatHostConnection(sshConnection("greg@studio"))).toBe("greg@studio");
    expect(connectionKey(sshConnection("greg@studio"))).toBe("ssh:greg@studio");
    expect(sameHostConnection(sshConnection("a"), sshConnection("a"))).toBe(true);
    expect(sameHostConnection(sshConnection("a"), sshConnection("b"))).toBe(false);
  });

  it("parses untrusted input: trimmed ssh targets only", () => {
    expect(parseHostConnection({ kind: "ssh", target: "  box.example " })).toEqual(
      sshConnection("box.example")
    );
    for (const value of [
      null,
      "box",
      { kind: "ssh" },
      { kind: "ssh", target: "-oProxyCommand=x" },
      { kind: "ssh", target: "a b" },
      FUTURE_WSL,
    ]) {
      expect(parseHostConnection(value)).toBeNull();
    }
    expect(() => requireHostConnection({ kind: "ssh", target: "" })).toThrow(
      expect.objectContaining({ code: "VALIDATION" })
    );
  });

  it("reads either stored shape", () => {
    expect(readStoredHostConnection({ sshTarget: "old" })).toEqual(sshConnection("old"));
    expect(
      readStoredHostConnection({ connection: sshConnection("new"), sshTarget: "old" })
    ).toEqual(sshConnection("new"));
    expect(readStoredHostConnection({ connection: FUTURE_WSL })).toBeNull();
    expect(readStoredHostConnection({})).toBeNull();
  });

  it("refuses ssh-only capabilities, typed, for any other kind", () => {
    expect(requireSshTarget(sshConnection("studio"), "Port forwarding")).toBe("studio");
    expect(sshTargetOf(FUTURE_WSL)).toBeNull();
    expect(() => requireSshTarget(FUTURE_WSL, "Port forwarding over ssh")).toThrow(
      expect.objectContaining({
        code: "UNSUPPORTED",
        message: "Port forwarding over ssh needs an ssh connection; this host is reached over wsl",
      })
    );
  });
});
