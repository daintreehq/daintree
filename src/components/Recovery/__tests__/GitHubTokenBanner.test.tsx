// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";

vi.mock("@/services/ActionService", () => ({
  actionService: {
    dispatch: vi.fn(),
  },
}));

import { GitHubTokenBanner } from "../GitHubTokenBanner";
import { useGitHubTokenHealthStore } from "@/store/githubTokenHealthStore";
import { actionService } from "@/services/ActionService";
import { BUILTIN_GITHUB_PROVIDER_ID } from "@shared/utils/forgeProviderIds";

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

describe("GitHubTokenBanner", () => {
  beforeEach(() => {
    useGitHubTokenHealthStore.setState({ isUnhealthy: false });
    vi.mocked(actionService.dispatch).mockClear();
    cleanup();
  });

  it("renders nothing when token is healthy", () => {
    const { container } = render(<GitHubTokenBanner />);
    expect(container.firstChild).toBeNull();
  });

  it("renders banner when token is unhealthy", () => {
    useGitHubTokenHealthStore.setState({ isUnhealthy: true });
    render(<GitHubTokenBanner />);
    const region = screen.getByRole("status");
    expect(region.hasAttribute("aria-live")).toBe(false);
    expect(screen.getByText("GitHub token expired")).toBeTruthy();
    expect(screen.getByText("Reconnect to restore issue, PR, and repository data.")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Reconnect to GitHub/i })).toBeTruthy();
  });

  it("routes reconnect through the settings action with the token sectionId", () => {
    useGitHubTokenHealthStore.setState({ isUnhealthy: true });
    const dispatchEventSpy = vi.spyOn(window, "dispatchEvent");

    render(<GitHubTokenBanner />);
    fireEvent.click(screen.getByRole("button", { name: /Reconnect to GitHub/i }));

    expect(actionService.dispatch).toHaveBeenCalledOnce();
    expect(actionService.dispatch).toHaveBeenCalledWith(
      "app.settings.openTab",
      { tab: "code-forge", subtab: BUILTIN_GITHUB_PROVIDER_ID, sectionId: "github-token" },
      { source: "user" }
    );
    // The legacy raw CustomEvent path must be gone — no settings event fired.
    expect(
      dispatchEventSpy.mock.calls.some(([event]) => event.type === "daintree:open-settings-tab")
    ).toBe(false);

    dispatchEventSpy.mockRestore();
  });

  it("dismisses on the close button and stays hidden while still unhealthy", () => {
    useGitHubTokenHealthStore.setState({ isUnhealthy: true });
    const { container } = render(<GitHubTokenBanner />);
    expect(container.firstChild).not.toBeNull();

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: /Dismiss GitHub token warning/i }));
    });
    expect(container.firstChild).toBeNull();
    // Token is still unhealthy — dismissal only hides the banner, it does not
    // claim the token recovered.
    expect(useGitHubTokenHealthStore.getState().isUnhealthy).toBe(true);
  });

  it("re-surfaces after a fresh expiry following a dismissal", () => {
    useGitHubTokenHealthStore.setState({ isUnhealthy: true });
    const { container } = render(<GitHubTokenBanner />);
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: /Dismiss GitHub token warning/i }));
    });
    expect(container.firstChild).toBeNull();

    // Recovery then a new expiry must show the banner again.
    act(() => {
      useGitHubTokenHealthStore.getState().setUnhealthy(false);
      useGitHubTokenHealthStore.getState().setUnhealthy(true);
    });
    expect(container.firstChild).not.toBeNull();
  });

  it("hides automatically when store transitions back to healthy", () => {
    useGitHubTokenHealthStore.setState({ isUnhealthy: true });
    const { container } = render(<GitHubTokenBanner />);
    expect(container.firstChild).not.toBeNull();

    act(() => {
      useGitHubTokenHealthStore.setState({ isUnhealthy: false });
    });
    expect(container.firstChild).toBeNull();
  });
});
