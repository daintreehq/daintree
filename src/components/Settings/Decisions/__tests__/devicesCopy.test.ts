import { describe, expect, it } from "vitest";
import {
  describeRelayRequestFailure,
  describeRevokeResult,
  describeRotateResult,
} from "../devicesCopy";

const ORIGIN = "https://decisions.example.workers.dev";

describe("revoke and rotate copy (#16010)", () => {
  it("finishes a revocation the relay took, or one for a device it no longer lists", () => {
    expect(describeRevokeResult({ result: "revoked", keyEpoch: 2 }, "Pixel").finished).toBe(true);
    expect(describeRevokeResult({ result: "not-found" }, "Pixel")).toEqual({
      finished: true,
      message: "The relay no longer lists 'Pixel' as paired.",
    });
  });

  it("names the relay whose answer was lost, and leaves the revocation unfinished", () => {
    const described = describeRevokeResult({ result: "unconfirmed", origin: ORIGIN }, "Pixel");

    expect(described.finished).toBe(false);
    expect(described.message).toContain("decisions.example.workers.dev");
    expect(described.message).not.toContain("https://");
  });

  it("ends a storage reason as a sentence once, whether or not it came with its period", () => {
    const bare = describeRotateResult({ result: "unsaved", reason: "The keychain is locked" });
    const closed = describeRotateResult({ result: "unsaved", reason: "The keychain is locked." });

    expect(bare.message).toContain("The keychain is locked. Daintree");
    expect(closed.message).toBe(bare.message);
    expect(bare.finished).toBe(false);
  });

  it("says a request that changed nothing as any signed request is said", () => {
    const failure = { result: "refused", origin: ORIGIN, reason: "rate-limited" } as const;

    expect(describeRotateResult(failure)).toEqual({
      finished: false,
      message: describeRelayRequestFailure(failure),
    });
  });
});
