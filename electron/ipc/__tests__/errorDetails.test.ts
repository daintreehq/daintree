import { describe, expect, it } from "vitest";
import { AppError } from "../../utils/errorTypes.js";
import {
  deserializeError,
  serializeError,
  wrapError,
} from "../../../shared/utils/ipcErrorSerialization.js";
import type { AppErrorDetails } from "../../../shared/types/appError.js";

// `satisfies` keeps the literal type, so the same object can also serve as `context`.
const details = {
  code: "PLUGIN_INCOMPATIBLE",
  pluginId: "acme.x",
  hostId: "box",
  reason: { kind: "engine", required: ">=2", hostVersion: "1.0.0" },
} satisfies AppErrorDetails;

describe("AppError details", () => {
  it("serializes as a top-level field, not a stray property", () => {
    const serialized = serializeError(
      new AppError({ code: "PLUGIN_INCOMPATIBLE", message: "no", details, context: details })
    );
    expect(serialized.details).toEqual(details);
    expect(serialized.context).toEqual(details);
    expect(serialized.properties).toBeUndefined();
  });

  it("round-trips through deserializeError", () => {
    const error = deserializeError(
      wrapError(new AppError({ code: "PLUGIN_INCOMPATIBLE", message: "no", details })).error
    );
    expect((error as { details?: unknown }).details).toEqual(details);
    expect((error as { code?: unknown }).code).toBe("PLUGIN_INCOMPATIBLE");
  });

  it("is absent when not set", () => {
    const serialized = serializeError(new AppError({ code: "NOT_FOUND", message: "x" }));
    expect("details" in serialized).toBe(false);
  });
});

describe("AppError details allowlist", () => {
  it("drops unrecognised shapes and extra fields", () => {
    const stray = serializeError(
      Object.assign(new Error("x"), { details: { code: "OTHER", secret: "/Users/greg/.ssh" } })
    );
    expect(stray.details).toBeUndefined();

    const extra = serializeError(
      Object.assign(new Error("x"), {
        details: { code: "PLUGIN_NOT_ON_HOST", pluginId: "p", hostId: "h", path: "/Users/greg" },
      })
    );
    expect(extra.details).toEqual({ code: "PLUGIN_NOT_ON_HOST", pluginId: "p", hostId: "h" });
  });
});
