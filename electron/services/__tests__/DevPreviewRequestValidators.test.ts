import { describe, expect, it } from "vitest";
import type {
  DevPreviewEnsureRequest,
  DevPreviewSessionRequest,
  DevPreviewStopByPanelRequest,
} from "../../../shared/types/ipc/devPreview.js";
import {
  createSessionKey,
  sanitizeToken,
  cloneEnv,
  envEquals,
  isPlainRecord,
  validateEnsureRequest,
  validateSessionRequest,
  validateStopByPanelRequest,
} from "../DevPreviewRequestValidators.js";

describe("createSessionKey", () => {
  it("joins projectId and panelId with a separator", () => {
    const key = createSessionKey("proj", "panel");
    expect(key).toContain("proj");
    expect(key).toContain("panel");
    expect(key).not.toBe("projpanel");
  });

  it("is deterministic", () => {
    expect(createSessionKey("a", "b")).toBe(createSessionKey("a", "b"));
  });

  it("produces different keys for different inputs", () => {
    expect(createSessionKey("a", "b")).not.toBe(createSessionKey("a", "c"));
  });
});

describe("sanitizeToken", () => {
  it("returns identity for clean input", () => {
    expect(sanitizeToken("hello_world-123")).toBe("hello_world-123");
  });

  it("replaces invalid characters with dashes", () => {
    expect(sanitizeToken("hello world!")).toBe("hello-world-");
  });

  it("truncates to 24 characters", () => {
    const long = "a".repeat(50);
    expect(sanitizeToken(long).length).toBeLessThanOrEqual(24);
  });

  it("returns dashes for all-invalid input", () => {
    expect(sanitizeToken("!!!")).toBe("---");
  });

  it("returns 'x' for entirely empty input", () => {
    expect(sanitizeToken("")).toBe("x");
  });
});

describe("cloneEnv", () => {
  it("returns undefined for undefined input", () => {
    expect(cloneEnv(undefined)).toBeUndefined();
  });

  it("returns a shallow copy", () => {
    const env = { FOO: "bar" };
    const cloned = cloneEnv(env);
    expect(cloned).toEqual(env);
    expect(cloned).not.toBe(env);
  });

  it("returns a copy disconnected from the original", () => {
    const env: Record<string, string> = { FOO: "bar" };
    const cloned = cloneEnv(env)!;
    env.BAZ = "qux";
    expect(cloned).not.toHaveProperty("BAZ");
  });
});

describe("envEquals", () => {
  it("returns true for two undefined", () => {
    expect(envEquals(undefined, undefined)).toBe(true);
  });

  it("returns false for one undefined", () => {
    expect(envEquals({ A: "1" }, undefined)).toBe(false);
    expect(envEquals(undefined, { A: "1" })).toBe(false);
  });

  it("returns true for equal objects", () => {
    expect(envEquals({ A: "1", B: "2" }, { A: "1", B: "2" })).toBe(true);
  });

  it("returns false for different values", () => {
    expect(envEquals({ A: "1" }, { A: "2" })).toBe(false);
  });

  it("returns false for different key counts", () => {
    expect(envEquals({ A: "1" }, { A: "1", B: "2" })).toBe(false);
  });
});

describe("isPlainRecord", () => {
  it("returns false for null", () => {
    expect(isPlainRecord(null)).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isPlainRecord(undefined)).toBe(false);
  });

  it("returns false for arrays", () => {
    expect(isPlainRecord([])).toBe(false);
  });

  it("returns true for plain objects", () => {
    expect(isPlainRecord({})).toBe(true);
    expect(isPlainRecord({ a: 1 })).toBe(true);
  });

  it("returns false for class instances", () => {
    expect(isPlainRecord(new Date())).toBe(false);
  });

  it("returns true for Object.create(null)", () => {
    expect(isPlainRecord(Object.create(null))).toBe(true);
  });
});

describe("validateEnsureRequest", () => {
  const valid = {
    panelId: "panel-1",
    projectId: "project-1",
    cwd: "/tmp",
    devCommand: "npm run dev",
  };

  it("throws for null", () => {
    expect(() => validateEnsureRequest(null as unknown as DevPreviewEnsureRequest)).toThrow(
      "Invalid dev preview request"
    );
  });

  it("throws for missing panelId", () => {
    expect(() =>
      validateEnsureRequest({ ...valid, panelId: undefined } as unknown as DevPreviewEnsureRequest)
    ).toThrow("panelId is required");
  });

  it("throws for empty panelId", () => {
    expect(() => validateEnsureRequest({ ...valid, panelId: "  " })).toThrow("panelId is required");
  });

  it("throws for missing projectId", () => {
    expect(() =>
      validateEnsureRequest({
        ...valid,
        projectId: undefined,
      } as unknown as DevPreviewEnsureRequest)
    ).toThrow("projectId is required");
  });

  it("throws for missing cwd", () => {
    expect(() =>
      validateEnsureRequest({ ...valid, cwd: undefined } as unknown as DevPreviewEnsureRequest)
    ).toThrow("cwd is required");
  });

  it("throws for non-string devCommand", () => {
    expect(() =>
      validateEnsureRequest({ ...valid, devCommand: 123 } as unknown as DevPreviewEnsureRequest)
    ).toThrow("devCommand must be a string");
  });

  it("throws for invalid worktreeId type", () => {
    expect(() =>
      validateEnsureRequest({ ...valid, worktreeId: 123 } as unknown as DevPreviewEnsureRequest)
    ).toThrow("worktreeId must be a string if provided");
  });

  it("throws for non-plain env", () => {
    expect(() =>
      validateEnsureRequest({ ...valid, env: [] } as unknown as DevPreviewEnsureRequest)
    ).toThrow("env must be a plain object if provided");
  });

  it("throws for env with empty key", () => {
    expect(() =>
      validateEnsureRequest({ ...valid, env: { "": "x" } } as unknown as DevPreviewEnsureRequest)
    ).toThrow("env contains invalid key");
  });

  it("throws for env with constructor key", () => {
    expect(() =>
      validateEnsureRequest({
        ...valid,
        env: { constructor: "x" },
      } as unknown as DevPreviewEnsureRequest)
    ).toThrow("env contains invalid key");
  });

  it("throws for env with non-string value", () => {
    expect(() =>
      validateEnsureRequest({ ...valid, env: { FOO: 123 } } as unknown as DevPreviewEnsureRequest)
    ).toThrow("env values must be strings");
  });

  it("throws for non-boolean turbopackEnabled", () => {
    expect(() =>
      validateEnsureRequest({
        ...valid,
        turbopackEnabled: "yes",
      } as unknown as DevPreviewEnsureRequest)
    ).toThrow("turbopackEnabled must be a boolean if provided");
  });

  it("accepts a valid request", () => {
    expect(() => validateEnsureRequest(valid)).not.toThrow();
  });

  it("accepts valid request with optional fields", () => {
    expect(() =>
      validateEnsureRequest({
        ...valid,
        worktreeId: "wt-1",
        env: { FOO: "bar" },
        turbopackEnabled: false,
      })
    ).not.toThrow();
  });
});

describe("validateSessionRequest", () => {
  const valid = {
    panelId: "panel-1",
    projectId: "project-1",
  };

  it("throws for null", () => {
    expect(() => validateSessionRequest(null as unknown as DevPreviewSessionRequest)).toThrow(
      "Invalid dev preview session request"
    );
  });

  it("throws for missing panelId", () => {
    expect(() =>
      validateSessionRequest({
        ...valid,
        panelId: undefined,
      } as unknown as DevPreviewSessionRequest)
    ).toThrow("panelId is required");
  });

  it("throws for missing projectId", () => {
    expect(() =>
      validateSessionRequest({
        ...valid,
        projectId: undefined,
      } as unknown as DevPreviewSessionRequest)
    ).toThrow("projectId is required");
  });

  it("accepts a valid request", () => {
    expect(() => validateSessionRequest(valid)).not.toThrow();
  });
});

describe("validateStopByPanelRequest", () => {
  const valid = {
    panelId: "panel-1",
  };

  it("throws for null", () => {
    expect(() =>
      validateStopByPanelRequest(null as unknown as DevPreviewStopByPanelRequest)
    ).toThrow("Invalid dev preview stop-by-panel request");
  });

  it("throws for missing panelId", () => {
    expect(() =>
      validateStopByPanelRequest({
        ...valid,
        panelId: undefined,
      } as unknown as DevPreviewStopByPanelRequest)
    ).toThrow("panelId is required");
  });

  it("accepts a valid request", () => {
    expect(() => validateStopByPanelRequest(valid)).not.toThrow();
  });
});
