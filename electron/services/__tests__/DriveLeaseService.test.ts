import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const loggerMock = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("../../utils/logger.js", () => ({
  createLogger: () => loggerMock,
}));

vi.mock("electron", () => ({
  webContents: { fromId: vi.fn(() => null), getAllWebContents: vi.fn(() => []) },
  BrowserWindow: { fromWebContents: vi.fn(() => null), getAllWindows: vi.fn(() => []) },
}));

import {
  DRAFTS_CHANGED_DELAY_MS,
  DriveLeaseService,
  NAVIGATION_CHANGED_DELAY_MS,
  PANELS_CHANGED_DELAY_MS,
  type DriveLeaseReservation,
} from "../DriveLeaseService.js";
import { EndpointRegistryImpl } from "../../ipc/endpointRegistry.js";
import type { ClientEndpoint, Disposable, HostFrame } from "../../ipc/endpoint.js";
import type {
  DriveLeaseEvent,
  DriveLeaseNavigation,
} from "../../../shared/types/ipc/driveLease.js";
import type { DriveLeaseState } from "../../../shared/types/remoteHosts.js";
import type { PtyHostDriveLease } from "../../../shared/types/pty-host.js";

class FakeEndpoint implements ClientEndpoint {
  readonly sent: HostFrame[] = [];
  private closed = false;
  private readonly closeListeners = new Set<() => void>();
  private static nextRemoteHandle = -1;

  constructor(
    readonly endpointId: string,
    readonly clientId: string,
    public projectId: string | null,
    readonly kind: "local-view" | "remote-view",
    readonly handle = kind === "local-view"
      ? Number(endpointId.replace(/\D/g, "")) || 1
      : FakeEndpoint.nextRemoteHandle--
  ) {}

  send(frame: HostFrame): void {
    this.sent.push(frame);
  }

  request(): Promise<unknown> {
    return Promise.reject(new Error("unused"));
  }

  onClose(cb: () => void): Disposable {
    this.closeListeners.add(cb);
    return { dispose: () => this.closeListeners.delete(cb) };
  }

  isClosed(): boolean {
    return this.closed;
  }

  close(): void {
    this.closed = true;
    for (const cb of [...this.closeListeners]) cb();
  }

  allEvents(): DriveLeaseEvent[] {
    return this.sent
      .filter((frame) => frame.channel === "drive-lease:event")
      .map((frame) => frame.args[0] as DriveLeaseEvent);
  }

  events(): Array<Extract<DriveLeaseEvent, { type: "changed" }>> {
    return this.allEvents().filter(
      (event): event is Extract<DriveLeaseEvent, { type: "changed" }> => event.type === "changed"
    );
  }
}

const local = (n: number, projectId: string | null = "p") =>
  new FakeEndpoint(`local:${n}`, "local", projectId, "local-view");
const remote = (id: string, clientId: string, projectId: string | null = "p") =>
  new FakeEndpoint(id, clientId, projectId, "remote-view");

const GRACE_MS = 1_000;

let registry: EndpointRegistryImpl;
let leaseTables: PtyHostDriveLease[][];
/** The projects the pty-host was last told to arbitrate. */
const arbitrated = () => (leaseTables.at(-1) ?? []).map((lease) => lease.projectId);
let service: DriveLeaseService;
let changes: DriveLeaseState[];

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
  loggerMock.info.mockClear();
  registry = new EndpointRegistryImpl();
  leaseTables = [];
  changes = [];
  service = new DriveLeaseService({
    registry,
    releaseGraceMs: GRACE_MS,
    now: () => 1_000,
    applyDriveLeases: (leases) => leaseTables.push(leases),
  });
  service.onChange((state) => changes.push(state));
});

afterEach(() => {
  service.dispose();
  vi.useRealTimers();
});

describe("DriveLeaseService", () => {
  it("never blocks this machine's own windows, and the pty-host is never told", async () => {
    const a = local(1);
    const b = local(2);
    registry.add(a);
    registry.add(b);
    await settle();

    // A project only this machine's windows show is held by nobody.
    expect(service.getHolder("p")).toBeNull();
    expect(service.isDriving("p", a)).toBe(true);
    expect(service.isDriving("p", b)).toBe(true);
    expect(service.viewFor("p", b)).toMatchObject({
      drivingHere: true,
      isHolderEndpoint: false,
      viewerIsHostLocal: true,
    });
    expect(leaseTables).toEqual([]);

    // One takes it: the other window of the same client carries on when it goes.
    service.takeOver("p", a);
    expect(service.isDriving("p", b)).toBe(true);
    a.close();
    await settle();
    expect(service.getHolder("p")?.endpointId).toBe("local:2");
    expect(leaseTables).toEqual([]);
  });

  it("never changes the holder on a read (#13285)", async () => {
    const hostWindow = local(1);
    const other = local(2);
    registry.add(hostWindow);
    registry.add(other);
    await settle();

    for (let i = 0; i < 3; i++) {
      expect(service.getHolder("p")).toBeNull();
      expect(service.getDriveTarget("p")).toEqual({ kind: "vacant" });
      service.viewFor("p", hostWindow);
      service.drivingLeaseId("p", other);
      service.projectsDrivenElsewhere(other);
    }
    expect(changes).toEqual([]);

    expect(service.nextHolderEndpoint("p")?.endpointId).toBe("local:1");
    expect(changes).toEqual([]);

    // A held lease stays on its machine: a read may move it to another window
    // of the holder's client, and never to anyone else.
    service.takeOver("p", hostWindow);
    const laptop = remote("s1:e1", "greg-mbp-id");
    registry.add(laptop);
    await settle();
    changes.length = 0;
    hostWindow.projectId = "q";
    expect(service.getHolder("p")?.endpointId).toBe("local:2");
    other.projectId = "q";
    expect(service.getHolder("p")?.endpointId).toBe("local:2");
    expect(changes.map((change) => change.holder?.clientId)).toEqual(["local"]);
  });

  it("reports each lease live, or away with the deadline its grace set, and lets it pass on", async () => {
    let now = 1_000;
    const own = new DriveLeaseService({
      registry,
      releaseGraceMs: GRACE_MS,
      now: () => now,
      applyDriveLeases: () => {},
    });
    const laptop = remote("s1:e1", "c1");
    const studio = remote("s2:e1", "c2", "q");
    registry.add(laptop);
    registry.add(studio);
    await settle();
    expect(own.snapshotLeases()).toEqual([
      {
        projectId: "p",
        holder: expect.objectContaining({ clientId: "c1", endpointId: "s1:e1" }),
        state: "live",
        awayUntil: null,
      },
      {
        projectId: "q",
        holder: expect.objectContaining({ clientId: "c2", endpointId: "s2:e1" }),
        state: "live",
        awayUntil: null,
      },
    ]);

    own.noteEndpointTransport([laptop.endpointId], false);
    now = 1_500;
    // Read again and again, the reservation still ends when the drop set it to.
    for (let i = 0; i < 3; i++) {
      expect(own.snapshotLeases()[0]).toMatchObject({
        projectId: "p",
        state: "away",
        awayUntil: 1_000 + GRACE_MS,
      });
    }
    vi.advanceTimersByTime(GRACE_MS);
    expect(own.snapshotLeases().map((lease) => lease.projectId)).toEqual(["q"]);
    own.dispose();
  });

  it("settles nothing when its leases are read, where a getter would (#13939)", async () => {
    const own = new DriveLeaseService({
      registry,
      releaseGraceMs: GRACE_MS,
      now: () => 1_000,
      applyDriveLeases: () => {},
    });
    const ownChanges: DriveLeaseState[] = [];
    own.onChange((state) => ownChanges.push(state));
    const hostWindow = local(1);
    const other = local(2);
    registry.add(hostWindow);
    registry.add(other);
    registry.add(remote("s1:e1", "greg-mbp-id"));
    await settle();
    own.takeOver("p", hostWindow);
    ownChanges.length = 0;
    const timers = vi.getTimerCount();

    // The holder moved off the project without the registry hearing of it.
    hostWindow.projectId = "q";
    expect(own.snapshotLeases()).toEqual([
      {
        projectId: "p",
        holder: expect.objectContaining({ endpointId: "local:1" }),
        state: "away",
        awayUntil: null,
      },
    ]);
    expect(ownChanges).toEqual([]);
    expect(vi.getTimerCount()).toBe(timers);

    // A getter settles it onto the holder's other window; the read above didn't.
    expect(own.getHolder("p")?.endpointId).toBe("local:2");
    expect(ownChanges).toHaveLength(1);
    own.dispose();
  });

  it("settles a lease nobody holds when views come back after it was released (#13285)", async () => {
    const a = remote("s1:e1", "c1");
    const b = remote("s2:e1", "c2");
    registry.add(a);
    registry.add(b);
    await settle();
    expect(service.getHolder("p")?.endpointId).toBe("s1:e1");

    service.noteEndpointTransport(["s1:e1", "s2:e1"], false);
    vi.advanceTimersByTime(GRACE_MS);
    expect(service.getHolder("p")).toBeNull();

    service.noteEndpointTransport(["s1:e1", "s2:e1"], true);
    const holder = service.getHolder("p");
    expect(holder).not.toBeNull();
    expect([a, b].filter((endpoint) => service.isDriving("p", endpoint))).toHaveLength(1);
    expect(arbitrated()).toEqual(["p"]);
  });

  it("lists the projects someone else drives, which a caller's calls may not change", async () => {
    const hostWindow = local(1, "mine");
    const laptop = remote("s1:e1", "greg-mbp-id", "theirs");
    registry.add(hostWindow);
    registry.add(laptop);
    await settle();
    service.takeOver("mine", hostWindow);

    expect([...service.projectsDrivenElsewhere(hostWindow).keys()]).toEqual(["theirs"]);
    expect(service.projectsDrivenElsewhere(hostWindow).get("theirs")).toMatchObject({
      endpointId: "s1:e1",
    });
    expect([...service.projectsDrivenElsewhere(laptop).keys()]).toEqual(["mine"]);
    // Another of this machine's windows drives with the first.
    expect([...service.projectsDrivenElsewhere(local(2, null)).keys()]).toEqual(["theirs"]);
  });

  it("an unleased project reports nobody driving, and everyone may drive it", () => {
    expect(service.getState("empty")).toEqual({ projectId: "empty", holder: null });
    expect(service.isDriving("empty", local(9, "empty"))).toBe(true);
  });

  it("grants a claim made on open only from the lease it read, so two Shells can't take it from each other", async () => {
    const hostWindow = local(1);
    const a = remote("s1:e1", "shell-a");
    const b = remote("s2:e1", "shell-b");
    registry.add(hostWindow);
    await settle();
    const seen = service.takeOver("p", hostWindow);
    registry.add(a);
    registry.add(b);
    await settle();

    // Both read the host's own window holding it, then claim at once.
    const first = service.takeOver("p", a, { ifLeaseId: seen.leaseId });
    expect(first?.endpointId).toBe("s1:e1");
    const second = service.takeOver("p", b, { ifLeaseId: seen.leaseId });
    expect(second?.endpointId).toBe("s1:e1");
    expect(service.isDriving("p", a)).toBe(true);
    expect(service.isDriving("p", b)).toBe(false);

    // The Take over button's unconditional take still works.
    expect(service.takeOver("p", b).endpointId).toBe("s2:e1");
  });

  it("a second client sees it driven elsewhere and can take over, with a fresh lease id", async () => {
    const hostWindow = local(1);
    const laptop = remote("s1:e1", "greg-mbp-id");
    registry.add(hostWindow);
    await settle();
    const first = service.takeOver("p", hostWindow);

    registry.add(laptop);
    service.noteEndpointClient(laptop.endpointId, {
      clientId: "greg-mbp-id",
      clientName: "greg-mbp",
      platform: "darwin",
      kind: "remote",
    });
    await settle();
    expect(service.getHolder("p")?.endpointId).toBe("local:1");
    expect(service.viewFor("p", laptop)).toMatchObject({
      drivingHere: false,
      isHolderEndpoint: false,
      viewerIsHostLocal: false,
      heldByThisClient: false,
    });
    expect(service.isDriving("p", laptop)).toBe(false);

    const taken = service.takeOver("p", laptop);
    expect(taken).toMatchObject({
      endpointId: "s1:e1",
      clientId: "greg-mbp-id",
      clientName: "greg-mbp",
      isHostLocal: false,
    });
    expect(taken.leaseId).toBeGreaterThan(first.leaseId);
    expect(service.isDriving("p", hostWindow)).toBe(false);
    expect(service.isDriving("p", laptop)).toBe(true);
    // Only the laptop's connection may type into or resize the project's terminals.
    expect(leaseTables.at(-1)).toEqual([
      { projectId: "p", leaseId: taken.leaseId, holderConnection: laptop.handle },
    ]);

    // Both screens hear it, each with its own view of who drives.
    const hostEvent = hostWindow.events().at(-1)!;
    const laptopEvent = laptop.events().at(-1)!;
    expect(hostEvent.state).toMatchObject({ drivingHere: false, viewerIsHostLocal: true });
    expect(hostEvent.state.holder?.clientName).toBe("greg-mbp");
    expect(laptopEvent.state).toMatchObject({ drivingHere: true, isHolderEndpoint: true });
    expect(changes.at(-1)).toEqual({ projectId: "p", holder: taken });

    // Take back from the host's own screen.
    const back = service.takeOver("p", hostWindow);
    expect(back.leaseId).toBeGreaterThan(taken.leaseId);
    expect(back.isHostLocal).toBe(true);
    // The laptop is still on the project, so the pty-host keeps refusing it.
    expect(leaseTables.at(-1)).toEqual([
      { projectId: "p", leaseId: back.leaseId, holderConnection: null },
    ]);
  });

  it("taking over what this endpoint already holds keeps the lease", async () => {
    const a = local(1);
    registry.add(a);
    await settle();
    const holder = service.takeOver("p", a);
    expect(service.takeOver("p", a)).toBe(holder);
  });

  it("refuses a takeover from a view that is not on the project", () => {
    const elsewhere = remote("s1:e1", "c1", "other");
    registry.add(elsewhere);
    expect(() => service.takeOver("p", elsewhere)).toThrow(/attached to the project/);
  });

  it("keeps a closed holder's lease for the grace window, then hands it on", async () => {
    const hostWindow = local(1);
    const laptop = remote("s1:e1", "c1");
    registry.add(hostWindow);
    registry.add(laptop);
    await settle();
    service.takeOver("p", laptop);

    laptop.close();
    await settle();
    expect(service.getHolder("p")?.clientId).toBe("c1");
    expect(service.isDriving("p", hostWindow)).toBe(false);

    vi.advanceTimersByTime(GRACE_MS);
    expect(service.getHolder("p")).toMatchObject({ endpointId: "local:1", isHostLocal: true });
    expect(arbitrated()).toEqual([]);
  });

  it("gives the lease back to the same client when it reopens within the grace window", async () => {
    const hostWindow = local(1);
    const laptop = remote("s1:e1", "c1");
    registry.add(hostWindow);
    registry.add(laptop);
    await settle();
    const taken = service.takeOver("p", laptop);

    laptop.close();
    await settle();
    const reopened = remote("s2:e1", "c1");
    registry.add(reopened);
    await settle();

    const holder = service.getHolder("p")!;
    expect(holder.endpointId).toBe("s2:e1");
    expect(holder.leaseId).toBeGreaterThan(taken.leaseId);
    vi.advanceTimersByTime(GRACE_MS * 2);
    expect(service.getHolder("p")?.endpointId).toBe("s2:e1");
  });

  it("hands the lease to a view reopened under its holder's id, on the new view's connection", async () => {
    const hostWindow = local(1);
    const laptop = remote("s1:e1", "c1");
    registry.add(hostWindow);
    registry.add(laptop);
    await settle();
    const taken = service.takeOver("p", laptop);

    // Closed and opened again before the registry's change settles.
    laptop.close();
    const reopened = remote("s1:e1", "c1");
    registry.add(reopened);
    await settle();

    const [published] = leaseTables.at(-1)!;
    expect(published).toMatchObject({ projectId: "p", holderConnection: reopened.handle });
    expect(published!.leaseId).toBeGreaterThan(taken.leaseId);
    expect(service.getHolder("p")?.leaseId).toBe(published!.leaseId);
    expect(service.isDriving("p", reopened)).toBe(true);
  });

  it("releases to nobody when no one is left on the project", async () => {
    const laptop = remote("s1:e1", "c1");
    registry.add(laptop);
    await settle();
    expect(service.getHolder("p")?.endpointId).toBe("s1:e1");
    expect(arbitrated()).toEqual(["p"]);

    laptop.close();
    await settle();
    vi.advanceTimersByTime(GRACE_MS);
    expect(service.getState("p").holder).toBeNull();
    expect(changes.at(-1)).toEqual({ projectId: "p", holder: null });
    expect(arbitrated()).toEqual([]);
  });

  it("keeps one tenure while a client holds the project, and starts another for anyone else", async () => {
    const hostWindow = local(1);
    const laptop = remote("s1:e1", "c1");
    const other = remote("s9:e1", "c2");
    registry.add(hostWindow);
    registry.add(laptop);
    registry.add(other);
    await settle();
    const taken = service.takeOver("p", laptop);
    expect(taken.tenureId).toEqual(expect.any(String));

    // Its link drops and resumes, then its window comes back on a new session.
    service.noteEndpointTransport([laptop.endpointId], false);
    service.noteEndpointTransport([laptop.endpointId], true);
    laptop.close();
    await settle();
    const reopened = remote("s2:e1", "c1");
    registry.add(reopened);
    await settle();
    const regranted = service.getHolder("p")!;
    expect(regranted.leaseId).toBeGreaterThan(taken.leaseId);
    expect(regranted.tenureId).toBe(taken.tenureId);
    expect(reopened.events().at(-1)?.state.holder?.tenureId).toBe(taken.tenureId);

    const elsewhere = service.takeOver("p", other);
    expect(elsewhere.tenureId).not.toBe(taken.tenureId);
    const back = service.takeOver("p", reopened);
    expect(new Set([taken.tenureId, elsewhere.tenureId, back.tenureId]).size).toBe(3);
  });

  describe("once the grace runs out with nobody there (#15918)", () => {
    /** The laptop drives p, then its link stays down past the grace: nobody holds p. */
    async function vacateAfterDriving(laptop = remote("s1:e1", "c1")) {
      registry.add(laptop);
      await settle();
      const first = service.getHolder("p")!;
      service.noteEndpointTransport([laptop.endpointId], false);
      vi.advanceTimersByTime(GRACE_MS);
      expect(service.getState("p").holder).toBeNull();
      return { laptop, first };
    }

    it("keeps the tenure for the client that comes back, however long it was away", async () => {
      const { laptop, first } = await vacateAfterDriving();
      vi.advanceTimersByTime(GRACE_MS * 60);

      service.noteEndpointTransport([laptop.endpointId], true);

      const regranted = service.getHolder("p")!;
      expect(regranted.endpointId).toBe("s1:e1");
      expect(regranted.leaseId).toBeGreaterThan(first.leaseId);
      expect(regranted.tenureId).toBe(first.tenureId);
      expect(laptop.events().at(-1)?.state.holder?.tenureId).toBe(first.tenureId);
    });

    it("keeps it for the same client back on a fresh session", async () => {
      const { laptop, first } = await vacateAfterDriving();
      laptop.close();
      await settle();

      const reopened = remote("s2:e1", "c1");
      registry.add(reopened);
      await settle();

      expect(service.getHolder("p")?.endpointId).toBe("s2:e1");
      expect(service.getHolder("p")?.tenureId).toBe(first.tenureId);
    });

    it("starts a new tenure once another Shell held the project in the gap", async () => {
      const { laptop, first } = await vacateAfterDriving();
      const other = remote("s9:e1", "c2");
      registry.add(other);
      await settle();
      expect(service.getHolder("p")?.clientId).toBe("c2");
      other.close();
      await settle();
      vi.advanceTimersByTime(GRACE_MS);
      expect(service.getHolder("p")).toBeNull();

      service.noteEndpointTransport([laptop.endpointId], true);

      expect(service.getHolder("p")?.endpointId).toBe("s1:e1");
      expect(service.getHolder("p")?.tenureId).not.toBe(first.tenureId);
    });

    it("starts a new tenure once a window on the Host's screen showed the project in the gap", async () => {
      const { laptop, first } = await vacateAfterDriving();
      const hostWindow = local(1);
      registry.add(hostWindow);
      await settle();
      expect(service.getHolder("p")?.clientId).toBe("local");
      hostWindow.close();
      await settle();
      vi.advanceTimersByTime(GRACE_MS);
      expect(service.getHolder("p")).toBeNull();

      service.noteEndpointTransport([laptop.endpointId], true);

      expect(service.getHolder("p")?.endpointId).toBe("s1:e1");
      expect(service.getHolder("p")?.tenureId).not.toBe(first.tenureId);
    });

    it("starts a new tenure once a Host window showed the project with no Shell attached at all", async () => {
      const { laptop, first } = await vacateAfterDriving();
      laptop.close();
      await settle();
      // A project only this machine's windows show is held by nobody, so they drive it.
      const hostWindow = local(1);
      registry.add(hostWindow);
      await settle();
      expect(service.getHolder("p")).toBeNull();
      hostWindow.close();
      await settle();

      const reopened = remote("s2:e1", "c1");
      registry.add(reopened);
      await settle();

      expect(service.getHolder("p")?.endpointId).toBe("s2:e1");
      expect(service.getHolder("p")?.tenureId).not.toBe(first.tenureId);
    });

    it("starts a new tenure once a Host window moved onto the project and wrote to it", async () => {
      const { laptop, first } = await vacateAfterDriving();
      const hostWindow = local(1, "q");
      registry.add(hostWindow);
      await settle();
      // A local view's binding is read live: moving projects tells the registry nothing.
      hostWindow.projectId = "p";
      expect(service.isDriving("p", hostWindow)).toBe(true);
      hostWindow.projectId = "q";

      service.noteEndpointTransport([laptop.endpointId], true);

      expect(service.getHolder("p")?.tenureId).not.toBe(first.tenureId);
    });

    it("starts a new tenure once a Host window on the project made a gated call", async () => {
      const { laptop, first } = await vacateAfterDriving();
      const hostWindow = local(1, "q");
      registry.add(hostWindow);
      await settle();
      hostWindow.projectId = "p";
      // The lease gate asks this for every call that changes a project.
      expect(service.projectsDrivenElsewhere(hostWindow).size).toBe(0);
      hostWindow.projectId = "q";

      service.noteEndpointTransport([laptop.endpointId], true);

      expect(service.getHolder("p")?.tenureId).not.toBe(first.tenureId);
    });

    it("starts a new tenure when a Host window is showing the project as the client comes back", async () => {
      const { laptop, first } = await vacateAfterDriving();
      const hostWindow = local(1, "q");
      registry.add(hostWindow);
      await settle();
      hostWindow.projectId = "p";

      service.noteEndpointTransport([laptop.endpointId], true);

      expect(service.getHolder("p")?.tenureId).not.toBe(first.tenureId);
    });

    it("starts a new tenure once a call the lease gate let through changed the project", async () => {
      const { laptop, first } = await vacateAfterDriving();
      const hostWindow = local(1, "q");
      registry.add(hostWindow);
      await settle();
      expect(service.keepsUnheldTenures()).toBe(true);

      // A window on q saving to p, and the laptop's own client changing p, end nothing.
      service.noteUnheldChange(hostWindow, ["q"]);
      service.noteUnheldChange(remote("s1:e2", "c1", "q"), ["p"]);
      expect(service.keepsUnheldTenures()).toBe(true);
      service.noteUnheldChange(hostWindow, ["p"]);
      expect(service.keepsUnheldTenures()).toBe(false);

      service.noteEndpointTransport([laptop.endpointId], true);
      expect(service.getHolder("p")?.tenureId).not.toBe(first.tenureId);
    });

    it("ends every kept tenure for a gated call whose target couldn't be traced", async () => {
      await vacateAfterDriving();
      service.noteUnheldChange(local(1, "q"), "every");
      expect(service.keepsUnheldTenures()).toBe(false);
    });

    it("starts a new tenure once the host ran an assistant's change to the project with no view", async () => {
      const { laptop, first } = await vacateAfterDriving(remote("remote:s1:e1", "c1"));
      // Relayed on the laptop's own link session: its own assistant.
      service.noteViewlessChange("p", "s1");
      expect(service.keepsUnheldTenures()).toBe(true);
      // This machine's own assistant.
      service.noteViewlessChange("p", null);
      expect(service.keepsUnheldTenures()).toBe(false);

      service.noteEndpointTransport([laptop.endpointId], true);
      expect(service.getHolder("p")?.tenureId).not.toBe(first.tenureId);
    });

    it("starts a new tenure once another Shell's assistant changed the project with no view", async () => {
      await vacateAfterDriving(remote("remote:s1:e1", "c1"));
      service.noteViewlessChange("p", "s9");
      expect(service.keepsUnheldTenures()).toBe(false);
    });

    it("tells a Canopy panel on the holder's own session from one on another", async () => {
      const { laptop, first } = await vacateAfterDriving(remote("remote:s1:e1", "c1"));
      const ownPanel = Object.assign(
        new FakeEndpoint("canopy-viewer:v1", "c1", null, "remote-view"),
        { linkSessionId: "s1" }
      );
      expect(service.isDriving("p", ownPanel)).toBe(true);
      expect(service.keepsUnheldTenures()).toBe(true);

      // Another Shell's panel claiming the laptop's client id drives too, while nobody holds p.
      const otherPanel = Object.assign(
        new FakeEndpoint("canopy-viewer:v2", "c1", null, "remote-view"),
        { linkSessionId: "s9" }
      );
      expect(service.drivingLeaseId("p", otherPanel)).toBeNull();

      service.noteEndpointTransport([laptop.endpointId], true);
      expect(service.getHolder("p")?.tenureId).not.toBe(first.tenureId);
    });

    it("keeps the tenure through a Host window that only showed another project", async () => {
      const { laptop, first } = await vacateAfterDriving();
      const hostWindow = local(1, "q");
      registry.add(hostWindow);
      await settle();
      expect(service.isDriving("q", hostWindow)).toBe(true);

      service.noteEndpointTransport([laptop.endpointId], true);

      expect(service.getHolder("p")?.tenureId).toBe(first.tenureId);
    });
  });

  it("treats a remote view rebound to another project as having left", async () => {
    const hostWindow = local(1);
    const laptop = remote("s1:e1", "c1");
    registry.add(hostWindow);
    registry.add(laptop);
    await settle();
    service.takeOver("p", laptop);

    registry.rebind(laptop.endpointId, "q");
    await settle();
    // Still reserved for its client, but no longer reachable as p's driver.
    expect(service.getHolder("p")?.endpointId).toBe("s1:e1");
    expect(service.getHolderEndpoint("p")).toBeNull();
    vi.advanceTimersByTime(GRACE_MS);
    expect(service.getHolder("p")?.endpointId).toBe("local:1");
    expect(service.getHolder("q")?.endpointId).toBe("s1:e1");
  });

  it("lease ids increase across grants and projects", async () => {
    const a = remote("s1:e1", "c1", "p");
    const b = remote("s2:e1", "c2", "q");
    const c = remote("s3:e1", "c3", "p");
    registry.add(a);
    registry.add(b);
    registry.add(c);
    await settle();
    const ids = [service.getHolder("p")!.leaseId, service.getHolder("q")!.leaseId];
    ids.push(service.takeOver("p", c).leaseId);
    ids.push(service.takeOver("p", a).leaseId);
    expect([...ids].sort((x, y) => x - y)).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("names the machine once its client is noted after the grant", async () => {
    const laptop = remote("s1:e1", "c1");
    registry.add(laptop);
    await settle();
    expect(service.getHolder("p")?.clientName).toBe("c1");
    const leaseId = service.getHolder("p")!.leaseId;

    service.noteEndpointClient("s1:e1", {
      clientId: "c1",
      clientName: "greg-mbp",
      platform: "darwin",
      kind: "remote",
    });
    expect(service.getHolder("p")).toMatchObject({ clientName: "greg-mbp", leaseId });
  });

  it("lets only the holder endpoint of a remote client drive, not its other windows", async () => {
    const first = remote("s1:e1", "c1");
    const second = remote("s1:e2", "c1");
    registry.add(first);
    registry.add(second);
    await settle();
    const holder = service.getHolder("p")!;
    expect(holder.endpointId).toBe("s1:e1");
    expect(service.isDriving("p", first)).toBe(true);
    expect(service.isDriving("p", second)).toBe(false);
    // Another window of the same client: not driving, but its own machine holds it.
    expect(service.viewFor("p", second)).toMatchObject({
      drivingHere: false,
      heldByThisClient: true,
    });
    expect(service.drivingLeaseId("p", first)).toBe(holder.leaseId);
    expect(service.drivingLeaseId("p", second)).toBe(false);
    expect(service.drivingLeaseId("nobody", second)).toBeNull();
  });

  it("starts the grace when the holder's link drops, and a resume inside it keeps the lease", async () => {
    const hostWindow = local(1);
    const laptop = remote("s1:e1", "c1");
    registry.add(hostWindow);
    registry.add(laptop);
    await settle();
    const taken = service.takeOver("p", laptop);

    service.noteEndpointTransport([laptop.endpointId], false);
    expect(service.getDriveTarget("p")).toEqual({ kind: "reserved", holder: taken });
    expect(service.getHolderEndpoint("p")).toBeNull();
    vi.advanceTimersByTime(GRACE_MS - 1);
    service.noteEndpointTransport([laptop.endpointId], true);
    vi.advanceTimersByTime(GRACE_MS * 2);
    expect(service.getHolder("p")).toBe(taken);
    expect(service.getDriveTarget("p")).toEqual({ kind: "live", holder: taken, endpoint: laptop });
  });

  it("hands the lease on when a dropped holder does not come back in time", async () => {
    const hostWindow = local(1);
    const laptop = remote("s1:e1", "c1");
    registry.add(hostWindow);
    registry.add(laptop);
    await settle();
    service.takeOver("p", laptop);

    service.noteEndpointTransport([laptop.endpointId], false);
    vi.advanceTimersByTime(GRACE_MS);
    expect(service.getHolder("p")).toMatchObject({ endpointId: "local:1" });

    // A resume after the handover does not take it back.
    service.noteEndpointTransport([laptop.endpointId], true);
    expect(service.getHolder("p")).toMatchObject({ endpointId: "local:1" });
  });

  it("a grace started before a takeover releases nothing afterwards", async () => {
    const hostWindow = local(1);
    const laptop = remote("s1:e1", "c1");
    registry.add(hostWindow);
    registry.add(laptop);
    await settle();
    service.takeOver("p", laptop);
    service.noteEndpointTransport([laptop.endpointId], false);

    const back = service.takeOver("p", hostWindow);
    service.noteEndpointTransport([laptop.endpointId], true);
    const again = service.takeOver("p", laptop);
    vi.advanceTimersByTime(GRACE_MS * 2);
    expect(service.getHolder("p")).toBe(again);
    expect(again.leaseId).toBeGreaterThan(back.leaseId);
  });

  it("reports an unleased project as vacant", () => {
    expect(service.getDriveTarget("empty")).toEqual({ kind: "vacant" });
  });

  it("tells the other views a dropped holder is away and how long its grace has left, then that it is back (#13937)", async () => {
    service.dispose();
    let clock = 1_000;
    service = new DriveLeaseService({
      registry,
      releaseGraceMs: GRACE_MS,
      now: () => clock,
      applyDriveLeases: (leases) => leaseTables.push(leases),
    });
    service.onChange((state) => changes.push(state));
    const hostWindow = local(1);
    const laptop = remote("s1:e1", "c1");
    registry.add(hostWindow);
    registry.add(laptop);
    await settle();
    const taken = service.takeOver("p", laptop);
    expect(service.viewFor("p", hostWindow)).not.toHaveProperty("holderAwayMs");
    const heard = hostWindow.events().length;
    const holderChanges = changes.length;

    service.noteEndpointTransport([laptop.endpointId], false);
    expect(hostWindow.events()).toHaveLength(heard + 1);
    expect(hostWindow.events().at(-1)?.state).toMatchObject({
      holder: taken,
      holderAwayMs: GRACE_MS,
    });

    clock += 400;
    vi.advanceTimersByTime(400);
    expect(service.viewFor("p", hostWindow).holderAwayMs).toBe(GRACE_MS - 400);
    // Reading the lease while it waits announces nothing more.
    service.getHolder("p");
    service.getDriveTarget("p");
    expect(hostWindow.events()).toHaveLength(heard + 1);

    service.noteEndpointTransport([laptop.endpointId], true);
    expect(hostWindow.events()).toHaveLength(heard + 2);
    expect(hostWindow.events().at(-1)?.state.holder).toBe(taken);
    expect(hostWindow.events().at(-1)?.state).not.toHaveProperty("holderAwayMs");
    expect(service.viewFor("p", hostWindow)).not.toHaveProperty("holderAwayMs");
    // Nobody new holds it: no holder change goes out to the remote sessions.
    expect(changes).toHaveLength(holderChanges);
  });

  it("taking control from an away holder lands at once, and its old grace hands nothing on", async () => {
    const hostWindow = local(1);
    const laptop = remote("s1:e1", "c1");
    const studio = remote("s2:e1", "c2");
    registry.add(hostWindow);
    registry.add(laptop);
    registry.add(studio);
    await settle();
    service.takeOver("p", laptop);
    service.noteEndpointTransport([laptop.endpointId], false);
    expect(studio.events().at(-1)?.state.holderAwayMs).toBe(GRACE_MS);

    const taken = service.takeOver("p", studio);
    expect(service.getHolder("p")).toBe(taken);
    for (const endpoint of [hostWindow, studio]) {
      expect(endpoint.events().at(-1)?.state.holder).toBe(taken);
      expect(endpoint.events().at(-1)?.state).not.toHaveProperty("holderAwayMs");
    }

    vi.advanceTimersByTime(GRACE_MS * 2);
    expect(service.getHolder("p")).toBe(taken);
    expect(service.viewFor("p", hostWindow)).not.toHaveProperty("holderAwayMs");
  });

  it("says a closed holder is away until the grace hands the project on", async () => {
    const hostWindow = local(1);
    const laptop = remote("s1:e1", "c1");
    registry.add(hostWindow);
    registry.add(laptop);
    await settle();
    service.takeOver("p", laptop);

    laptop.close();
    await settle();
    expect(hostWindow.events().at(-1)?.state).toMatchObject({
      holder: { clientId: "c1" },
      holderAwayMs: GRACE_MS,
    });

    vi.advanceTimersByTime(GRACE_MS);
    const handedOn = hostWindow.events().at(-1)?.state;
    expect(handedOn?.holder).toMatchObject({ endpointId: "local:1" });
    expect(handedOn).not.toHaveProperty("holderAwayMs");
  });
});

describe("DriveLeaseService and a Canopy panel reading this host (#13387)", () => {
  // Never registered: a viewer is a caller, not a view of a project.
  const viewerFrom = (clientId: string, linkSessionId?: string) =>
    Object.assign(
      new FakeEndpoint("canopy-viewer:v1", clientId, null, "remote-view"),
      linkSessionId === undefined ? {} : { linkSessionId }
    );
  const laptopClient = {
    clientId: "greg-mbp-id",
    clientName: "greg-mbp",
    platform: "darwin" as const,
    kind: "remote" as const,
  };

  it("types where its own machine's window holds the project, and nowhere another does", async () => {
    const hostWindow = local(1);
    const laptopWindow = remote("remote:s1:e1", "greg-mbp-id");
    const studioWindow = remote("remote:s2:e1", "studio-id");
    for (const endpoint of [hostWindow, laptopWindow, studioWindow]) registry.add(endpoint);
    service.noteEndpointClient(laptopWindow.endpointId, laptopClient);
    service.noteEndpointClient(studioWindow.endpointId, {
      ...laptopClient,
      clientId: "studio-id",
      clientName: "studio",
    });
    await settle();
    const laptopViewer = viewerFrom("greg-mbp-id", "s1");

    service.takeOver("p", laptopWindow);
    expect(service.isDriving("p", laptopViewer)).toBe(true);
    expect(service.projectsDrivenElsewhere(laptopViewer).has("p")).toBe(false);

    service.takeOver("p", studioWindow);
    expect(service.isDriving("p", laptopViewer)).toBe(false);
    expect(service.projectsDrivenElsewhere(laptopViewer).get("p")?.clientId).toBe("studio-id");

    // The host's own screen holds it: another machine has control.
    service.takeOver("p", hostWindow);
    expect(service.isDriving("p", laptopViewer)).toBe(false);
  });

  it("is held to the same rule as its machine, taking nothing by typing", async () => {
    const hostWindow = local(1);
    const laptopWindow = remote("remote:s1:e1", "greg-mbp-id");
    registry.add(hostWindow);
    registry.add(laptopWindow);
    service.noteEndpointClient(laptopWindow.endpointId, laptopClient);
    await settle();
    const holder = service.takeOver("p", laptopWindow);
    const laptopViewer = viewerFrom("greg-mbp-id", "s1");

    expect(service.isDriving("p", laptopViewer)).toBe(true);
    // Driving through its machine's lease is not holding it.
    expect(service.getHolder("p")).toEqual(holder);
    expect(service.drivingLeaseId("p", laptopViewer)).toBe(holder.leaseId);
  });

  it("leaves another machine's ordinary windows as they were", async () => {
    const laptopWindow = remote("remote:s1:e1", "greg-mbp-id");
    const laptopSecondWindow = remote("remote:s1:e2", "greg-mbp-id");
    registry.add(laptopWindow);
    registry.add(laptopSecondWindow);
    service.noteEndpointClient(laptopWindow.endpointId, laptopClient);
    service.noteEndpointClient(laptopSecondWindow.endpointId, laptopClient);
    await settle();
    service.takeOver("p", laptopWindow);

    expect(service.isDriving("p", laptopSecondWindow)).toBe(false);
  });

  it("this machine's own panel reading itself from a remote-bound view types with its windows", async () => {
    const hostWindow = local(1);
    registry.add(hostWindow);
    await settle();
    service.takeOver("p", hostWindow);

    expect(service.isDriving("p", viewerFrom("local"))).toBe(true);
  });

  it("drives nowhere another session holds, even under the holder's client id (#14679)", async () => {
    const hostWindow = local(1);
    const laptopWindow = remote("remote:s1:e1", "greg-mbp-id");
    registry.add(hostWindow);
    registry.add(laptopWindow);
    service.noteEndpointClient(laptopWindow.endpointId, laptopClient);
    await settle();
    service.takeOver("p", laptopWindow);

    // Another Shell connected under the laptop's client id has a session of its own.
    const impostor = viewerFrom("greg-mbp-id", "s9");
    expect(service.isDriving("p", impostor)).toBe(false);
    expect(service.drivingLeaseId("p", impostor)).toBe(false);
    expect(service.projectsDrivenElsewhere(impostor).get("p")?.clientId).toBe("greg-mbp-id");
    // A remote viewer that names no session stands for none.
    expect(service.isDriving("p", viewerFrom("greg-mbp-id"))).toBe(false);
    // Nor does one on the right session reach the host's own windows' projects.
    service.takeOver("p", hostWindow);
    expect(service.isDriving("p", viewerFrom("greg-mbp-id", "s1"))).toBe(false);
    expect(service.isDriving("p", viewerFrom("local"))).toBe(true);
  });

  it("types anywhere while nobody holds the project", () => {
    expect(service.isDriving("p", viewerFrom("greg-mbp-id", "s9"))).toBe(true);
  });
});

describe("DriveLeaseService and a device paired with a Shell answering this host (#13941)", () => {
  // Never registered: only ever asked whether it drives.
  const deviceThrough = (clientId: string, linkSessionId: string) => ({
    endpointId: "device-answer:1",
    clientId,
    linkSessionId,
  });
  const laptopClient = {
    clientId: "greg-mbp-id",
    clientName: "greg-mbp",
    platform: "darwin" as const,
    kind: "remote" as const,
  };

  it("presses where its Shell's window holds the project, and nowhere another screen does", async () => {
    const hostWindow = local(1);
    const laptopWindow = remote("remote:s1:e1", "greg-mbp-id");
    const studioWindow = remote("remote:s2:e1", "studio-id");
    for (const endpoint of [hostWindow, laptopWindow, studioWindow]) registry.add(endpoint);
    service.noteEndpointClient(laptopWindow.endpointId, laptopClient);
    service.noteEndpointClient(studioWindow.endpointId, {
      ...laptopClient,
      clientId: "studio-id",
      clientName: "studio",
    });
    await settle();
    const device = deviceThrough("greg-mbp-id", "s1");

    const holder = service.takeOver("p", laptopWindow);
    expect(service.isDriving("p", device)).toBe(true);
    // Answering through its Shell's lease is not holding it.
    expect(service.getHolder("p")).toEqual(holder);

    service.takeOver("p", studioWindow);
    expect(service.isDriving("p", device)).toBe(false);

    // The host's own screen holds it: the Shell couldn't type there either.
    service.takeOver("p", hostWindow);
    expect(service.isDriving("p", device)).toBe(false);
  });

  it("presses nothing where another session holds, even under the holder's client id (#14679)", async () => {
    const laptopWindow = remote("remote:s1:e1", "greg-mbp-id");
    registry.add(laptopWindow);
    service.noteEndpointClient(laptopWindow.endpointId, laptopClient);
    await settle();
    service.takeOver("p", laptopWindow);

    expect(service.isDriving("p", deviceThrough("greg-mbp-id", "s9"))).toBe(false);
    expect(service.isDriving("p", deviceThrough("greg-mbp-id", "s1"))).toBe(true);
  });

  it("presses through a relaunched Shell once the project is handed back to its new session", async () => {
    const install = "5b1f6c3e-8d2a-4f4e-9c1b-0a7e2d9f3c41";
    const before = remote("remote:s1:e1", "launch-1");
    registry.add(before);
    service.noteEndpointClient(before.endpointId, {
      ...laptopClient,
      clientId: "launch-1",
      deviceId: install,
    });
    await settle();
    expect(service.getHolder("p")?.endpointId).toBe("remote:s1:e1");
    before.close();
    await settle();

    const after = remote("remote:s2:e1", "launch-2");
    registry.add(after);
    service.noteEndpointClient(after.endpointId, {
      ...laptopClient,
      clientId: "launch-2",
      deviceId: install,
    });
    await settle();

    expect(service.getHolder("p")?.endpointId).toBe("remote:s2:e1");
    expect(service.isDriving("p", deviceThrough("launch-2", "s2"))).toBe(true);
    expect(service.isDriving("p", deviceThrough("launch-1", "s1"))).toBe(false);
  });
});

describe("DriveLeaseService panel notices", () => {
  const panelNotices = (endpoint: FakeEndpoint) =>
    endpoint.allEvents().filter((event) => event.type === "panels-changed");

  async function laptopDrivesWithHostWatching() {
    const hostWindow = local(1);
    const otherHostWindow = local(2);
    const laptop = remote("s1:e1", "greg-mbp-id");
    const otherProject = local(3, "q");
    for (const endpoint of [hostWindow, otherHostWindow, laptop, otherProject]) {
      registry.add(endpoint);
    }
    await settle();
    service.takeOver("p", laptop);
    return { hostWindow, otherHostWindow, laptop, otherProject };
  }

  it("tells every view that watches the project, once per burst of saves", async () => {
    const { hostWindow, otherHostWindow, laptop, otherProject } =
      await laptopDrivesWithHostWatching();

    service.notifyPanelsChanged("p");
    service.notifyPanelsChanged("p");
    expect(panelNotices(hostWindow)).toEqual([]);
    vi.advanceTimersByTime(PANELS_CHANGED_DELAY_MS);
    service.notifyPanelsChanged("p");
    vi.advanceTimersByTime(PANELS_CHANGED_DELAY_MS);

    const expected = [
      { type: "panels-changed", projectId: "p" },
      { type: "panels-changed", projectId: "p" },
    ];
    expect(panelNotices(hostWindow)).toEqual(expected);
    expect(panelNotices(otherHostWindow)).toEqual(expected);
    // The driver saved it, and a view on another project has nothing to follow.
    expect(panelNotices(laptop)).toEqual([]);
    expect(panelNotices(otherProject)).toEqual([]);
  });

  it("tells the views that watch of the driver's drafts apart from its panels (#13283)", async () => {
    const { hostWindow, laptop } = await laptopDrivesWithHostWatching();
    const draftNotices = (endpoint: FakeEndpoint) =>
      endpoint.allEvents().filter((event) => event.type === "drafts-changed");

    service.notifyPanelsChanged("p");
    service.notifyDraftsChanged("p");
    service.notifyDraftsChanged("p");
    vi.advanceTimersByTime(Math.max(PANELS_CHANGED_DELAY_MS, DRAFTS_CHANGED_DELAY_MS));

    expect(draftNotices(hostWindow)).toEqual([{ type: "drafts-changed", projectId: "p" }]);
    expect(panelNotices(hostWindow)).toEqual([{ type: "panels-changed", projectId: "p" }]);
    expect(draftNotices(laptop)).toEqual([]);
  });

  it("tells nobody while this machine's own windows drive among themselves", async () => {
    const a = local(1);
    const b = local(2);
    registry.add(a);
    registry.add(b);
    await settle();

    service.notifyPanelsChanged("p");
    vi.advanceTimersByTime(PANELS_CHANGED_DELAY_MS);

    expect(panelNotices(a)).toEqual([]);
    expect(panelNotices(b)).toEqual([]);
  });

  it("decides who watches when the notice goes, not when the save landed", async () => {
    const { hostWindow, laptop } = await laptopDrivesWithHostWatching();

    service.notifyPanelsChanged("p");
    service.takeOver("p", hostWindow);
    vi.advanceTimersByTime(PANELS_CHANGED_DELAY_MS);

    expect(panelNotices(hostWindow)).toEqual([]);
    expect(panelNotices(laptop)).toEqual([{ type: "panels-changed", projectId: "p" }]);
  });

  it("sends nothing still pending once disposed", async () => {
    const { hostWindow } = await laptopDrivesWithHostWatching();

    service.notifyPanelsChanged("p");
    service.dispose();
    vi.advanceTimersByTime(PANELS_CHANGED_DELAY_MS);

    expect(panelNotices(hostWindow)).toEqual([]);
  });
});

describe("DriveLeaseService driver navigation (#13281)", () => {
  const navigationNotices = (endpoint: FakeEndpoint) =>
    endpoint.allEvents().filter((event) => event.type === "navigation-changed");
  const at = (worktree: string, focused: string | null = null): DriveLeaseNavigation => ({
    activeWorktreeId: worktree,
    focusedPanelId: focused,
    maximize: null,
    focusMode: false,
  });

  async function laptopDrivesWithHostWatching() {
    const hostWindow = local(1);
    const laptop = remote("s1:e1", "greg-mbp-id");
    const otherProject = local(3, "q");
    for (const endpoint of [hostWindow, laptop, otherProject]) registry.add(endpoint);
    await settle();
    const holder = service.takeOver("p", laptop);
    return { hostWindow, laptop, otherProject, leaseId: holder.leaseId };
  }

  it("passes the newest of a burst of moves to the views that watch", async () => {
    const { hostWindow, laptop, otherProject, leaseId } = await laptopDrivesWithHostWatching();

    service.reportNavigation("p", laptop, leaseId, at("wt-1"));
    service.reportNavigation("p", laptop, leaseId, at("wt-2", "t1"));
    expect(navigationNotices(hostWindow)).toEqual([]);
    vi.advanceTimersByTime(NAVIGATION_CHANGED_DELAY_MS);

    expect(navigationNotices(hostWindow)).toEqual([
      { type: "navigation-changed", projectId: "p", navigation: at("wt-2", "t1") },
    ]);
    expect(navigationNotices(laptop)).toEqual([]);
    expect(navigationNotices(otherProject)).toEqual([]);
    // A view reading the lease, or coming to watch, gets it without waiting for a move.
    expect(service.viewFor("p", hostWindow).driverNavigation).toEqual(at("wt-2", "t1"));
  });

  it("ignores a view that doesn't drive, and a driver's report from a lease it lost", async () => {
    const { hostWindow, laptop, leaseId } = await laptopDrivesWithHostWatching();

    service.reportNavigation("p", hostWindow, leaseId, at("watcher"));
    service.reportNavigation("p", laptop, leaseId, at("driver"));
    const taken = service.takeOver("p", hostWindow);
    // Sent before the takeover reached the laptop.
    service.reportNavigation("p", laptop, leaseId, at("stale"));
    vi.advanceTimersByTime(NAVIGATION_CHANGED_DELAY_MS);

    // The view taking over starts from where the driver it displaced was.
    expect(service.viewFor("p", hostWindow).driverNavigation).toEqual(at("driver"));
    service.reportNavigation("p", hostWindow, taken.leaseId, at("host"));
    vi.advanceTimersByTime(NAVIGATION_CHANGED_DELAY_MS);
    expect(service.viewFor("p", laptop).driverNavigation).toEqual(at("host"));
    expect(navigationNotices(laptop).at(-1)).toEqual({
      type: "navigation-changed",
      projectId: "p",
      navigation: at("host"),
    });
  });

  it("takes a report from any of this machine's windows while it drives", async () => {
    const a = local(1);
    const b = local(2);
    const laptop = remote("s1:e1", "greg-mbp-id");
    for (const endpoint of [a, b, laptop]) registry.add(endpoint);
    await settle();
    const holder = service.takeOver("p", a);

    service.reportNavigation("p", b, holder.leaseId, at("from-b"));
    vi.advanceTimersByTime(NAVIGATION_CHANGED_DELAY_MS);

    expect(navigationNotices(laptop)).toEqual([
      { type: "navigation-changed", projectId: "p", navigation: at("from-b") },
    ]);
    expect(navigationNotices(a)).toEqual([]);
  });

  it("sends nothing still pending once disposed", async () => {
    const { hostWindow, laptop, leaseId } = await laptopDrivesWithHostWatching();

    service.reportNavigation("p", laptop, leaseId, at("wt-1"));
    service.dispose();
    vi.advanceTimersByTime(NAVIGATION_CHANGED_DELAY_MS);

    expect(navigationNotices(hostWindow)).toEqual([]);
  });
});

describe("DriveLeaseService and the Host's own screen in use (#13285)", () => {
  let inUse: Set<string>;

  beforeEach(() => {
    service.dispose();
    inUse = new Set();
    service = new DriveLeaseService({
      registry,
      releaseGraceMs: GRACE_MS,
      now: () => 1_000,
      applyDriveLeases: (leases) => leaseTables.push(leases),
      isHostScreenInUse: (endpoint) => inUse.has(endpoint.endpointId),
    });
  });

  it("refuses a claim made on open while someone uses the Host's screen, but not Take control", async () => {
    const hostWindow = local(1);
    const laptop = remote("s1:e1", "greg-mbp-id");
    registry.add(hostWindow);
    await settle();
    const held = service.takeOver("p", hostWindow);
    registry.add(laptop);
    await settle();
    inUse.add("local:1");

    expect(service.viewFor("p", laptop)).toMatchObject({ hostScreenInUse: true });
    expect(service.takeOver("p", laptop, { ifLeaseId: held.leaseId })).toBe(held);
    expect(service.isDriving("p", laptop)).toBe(false);

    // Stepping away from the Host lets the next open take it.
    inUse.clear();
    expect(service.viewFor("p", laptop)).toMatchObject({ hostScreenInUse: false });
    expect(service.takeOver("p", laptop, { ifLeaseId: held.leaseId })?.endpointId).toBe("s1:e1");

    // Take control is explicit, and always granted.
    inUse.add("local:1");
    const back = service.takeOver("p", hostWindow);
    expect(service.takeOver("p", laptop).endpointId).toBe("s1:e1");
    expect(service.getHolder("p")!.leaseId).toBeGreaterThan(back.leaseId);
  });

  it("leaves a project nobody holds with the Host's screen in use when a claim on open arrives", async () => {
    const hostWindow = local(1);
    registry.add(hostWindow);
    await settle();
    inUse.add("local:1");
    const laptop = remote("s1:e1", "greg-mbp-id");
    registry.add(laptop);
    // Read before the arrival settles: nobody holds it yet.
    expect(service.getHolder("p")).toBeNull();

    const result = service.takeOver("p", laptop, { ifLeaseId: null });
    expect(result).toMatchObject({ endpointId: "local:1", isHostLocal: true });
    expect(service.isDriving("p", laptop)).toBe(false);
  });

  it("gives a project nobody holds to the Host's screen in use rather than whoever arrived first", async () => {
    const laptop = remote("s1:e1", "greg-mbp-id");
    const idle = local(1);
    const busy = local(2);
    registry.add(laptop);
    registry.add(idle);
    registry.add(busy);
    inUse.add("local:2");
    await settle();

    expect(service.getHolder("p")).toMatchObject({ endpointId: "local:2", isHostLocal: true });
  });
});

describe("DriveLeaseService across a restart of this app", () => {
  function memoryStore(initial: Record<string, DriveLeaseReservation> = {}) {
    const saved: Array<Record<string, DriveLeaseReservation>> = [];
    return {
      saved,
      store: {
        load: () => initial,
        save: (next: Record<string, DriveLeaseReservation>) => {
          saved.push(next);
        },
      },
    };
  }

  const RESTORED_GRACE_MS = GRACE_MS * 3;

  function restarted(initial: Record<string, DriveLeaseReservation>) {
    const memory = memoryStore(initial);
    const next = new DriveLeaseService({
      registry,
      releaseGraceMs: GRACE_MS,
      restoredReservationGraceMs: RESTORED_GRACE_MS,
      now: () => 1_000,
      applyDriveLeases: (leases) => leaseTables.push(leases),
      reservations: memory.store,
    });
    return { next, memory };
  }

  const greg = { clientId: "shell-launch-1", clientName: "greg-mbp" };
  const noteClient = (endpoint: FakeEndpoint, clientId: string, clientName: string) =>
    service.noteEndpointClient(endpoint.endpointId, {
      clientId,
      clientName,
      platform: "darwin",
      kind: "remote",
    });

  it("keeps the remote holders it grants, and forgets a project once this machine drives it", async () => {
    service.dispose();
    const memory = memoryStore();
    service = new DriveLeaseService({
      registry,
      releaseGraceMs: GRACE_MS,
      now: () => 1_000,
      applyDriveLeases: (leases) => leaseTables.push(leases),
      reservations: memory.store,
    });
    const laptop = remote("s1:e1", "shell-launch-1");
    const hostWindow = local(1);
    registry.add(laptop);
    service.noteEndpointClient(laptop.endpointId, {
      clientId: "shell-launch-1",
      clientName: "greg-mbp",
      platform: "darwin",
      kind: "remote",
    });
    await settle();
    expect(memory.saved.at(-1)).toEqual({
      p: {
        clientId: "shell-launch-1",
        clientName: "greg-mbp",
        tenureId: service.getHolder("p")!.tenureId,
      },
    });

    registry.add(hostWindow);
    await settle();
    service.takeOver("p", hostWindow);
    expect(memory.saved.at(-1)).toEqual({});
  });

  it("holds a project for the Shell that drove it, so this machine's window can't take it on start", async () => {
    service.dispose();
    const { next } = restarted({ p: { clientId: "shell-launch-1", clientName: "greg-mbp" } });
    service = next;
    const hostWindow = local(1);
    registry.add(hostWindow);
    await settle();

    expect(service.getHolder("p")).toMatchObject({
      clientId: "shell-launch-1",
      clientName: "greg-mbp",
      isHostLocal: false,
    });
    expect(service.getDriveTarget("p").kind).toBe("reserved");
    expect(service.isDriving("p", hostWindow)).toBe(false);
    // The Shell is away from the start, for the whole restored grace.
    expect(service.viewFor("p", hostWindow).holderAwayMs).toBe(RESTORED_GRACE_MS);
    // Nobody's terminal input reaches it while it waits: no connection has id 0.
    expect(leaseTables.at(-1)).toEqual([
      expect.objectContaining({ projectId: "p", holderConnection: 0 }),
    ]);

    // The Shell comes back inside the grace and simply carries on.
    const laptop = remote("s2:e1", "shell-launch-1");
    registry.add(laptop);
    await settle();
    expect(service.getHolder("p")?.endpointId).toBe("s2:e1");
    expect(service.isDriving("p", laptop)).toBe(true);
    expect(service.viewFor("p", hostWindow)).not.toHaveProperty("holderAwayMs");
  });

  it("gives the project to whoever is there once the grace runs out", async () => {
    service.dispose();
    const { next, memory } = restarted({
      p: { clientId: "shell-launch-1", clientName: "greg-mbp" },
    });
    service = next;
    const hostWindow = local(1);
    registry.add(hostWindow);
    await settle();
    expect(service.isDriving("p", hostWindow)).toBe(false);

    // Past the ordinary grace it still waits: the Shell may be deep in its backoff.
    vi.advanceTimersByTime(GRACE_MS + 1);
    expect(service.isDriving("p", hostWindow)).toBe(false);

    vi.advanceTimersByTime(RESTORED_GRACE_MS - GRACE_MS);
    expect(service.getHolder("p")).toMatchObject({ endpointId: "local:1", isHostLocal: true });
    expect(service.isDriving("p", hostWindow)).toBe(true);
    expect(memory.saved.at(-1)).toEqual({});
  });

  it("lets this machine's window take it over explicitly while it waits", async () => {
    service.dispose();
    const { next } = restarted({ p: { clientId: "shell-launch-1", clientName: "greg-mbp" } });
    service = next;
    const hostWindow = local(1);
    registry.add(hostWindow);
    await settle();

    service.takeOver("p", hostWindow);
    expect(service.isDriving("p", hostWindow)).toBe(true);
    vi.advanceTimersByTime(RESTORED_GRACE_MS + 1);
    expect(service.getHolder("p")?.endpointId).toBe("local:1");
  });

  it("keeps it from another Shell that attaches first, and hands it back to the one that drove", async () => {
    service.dispose();
    const { next } = restarted({ p: greg });
    service = next;
    const other = remote("s9:e1", "shell-launch-2");
    registry.add(other);
    noteClient(other, "shell-launch-2", "ana-mbp");
    await settle();
    expect(service.isDriving("p", other)).toBe(false);
    expect(service.getHolder("p")?.clientId).toBe("shell-launch-1");

    const back = remote("s2:e1", "shell-launch-1");
    registry.add(back);
    noteClient(back, "shell-launch-1", "greg-mbp");
    await settle();
    expect(service.getHolder("p")?.endpointId).toBe("s2:e1");
    expect(service.isDriving("p", other)).toBe(false);
    expect(leaseTables.at(-1)).toEqual([
      expect.objectContaining({ projectId: "p", holderConnection: back.handle }),
    ]);
  });

  it("carries the tenure across the restart, so the Shell that drove carries on in it", async () => {
    service.dispose();
    const { next } = restarted({
      p: { ...greg, tenureId: "tenure-before-restart" },
      q: greg,
    });
    service = next;
    expect(service.getHolder("p")?.tenureId).toBe("tenure-before-restart");
    // Saved by a Host that predates tenures: a tenure of its own from here on.
    expect(service.getHolder("q")?.tenureId).toEqual(expect.any(String));

    const back = remote("s2:e1", "shell-launch-1");
    registry.add(back);
    await settle();
    expect(service.getHolder("p")).toMatchObject({
      endpointId: "s2:e1",
      tenureId: "tenure-before-restart",
    });
  });

  it("writes the tenure a reservation saved without one gets, so the next restart keeps it", async () => {
    service.dispose();
    const first = restarted({ p: greg });
    service = first.next;
    const tenure = service.getHolder("p")!.tenureId;

    const back = remote("s2:e1", "shell-launch-1");
    registry.add(back);
    noteClient(back, "shell-launch-1", "greg-mbp");
    await settle();
    expect(first.memory.saved.at(-1)).toEqual({ p: { ...greg, tenureId: tenure } });

    service.dispose();
    back.close();
    const second = restarted(first.memory.saved.at(-1)!);
    service = second.next;
    expect(service.getHolder("p")?.tenureId).toBe(tenure);
  });

  it("gives it to the Shell that waited once the grace runs out; the old driver returning late observes", async () => {
    service.dispose();
    const { next } = restarted({ p: greg });
    service = next;
    const other = remote("s9:e1", "shell-launch-2");
    registry.add(other);
    await settle();

    vi.advanceTimersByTime(RESTORED_GRACE_MS + 1);
    expect(service.getHolder("p")?.endpointId).toBe("s9:e1");

    const late = remote("s2:e1", "shell-launch-1");
    registry.add(late);
    await settle();
    expect(service.getHolder("p")?.endpointId).toBe("s9:e1");
    expect(service.isDriving("p", late)).toBe(false);
  });

  it("tries a failed save again on the next change", async () => {
    service.dispose();
    const saved: unknown[] = [];
    let failNext = true;
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    service = new DriveLeaseService({
      registry,
      releaseGraceMs: GRACE_MS,
      applyDriveLeases: (leases) => leaseTables.push(leases),
      reservations: {
        load: () => ({}),
        save: (next) => {
          if (failNext) {
            failNext = false;
            throw new Error("ENOSPC");
          }
          saved.push(next);
        },
      },
    });
    const laptop = remote("s1:e1", "shell-launch-1");
    registry.add(laptop);
    await settle();
    expect(saved).toEqual([]);
    const { tenureId } = service.getHolder("p")!;

    // Same client, same name, a new endpoint: nothing new to say, but the file is behind.
    laptop.close();
    const again = remote("s1:e2", "shell-launch-1");
    registry.add(again);
    await settle();
    expect(saved.at(-1)).toEqual({
      p: { clientId: "shell-launch-1", clientName: "shell-launch-1", tenureId },
    });
    errors.mockRestore();
  });

  it("starts with nothing held when the store can't be read", async () => {
    service.dispose();
    loggerMock.error.mockClear();
    service = new DriveLeaseService({
      registry,
      releaseGraceMs: GRACE_MS,
      applyDriveLeases: (leases) => leaseTables.push(leases),
      reservations: {
        load: () => {
          throw new Error("EACCES");
        },
        save: () => {},
      },
    });
    expect(service.getState("p").holder).toBeNull();
    expect(loggerMock.error).toHaveBeenCalledWith(
      "Drive lease reservations could not be read",
      expect.any(Error)
    );
  });
});

describe("DriveLeaseService and a relaunched Shell (#13909)", () => {
  const INSTALL = "5b1f6c3e-8d2a-4f4e-9c1b-0a7e2d9f3c41";
  const OTHER_INSTALL = "c0e9a1d2-3b4c-4d5e-8f6a-7b8c9d0e1f2a";

  const note = (endpoint: FakeEndpoint, clientName: string, deviceId?: string) =>
    service.noteEndpointClient(endpoint.endpointId, {
      clientId: endpoint.clientId,
      clientName,
      platform: "darwin",
      kind: "remote",
      ...(deviceId ? { deviceId } : {}),
    });

  async function drivenThenGone(deviceId: string | undefined, gone: "quit" | "parked") {
    const before = remote("s1:e1", "launch-1");
    registry.add(before);
    note(before, "greg-studio", deviceId);
    await settle();
    expect(service.getHolder("p")?.endpointId).toBe("s1:e1");
    if (gone === "quit") before.close();
    else service.noteEndpointTransport([before.endpointId], false);
    await settle();
    return before;
  }

  it("takes the project straight back for a relaunch of the install that drove it", async () => {
    await drivenThenGone(INSTALL, "quit");
    const hostWindow = local(1);
    registry.add(hostWindow);
    await settle();
    expect(service.isDriving("p", hostWindow)).toBe(false);

    const after = remote("s2:e1", "launch-2");
    registry.add(after);
    note(after, "greg-studio", INSTALL);
    await settle();

    expect(service.getHolder("p")).toMatchObject({ endpointId: "s2:e1", clientId: "launch-2" });
    expect(service.getDriveTarget("p").kind).toBe("live");
    expect(service.viewFor("p", after)).toMatchObject({
      drivingHere: true,
      isHolderEndpoint: true,
      heldByThisClient: true,
    });
    expect(service.isDriving("p", hostWindow)).toBe(false);
    expect(leaseTables.at(-1)).toEqual([
      expect.objectContaining({ projectId: "p", holderConnection: after.handle }),
    ]);
    // The grace the old launch left running releases nothing.
    vi.advanceTimersByTime(GRACE_MS * 2);
    expect(service.getHolder("p")?.endpointId).toBe("s2:e1");
  });

  it("leaves a holder whose link merely dropped its grace, and carries on once its session ends", async () => {
    const before = await drivenThenGone(INSTALL, "parked");

    // Another launch sharing the install's id waits: a resume keeps the lease.
    const after = remote("s2:e1", "launch-2");
    registry.add(after);
    note(after, "greg-studio", INSTALL);
    await settle();
    expect(service.getHolder("p")?.endpointId).toBe("s1:e1");
    expect(service.isDriving("p", after)).toBe(false);
    service.noteEndpointTransport([before.endpointId], true);
    expect(service.getHolder("p")?.endpointId).toBe("s1:e1");

    // Its link drops again and the host ends the session, as a relaunch's HELLO does.
    service.noteEndpointTransport([before.endpointId], false);
    before.close();
    await settle();
    expect(changes.at(-1)?.holder?.endpointId).toBe("s2:e1");
    expect(service.isDriving("p", before)).toBe(false);
    vi.advanceTimersByTime(GRACE_MS * 2);
    expect(service.getHolder("p")?.endpointId).toBe("s2:e1");
  });

  it("hands it to its install, over an earlier watcher, when a dropped holder's grace runs out", async () => {
    const before = remote("s1:e1", "launch-1");
    registry.add(before);
    note(before, "greg-studio", INSTALL);
    await settle();
    const watcher = remote("s9:e1", "ana-launch");
    registry.add(watcher);
    note(watcher, "ana-mbp", OTHER_INSTALL);
    await settle();
    // The host only sees the crashed launch's link die after the relaunch said HELLO.
    const after = remote("s2:e1", "launch-2");
    registry.add(after);
    note(after, "greg-studio", INSTALL);
    service.noteEndpointTransport([before.endpointId], false);
    await settle();
    expect(service.getHolder("p")?.endpointId).toBe("s1:e1");

    vi.advanceTimersByTime(GRACE_MS);
    expect(service.getHolder("p")?.endpointId).toBe("s2:e1");
    expect(service.isDriving("p", watcher)).toBe(false);
  });

  it.each([
    ["another install", INSTALL, OTHER_INSTALL],
    ["a newcomer that names no install", INSTALL, undefined],
    ["a holder that named no install", undefined, INSTALL],
    ["neither naming one", undefined, undefined],
  ])("waits out the grace for %s", async (_label, holderInstall, newcomerInstall) => {
    await drivenThenGone(holderInstall, "quit");

    const after = remote("s2:e1", "launch-2");
    registry.add(after);
    // Same machine name: a name never stands in for the install.
    note(after, "greg-studio", newcomerInstall);
    await settle();
    expect(service.getHolder("p")?.clientId).toBe("launch-1");
    expect(service.isDriving("p", after)).toBe(false);

    vi.advanceTimersByTime(GRACE_MS);
    expect(service.getHolder("p")?.endpointId).toBe("s2:e1");
  });

  it("never takes it from a holder still there, whichever install it names", async () => {
    const first = remote("s1:e1", "launch-1");
    const second = remote("s2:e1", "launch-2");
    registry.add(first);
    note(first, "greg-studio", INSTALL);
    await settle();
    registry.add(second);
    note(second, "greg-studio", INSTALL);
    await settle();

    expect(service.getHolder("p")?.endpointId).toBe("s1:e1");
    expect(service.isDriving("p", second)).toBe(false);
    vi.advanceTimersByTime(GRACE_MS * 2);
    expect(service.getHolder("p")?.endpointId).toBe("s1:e1");
    // Taking control is still the explicit step.
    expect(service.takeOver("p", second).endpointId).toBe("s2:e1");
  });

  it("hands it to the holder's own client before another launch of its install", async () => {
    await drivenThenGone(INSTALL, "quit");
    const sibling = remote("s2:e1", "launch-2");
    const sameLaunch = remote("s1:e2", "launch-1");
    registry.add(sibling);
    note(sibling, "greg-studio", INSTALL);
    registry.add(sameLaunch);
    note(sameLaunch, "greg-studio", INSTALL);
    await settle();

    expect(service.getHolder("p")?.endpointId).toBe("s1:e2");
  });

  it("matches the install once it is noted, whichever order the note and the lease came in", async () => {
    // Granted before its client was noted: the install is learned from the late note.
    const before = remote("s1:e1", "launch-1");
    registry.add(before);
    await settle();
    expect(service.getHolder("p")?.endpointId).toBe("s1:e1");
    note(before, "greg-studio", INSTALL);
    before.close();
    await settle();

    // A newcomer attached before its own note arrived takes it once the note says who it is.
    const after = remote("s2:e1", "launch-2");
    registry.add(after);
    await settle();
    expect(service.getHolder("p")?.clientId).toBe("launch-1");
    note(after, "greg-studio", INSTALL);
    await settle();
    // Settled by the note itself, not by a later read.
    expect(changes.at(-1)?.holder?.endpointId).toBe("s2:e1");
    expect(leaseTables.at(-1)).toEqual([
      expect.objectContaining({ projectId: "p", holderConnection: after.handle }),
    ]);
  });

  it("keeps the install id off everything other Shells see", async () => {
    const watcher = remote("s9:e1", "ana-launch");
    registry.add(watcher);
    note(watcher, "ana-mbp", OTHER_INSTALL);
    await settle();
    const driver = remote("s1:e1", "launch-1");
    registry.add(driver);
    note(driver, "greg-studio", INSTALL);
    await settle();
    service.takeOver("p", driver);

    const seen = JSON.stringify([
      changes,
      watcher.sent,
      driver.sent,
      service.getState("p"),
      service.viewFor("p", watcher),
    ]);
    expect(seen).not.toContain(INSTALL);
    expect(seen).not.toContain(OTHER_INSTALL);
  });

  describe("across a restart of this app", () => {
    function restartedWith(initial: Record<string, DriveLeaseReservation>) {
      const saved: Array<Record<string, DriveLeaseReservation>> = [];
      service.dispose();
      service = new DriveLeaseService({
        registry,
        releaseGraceMs: GRACE_MS,
        restoredReservationGraceMs: GRACE_MS * 3,
        now: () => 1_000,
        applyDriveLeases: (leases) => leaseTables.push(leases),
        reservations: { load: () => initial, save: (next) => saved.push(next) },
      });
      return saved;
    }

    it("saves the holder's install with its reservation", async () => {
      const saved = restartedWith({});
      const driver = remote("s1:e1", "launch-1");
      registry.add(driver);
      note(driver, "greg-studio", INSTALL);
      await settle();
      const { tenureId } = service.getHolder("p")!;
      expect(saved.at(-1)).toEqual({
        p: { clientId: "launch-1", clientName: "greg-studio", deviceId: INSTALL, tenureId },
      });
    });

    it("saves the install a late note names, even one that leaves the name as it was", async () => {
      const saved = restartedWith({});
      const driver = remote("s1:e1", "launch-1");
      registry.add(driver);
      await settle();
      const { tenureId } = service.getHolder("p")!;
      expect(saved.at(-1)).toEqual({
        p: { clientId: "launch-1", clientName: "launch-1", tenureId },
      });

      note(driver, "launch-1", INSTALL);
      expect(saved.at(-1)).toEqual({
        p: { clientId: "launch-1", clientName: "launch-1", deviceId: INSTALL, tenureId },
      });
    });

    it("holds the project for its install, which takes it straight back on a new launch", async () => {
      restartedWith({
        p: { clientId: "launch-1", clientName: "greg-studio", deviceId: INSTALL },
      });
      const other = remote("s9:e1", "ana-launch");
      registry.add(other);
      note(other, "ana-mbp", OTHER_INSTALL);
      await settle();
      expect(service.getDriveTarget("p").kind).toBe("reserved");
      expect(service.isDriving("p", other)).toBe(false);

      const after = remote("s2:e1", "launch-2");
      registry.add(after);
      note(after, "greg-studio", INSTALL);
      await settle();
      expect(service.getHolder("p")?.endpointId).toBe("s2:e1");
      expect(service.isDriving("p", other)).toBe(false);
    });

    it("leaves a reservation saved before installs were recorded to its client alone", async () => {
      restartedWith({ p: { clientId: "launch-1", clientName: "greg-studio" } });
      const after = remote("s2:e1", "launch-2");
      registry.add(after);
      note(after, "greg-studio", INSTALL);
      await settle();
      expect(service.getHolder("p")?.clientId).toBe("launch-1");
      expect(service.isDriving("p", after)).toBe(false);
    });
  });

  describe("logging", () => {
    const messages = () => loggerMock.info.mock.calls.map(([message]) => message);

    it("records who got the lease, who lost it and why", async () => {
      const laptop = remote("s1:e1", "c1");
      const phone = remote("s2:e1", "c2");
      registry.add(laptop);
      registry.add(phone);
      await settle();
      service.takeOver("p", laptop);
      service.takeOver("p", phone);

      expect(loggerMock.info).toHaveBeenCalledWith(
        "Drive lease transferred",
        expect.objectContaining({
          projectId: "p",
          clientId: "c2",
          reason: "explicit-takeover",
          previousClientId: "c1",
        })
      );
    });

    it("records a holder going away, the grace running out, and the successor", async () => {
      const hostWindow = local(1);
      const laptop = remote("s1:e1", "c1");
      registry.add(hostWindow);
      registry.add(laptop);
      await settle();
      service.takeOver("p", laptop);
      loggerMock.info.mockClear();

      laptop.close();
      await settle();
      expect(messages()).toContain("Drive lease holder away");

      vi.advanceTimersByTime(GRACE_MS);
      expect(messages()).toEqual([
        "Drive lease holder away",
        "Drive lease grace expired",
        "Drive lease transferred",
      ]);
      expect(loggerMock.info).toHaveBeenLastCalledWith(
        "Drive lease transferred",
        expect.objectContaining({ reason: "grace-expired" })
      );
    });

    it("records a release when nobody is left, and stays quiet on reads", async () => {
      const laptop = remote("s1:e1", "c1");
      registry.add(laptop);
      await settle();
      service.getHolder("p");
      service.getState("p");
      expect(messages()).toEqual(["Drive lease granted"]);

      laptop.close();
      await settle();
      vi.advanceTimersByTime(GRACE_MS);
      expect(messages().at(-1)).toBe("Drive lease released");
    });
  });
});
