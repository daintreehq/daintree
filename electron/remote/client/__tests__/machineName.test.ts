import { describe, expect, it } from "vitest";
import { machineDisplayName } from "../machineName.js";

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
