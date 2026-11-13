// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PluginCapabilityConfirmDialog,
  presetLaunchTitleFor,
} from "../PluginCapabilityConfirmDialog";
import type { PluginPresetLaunchSummary } from "@shared/utils/agentPresetLaunchConsent";
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

const summary: PluginPresetLaunchSummary = {
  agentId: "claude",
  agentName: "Claude",
  presetId: "zai",
  presetName: "Z.ai",
  source: "project",
  args: ["--model", "glm"],
  dangerousMode: "inherit",
  skipsPermissions: true,
  envNames: ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"],
  fallbacks: [
    {
      presetName: "Backup",
      args: ["--fast"],
      dangerousMode: "on",
      skipsPermissions: true,
      envNames: ["BACKUP_KEY"],
    },
  ],
  fallbackOnRateLimit: true,
  accountName: "Work",
  customFlags: "--verbose",
};

function ask(requestId: string, preset = summary) {
  return requestPluginCapabilityConsent({
    requestId,
    pluginId: "digitalfrontier.beads",
    pluginDisplayName: "Beads",
    capability: "agent:launch-preset",
    preset,
    declaredCapabilities: ["agent:launch-preset"],
  });
}

afterEach(() => {
  act(() => __resetPluginCapabilityConfirmStoreForTesting());
  cleanup();
  vi.useRealTimers();
});

describe("PluginCapabilityConfirmDialog — launching on a preset (#16324)", () => {
  it("shows what the preset turns on, with env names but no values", () => {
    act(() => {
      void ask("preset-1");
    });
    render(<PluginCapabilityConfirmDialog />);

    const dialog = screen.getByRole("dialog");
    expect(screen.getByText(presetLaunchTitleFor("Beads", summary))).toBeTruthy();
    expect(presetLaunchTitleFor("Beads", summary)).toContain("'Z.ai'");
    expect(presetLaunchTitleFor("Beads", summary)).toContain("Claude");
    const text = dialog.textContent ?? "";
    expect(text).toContain("Work");
    expect(text).toContain("--verbose");
    expect(text).toContain("--model glm");
    expect(text).toContain(".daintree/presets");
    expect(text).toContain("Skipped: from Claude's settings");
    expect(text).toContain("ANTHROPIC_AUTH_TOKEN=••••");
    // A hop runs on the fallback unasked, so what it turns on is shown too.
    expect(text).toContain("falls back to · Backup");
    expect(text).toContain("--fast");
    expect(text).toContain("BACKUP_KEY=••••");
    expect(text).toContain("Skipped: the preset turns bypass on");
  });

  it("answers approved-and-pin on allow and rejected on deny", async () => {
    vi.useFakeTimers();
    let first!: ReturnType<typeof ask>;
    let second!: ReturnType<typeof ask>;
    act(() => {
      first = ask("preset-1");
      second = ask("preset-2", {
        ...summary,
        presetId: "danger",
        presetName: "Danger zone",
        dangerousMode: "on",
        fallbacks: [],
      });
    });
    render(<PluginCapabilityConfirmDialog />);

    const allow = screen.getByRole("button", { name: "Allow and remember" });
    // Held for a read before it can answer.
    expect(allow.getAttribute("aria-disabled")).toBe("true");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_200);
    });
    act(() => {
      allow.focus();
      fireEvent.click(allow);
    });
    await expect(first).resolves.toBe("approved-and-pin");
    // The next prompt doesn't inherit focus on the button that approved the last.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(16);
    });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Deny" }));
    // The next prompt names its own preset, not the one just approved.
    const next = screen.getByRole("dialog").textContent ?? "";
    expect(next).toContain("Danger zone");
    expect(next).toContain("Skipped: the preset turns bypass on");
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    });
    await expect(second).resolves.toBe("rejected");
    expect(usePluginCapabilityConfirmStore.getState().current).toBeNull();
  });
});
