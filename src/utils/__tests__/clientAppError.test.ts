import { describe, expect, it } from "vitest";
import { isClientAppError } from "../clientAppError";

// Mirrors the preload's `_reconstructAppError` encoding.
function encode(code: string, message: string, userMessage?: string, details?: unknown): Error {
  const userPart = userMessage !== undefined ? `|${encodeURIComponent(userMessage)}` : "";
  const detailsPart =
    details !== undefined ? `|#${encodeURIComponent(JSON.stringify(details))}` : "";
  return new Error(`[AppError|${code}${userPart}${detailsPart}] ${message}`);
}

function decoded(e: Error) {
  if (!isClientAppError(e)) throw new Error("not decoded as an AppError");
  return e;
}

describe("isClientAppError", () => {
  it("decodes code and userMessage as before", () => {
    const e = decoded(encode("NOT_FOUND", "gone", "It's gone | really"));
    expect(e.code).toBe("NOT_FOUND");
    expect(e.userMessage).toBe("It's gone | really");
    expect(e.message).toBe("gone");
    expect(e.details).toBeUndefined();
  });

  it("decodes details with and without a userMessage", () => {
    const details = { code: "PLUGIN_NOT_ON_HOST", pluginId: "acme.x", hostId: "box] |#" };
    const withUser = decoded(encode("PLUGIN_NOT_ON_HOST", "missing", "Not on this host", details));
    const withoutUser = decoded(encode("PLUGIN_NOT_ON_HOST", "missing", undefined, details));

    expect(withUser.userMessage).toBe("Not on this host");
    expect(withUser.details).toEqual(details);
    expect(withUser.message).toBe("missing");

    expect(withoutUser.userMessage).toBeUndefined();
    expect(withoutUser.details).toEqual(details);
    expect(withoutUser.message).toBe("missing");
  });

  it("ignores undecodable details without failing the guard", () => {
    const e = decoded(new Error("[AppError|INTERNAL|#%7Bnot-json] boom"));
    expect(e.details).toBeUndefined();
    expect(e.message).toBe("boom");
  });
});
