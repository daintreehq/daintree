import { describe, expect, it } from "vitest";
import type { DecisionsRelayCheck } from "@shared/types/decisions";
import { describeRelayCheck } from "../relayCheckCopy";
import { describeConnectResult } from "../relayIdentityCopy";

const ORIGIN = "https://decisions.example.workers.dev";

describe("describeConnectResult", () => {
  it("leaves a saved identity to the status, and an unsent address to its field", () => {
    expect(
      describeConnectResult({ result: "saved", status: { state: "not-connected" } })
    ).toBeNull();
    expect(
      describeConnectResult({
        result: "relay",
        check: { result: "invalid-url", reason: "not-https" },
      })
    ).toBeNull();
  });

  it("says what the relay check observed when it stopped the setup", () => {
    const check: DecisionsRelayCheck = {
      result: "unreachable",
      origin: ORIGIN,
      endpoint: "health",
      reason: "dns",
    };
    expect(describeConnectResult({ result: "relay", check })).toEqual(describeRelayCheck(check));
  });

  it("says whether a refused claim left an earlier claim's keys behind", () => {
    const dropped = describeConnectResult({
      result: "refused",
      origin: ORIGIN,
      reason: "wrong-secret",
      kept: false,
    })!;
    const kept = describeConnectResult({
      result: "refused",
      origin: ORIGIN,
      reason: "wrong-secret",
      kept: true,
    })!;

    expect(dropped.label).toBe(kept.label);
    expect(dropped.detail).toMatch(/Nothing was saved\.$/);
    expect(kept.detail).not.toContain("Nothing was saved");
    expect(kept.detail).toMatch(/stay on this computer/);
  });

  it("tells a claim that may have arrived from a relay never reached", () => {
    const maybe = describeConnectResult({
      result: "unreachable",
      origin: ORIGIN,
      reason: "timeout",
      kept: true,
    })!;
    const never = describeConnectResult({
      result: "unreachable",
      origin: ORIGIN,
      reason: "dns",
      kept: false,
    })!;

    expect(maybe.severity).toBe("warning");
    expect(maybe.label).toBe("decisions.example.workers.dev didn't confirm the claim");
    expect(maybe.detail).toMatch(/^It didn't answer in time\. .*kept its keys/);
    expect(never.severity).toBe("error");
    expect(never.label).toBe("Couldn't reach decisions.example.workers.dev");
    expect(never.detail).toMatch(/^Its name doesn't resolve.*Nothing was saved\.$/);
  });

  it("names a server error as an answer, not as silence", () => {
    const observed = describeConnectResult({
      result: "unreachable",
      origin: ORIGIN,
      reason: "server-error",
      kept: true,
    })!;

    expect(observed.detail).toMatch(/^It answered with a server error\./);
  });

  it("names the relay keys are already held for, or says it can't", () => {
    expect(
      describeConnectResult({ result: "conflict", origin: ORIGIN, unfinished: true })!.detail
    ).toMatch(/^They are for decisions\.example\.workers\.dev\./);
    expect(
      describeConnectResult({ result: "conflict", origin: null, unfinished: false })!.detail
    ).toMatch(/^It is for a relay it can't name\./);
  });

  it("carries main's own reason for a key storage failure", () => {
    expect(
      describeConnectResult({
        result: "key-storage",
        kind: "locked",
        reason: "The keychain gave no key this session",
      })!.detail
    ).toBe("The keychain gave no key this session");
  });

  it("says a refused kit saved nothing", () => {
    expect(
      describeConnectResult({ result: "kit-refused", origin: ORIGIN, reason: "another-relay" })!
        .detail
    ).toMatch(/other than decisions\.example\.workers\.dev\. Nothing was saved\.$/);
  });
});
