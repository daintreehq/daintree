import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/platform")>()),
  isMac: () => true,
}));

import { settingsMachineOptions } from "../SettingsMachinePicker";

function host(id: string, name: string, connected: boolean) {
  return {
    descriptor: { id, name },
    connection: { status: connected ? ("connected" as const) : ("disconnected" as const) },
  };
}

describe("settingsMachineOptions (#14706)", () => {
  it("offers this Mac first in a local window, then each paired host with its state", () => {
    const options = settingsMachineOptions(
      [host("studio-03", "studio-03", true), host("lab", "Lab", false)],
      "local",
      null
    );
    expect(options.map((o) => [o.hostId, o.name, o.connected])).toEqual([
      [null, "This Mac", true],
      ["studio-03", "studio-03", true],
      ["lab", "Lab", false],
    ]);
  });

  it("offers the window's host first in a remote window, then this Mac, never the host twice", () => {
    const options = settingsMachineOptions(
      [host("studio-03", "studio-03", true), host("lab", "Lab", true)],
      "studio-03",
      "studio-03"
    );
    expect(options.map((o) => o.hostId)).toEqual([null, "local", "lab"]);
    expect(options[0]!.name).toBe("studio-03");
    expect(options[1]!.name).toBe("This Mac");
  });

  it("has nothing to pick with no paired hosts", () => {
    expect(settingsMachineOptions([], "local", null)).toHaveLength(1);
  });
});
