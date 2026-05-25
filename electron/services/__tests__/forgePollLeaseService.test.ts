import { afterEach, describe, expect, it } from "vitest";
import {
  FORGE_POLL_LEASE_TTL_MS,
  _resetForgePollLeasesForTests,
  acquirePollLease,
  releaseAllLeasesForHolder,
  releasePollLease,
} from "../forgePollLeaseService.js";

const PROJECT_A = "/Users/test/projects/canopy";
const PROJECT_B = "/Users/test/projects/other";

const HOLDER_A = "daintree-workspace-host:canopy-aaaaaaaa";
const HOLDER_B = "daintree-workspace-host:canopy-bbbbbbbb";

afterEach(() => {
  _resetForgePollLeasesForTests();
});

describe("forgePollLeaseService", () => {
  it("grants the first acquire and denies a different holder until TTL elapses", () => {
    const now = 1_000_000;
    expect(acquirePollLease(PROJECT_A, HOLDER_A, now)).toBe(true);
    expect(acquirePollLease(PROJECT_A, HOLDER_B, now)).toBe(false);
    expect(acquirePollLease(PROJECT_A, HOLDER_B, now + FORGE_POLL_LEASE_TTL_MS - 1)).toBe(false);
    expect(acquirePollLease(PROJECT_A, HOLDER_B, now + FORGE_POLL_LEASE_TTL_MS + 1)).toBe(true);
  });

  it("renews the lease for the same holder before TTL", () => {
    const now = 1_000_000;
    expect(acquirePollLease(PROJECT_A, HOLDER_A, now)).toBe(true);
    // Renew partway through the window — same holder always succeeds and the
    // deadline slides forward, so a sibling that arrives near the original
    // expiry is still denied.
    expect(acquirePollLease(PROJECT_A, HOLDER_A, now + 45_000)).toBe(true);
    expect(acquirePollLease(PROJECT_A, HOLDER_B, now + FORGE_POLL_LEASE_TTL_MS + 1)).toBe(false);
    expect(
      acquirePollLease(PROJECT_A, HOLDER_B, now + 45_000 + FORGE_POLL_LEASE_TTL_MS + 1)
    ).toBe(true);
  });

  it("scopes leases per project", () => {
    const now = 1_000_000;
    expect(acquirePollLease(PROJECT_A, HOLDER_A, now)).toBe(true);
    expect(acquirePollLease(PROJECT_B, HOLDER_B, now)).toBe(true);
    expect(acquirePollLease(PROJECT_B, HOLDER_A, now)).toBe(false);
    expect(acquirePollLease(PROJECT_A, HOLDER_B, now)).toBe(false);
  });

  it("release by the holder frees the lease immediately", () => {
    const now = 1_000_000;
    expect(acquirePollLease(PROJECT_A, HOLDER_A, now)).toBe(true);
    releasePollLease(PROJECT_A, HOLDER_A);
    expect(acquirePollLease(PROJECT_A, HOLDER_B, now)).toBe(true);
  });

  it("release by a non-holder is a no-op", () => {
    const now = 1_000_000;
    expect(acquirePollLease(PROJECT_A, HOLDER_A, now)).toBe(true);
    releasePollLease(PROJECT_A, HOLDER_B);
    // Holder A still owns it, so B is still denied.
    expect(acquirePollLease(PROJECT_A, HOLDER_B, now)).toBe(false);
  });

  it("releaseAllLeasesForHolder drops every lease that holder owns", () => {
    const now = 1_000_000;
    expect(acquirePollLease(PROJECT_A, HOLDER_A, now)).toBe(true);
    expect(acquirePollLease(PROJECT_B, HOLDER_A, now)).toBe(true);

    releaseAllLeasesForHolder(HOLDER_A);

    expect(acquirePollLease(PROJECT_A, HOLDER_B, now)).toBe(true);
    expect(acquirePollLease(PROJECT_B, HOLDER_B, now)).toBe(true);
  });

  it("releaseAllLeasesForHolder leaves other holders' leases intact", () => {
    const now = 1_000_000;
    expect(acquirePollLease(PROJECT_A, HOLDER_A, now)).toBe(true);
    expect(acquirePollLease(PROJECT_B, HOLDER_B, now)).toBe(true);

    releaseAllLeasesForHolder(HOLDER_A);

    // Holder B's lease on PROJECT_B still holds; a third holder is denied.
    expect(acquirePollLease(PROJECT_B, "other-holder", now)).toBe(false);
  });

  it("treats exact-TTL expiry as expired (strict > on expiresAt)", () => {
    const now = 1_000_000;
    expect(acquirePollLease(PROJECT_A, HOLDER_A, now)).toBe(true);
    // At now + TTL exactly, expiresAt === now, which is NOT strictly greater
    // than now. Another holder wins.
    expect(acquirePollLease(PROJECT_A, HOLDER_B, now + FORGE_POLL_LEASE_TTL_MS)).toBe(true);
  });

  it("ignores a stale release from a preempted prior holder", () => {
    const now = 1_000_000;
    expect(acquirePollLease(PROJECT_A, HOLDER_A, now)).toBe(true);
    // Holder A's lease times out; holder B takes over.
    const afterExpiry = now + FORGE_POLL_LEASE_TTL_MS + 1;
    expect(acquirePollLease(PROJECT_A, HOLDER_B, afterExpiry)).toBe(true);

    // A late release from holder A (e.g. delayed cooperative release event)
    // must not free holder B's fresh lease.
    releasePollLease(PROJECT_A, HOLDER_A);
    expect(acquirePollLease(PROJECT_A, "third-holder", afterExpiry)).toBe(false);
  });
});
