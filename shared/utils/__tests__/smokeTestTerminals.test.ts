import { describe, expect, it } from "vitest";
import { isSmokeTestTerminalId } from "../smokeTestTerminals.js";

describe("isSmokeTestTerminalId", () => {
  it("matches known smoke test terminal prefixes", () => {
    expect(isSmokeTestTerminalId("smoke-test-terminal-0")).toBe(true);
    expect(isSmokeTestTerminalId("smoke-renderer-terminal")).toBe(true);
    expect(isSmokeTestTerminalId("smoke-main-terminal-12")).toBe(true);
    expect(isSmokeTestTerminalId("smoke-burst-3-1")).toBe(true);
  });

  it("ignores normal terminal ids", () => {
    expect(isSmokeTestTerminalId("default")).toBe(false);
    expect(isSmokeTestTerminalId("terminal-1")).toBe(false);
    expect(isSmokeTestTerminalId("smoke")).toBe(false);
    expect(isSmokeTestTerminalId(undefined)).toBe(false);
  });
});
