import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  webContents: { fromId: vi.fn(() => null), getAllWebContents: vi.fn(() => []) },
  BrowserWindow: { fromWebContents: vi.fn(() => null), getAllWindows: vi.fn(() => []) },
}));

import { DriveLeaseService } from "../DriveLeaseService.js";
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

  events(): DriveLeaseEvent[] {
    return this.sent
      .filter((frame) => frame.channel === "drive-lease:event")
      .map((frame) => frame.args[0] as DriveLeaseEvent);
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

    const holder = service.getHolder("p");
    expect(holder).toMatchObject({ endpointId: "local:1", clientId: "local", isHostLocal: true });
    expect(service.isDriving("p", a)).toBe(true);
    expect(service.isDriving("p", b)).toBe(true);
    expect(service.viewFor("p", b)).toMatchObject({
      drivingHere: true,
      isHolderEndpoint: false,
      viewerIsHostLocal: true,
    });
    expect(leaseTables).toEqual([]);

    // The holder window goes: the other window of the same client carries on.
    a.close();
    await settle();
    expect(service.getHolder("p")?.endpointId).toBe("local:2");
    expect(leaseTables).toEqual([]);
  });

  it("lists the projects someone else drives, which a caller's calls may not change", async () => {
    const hostWindow = local(1, "mine");
    const laptop = remote("s1:e1", "greg-mbp-id", "theirs");
    registry.add(hostWindow);
    registry.add(laptop);
    await settle();
    service.getHolder("mine");

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

  it("a second client sees it driven elsewhere and can take over, with a fresh lease id", async () => {
    const hostWindow = local(1);
    const laptop = remote("s1:e1", "greg-mbp-id");
    registry.add(hostWindow);
    await settle();
    const first = service.getHolder("p")!;

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
    const holder = service.getHolder("p")!;
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
    expect(service.viewFor("p", second)).toMatchObject({ drivingHere: false });
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
