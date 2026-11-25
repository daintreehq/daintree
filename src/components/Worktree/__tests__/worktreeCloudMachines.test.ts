import { describe, expect, it } from "vitest";
import type {
  CloudHostCreatedFor,
  CloudHostStatus,
  CloudHostsSnapshot,
  CloudProviderInfo,
} from "@shared/types/cloudHosts";
import { cleanupChoiceCopy, cleanupConsequence, machinesMarkedFor } from "../worktreeCloudMachines";
import {
  BOAT_PROVIDER,
  DELETE_ONLY_PROVIDER,
  provider as acme,
} from "@/components/Hosts/cloud/__tests__/cloudProviderFixtures";

const WORKTREE = { hostId: null, projectId: "0f1e2d3c", worktreeId: "/code/app-wt/login" };
const MARK: CloudHostCreatedFor = {
  ...WORKTREE,
  projectName: "app",
  worktreeName: "feature/login",
  hostName: null,
};
const NOW = 1_000_000;

function status(overrides: Partial<CloudHostStatus> = {}): CloudHostStatus {
  return {
    hostId: "build",
    providerId: "boat",
    providerUnavailable: null,
    accountId: "ca_0123456789",
    accountName: "Personal",
    resourceId: "bx_23456789",
    machineName: "login-box",
    ownership: "created-by-daintree",
    createdFor: MARK,
    worktreeCleanup: null,
    provisioning: null,
    machine: "running",
    rawState: "ready",
    machineType: "default",
    vcpu: 4,
    memoryGB: 8,
    hourlyDollars: 0.036,
    lifetime: { kind: "renewable" },
    autoStopAt: null,
    lifetimeSeconds: 7200,
    stoppedAt: null,
    stop: null,
    lastSnapshotAt: null,
    dataExpired: false,
    operation: null,
    lastError: null,
    observedAt: NOW,
    lastEndpoint: null,
    hostKeyFingerprint: null,
    hostKeyReview: null,
    keptRunningAt: null,
    asleep: false,
    ...overrides,
  };
}

function snapshot(
  hosts: CloudHostStatus[],
  providers: CloudProviderInfo[] = [BOAT_PROVIDER]
): CloudHostsSnapshot {
  return { providers, accounts: [], hosts };
}

describe("machinesMarkedFor", () => {
  it("finds only machines whose mark names this worktree where it lives", () => {
    const found = machinesMarkedFor(
      snapshot([
        status({ hostId: "mine" }),
        status({ hostId: "settings", createdFor: null }),
        status({ hostId: "imported", ownership: "imported" }),
        status({ hostId: "sibling", createdFor: { ...MARK, worktreeId: "/code/app-wt/other" } }),
        status({ hostId: "other-project", createdFor: { ...MARK, projectId: "aaaa" } }),
        status({ hostId: "same-path-elsewhere", createdFor: { ...MARK, hostId: "devbox" } }),
        status({ hostId: "gone", machine: "deleted" }),
      ]),
      WORKTREE
    );
    expect(found.map((machine) => machine.status.hostId)).toEqual(["mine"]);
  });

  it("offers stop and delete on a provider that does both, even for a machine last seen stopped", () => {
    const [running] = machinesMarkedFor(snapshot([status()]), WORKTREE);
    expect(running).toMatchObject({ choices: ["keep", "stop", "delete"], keptBecause: null });
    // That reading may be old; a stop finds a stopped machine and leaves it.
    const [stopped] = machinesMarkedFor(snapshot([status({ machine: "stopped" })]), WORKTREE);
    expect(stopped?.choices).toEqual(["keep", "stop", "delete"]);
  });

  it("offers no delete through a provider that can't delete machines from Daintree", () => {
    const [machine] = machinesMarkedFor(
      snapshot([status({ providerId: "acme.droplets.droplets" })], [acme({ deletion: false })]),
      WORKTREE
    );
    expect(machine).toMatchObject({ choices: ["keep", "stop"], providerName: "Acme" });
  });

  it("only keeps a machine without one yet, saying whether its create is still going", () => {
    const notCreated = { resourceId: null, machine: "not-created" as const };
    const [creating] = machinesMarkedFor(
      snapshot([
        status({
          ...notCreated,
          operation: { id: "op", kind: "creating", startedAt: 0, stage: "Asking Boat" },
        }),
      ]),
      WORKTREE
    );
    expect(creating?.choices).toEqual(["keep"]);
    expect(creating?.keptBecause).toMatch(/still being created/);
    const [unfinished] = machinesMarkedFor(snapshot([status(notCreated)]), WORKTREE);
    expect(unfinished?.choices).toEqual(["keep"]);
    expect(unfinished?.keptBecause).toMatch(/wasn't finished being set up/);
  });

  it("only keeps a machine whose provider isn't available, without guessing what it costs", () => {
    const [unavailable] = machinesMarkedFor(
      snapshot([status({ providerUnavailable: "Its plugin is disabled" })]),
      WORKTREE
    );
    expect(unavailable?.choices).toEqual(["keep"]);
    expect(unavailable?.keptBecause).toMatch(/Boat isn't available/);
    // Its declaration gone from the snapshot entirely.
    const [undeclared] = machinesMarkedFor(snapshot([status()], []), WORKTREE);
    expect(undeclared).toMatchObject({ choices: ["keep"], provider: null, providerName: "boat" });
    expect(cleanupChoiceCopy(undeclared!, "keep", NOW).description).toBe(
      "It stays in your boat account as it is. Daintree can't say what it costs while boat isn't available."
    );
  });
});

describe("cleanupChoiceCopy", () => {
  const only = (overrides: Partial<CloudHostStatus>, providers?: CloudProviderInfo[]) =>
    machinesMarkedFor(snapshot([status(overrides)], providers), WORKTREE)[0]!;

  it("says a stop ends compute billing where the provider stops billing a stopped machine", () => {
    const stop = cleanupChoiceCopy(only({}), "stop", NOW).description;
    expect(stop).toContain("Files in its home folder are kept for at least 14 days");
    expect(stop).toContain("Personal stops paying for its compute once it's stopped");
  });

  it("says a stopped machine keeps billing where the provider still bills it", () => {
    const machine = only({ providerId: "acme.droplets.droplets" }, [acme()]);
    expect(cleanupChoiceCopy(machine, "stop", NOW).description).toContain(
      "Acme keeps billing Personal for it while it's stopped, until it's deleted"
    );
    expect(cleanupChoiceCopy(machine, "keep", NOW).description).toBe(
      "It's running and keeps billing Personal until it's deleted, even once it stops."
    );
  });

  it("keeps the host listed, so a kept machine isn't offered back from Add host", () => {
    const keep = cleanupChoiceCopy(only({ machine: "stopped" }), "keep", NOW).description;
    expect(keep).toBe("It stays stopped in your account.");
  });

  it("says when an old reading is from", () => {
    const keep = cleanupChoiceCopy(only({ observedAt: NOW - 60 * 60_000 }), "keep", NOW);
    expect(keep.description).toMatch(/That's as of .+; it may have changed since\.$/);
  });

  it("says a delete takes the disk and ends what the account pays", () => {
    const machine = only({});
    expect(cleanupChoiceCopy(machine, "delete", NOW).description).toBe(
      "It and everything on its disk are deleted from Boat for good once the worktree is deleted, and Personal stops paying for it. Its host leaves your list."
    );
    expect(cleanupConsequence(machine, "delete")).toBe(
      "Cloud machine 'login-box' will be deleted from Boat"
    );
    expect(cleanupConsequence(machine, "stop")).toBe("Cloud machine 'login-box' will be stopped");
  });
});

describe("a worktree's machine whose provider has no stop (#18229)", () => {
  const leasy = (overrides: Partial<CloudHostStatus> = {}) =>
    machinesMarkedFor(
      snapshot(
        [status({ providerId: "leasy", lifetime: { kind: "none" }, ...overrides })],
        [DELETE_ONLY_PROVIDER]
      ),
      WORKTREE
    )[0]!;

  it("offers keep or delete, never stop, whatever the machine last reported", () => {
    expect(leasy().choices).toEqual(["keep", "delete"]);
    expect(leasy({ machine: "stopped" }).choices).toEqual(["keep", "delete"]);
    expect(leasy({ machine: "error" }).choices).toEqual(["keep", "delete"]);
    expect(leasy({ machine: "unknown" }).choices).toEqual(["keep", "delete"]);
  });

  it("still only keeps one it can't act on yet", () => {
    expect(leasy({ resourceId: null })).toMatchObject({
      choices: ["keep"],
      keptBecause:
        "'login-box' wasn't finished being set up, so it's kept. Retry or remove it from Settings → Hosts.",
    });
    expect(leasy({ providerUnavailable: "Leasy is unavailable" })).toMatchObject({
      choices: ["keep"],
      keptBecause: "Leasy isn't available right now, so 'login-box' is kept.",
    });
  });

  it("says keeping it bills until it's deleted, and deleting it takes everything on it", () => {
    const machine = leasy();
    expect(cleanupChoiceCopy(machine, "keep", NOW).description).toBe(
      "It keeps running, and billing Personal, until it's deleted."
    );
    expect(cleanupChoiceCopy(leasy({ machine: "unknown" }), "keep", NOW).description).toBe(
      "Daintree can't tell whether it's running; check on Leasy, where it keeps billing until it's deleted."
    );
    expect(cleanupChoiceCopy(machine, "delete", NOW).description).toBe(
      "It and everything on its disk are deleted from Leasy for good once the worktree is deleted, and Personal stops paying for it. Its host leaves your list."
    );
  });
});
