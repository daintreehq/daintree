import { describe, expect, it } from "vitest";
import { HOST_PACKAGES_COMMAND, HOST_PACKAGES_INSTRUCTION } from "@shared/config/linuxHostPackages";
import { splitHostFix } from "../hostFixCommands";

// The shape HostLibrariesMissingError writes (electron/remote/client/linuxHostLibraries.ts).
const words = (host: string, note?: string) =>
  `Daintree can't start on ${host}: these libraries it needs aren't installed there: libnspr4, libnss3.so.${note ? ` ${note}.` : ""}`;
const refused = (host: string, note?: string) =>
  `${words(host, note)} ${HOST_PACKAGES_INSTRUCTION}`;

describe("splitHostFix", () => {
  it("takes the package install out of a refused start and offers it as the command", () => {
    expect(splitHostFix(refused("box"))).toEqual({
      text: words("box"),
      rootCommand: HOST_PACKAGES_COMMAND,
    });
  });

  it("keeps a note about an install as root that failed", () => {
    const note = "Daintree couldn't install them as root there: apt-get couldn't install them";
    expect(splitHostFix(refused("box", note))).toEqual({
      text: words("box", note),
      rootCommand: HOST_PACKAGES_COMMAND,
    });
  });

  it("joins an installer's recovery note without a doubled stop", () => {
    // hostInstaller.ts withRecovery: `${base.message}. ${note}`.
    expect(splitHostFix(`${refused("the host")}. The previous build was put back.`)).toEqual({
      text: `${words("the host")} The previous build was put back.`,
      rootCommand: HOST_PACKAGES_COMMAND,
    });
  });

  it("shows one command when the build put back was refused for the same reason", () => {
    // hostInstaller.ts withRecovery, with the restored build's own refusal as its note.
    const message = `${refused("the host")}. The previous build wasn't started again. ${refused("the host")}`;
    expect(splitHostFix(message)).toEqual({
      text: `${words("the host")} The previous build wasn't started again. ${words("the host")}`,
      rootCommand: HOST_PACKAGES_COMMAND,
    });
  });

  it("keeps whatever came before it, such as Bring back's own words", () => {
    expect(splitHostFix(`Daintree on box wasn't started: ${refused("box")}`)).toEqual({
      text: `Daintree on box wasn't started: ${words("box")}`,
      rootCommand: HOST_PACKAGES_COMMAND,
    });
  });

  it("offers no command for words cut short inside it, however close to its end", () => {
    const whole = refused("box");
    for (const cut of [`${whole.slice(0, -40)}…`, whole.slice(0, -1)]) {
      expect(splitHostFix(cut)).toEqual({ text: cut, rootCommand: null });
    }
  });

  it("leaves other errors exactly as they are", () => {
    const other = "  Couldn't connect:\nPermission denied (publickey)  ";
    expect(splitHostFix(other)).toEqual({ text: other, rootCommand: null });
  });
});
