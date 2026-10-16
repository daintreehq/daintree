import { describe, expect, it } from "vitest";
import {
  formatHostConnection,
  readStoredHostConnection,
  sameHostAccount,
  sameHostConnection,
  sameHostMachine,
  sshConnection,
  wslConnection,
  wslDistroOf,
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
const FUTURE_KIND = { kind: "tcp", address: "studio:7000" } as unknown as HostConnection;

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
      { kind: "wsl" },
      { kind: "wsl", distro: "" },
      { kind: "wsl", distro: "-u root" },
      { kind: "wsl", distro: "Ubuntu;rm" },
      { kind: "wsl", distro: "x".repeat(65) },
      FUTURE_KIND,
    ]) {
      expect(parseHostConnection(value)).toBeNull();
    }
    expect(() => requireHostConnection({ kind: "ssh", target: "" })).toThrow(
      expect.objectContaining({ code: "VALIDATION" })
    );
  });

  it("parses a WSL distro, trimmed, with the names wsl.exe lists", () => {
    expect(parseHostConnection({ kind: "wsl", distro: " Ubuntu-24.04 " })).toEqual(
      wslConnection("Ubuntu-24.04")
    );
    for (const distro of [
      "Debian",
      "archlinux",
      "FedoraLinux-44",
      "Ubuntu 22.04 LTS",
      "my_distro",
    ]) {
      expect(parseHostConnection({ kind: "wsl", distro })).toEqual(wslConnection(distro));
    }
    expect(() => requireHostConnection({ kind: "wsl", distro: "--exec" })).toThrow(
      expect.objectContaining({
        code: "VALIDATION",
        userMessage: "Choose a WSL distribution installed on this PC.",
      })
    );
  });

  it("names a WSL host by its distro and compares distros without regard to case", () => {
    const wsl = wslConnection("Ubuntu-24.04");
    expect(formatHostConnection(wsl)).toBe("Ubuntu-24.04 (WSL)");
    expect(connectionKey(wsl)).toBe("wsl:ubuntu-24.04");
    expect(connectionKey(wslConnection("UBUNTU-24.04"))).toBe(connectionKey(wsl));
    expect(wslDistroOf(wsl)).toBe("Ubuntu-24.04");
    expect(wslDistroOf(sshConnection("studio"))).toBeNull();
    expect(sshTargetOf(wsl)).toBeNull();
    expect(sameHostConnection(wsl, wslConnection("ubuntu-24.04"))).toBe(true);
    expect(sameHostAccount(wsl, wslConnection("UBUNTU-24.04"))).toBe(true);
    expect(sameHostMachine(wsl, wslConnection("Debian"))).toBe(false);
    // A distro and an ssh target that happen to share a name are different hosts.
    expect(sameHostConnection(wslConnection("studio"), sshConnection("studio"))).toBe(false);
    expect(sameHostAccount(wslConnection("studio"), sshConnection("studio"))).toBe(false);
  });

  it("reads either stored shape", () => {
    expect(readStoredHostConnection({ sshTarget: "old" })).toEqual(sshConnection("old"));
    expect(
      readStoredHostConnection({ connection: sshConnection("new"), sshTarget: "old" })
    ).toEqual(sshConnection("new"));
    expect(readStoredHostConnection({ connection: wslConnection("Debian") })).toEqual(
      wslConnection("Debian")
    );
    expect(readStoredHostConnection({ connection: { kind: "wsl", distro: 4 } })).toBeNull();
    expect(readStoredHostConnection({ connection: FUTURE_KIND })).toBeNull();
    expect(readStoredHostConnection({})).toBeNull();
  });

  it("refuses ssh-only capabilities, typed, for any other kind", () => {
    expect(requireSshTarget(sshConnection("studio"), "Port forwarding")).toBe("studio");
    expect(() => requireSshTarget(wslConnection("Ubuntu"), "Copying a file over scp")).toThrow(
      expect.objectContaining({
        code: "UNSUPPORTED",
        userMessage: "Copying a file over scp isn't available for Ubuntu (WSL) yet.",
      })
    );
    expect(sshTargetOf(FUTURE_KIND)).toBeNull();
    expect(() => requireSshTarget(FUTURE_KIND, "Port forwarding over ssh")).toThrow(
      expect.objectContaining({
        code: "UNSUPPORTED",
        message: "Port forwarding over ssh needs an ssh connection; this host is reached over tcp",
      })
    );
  });
});
