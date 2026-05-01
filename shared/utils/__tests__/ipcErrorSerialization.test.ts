import { describe, it, expect } from "vitest";
import {
  serializeError,
  deserializeError,
  wrapSuccess,
  wrapError,
} from "../ipcErrorSerialization.js";
import { isIpcEnvelope } from "../../types/ipc/errors.js";

describe("serializeError", () => {
  it("serializes a plain Error", () => {
    const err = new Error("something failed");
    const serialized = serializeError(err);

    expect(serialized.name).toBe("Error");
    expect(serialized.message).toBe("something failed");
    expect(serialized.stack).toBeDefined();
  });

  it("serializes a named error", () => {
    const err = new TypeError("invalid type");
    const serialized = serializeError(err);

    expect(serialized.name).toBe("TypeError");
    expect(serialized.message).toBe("invalid type");
  });

  it("serializes Node errno properties", () => {
    const err = Object.assign(new Error("file not found"), {
      code: "ENOENT",
      errno: -2,
      syscall: "open",
      path: "/tmp/missing.txt",
    });
    const serialized = serializeError(err);

    expect(serialized.code).toBe("ENOENT");
    expect(serialized.errno).toBe(-2);
    expect(serialized.syscall).toBe("open");
    expect(serialized.path).toBe("/tmp/missing.txt");
  });

  it("serializes a context object", () => {
    const err = Object.assign(new Error("git failed"), {
      name: "GitError",
      context: { worktreeId: "wt-123", command: "git status" },
    });
    const serialized = serializeError(err);

    expect(serialized.name).toBe("GitError");
    expect(serialized.context).toEqual({ worktreeId: "wt-123", command: "git status" });
  });

  it("serializes cause recursively", () => {
    const cause = new Error("root cause");
    const err = Object.assign(new Error("wrapper"), { cause });
    const serialized = serializeError(err);

    expect(serialized.cause).toBeDefined();
    expect(serialized.cause!.message).toBe("root cause");
  });

  it("handles circular cause chains", () => {
    const a = new Error("error a") as Error & { cause: Error };
    const b = new Error("error b") as Error & { cause: Error };
    a.cause = b;
    b.cause = a;

    const serialized = serializeError(a);
    expect(serialized.cause).toBeDefined();
    expect(serialized.cause!.message).toBe("error b");
    expect(serialized.cause!.cause).toBeDefined();
    expect(serialized.cause!.cause!.message).toBe("[Circular]");
  });

  it("captures arbitrary own properties in properties bag", () => {
    const err = Object.assign(new Error("conflict"), {
      name: "NoteConflictError",
      currentLastModified: 1234567890,
      expectedLastModified: 1234567800,
    });
    const serialized = serializeError(err);

    expect(serialized.properties).toBeDefined();
    expect(serialized.properties!.currentLastModified).toBe(1234567890);
    expect(serialized.properties!.expectedLastModified).toBe(1234567800);
  });

  it("excludes function properties", () => {
    const err = Object.assign(new Error("test"), {
      toJSON: () => "custom",
    });
    const serialized = serializeError(err);

    expect(serialized.properties?.toJSON).toBeUndefined();
  });

  it("handles non-Error values", () => {
    expect(serializeError("string error").message).toBe("string error");
    expect(serializeError(42).message).toBe("42");
    expect(serializeError(null).message).toBe("null");
    expect(serializeError(undefined).message).toBe("undefined");
  });
});

describe("deserializeError", () => {
  it("reconstructs a basic Error", () => {
    const serialized = { name: "Error", message: "test error" };
    const err = deserializeError(serialized);

    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("Error");
    expect(err.message).toBe("test error");
  });

  it("preserves error name", () => {
    const serialized = { name: "GitError", message: "git failed" };
    const err = deserializeError(serialized);

    expect(err.name).toBe("GitError");
  });

  it("restores Node errno properties", () => {
    const serialized = {
      name: "Error",
      message: "file not found",
      code: "ENOENT",
      errno: -2,
      syscall: "open",
      path: "/tmp/missing.txt",
    };
    const err = deserializeError(serialized) as NodeJS.ErrnoException;

    expect(err.code).toBe("ENOENT");
    expect(err.errno).toBe(-2);
    expect(err.syscall).toBe("open");
    expect(err.path).toBe("/tmp/missing.txt");
  });

  it("restores context", () => {
    const serialized = {
      name: "GitError",
      message: "failed",
      context: { worktreeId: "wt-1" },
    };
    const err = deserializeError(serialized) as Error & { context: Record<string, unknown> };

    expect(err.context).toEqual({ worktreeId: "wt-1" });
  });

  it("restores cause recursively", () => {
    const serialized = {
      name: "Error",
      message: "wrapper",
      cause: { name: "Error", message: "root cause" },
    };
    const err = deserializeError(serialized);

    expect(err.cause).toBeInstanceOf(Error);
    expect((err.cause as Error).message).toBe("root cause");
  });

  it("restores arbitrary properties from properties bag", () => {
    const serialized = {
      name: "NoteConflictError",
      message: "conflict",
      properties: { currentLastModified: 1234567890 },
    };
    const err = deserializeError(serialized) as Error & { currentLastModified: number };

    expect(err.currentLastModified).toBe(1234567890);
  });

  it("restores stack when present", () => {
    const serialized = {
      name: "Error",
      message: "test",
      stack: "Error: test\n    at foo.ts:1:1",
    };
    const err = deserializeError(serialized);

    expect(err.stack).toBe("Error: test\n    at foo.ts:1:1");
  });
});

describe("round-trip serialization", () => {
  it("round-trips a plain Error", () => {
    const original = new Error("test error");
    const restored = deserializeError(serializeError(original));

    expect(restored.name).toBe(original.name);
    expect(restored.message).toBe(original.message);
  });

  it("round-trips an Error with Node properties", () => {
    const original = Object.assign(new Error("ENOENT"), {
      code: "ENOENT",
      errno: -2,
      syscall: "stat",
      path: "/missing",
    });
    const restored = deserializeError(serializeError(original)) as NodeJS.ErrnoException;

    expect(restored.code).toBe("ENOENT");
    expect(restored.errno).toBe(-2);
    expect(restored.syscall).toBe("stat");
    expect(restored.path).toBe("/missing");
  });

  it("round-trips an Error with context and custom properties", () => {
    const original = Object.assign(new Error("conflict"), {
      name: "ConflictError",
      context: { resourceId: "r-1" },
      currentLastModified: 12345,
    });
    const restored = deserializeError(serializeError(original)) as Error & {
      context: Record<string, unknown>;
      currentLastModified: number;
    };

    expect(restored.name).toBe("ConflictError");
    expect(restored.context).toEqual({ resourceId: "r-1" });
    expect(restored.currentLastModified).toBe(12345);
  });

  it("round-trips a GitOperationError discriminator via serialize -> structuredClone -> deserialize", () => {
    // Shared-layer test synthesizes the GitOperationError shape without importing
    // the electron/ module — shared/ must not depend on electron/.
    //
    // The handler's `reason` field is promoted to the top-level `gitReason`
    // slot on `SerializedError` so it survives the packaged-build strip in
    // `electron/setup/security.ts` (which clears `context`/`cause`/`properties`
    // but preserves named top-level fields).
    const original = Object.assign(new Error("fatal: not a git repository"), {
      name: "GitOperationError",
      context: { cwd: "/repo", op: "status", reason: "not-a-repository" },
      reason: "not-a-repository",
      op: "status",
      rawMessage: "fatal: not a git repository",
    });

    const serialized = serializeError(original);
    expect(serialized.gitReason).toBe("not-a-repository");

    const cloned = structuredClone(serialized);
    const restored = deserializeError(cloned) as Error & {
      gitReason: string;
      op: string;
      rawMessage: string;
      context: Record<string, unknown>;
    };

    expect(restored.name).toBe("GitOperationError");
    expect(restored.gitReason).toBe("not-a-repository");
    expect(restored.op).toBe("status");
    expect(restored.rawMessage).toBe("fatal: not a git repository");
    expect(restored.context).toEqual({
      cwd: "/repo",
      op: "status",
      reason: "not-a-repository",
    });
  });

  it("round-trips an AppError code + userMessage via serialize -> structuredClone -> deserialize", () => {
    const original = Object.assign(new Error("Binary file"), {
      name: "AppError",
      code: "BINARY_FILE",
      userMessage: "This file can't be displayed.",
      context: { filePath: "/repo/asset.bin" },
    });

    const serialized = serializeError(original);
    expect(serialized.code).toBe("BINARY_FILE");
    expect(serialized.userMessage).toBe("This file can't be displayed.");

    const cloned = structuredClone(serialized);
    const restored = deserializeError(cloned) as Error & {
      code: string;
      userMessage: string;
    };

    expect(restored.name).toBe("AppError");
    expect(restored.code).toBe("BINARY_FILE");
    expect(restored.userMessage).toBe("This file can't be displayed.");
  });

  it("round-trips a post-hoc correlationId via serialize -> structuredClone -> deserialize", () => {
    // Simulates the security.ts injection path: serializeError() runs first,
    // then correlationId is set post-hoc on the serialized object. The field
    // is NOT a property of the original error — it's added by main-process
    // code after serialization.
    const original = new Error("something failed");
    const serialized = serializeError(original);
    expect(serialized.correlationId).toBeUndefined();

    // Post-hoc injection (as security.ts does)
    serialized.correlationId = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";

    const cloned = structuredClone(serialized);
    const restored = deserializeError(cloned) as Error & { correlationId: string };

    expect(restored.message).toBe("something failed");
    expect(restored.correlationId).toBe("a1b2c3d4-e5f6-7890-abcd-ef1234567890");
  });
});

describe("wrapSuccess", () => {
  it("creates a success envelope", () => {
    const envelope = wrapSuccess({ foo: "bar" });

    expect(envelope.__daintreeIpcEnvelope).toBe(true);
    expect(envelope.ok).toBe(true);
    expect(envelope.data).toEqual({ foo: "bar" });
  });

  it("handles null data", () => {
    const envelope = wrapSuccess(null);

    expect(envelope.ok).toBe(true);
    expect(envelope.data).toBeNull();
  });

  it("handles undefined data", () => {
    const envelope = wrapSuccess(undefined);

    expect(envelope.ok).toBe(true);
    expect(envelope.data).toBeUndefined();
  });
});

describe("wrapError", () => {
  it("creates an error envelope", () => {
    const envelope = wrapError(new Error("oops"));

    expect(envelope.__daintreeIpcEnvelope).toBe(true);
    expect(envelope.ok).toBe(false);
    expect(envelope.error.message).toBe("oops");
  });

  it("handles non-Error values", () => {
    const envelope = wrapError("string error");

    expect(envelope.ok).toBe(false);
    expect(envelope.error.message).toBe("string error");
  });
});

describe("isIpcEnvelope", () => {
  it("returns true for success envelope", () => {
    expect(isIpcEnvelope(wrapSuccess("data"))).toBe(true);
  });

  it("returns true for error envelope", () => {
    expect(isIpcEnvelope(wrapError(new Error("err")))).toBe(true);
  });

  it("returns false for null", () => {
    expect(isIpcEnvelope(null)).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isIpcEnvelope(undefined)).toBe(false);
  });

  it("returns false for plain objects", () => {
    expect(isIpcEnvelope({ ok: true, data: "test" })).toBe(false);
    expect(isIpcEnvelope({ __daintreeIpcEnvelope: false })).toBe(false);
  });

  it("returns false for primitives", () => {
    expect(isIpcEnvelope(42)).toBe(false);
    expect(isIpcEnvelope("string")).toBe(false);
    expect(isIpcEnvelope(true)).toBe(false);
  });

  it("returns false for domain result objects", () => {
    expect(isIpcEnvelope({ ok: false, code: "BINARY_FILE" })).toBe(false);
    expect(isIpcEnvelope({ success: false, error: "something" })).toBe(false);
  });
});
