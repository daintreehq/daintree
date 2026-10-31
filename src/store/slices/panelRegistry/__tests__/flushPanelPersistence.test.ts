import { describe, it, expect, vi } from "vitest";

const flushAndSettleMock = vi.hoisted(() => vi.fn<() => Promise<void>>());
vi.mock("../../../persistence/panelPersistence", () => ({
  panelPersistence: { flushAndSettle: flushAndSettleMock },
}));

const { flushPanelPersistence } = await import("../persistence");

describe("flushPanelPersistence (#15651)", () => {
  it("resolves only once the layout writes it started have settled", async () => {
    let release!: () => void;
    flushAndSettleMock.mockReturnValueOnce(new Promise<void>((resolve) => (release = resolve)));

    let settled = false;
    void flushPanelPersistence().then(() => (settled = true));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(flushAndSettleMock).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);

    release();
    await vi.waitFor(() => expect(settled).toBe(true));
  });
});
