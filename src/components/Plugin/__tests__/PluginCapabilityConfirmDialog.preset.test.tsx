// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PluginCapabilityConfirmDialog,
  presetLaunchTitleFor,
} from "../PluginCapabilityConfirmDialog";
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

const summary = {
  agentId: "claude",
  agentName: "Claude",
  presetId: "zai",
  presetName: "Z.ai",
  source: "project" as const,
  args: ["--model", "glm"],
  dangerousMode: "inherit" as const,
  skipsPermissions: true,
  envNames: ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"],
  fallbackNames: ["Backup"],
  fallbackOnRateLimit: true,
};

function ask(requestId: string) {
  return requestPluginCapabilityConsent({
    requestId,
    pluginId: "digitalfrontier.beads",
    pluginDisplayName: "Beads",
    capability: "agent:launch-preset",
    preset: summary,
    declaredCapabilities: ["agent:launch-preset"],
  });
}

afterEach(() => {
  act(() => __resetPluginCapabilityConfirmStoreForTesting());
  cleanup();
});

describe("PluginCapabilityConfirmDialog — launching on a preset (#16324)", () => {
  it("shows what the preset turns on, with env names but no values", () => {
    act(() => {
      void ask("preset-1");
    });
    render(<PluginCapabilityConfirmDialog />);

    const dialog = screen.getByRole("dialog");
    expect(screen.getByText(presetLaunchTitleFor("Beads", summary))).toBeTruthy();
    const text = dialog.textContent ?? "";
    expect(text).toContain("--model glm");
    expect(text).toContain(".daintree/presets");
    expect(text).toContain("Skipped: from Claude's settings");
    expect(text).toContain("ANTHROPIC_AUTH_TOKEN=••••");
    expect(text).toContain("Backup");
  });

  it("answers approved-and-pin on allow and rejected on deny", async () => {
    let first!: ReturnType<typeof ask>;
    let second!: ReturnType<typeof ask>;
    act(() => {
      first = ask("preset-1");
      second = ask("preset-2");
    });
    render(<PluginCapabilityConfirmDialog />);

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Allow and remember" }));
    });
    await expect(first).resolves.toBe("approved-and-pin");
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    });
    await expect(second).resolves.toBe("rejected");
    expect(usePluginCapabilityConfirmStore.getState().current).toBeNull();
  });
});
