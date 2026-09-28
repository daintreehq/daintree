import { describe, expect, it } from "vitest";
import { SSH_EXECUTABLE_ENV, sshExecutable } from "../sshExecutable.js";

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
