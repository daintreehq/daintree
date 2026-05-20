import { describe, expect, it } from "vitest";
import { ClientBrokerError, isClientBrokerError } from "../clientBrokerError";

describe("isClientBrokerError", () => {
  it.each(["HOST_EXITED", "APP_SHUTDOWN", "TIMEOUT"] as const)(
    "decodes prefix-encoded %s and restores code/name/message",
    (code) => {
      const err = new Error(`[BrokerError|${code}] underlying message`);
      expect(isClientBrokerError(err)).toBe(true);
      expect(err.name).toBe("BrokerError");
      expect((err as Error & { code: string }).code).toBe(code);
      expect(err.message).toBe("underlying message");
    }
  );

  it("returns false for a plain Error without the prefix", () => {
    const err = new Error("nothing to see here");
    expect(isClientBrokerError(err)).toBe(false);
    expect(err.message).toBe("nothing to see here");
  });

  it("returns false for non-Error values", () => {
    expect(isClientBrokerError(null)).toBe(false);
    expect(isClientBrokerError(undefined)).toBe(false);
    expect(isClientBrokerError("string error")).toBe(false);
    expect(isClientBrokerError({ message: "fake" })).toBe(false);
  });

  it("returns false for prefix with unknown code", () => {
    const err = new Error("[BrokerError|MYSTERY_CODE] something");
    expect(isClientBrokerError(err)).toBe(false);
    // Side effects should not have fired
    expect(err.message).toBe("[BrokerError|MYSTERY_CODE] something");
  });

  it("returns false for malformed prefix (lowercase code)", () => {
    const err = new Error("[BrokerError|host_exited] foo");
    expect(isClientBrokerError(err)).toBe(false);
  });

  it("decodes multi-line messages (regex /s flag)", () => {
    const err = new Error("[BrokerError|TIMEOUT] line one\nline two");
    expect(isClientBrokerError(err)).toBe(true);
    expect((err as Error & { code: string }).code).toBe("TIMEOUT");
    expect(err.message).toBe("line one\nline two");
  });

  it("recognises same-realm ClientBrokerError without a prefix", () => {
    const err = new ClientBrokerError("HOST_EXITED", "fell over");
    expect(isClientBrokerError(err)).toBe(true);
    expect(err.code).toBe("HOST_EXITED");
    expect(err.message).toBe("fell over");
  });
});
