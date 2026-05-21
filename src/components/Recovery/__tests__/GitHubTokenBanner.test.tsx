// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import { GitHubTokenBanner } from "../GitHubTokenBanner";
import { useGitHubTokenHealthStore } from "@/store/githubTokenHealthStore";

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

  it("dispatches open-settings-tab event when reconnect clicked", () => {
    useGitHubTokenHealthStore.setState({ isUnhealthy: true });
    const listener = vi.fn();
    window.addEventListener("daintree:open-settings-tab", listener as EventListener);

    render(<GitHubTokenBanner />);
    fireEvent.click(screen.getByRole("button", { name: /Reconnect to GitHub/i }));

    expect(listener).toHaveBeenCalledOnce();
    const event = listener.mock.calls[0]![0] as CustomEvent<{ tab: string }>;
    expect(event.detail.tab).toBe("code-forge");

    window.removeEventListener("daintree:open-settings-tab", listener as EventListener);
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
