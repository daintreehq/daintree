import { describe, expect, it, vi } from "vitest";
import { wrapSuccess } from "../../../../shared/utils/ipcErrorSerialization.js";
import type { CanopySnapshot } from "../../../../shared/types/ipc/canopy.js";
import type { FleetSnapshot } from "../../../../shared/types/ipc/fleet.js";
import { CanopyViewers, createCanopyViewer } from "../viewer.js";

const client = {
  clientId: "c",
  clientName: "c",
  platform: "darwin" as const,
  kind: "remote" as const,
};

function params(onPush = vi.fn()) {
  return { endpointId: "canopy-viewer:a", clientId: "c", onPush };
}

describe("createCanopyViewer", () => {
  it("passes on Canopy's own pushes only, until it closes", () => {
    const onPush = vi.fn();
    const viewer = createCanopyViewer(params(onPush));
    viewer.send({ type: "event", channel: "terminal:data", args: ["x"] });
    viewer.send({ type: "event", channel: "canopy:terminal-data", args: [{ kind: "data" }] });
    viewer.close();
    viewer.send({ type: "event", channel: "canopy:snapshot-updated", args: [{}] });
    expect(onPush.mock.calls).toEqual([["canopy:terminal-data", { kind: "data" }]]);
  });

  it("has a handle no WebContents or other viewer shares, and closes once", async () => {
    const a = createCanopyViewer(params());
    const b = createCanopyViewer(params());
    expect(a.handle).toBeLessThan(0);
    expect(a.handle).not.toBe(b.handle);
    const closed = vi.fn();
    a.onClose(closed);
    a.close();
    a.close();
    expect(closed).toHaveBeenCalledTimes(1);
    expect(a.isClosed()).toBe(true);
    const late = vi.fn();
    a.onClose(late);
    await Promise.resolve();
    expect(late).toHaveBeenCalledTimes(1);
  });
});

describe("CanopyViewers", () => {
  function setup(fleetReady = true) {
    let canopyListener: ((s: CanopySnapshot) => void) | null = null;
    let fleetListener: ((s: FleetSnapshot) => void) | null = null;
    const offCanopy = vi.fn(() => void (canopyListener = null));
    const invoke = vi.fn(async () => wrapSuccess("ok"));
    const ready = { fleet: fleetReady };
    const viewers = new CanopyViewers({
      source: {
        observeCanopy: (listener) => {
          canopyListener = listener;
          return offCanopy;
        },
        observeFleet: (listener) => {
          if (!ready.fleet) return null;
          fleetListener = listener;
          return () => void (fleetListener = null);
        },
      },
      invoke,
    });
    return {
      viewers,
      invoke,
      offCanopy,
      ready,
      canopy: (s: unknown) => canopyListener?.(s as CanopySnapshot),
      fleet: (s: unknown) => fleetListener?.(s as FleetSnapshot),
      observing: () => canopyListener !== null,
    };
  }

  it("refuses a channel outside the allowed Canopy calls without running it", async () => {
    const s = setup();
    await expect(
      s.viewers.invoke("k", () => params(), client, "canopy:terminal-resize", [])
    ).rejects.toMatchObject({ code: "VALIDATION" });
    expect(s.invoke).not.toHaveBeenCalled();
    expect(s.viewers.has("k")).toBe(false);
  });

  it("runs every call of one key as the same viewer", async () => {
    const s = setup();
    await s.viewers.invoke("k", () => params(), client, "canopy:get-snapshot", []);
    await s.viewers.invoke("k", () => params(), client, "canopy:refresh", []);
    const [first, second] = s.invoke.mock.calls as unknown as Array<[{ endpoint: unknown }]>;
    expect(first[0].endpoint).toBe(second[0].endpoint);
  });

  it("pushes this machine's snapshots to every viewer while any exists", async () => {
    const s = setup(false);
    const a = vi.fn();
    const b = vi.fn();
    await s.viewers.invoke("a", () => params(a), client, "canopy:get-snapshot", []);
    // The fleet service came up after the first viewer: the next one subscribes.
    s.ready.fleet = true;
    await s.viewers.invoke("b", () => params(b), client, "canopy:get-snapshot", []);
    s.canopy({ sequence: 1 });
    s.fleet({ runs: [] });
    expect(a.mock.calls).toEqual([
      ["canopy:snapshot-updated", { sequence: 1 }],
      ["fleet:snapshot-updated", { runs: [] }],
    ]);
    expect(b.mock.calls).toEqual(a.mock.calls);

    s.viewers.close("a");
    expect(s.observing()).toBe(true);
    s.viewers.close("b");
    expect(s.observing()).toBe(false);
  });

  it("takes a late unwatch for a viewer already gone without opening it again", async () => {
    const s = setup();
    const envelope = await s.viewers.invoke(
      "k",
      () => params(),
      client,
      "canopy:unwatch-terminal",
      []
    );
    expect(envelope.ok).toBe(true);
    expect(s.invoke).not.toHaveBeenCalled();
    expect(s.viewers.has("k")).toBe(false);
  });
});

describe("CanopyViewers: assistant viewers (#14163)", () => {
  function setup() {
    let canopyListener: ((s: CanopySnapshot) => void) | null = null;
    const invoke = vi.fn(async () => wrapSuccess("ok"));
    const offAdmission = vi.fn();
    const admitAssistantViewers = vi.fn(() => offAdmission);
    const viewers = new CanopyViewers({
      source: {
        observeCanopy: (listener) => {
          canopyListener = listener;
          return () => void (canopyListener = null);
        },
        observeFleet: () => null,
      },
      invoke,
      admitAssistantViewers,
    });
    return {
      viewers,
      invoke,
      admitAssistantViewers,
      offAdmission,
      canopy: (s: unknown) => canopyListener?.(s as CanopySnapshot),
      observing: () => canopyListener !== null,
    };
  }

  it("opens on a watch, reads no snapshots and hears only its own stream", async () => {
    const s = setup();
    const onPush = vi.fn();
    await s.viewers.invokeAssistant(
      "a",
      () => params(onPush),
      client,
      "canopy:watch-assistant-terminal",
      [{}]
    );
    expect(s.observing()).toBe(false);
    expect(s.admitAssistantViewers).toHaveBeenCalledTimes(1);
    const viewer = (s.invoke.mock.calls[0] as unknown[])[0] as {
      endpoint: { send: (frame: unknown) => void; purpose: string };
    };
    expect(viewer.endpoint.purpose).toBe("assistant");
    viewer.endpoint.send({ type: "event", channel: "canopy:snapshot-updated", args: [{}] });
    viewer.endpoint.send({ type: "event", channel: "canopy:terminal-data", args: ["bytes"] });
    expect(onPush.mock.calls).toEqual([["canopy:terminal-data", "bytes"]]);
  });

  it("never opens a viewer to type or unwatch, and refuses typing with no watch", async () => {
    const s = setup();
    await expect(
      s.viewers.invokeAssistant("a", () => params(), client, "canopy:unwatch-terminal", [])
    ).resolves.toEqual(wrapSuccess(undefined));
    await expect(
      s.viewers.invokeAssistant("a", () => params(), client, "canopy:terminal-input", [1, "x"])
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(s.viewers.has("a")).toBe(false);
    expect(s.invoke).not.toHaveBeenCalled();
    expect(s.admitAssistantViewers).not.toHaveBeenCalled();
  });

  it("refuses a Canopy call outside the assistant's own", async () => {
    const s = setup();
    await expect(
      s.viewers.invokeAssistant("a", () => params(), client, "canopy:answer", [])
    ).rejects.toMatchObject({ code: "VALIDATION" });
    expect(s.invoke).not.toHaveBeenCalled();
  });

  it("keeps a Canopy panel's viewer and an assistant viewer apart by key", async () => {
    const s = setup();
    await s.viewers.invoke("panel", () => params(), client, "canopy:get-snapshot", []);
    await expect(
      s.viewers.invokeAssistant(
        "panel",
        () => params(),
        client,
        "canopy:watch-assistant-terminal",
        [{}]
      )
    ).rejects.toMatchObject({ code: "VALIDATION" });
    await s.viewers.invokeAssistant(
      "pick",
      () => params(),
      client,
      "canopy:watch-assistant-terminal",
      [{}]
    );
    await expect(
      s.viewers.invoke("pick", () => params(), client, "canopy:get-snapshot", [])
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("sends snapshots to Canopy panels only, and lets each resource go with its last viewer", async () => {
    const s = setup();
    const panelPush = vi.fn();
    const pickPush = vi.fn();
    await s.viewers.invoke("panel", () => params(panelPush), client, "canopy:get-snapshot", []);
    await s.viewers.invokeAssistant(
      "pick",
      () => params(pickPush),
      client,
      "canopy:watch-assistant-terminal",
      [{}]
    );
    s.canopy({ revision: 1 });
    expect(panelPush).toHaveBeenCalledTimes(1);
    expect(pickPush).not.toHaveBeenCalled();

    s.viewers.close("panel");
    expect(s.observing()).toBe(false);
    expect(s.offAdmission).not.toHaveBeenCalled();
    s.viewers.close("pick");
    expect(s.offAdmission).toHaveBeenCalledTimes(1);
  });

  it("takes its admission back on dispose", async () => {
    const s = setup();
    await s.viewers.invokeAssistant("pick", () => params(), client, "canopy:resolve-assistant", [
      {},
    ]);
    s.viewers.dispose();
    expect(s.offAdmission).toHaveBeenCalledTimes(1);
  });
});
