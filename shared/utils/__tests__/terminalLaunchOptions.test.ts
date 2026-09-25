import { describe, expect, it } from "vitest";
import { mergeTerminalLaunchEnv, spawnSourceForMcpOrigin } from "../terminalLaunchOptions.js";

describe("mergeTerminalLaunchEnv", () => {
  it("layers global under project under the launch env", () => {
    expect(
      mergeTerminalLaunchEnv({ A: "g", B: "g", C: "g" }, { B: "p", C: "p" }, { C: "l" })
    ).toEqual({ A: "g", B: "p", C: "l" });
  });

  it("passes the launch env through, undefined included, when no ambient layer is set", () => {
    const launch = { X: "1" };
    expect(mergeTerminalLaunchEnv({}, {}, launch)).toBe(launch);
    expect(mergeTerminalLaunchEnv(null, undefined, undefined)).toBeUndefined();
  });

  it("returns a fresh object when it merges", () => {
    const global = { A: "g" };
    const merged = mergeTerminalLaunchEnv(global, {}, undefined);
    expect(merged).toEqual({ A: "g" });
    expect(merged).not.toBe(global);
  });
});

describe("spawnSourceForMcpOrigin", () => {
  it("credits only Daintree's own assistant surfaces to the assistant", () => {
    expect(spawnSourceForMcpOrigin("help")).toBe("assistant");
    expect(spawnSourceForMcpOrigin("assistant-pane")).toBe("assistant");
    expect(spawnSourceForMcpOrigin("external")).toBe("mcp");
    expect(spawnSourceForMcpOrigin(undefined)).toBe("mcp");
  });
});
