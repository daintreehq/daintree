// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";

vi.mock("@/services/ActionService", () => ({
  actionService: {
    dispatch: vi.fn(),
  },
}));

import { ForgeTokenBanner } from "../ForgeTokenBanner";
import { useForgeProviderHealthStore } from "@/store/forgeProviderHealthStore";
import { usePluginRuntimeStore } from "@/store/pluginRuntimeStore";
import { actionService } from "@/services/ActionService";

const PROVIDER_ID = "daintree.github.github";
const PLUGIN_ID = "daintree.github";

beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

function setUnhealthy(value: boolean, opts?: { reauthUrl?: string }) {
  const store = useForgeProviderHealthStore.getState();
  store.setTokenUnhealthy(
    PROVIDER_ID,
    value,
    value
      ? { status: "unhealthy", tokenVersion: 0, checkedAt: 0, reauthUrl: opts?.reauthUrl }
      : undefined
  );
  store.setProviderMeta(PROVIDER_ID, { providerName: "GitHub", pluginId: PLUGIN_ID });
}

describe("ForgeTokenBanner", () => {
  beforeEach(() => {
    useForgeProviderHealthStore.setState({ providers: {} });
    usePluginRuntimeStore.setState({ disabledPluginIds: new Set<string>() });
    vi.mocked(actionService.dispatch).mockClear();
    cleanup();
  });

  it("renders nothing when every provider's token is healthy", () => {
    const { container } = render(<ForgeTokenBanner />);
    expect(container.firstChild).toBeNull();
  });

  it("renders a provider-named banner when a token is unhealthy", () => {
    setUnhealthy(true);
    render(<ForgeTokenBanner />);
    const region = screen.getByRole("status");
    expect(region.hasAttribute("aria-live")).toBe(false);
    expect(screen.getByText("GitHub token expired")).toBeTruthy();
    expect(screen.getByText("Reconnect to restore issue, PR, and repository data.")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Reconnect to GitHub/i })).toBeTruthy();
  });

  it("routes reconnect through the settings action to the provider's subtab", () => {
    setUnhealthy(true);
    const dispatchEventSpy = vi.spyOn(window, "dispatchEvent");

    render(<ForgeTokenBanner />);
    fireEvent.click(screen.getByRole("button", { name: /Reconnect to GitHub/i }));

    expect(actionService.dispatch).toHaveBeenCalledOnce();
    expect(actionService.dispatch).toHaveBeenCalledWith(
      "app.settings.openTab",
      { tab: "code-forge", subtab: PROVIDER_ID },
      { source: "user" }
    );
    // The legacy raw CustomEvent path must be gone — no settings event fired.
    expect(
      dispatchEventSpy.mock.calls.some(([event]) => event.type === "daintree:open-settings-tab")
    ).toBe(false);

    dispatchEventSpy.mockRestore();
  });

  it("offers a reauthorization action when the provider reported a reauthUrl", () => {
    setUnhealthy(true, { reauthUrl: "https://example.com/sso" });
    render(<ForgeTokenBanner />);

    fireEvent.click(screen.getByRole("button", { name: /Open reauthorization page/i }));
    expect(actionService.dispatch).toHaveBeenCalledWith(
      "system.openExternal",
      { url: "https://example.com/sso" },
      { source: "user" }
    );
  });

  it("omits the reauthorization action when no reauthUrl was observed", () => {
    setUnhealthy(true);
    render(<ForgeTokenBanner />);
    expect(screen.queryByRole("button", { name: /Open reauthorization page/i })).toBeNull();
  });

  it("renders nothing while the provider's owning plugin is disabled", () => {
    setUnhealthy(true);
    usePluginRuntimeStore.setState({ disabledPluginIds: new Set([PLUGIN_ID]) });
    const { container } = render(<ForgeTokenBanner />);
    expect(container.firstChild).toBeNull();
  });

  it("dismisses on the close button and stays hidden while still unhealthy", () => {
    setUnhealthy(true);
    const { container } = render(<ForgeTokenBanner />);
    expect(container.firstChild).not.toBeNull();

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: /Dismiss GitHub token warning/i }));
    });
    expect(container.firstChild).toBeNull();
    // Token is still unhealthy — dismissal only hides the banner, it does not
    // claim the token recovered.
    expect(useForgeProviderHealthStore.getState().providers[PROVIDER_ID]?.tokenUnhealthy).toBe(
      true
    );
  });

  it("re-surfaces after a fresh expiry following a dismissal", () => {
    setUnhealthy(true);
    const { container } = render(<ForgeTokenBanner />);
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: /Dismiss GitHub token warning/i }));
    });
    expect(container.firstChild).toBeNull();

    // Recovery then a new expiry must show the banner again.
    act(() => {
      setUnhealthy(false);
      setUnhealthy(true);
    });
    expect(container.firstChild).not.toBeNull();
  });

  it("hides automatically when the slice transitions back to healthy", () => {
    setUnhealthy(true);
    const { container } = render(<ForgeTokenBanner />);
    expect(container.firstChild).not.toBeNull();

    act(() => {
      setUnhealthy(false);
    });
    expect(container.firstChild).toBeNull();
  });
});
