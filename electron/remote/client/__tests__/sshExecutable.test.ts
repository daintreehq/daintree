import { describe, expect, it } from "vitest";
import path from "node:path";
import { SSH_EXECUTABLE_ENV, sshExecutable, sshKeyscanExecutable } from "../sshExecutable.js";

describe("sshExecutable", () => {
  it("runs ssh from PATH unless an absolute path is configured", () => {
    expect(sshExecutable({})).toBe("ssh");
    expect(sshExecutable({ [SSH_EXECUTABLE_ENV]: "/opt/ssh/bin/ssh" })).toBe("/opt/ssh/bin/ssh");
    expect(sshExecutable({ [SSH_EXECUTABLE_ENV]: "  /opt/ssh/bin/ssh " })).toBe("/opt/ssh/bin/ssh");
  });

  it("ignores an empty or relative value rather than resolving it against the cwd", () => {
    expect(sshExecutable({ [SSH_EXECUTABLE_ENV]: "" })).toBe("ssh");
    expect(sshExecutable({ [SSH_EXECUTABLE_ENV]: "bin/ssh" })).toBe("ssh");
    expect(sshExecutable({ [SSH_EXECUTABLE_ENV]: "ssh-wrapper" })).toBe("ssh");
  });
});

describe("sshKeyscanExecutable", () => {
  it("runs the ssh-keyscan beside a configured ssh, keeping its extension", () => {
    expect(sshKeyscanExecutable({ [SSH_EXECUTABLE_ENV]: "/opt/ssh/bin/ssh" })).toBe(
      path.join("/opt/ssh/bin", "ssh-keyscan")
    );
    expect(sshKeyscanExecutable({ [SSH_EXECUTABLE_ENV]: "/opt/OpenSSH/ssh.exe" })).toBe(
      path.join("/opt/OpenSSH", "ssh-keyscan.exe")
    );
  });

  it("runs ssh-keyscan from PATH when ssh comes from PATH", () => {
    expect(sshKeyscanExecutable({})).toBe("ssh-keyscan");
    expect(sshKeyscanExecutable({ [SSH_EXECUTABLE_ENV]: "bin/ssh" })).toBe("ssh-keyscan");
  });
});
