import { beforeEach, describe, expect, it } from "vitest";
import {
  readDeliveredOpenRequestSeq,
  usePluginPanelOpenRequestStore,
} from "../pluginPanelOpenRequestStore";

function entryOf(panelId: string) {
  return usePluginPanelOpenRequestStore.getState().entriesByPanelId[panelId];
}

describe("pluginPanelOpenRequestStore", () => {
  beforeEach(() => {
    usePluginPanelOpenRequestStore.setState({ entriesByPanelId: {} });
  });

  it("keeps one latest request per panel", () => {
    const { publish } = usePluginPanelOpenRequestStore.getState();
    expect(publish("p1", { path: "/a" })).toBe(true);
    publish("p2", { path: "/x" });
    publish("p1", { path: "/b" });

    expect(entryOf("p1")?.request.args).toEqual({ path: "/b" });
    expect(entryOf("p2")?.request.args).toEqual({ path: "/x" });
    expect(entryOf("p1")!.request.seq).toBeGreaterThan(entryOf("p2")!.request.seq);
  });

  it("marks only the latest request delivered, and keeps it on the slot", () => {
    const { publish, markDelivered } = usePluginPanelOpenRequestStore.getState();
    publish("p1", { path: "/a" });
    const first = entryOf("p1")!.request;
    publish("p1", { path: "/b" });
    const second = entryOf("p1")!.request;

    // A view that rendered the first request acks after the second arrived.
    markDelivered("p1", first.seq);
    expect(readDeliveredOpenRequestSeq("p1")).toBe(0);

    markDelivered("p1", second.seq);
    expect(readDeliveredOpenRequestSeq("p1")).toBe(second.seq);
    expect(entryOf("p1")?.request).toBe(second);
  });

  it("carries the delivered mark across a newer request", () => {
    const { publish, markDelivered } = usePluginPanelOpenRequestStore.getState();
    publish("p1", { path: "/a" });
    const delivered = entryOf("p1")!.request.seq;
    markDelivered("p1", delivered);

    publish("p1", { path: "/b" });

    expect(readDeliveredOpenRequestSeq("p1")).toBe(delivered);
    expect(entryOf("p1")!.request.seq).toBeGreaterThan(delivered);
  });

  it("leaves the snapshot alone when an ack changes nothing", () => {
    const { publish, markDelivered } = usePluginPanelOpenRequestStore.getState();
    publish("p1", { path: "/a" });
    const { seq } = entryOf("p1")!.request;
    markDelivered("p1", seq);
    const before = usePluginPanelOpenRequestStore.getState().entriesByPanelId;

    markDelivered("p1", seq);
    markDelivered("missing", seq);

    expect(usePluginPanelOpenRequestStore.getState().entriesByPanelId).toBe(before);
  });

  it("refuses args it can't hold, leaving the waiting request in place", () => {
    const { publish } = usePluginPanelOpenRequestStore.getState();
    publish("p1", { path: "/a" });
    const waiting = entryOf("p1")!.request;
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;

    expect(publish("p1", cyclic)).toBe(false);
    expect(publish("p1", { blob: "é".repeat(40 * 1024) })).toBe(false);
    expect(entryOf("p1")?.request).toBe(waiting);
  });

  it("clears a closed panel, and a later ack for it does not bring it back", () => {
    const { publish, markDelivered, clearPanel } = usePluginPanelOpenRequestStore.getState();
    publish("p1", { path: "/a" });
    const { seq } = entryOf("p1")!.request;

    clearPanel("p1");
    markDelivered("p1", seq);

    expect(entryOf("p1")).toBeUndefined();
    expect(readDeliveredOpenRequestSeq("p1")).toBe(0);
  });

  it("never reuses a seq for a panel cleared and published again", () => {
    const { publish, clearPanel } = usePluginPanelOpenRequestStore.getState();
    publish("p1", { path: "/a" });
    const before = entryOf("p1")!.request.seq;
    clearPanel("p1");

    publish("p1", { path: "/a" });

    expect(entryOf("p1")!.request.seq).toBeGreaterThan(before);
  });
});
