import { beforeEach, describe, expect, it } from "vitest";

import {
  assertIpcSecurityReady,
  markIpcSecurityReady,
  _resetIpcGuardForTesting,
} from "../ipcGuard.js";

describe("ipcGuard", () => {
  beforeEach(() => {
    _resetIpcGuardForTesting();
  });

  it("throws when assert is called before mark", () => {
    expect(() => assertIpcSecurityReady("project:get:all")).toThrow(
      /IPC handler for 'project:get:all' registered before enforceIpcSenderValidation\(\) was called/
    );
  });

  it("includes the offending channel name in the error message", () => {
    let captured: unknown;
    try {
      assertIpcSecurityReady("worktree:create");
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(Error);
    expect((captured as Error).message).toContain("'worktree:create'");
  });

  it("does not throw after mark", () => {
    markIpcSecurityReady();
    expect(() => assertIpcSecurityReady("project:get:all")).not.toThrow();
  });

  it("is idempotent — repeated mark calls do not throw", () => {
    markIpcSecurityReady();
    markIpcSecurityReady();
    expect(() => assertIpcSecurityReady("project:get:all")).not.toThrow();
  });

  it("reset restores the throwing behavior", () => {
    markIpcSecurityReady();
    expect(() => assertIpcSecurityReady("project:get:all")).not.toThrow();
    _resetIpcGuardForTesting();
    expect(() => assertIpcSecurityReady("project:get:all")).toThrow();
  });
});
