import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  webContents: { fromId: vi.fn(() => null), getAllWebContents: vi.fn(() => []) },
  BrowserWindow: { fromWebContents: vi.fn(() => null), getAllWindows: vi.fn(() => []) },
}));

import { DriveLeaseService, PANELS_CHANGED_DELAY_MS } from "../DriveLeaseService.js";
import { EndpointRegistryImpl } from "../../ipc/endpointRegistry.js";
import type { ClientEndpoint, Disposable, HostFrame } from "../../ipc/endpoint.js";
import type { DriveLeaseEvent } from "../../../shared/types/ipc/driveLease.js";
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

    // A held lease isn't handed to another window of its client by a read either.
    service.takeOver("p", hostWindow);
    changes.length = 0;
    hostWindow.projectId = "q";
    expect(service.getHolder("p")?.endpointId).toBe("local:1");
    expect(changes).toEqual([]);
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
  function memoryStore(initial: Record<string, { clientId: string; clientName: string }> = {}) {
    const saved: Array<Record<string, { clientId: string; clientName: string }>> = [];
    return {
      saved,
      store: {
        load: () => initial,
        save: (next: Record<string, { clientId: string; clientName: string }>) => {
          saved.push(next);
        },
      },
    };
  }

  const RESTORED_GRACE_MS = GRACE_MS * 3;

  function restarted(initial: Record<string, { clientId: string; clientName: string }>) {
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
      p: { clientId: "shell-launch-1", clientName: "greg-mbp" },
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

    // Same client, same name, a new endpoint: nothing new to say, but the file is behind.
    laptop.close();
    const again = remote("s1:e2", "shell-launch-1");
    registry.add(again);
    await settle();
    expect(saved.at(-1)).toEqual({
      p: { clientId: "shell-launch-1", clientName: "shell-launch-1" },
    });
    errors.mockRestore();
  });

  it("starts with nothing held when the store can't be read", async () => {
    service.dispose();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
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
    expect(errors).toHaveBeenCalled();
    errors.mockRestore();
  });
});
