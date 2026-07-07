import { describe, expect, it } from "vitest";
import { PaintFabricCompositor } from "../PaintFabricCompositor";
import type { ManagedTerminal } from "../../types";
import { makeSurface } from "./fakePaintPlane";

// Phase 1V sync-read mirrors: the sync half of TerminalPaintPlane (`get`,
// `captureBufferText`, `getAgentState`, `isFocused`, `fit`, `resize`) cannot
// cross a process boundary, so terminals owned by view-hosted surfaces answer
// those calls from compositor-side mirrors — written on control paths and via
// applyMirrorPatch, never per output chunk. Local surfaces keep delegating to
// their plane, byte-identical to the pre-1V path.
function makeCompositor() {
  const local = makeSurface("local");
  const view = makeSurface("view-1", "view");
  const compositor = new PaintFabricCompositor({
    surfaces: [local.surface, view.surface],
    choosePlacement: (terminalId, registry) =>
      registry
        .surfaces()
        .find((s) => s.id === (terminalId.startsWith("v-") ? "view-1" : "local")) ??
      registry.defaultSurface(),
  });
  return { compositor, local: local.plane, view: view.plane };
}

describe("PaintFabricCompositor sync-read mirrors", () => {
  it("answers view-owned sync reads from the mirror, never the plane", async () => {
    const { compositor, view } = makeCompositor();
    await compositor.getOrCreate("v-1", undefined, {});

    compositor.applyMirrorPatch("v-1", {
      agentState: "working",
      focused: true,
      bufferText: "hello world",
    });

    expect(compositor.getAgentState("v-1")).toBe("working");
    expect(compositor.isFocused("v-1")).toBe(true);
    expect(compositor.captureBufferText("v-1")).toBe("hello world");
    expect(view.getAgentState).not.toHaveBeenCalled();
    expect(view.isFocused).not.toHaveBeenCalled();
    expect(view.captureBufferText).not.toHaveBeenCalled();
  });

  it("tail-truncates mirrored buffer text to maxChars like the bare service", async () => {
    const { compositor } = makeCompositor();
    await compositor.getOrCreate("v-1", undefined, {});
    compositor.applyMirrorPatch("v-1", { bufferText: "0123456789" });

    expect(compositor.captureBufferText("v-1", 4)).toBe("6789");
    // Boundary semantics match the bare service: nothing for a non-positive
    // budget (`slice(-0)` would otherwise return the full text).
    expect(compositor.captureBufferText("v-1", 0)).toBe("");
    expect(compositor.captureBufferText("v-1", -5)).toBe("");
  });

  it("drops mirror patches for ids not currently view-owned", async () => {
    const { compositor } = makeCompositor();
    // Unplaced id → default (local) surface owns it → patch dropped.
    compositor.applyMirrorPatch("ghost", { agentState: "working" });
    expect(compositor.getMirrorForTests("ghost")).toBeUndefined();

    // Destroyed view-owned terminal: a late patch must not resurrect state.
    await compositor.getOrCreate("v-1", undefined, {});
    compositor.applyMirrorPatch("v-1", { agentState: "working" });
    compositor.destroy("v-1");
    compositor.applyMirrorPatch("v-1", { agentState: "working" });
    expect(compositor.getMirrorForTests("v-1")).toBeUndefined();
  });

  it("defaults view-owned reads when no mirror state has arrived", async () => {
    const { compositor } = makeCompositor();
    await compositor.getOrCreate("v-1", undefined, {});

    expect(compositor.getAgentState("v-1")).toBeUndefined();
    expect(compositor.isFocused("v-1")).toBe(false);
    expect(compositor.captureBufferText("v-1")).toBe("");
  });

  it("skips undefined fields in a patch so partial pushes never erase state", async () => {
    const { compositor } = makeCompositor();
    await compositor.getOrCreate("v-1", undefined, {});
    compositor.applyMirrorPatch("v-1", { agentState: "working", focused: true });
    compositor.applyMirrorPatch("v-1", { bufferText: "text" });

    expect(compositor.getAgentState("v-1")).toBe("working");
    expect(compositor.isFocused("v-1")).toBe(true);
    expect(compositor.captureBufferText("v-1")).toBe("text");
  });

  it("keeps the mirror fresh from compositor control paths", async () => {
    const { compositor, view } = makeCompositor();
    await compositor.getOrCreate("v-1", undefined, {});

    compositor.setAgentState("v-1", "waiting");
    compositor.setFocused("v-1", true);

    expect(compositor.getAgentState("v-1")).toBe("waiting");
    expect(compositor.isFocused("v-1")).toBe(true);
    // Control writes still forward to the owning plane (the future remote
    // adapter relays them to the surface renderer).
    expect(view.setAgentState).toHaveBeenCalledWith("v-1", "waiting");
    expect(view.setFocused).toHaveBeenCalledWith("v-1", true);
  });

  it("returns null/undefined for cross-process handles on view-owned terminals", async () => {
    const { compositor, view } = makeCompositor();
    await compositor.getOrCreate("v-1", undefined, {});
    view.get.mockReturnValue({ id: "v-1" } as unknown as ManagedTerminal);

    expect(compositor.get("v-1")).toBeNull();
    expect(compositor.getInstanceForE2E("v-1")).toBeUndefined();
    expect(compositor.fit("v-1")).toBeNull();
    expect(compositor.resize("v-1", 800, 600)).toBeNull();
  });

  it("answers the remaining sync reads with safe defaults for view-owned terminals", async () => {
    const { compositor } = makeCompositor();
    await compositor.getOrCreate("v-1", undefined, {});

    expect(compositor.getHoveredLinkText("v-1")).toBeNull();
    expect(compositor.getHoveredFilePath("v-1")).toBeNull();
    expect(compositor.getCachedSelection("v-1")).toBe("");
    expect(compositor.getAttachGeneration("v-1")).toBe(0);
    expect(compositor.getAltBufferState("v-1")).toBe(false);
    expect(compositor.getSynchronizedOutputMode("v-1")).toBeNull();
    expect(compositor.isHibernated("v-1")).toBe(false);
    expect(compositor.isWebGLActive("v-1")).toBe(false);
  });

  it("releases a failed first create's claim on a view surface", async () => {
    const { compositor, view } = makeCompositor();
    view.getOrCreate.mockRejectedValueOnce(new Error("boot failed"));

    await expect(compositor.getOrCreate("v-1", undefined, {})).rejects.toThrow(/boot failed/);
    // Nothing keeps routing to a terminal that never existed; the next
    // create claims cleanly.
    expect(compositor.getRegistryForTests().surfaceFor("v-1")).toBeNull();
  });

  it("keeps the claim when an overlapping create already succeeded on the view surface", async () => {
    const { compositor, view } = makeCompositor();
    let rejectFirst!: (error: Error) => void;
    view.getOrCreate
      .mockImplementationOnce(
        () =>
          new Promise<ManagedTerminal>((_, reject) => {
            rejectFirst = reject;
          })
      )
      .mockImplementationOnce(async (id: string) => ({ id }) as unknown as ManagedTerminal);

    const first = compositor.getOrCreate("v-1", undefined, {});
    const second = compositor.getOrCreate("v-1", undefined, {});
    await second;
    rejectFirst(new Error("aborted"));
    await expect(first).rejects.toThrow(/aborted/);

    // The sibling's success marked the id live in the compositor ledger, so
    // the failed claimant must not strip the live terminal's placement.
    expect(compositor.getRegistryForTests().surfaceFor("v-1")?.id).toBe("view-1");
  });

  it("drops the mirror when a transfer fails after the source was destroyed", async () => {
    const { compositor, local, view } = makeCompositor();
    await compositor.getOrCreate("v-1", undefined, {});
    compositor.applyMirrorPatch("v-1", { agentState: "working", bufferText: "state" });
    local.getOrCreate.mockRejectedValueOnce(new Error("target build failed"));

    await expect(compositor.transferTerminal("v-1", "local")).rejects.toThrow(
      /target build failed/
    );
    // The terminal exists nowhere; stale mirror state must not answer for it.
    expect(compositor.getMirrorForTests("v-1")).toBeUndefined();
    expect(view.destroy).toHaveBeenCalledWith("v-1");
  });

  it("routes DOM attach/detach to the bounds protocol (no-op) for view-owned terminals", async () => {
    const { compositor, view, local } = makeCompositor();
    await compositor.getOrCreate("v-1", undefined, {});
    await compositor.getOrCreate("l-1", undefined, {});
    const container = {} as HTMLElement;

    expect(compositor.attach("v-1", container)).toBeNull();
    compositor.detach("v-1", container);
    expect(view.attach).not.toHaveBeenCalled();
    expect(view.detach).not.toHaveBeenCalled();

    compositor.attach("l-1", container);
    compositor.detach("l-1", container);
    expect(local.attach).toHaveBeenCalledWith("l-1", container);
    expect(local.detach).toHaveBeenCalledWith("l-1", container);
  });

  it("keeps local-owned sync reads delegating to the plane", async () => {
    const { compositor, local } = makeCompositor();
    await compositor.getOrCreate("l-1", undefined, {});
    local.getAgentState.mockReturnValue("idle");
    local.isFocused.mockReturnValue(true);
    local.captureBufferText.mockReturnValue("local text");

    // A stale mirror for a local terminal must not shadow the plane.
    compositor.applyMirrorPatch("l-1", { agentState: "working", bufferText: "stale" });

    expect(compositor.getAgentState("l-1")).toBe("idle");
    expect(compositor.isFocused("l-1")).toBe(true);
    expect(compositor.captureBufferText("l-1")).toBe("local text");
  });

  it("seeds the mirror on transfer to a view surface and drops it on transfer back", async () => {
    const { compositor, local, view } = makeCompositor();
    await compositor.getOrCreate("l-1", undefined, {});
    local.get.mockReturnValue({ id: "l-1" } as unknown as ManagedTerminal);
    local.getAgentState.mockReturnValue("working");
    local.isFocused.mockReturnValue(true);

    const moved = await compositor.transferTerminal("l-1", "view-1");
    expect(moved).toBe(true);
    // Sync reads now answer from the seeded mirror.
    expect(compositor.getAgentState("l-1")).toBe("working");
    expect(compositor.isFocused("l-1")).toBe(true);
    expect(compositor.getMirrorForTests("l-1")).toBeDefined();

    // Moving back to a local surface drops the mirror — the plane is
    // authoritative again.
    const movedBack = await compositor.transferTerminal("l-1", "local");
    expect(movedBack).toBe(true);
    expect(compositor.getMirrorForTests("l-1")).toBeUndefined();
    expect(view.destroy).toHaveBeenCalledWith("l-1");
  });

  it("rebuilds a view-owned terminal on transfer without a liveness probe", async () => {
    const { compositor, view, local } = makeCompositor();
    await compositor.getOrCreate("v-1", undefined, {});
    // A view-hosted plane cannot answer get(); the compositor must not ask.
    view.get.mockImplementation(() => {
      throw new Error("sync get cannot cross a process boundary");
    });

    const moved = await compositor.transferTerminal("v-1", "local");
    expect(moved).toBe(true);
    expect(view.get).not.toHaveBeenCalled();
    expect(local.getOrCreate).toHaveBeenCalledWith(
      "v-1",
      undefined,
      {},
      undefined,
      undefined,
      undefined
    );
  });

  it("clears the mirror on destroy", async () => {
    const { compositor } = makeCompositor();
    await compositor.getOrCreate("v-1", undefined, {});
    compositor.applyMirrorPatch("v-1", { agentState: "working" });

    compositor.destroy("v-1");
    expect(compositor.getMirrorForTests("v-1")).toBeUndefined();
  });

  it("clears every mirror on dispose", async () => {
    const { compositor } = makeCompositor();
    await compositor.getOrCreate("v-1", undefined, {});
    compositor.applyMirrorPatch("v-1", { agentState: "working" });

    compositor.dispose();
    expect(compositor.getMirrorForTests("v-1")).toBeUndefined();
  });
});
