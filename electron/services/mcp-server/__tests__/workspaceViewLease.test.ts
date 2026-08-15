import { describe, it, expect } from "vitest";
import { WorkspaceViewLeaseRegistry } from "../workspaceViewLease.js";

describe("WorkspaceViewLeaseRegistry (#11790)", () => {
  it("reports no lease for a view nothing is dispatching to", () => {
    const leases = new WorkspaceViewLeaseRegistry();
    expect(leases.has(42)).toBe(false);
  });

  it("holds the view until the last of several concurrent requests releases", () => {
    const leases = new WorkspaceViewLeaseRegistry();
    const releaseFirst = leases.acquire(42);
    const releaseSecond = leases.acquire(42);

    releaseFirst();
    // A bound session can have more than one call in flight; the first one
    // finishing must not expose the view to the pass that would strand the
    // second.
    expect(leases.has(42)).toBe(true);

    releaseSecond();
    expect(leases.has(42)).toBe(false);
  });

  it("keeps leases on different views independent", () => {
    const leases = new WorkspaceViewLeaseRegistry();
    const releaseOne = leases.acquire(1);
    leases.acquire(2);

    releaseOne();

    expect(leases.has(1)).toBe(false);
    expect(leases.has(2)).toBe(true);
  });

  it("ignores a repeated release instead of dropping another caller's lease", () => {
    // A request settles through several paths (response, deadline, WebContents
    // destruction), and more than one can run for the same request. A
    // double-decrement would unprotect a view another in-flight call is still
    // waiting on.
    const leases = new WorkspaceViewLeaseRegistry();
    const release = leases.acquire(7);
    leases.acquire(7);

    release();
    release();
    release();

    expect(leases.has(7)).toBe(true);
  });

  it("does not resurrect a lease when a stale release runs after a new acquire", () => {
    const leases = new WorkspaceViewLeaseRegistry();
    const staleRelease = leases.acquire(9);
    staleRelease();

    // A later request takes the same view — an earlier request's release must
    // not cancel it.
    leases.acquire(9);
    staleRelease();

    expect(leases.has(9)).toBe(true);
  });

  it("clear() drops every lease", () => {
    // Server stop rejects the pending requests that own these leases, so
    // nothing is left to release them one by one.
    const leases = new WorkspaceViewLeaseRegistry();
    leases.acquire(1);
    leases.acquire(1);
    leases.acquire(2);

    leases.clear();

    expect(leases.has(1)).toBe(false);
    expect(leases.has(2)).toBe(false);
  });

  it("takes fresh leases normally after a clear", () => {
    const leases = new WorkspaceViewLeaseRegistry();
    leases.acquire(3);
    leases.clear();

    const release = leases.acquire(3);
    expect(leases.has(3)).toBe(true);
    release();
    expect(leases.has(3)).toBe(false);
  });
});
