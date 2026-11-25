import { describe, expect, it } from "vitest";
import { HOST_PACKAGES_COMMAND, HOST_PACKAGES_INSTRUCTION } from "@shared/config/linuxHostPackages";
import { splitHostFix } from "../hostFixCommands";

// The shape HostLibrariesMissingError writes (electron/remote/client/linuxHostLibraries.ts).
const refused = (host: string, note?: string) =>
  `Daintree can't start on ${host}: these libraries it needs aren't installed there: libnspr4, libnss3.so.${note ? ` ${note}.` : ""} ${HOST_PACKAGES_INSTRUCTION}`;

describe("splitHostFix", () => {
  it("takes the package install out of a refused start and offers it as the command", () => {
    const fix = splitHostFix(refused("box"));
    expect(fix.text).toBe(
      "Daintree can't start on box: these libraries it needs aren't installed there: libnspr4, libnss3.so."
    );
    expect(fix.rootCommand).toBe(HOST_PACKAGES_COMMAND);
  });

  it("keeps a note about an install as root that failed", () => {
    const fix = splitHostFix(
      refused("box", "Daintree couldn't install them as root there: apt-get couldn't install them")
    );
    expect(fix.text.endsWith("libnss3.so. Daintree couldn't install them as root there: apt-get couldn't install them.")).toBe(true);
    expect(fix.rootCommand).toBe(HOST_PACKAGES_COMMAND);
  });

  it("joins an installer's recovery note without a doubled stop", () => {
    const fix = splitHostFix(`${refused("the host")}. The previous build was put back.`);
    expect(fix.text).toBe(
      "Daintree can't start on the host: these libraries it needs aren't installed there: libnspr4, libnss3.so. The previous build was put back."
    );
    expect(fix.rootCommand).toBe(HOST_PACKAGES_COMMAND);
  });

  it("shows one command when a rollback was refused for the same reason", () => {
    const fix = splitHostFix(
      `${refused("the host")}. Daintree couldn't be started again on the host. ${refused("the host")}`
    );
    expect(fix.text).not.toContain("apt-get");
    expect(fix.text).toContain("Daintree couldn't be started again on the host. Daintree can't start");
    expect(fix.text.endsWith("libnss3.so.")).toBe(true);
    expect(fix.rootCommand).toBe(HOST_PACKAGES_COMMAND);
  });

  it("keeps whatever came before it, such as Bring back's own words", () => {
    const fix = splitHostFix(`Daintree on box wasn't started: ${refused("box")}`);
    expect(fix.text.startsWith("Daintree on box wasn't started: Daintree can't start on box:")).toBe(
      true
    );
    expect(fix.rootCommand).toBe(HOST_PACKAGES_COMMAND);
  });

  it("offers no command for words cut short inside it", () => {
    const whole = refused("box");
    const cut = `${whole.slice(0, whole.length - 40)}…`;
    expect(splitHostFix(cut)).toEqual({ text: cut, rootCommand: null });
  });

  it("leaves other errors as they are", () => {
    const other = "Couldn't connect: Permission denied (publickey)";
    expect(splitHostFix(other)).toEqual({ text: other, rootCommand: null });
  });
});
