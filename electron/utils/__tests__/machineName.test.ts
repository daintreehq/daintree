import { describe, expect, it } from "vitest";
import { machineDisplayName, sshLoginTarget } from "../machineName.js";

describe("machineDisplayName", () => {
  it("uses a Mac's own computer name", () => {
    expect(
      machineDisplayName("darwin", "Gregs-Mac-Studio-2.local", () => "Greg's Mac Studio\n")
    ).toBe("Greg's Mac Studio");
  });

  it("falls back to the hostname without .local when a Mac has no computer name to give", () => {
    const fails = () => {
      throw new Error("scutil: ComputerName: not set");
    };
    expect(machineDisplayName("darwin", "Gregs-Mac-Studio-2.local", fails)).toBe(
      "Gregs-Mac-Studio-2"
    );
    expect(machineDisplayName("darwin", "studio.local", () => "  \n")).toBe("studio");
  });

  it("keeps a Linux hostname as it is", () => {
    expect(machineDisplayName("linux", "devbox", () => "unused")).toBe("devbox");
  });
});

describe("sshLoginTarget", () => {
  it("names the login at the hostname", () => {
    expect(sshLoginTarget("studio.local", () => "greg")).toBe("greg@studio.local");
  });

  it("gives the hostname alone when there is no login to name", () => {
    const fails = () => {
      throw new Error("ENOENT: no passwd entry");
    };
    expect(sshLoginTarget("studio.local", fails)).toBe("studio.local");
  });
});
