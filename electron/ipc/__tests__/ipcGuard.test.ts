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

  it("does not throw after mark", () => {
    markIpcSecurityReady();
    expect(() => assertIpcSecurityReady("project:get:all")).not.toThrow();
  });
});
