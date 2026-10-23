// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PluginCapabilityConfirmDialog, restoreTitleFor } from "../PluginCapabilityConfirmDialog";
import { CAPABILITY_META } from "../capabilityMeta";
import {
  __resetPluginCapabilityConfirmStoreForTesting,
  requestPluginCapabilityConsent,
  usePluginCapabilityConfirmStore,
} from "@/store/pluginCapabilityConfirmStore";

vi.mock("zustand/react/shallow", () => ({
  useShallow: (fn: unknown) => fn,
}));
vi.mock("@/store", () => ({
  usePortalStore: () => ({ isOpen: false, width: 0 }),
}));
vi.mock("@/store/portalStore", () => ({ usePortalStore: () => ({ isOpen: false, width: 0 }) }));
vi.mock("@/hooks", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, useOverlayState: () => {} };
});
vi.mock("@/hooks/useOverlayState", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/useOverlayState")>()),
  useOverlayState: () => {},
}));
vi.mock("@/hooks/useAnimatedPresence", () => ({
  useAnimatedPresence: ({ isOpen }: { isOpen: boolean }) => ({
    isVisible: isOpen,
    shouldRender: isOpen,
  }),
}));
vi.mock("@/hooks/useHostConnection", () => ({
  useHostConnection: () => ({ hostId: null, hostName: null }),
}));

vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
);

function offer(requestId: string) {
  return requestPluginCapabilityConsent({
    requestId,
    pluginId: "acme.grid",
    pluginDisplayName: "Agent Grid",
    restore: ["terminal:read", "project:dispatch", "panel-attention"],
    declaredCapabilities: ["terminal:read", "project:dispatch"],
  });
}

afterEach(() => {
  act(() => __resetPluginCapabilityConfirmStoreForTesting());
  cleanup();
});

describe("PluginCapabilityConfirmDialog — offer-back after a replacing install (#14019)", () => {
  it("lists every permission it would restore, the attention switch included", () => {
    act(() => {
      void offer("restore-1");
    });
    render(<PluginCapabilityConfirmDialog />);

    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByText(restoreTitleFor("Agent Grid"))).toBeTruthy();
    expect(screen.getByText(CAPABILITY_META["terminal:read"].label)).toBeTruthy();
    expect(screen.getByText(CAPABILITY_META["project:dispatch"].label)).toBeTruthy();
    expect(screen.getByText("Show in attention views")).toBeTruthy();
  });

  it("answers approved-and-pin on restore and rejected when left off, then moves on", async () => {
    let first!: ReturnType<typeof offer>;
    let second!: ReturnType<typeof offer>;
    act(() => {
      first = offer("restore-1");
      second = offer("restore-2");
    });
    render(<PluginCapabilityConfirmDialog />);

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Restore permissions" }));
    });
    await expect(first).resolves.toBe("approved-and-pin");
    expect(usePluginCapabilityConfirmStore.getState().current?.requestId).toBe("restore-2");

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Leave off" }));
    });
    await expect(second).resolves.toBe("rejected");
    expect(usePluginCapabilityConfirmStore.getState().current).toBeNull();
  });
});
