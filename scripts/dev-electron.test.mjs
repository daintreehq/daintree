import { describe, expect, it } from "vitest";
import { devSandboxUsable } from "./dev-electron.mjs";

const sysctls = (values) => (file) => {
  const name = file.split("/").pop();
  if (name in values) return `${values[name]}\n`;
  throw new Error("ENOENT");
};
const helper = (uid, mode) => () => ({ uid, mode });
const noHelper = () => {
  throw new Error("ENOENT");
};

describe("devSandboxUsable", () => {
  it("needs --no-sandbox where user namespaces are restricted and the helper isn't setuid root", () => {
    // Ubuntu 24.04 with the npm Electron: what aborted `npm run dev` there.
    expect(
      devSandboxUsable({
        stat: helper(1000, 0o100755),
        readFile: sysctls({ apparmor_restrict_unprivileged_userns: 1 }),
      })
    ).toBe(false);
    expect(
      devSandboxUsable({ stat: noHelper, readFile: sysctls({ unprivileged_userns_clone: 0 }) })
    ).toBe(false);
    // Setuid root but not executable by others: Chromium still aborts.
    expect(
      devSandboxUsable({
        stat: helper(0, 0o104750),
        readFile: sysctls({ apparmor_restrict_unprivileged_userns: 1 }),
      })
    ).toBe(false);
  });

  it("keeps the sandbox with a setuid-root helper or usable user namespaces", () => {
    expect(
      devSandboxUsable({
        stat: helper(0, 0o104755),
        readFile: sysctls({ apparmor_restrict_unprivileged_userns: 1 }),
      })
    ).toBe(true);
    expect(
      devSandboxUsable({
        stat: helper(1000, 0o100755),
        readFile: sysctls({ apparmor_restrict_unprivileged_userns: 0 }),
      })
    ).toBe(true);
    expect(devSandboxUsable({ stat: noHelper, readFile: sysctls({}) })).toBe(true);
  });
});
