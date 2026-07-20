import { describe, expect, it } from "vitest";
import { extractHelpSessionErrorCode } from "../clientHelpSessionError";

describe("extractHelpSessionErrorCode", () => {
  it("decodes the preload's encoded prefix and cleans the message", () => {
    const err = new Error("[HelpSessionError|USER_CONTENT_SYNC_FAILED] Couldn't refresh skills");

    expect(extractHelpSessionErrorCode(err)).toBe("USER_CONTENT_SYNC_FAILED");
    expect(err.message).toBe("Couldn't refresh skills");
    expect(err.name).toBe("HelpSessionError");
    expect((err as Error & { code?: string }).code).toBe("USER_CONTENT_SYNC_FAILED");
  });

  it("falls back to a same-realm code property", () => {
    const err = Object.assign(new Error("boom"), { code: "MCP_PROBE_FAILED" });
    expect(extractHelpSessionErrorCode(err)).toBe("MCP_PROBE_FAILED");
  });

  it("returns undefined for plain errors and non-errors", () => {
    expect(extractHelpSessionErrorCode(new Error("plain failure"))).toBeUndefined();
    expect(extractHelpSessionErrorCode("string failure")).toBeUndefined();
    expect(extractHelpSessionErrorCode(null)).toBeUndefined();
    expect(extractHelpSessionErrorCode(undefined)).toBeUndefined();
  });
});
