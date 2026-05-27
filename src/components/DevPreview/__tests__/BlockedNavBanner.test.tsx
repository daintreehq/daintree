// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// Render the overflow popover open so demoted items are queryable.
vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverAnchor: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverTrigger: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
  PopoverContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="overflow-content">{children}</div>
  ),
}));

import { BlockedNavBanner } from "../BlockedNavBanner";

type Phase =
  | "blocked"
  | "oauth-started"
  | "oauth-intercepting"
  | "oauth-completed"
  | "oauth-timed-out"
  | "oauth-error";

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

beforeEach(() => {
  (window as unknown as { electron: unknown }).electron = {
    webview: {
      onOAuthLoopbackStatus: vi.fn(() => () => {}),
      cancelOAuthLoopback: vi.fn().mockResolvedValue(undefined),
    },
    clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
    system: { openExternal: vi.fn() },
  };
});

function renderPhase(phase: Phase, extra: Partial<Record<string, unknown>> = {}) {
  const state = {
    url: "https://accounts.example.com/o/oauth2/auth",
    canOpenExternal: false,
    sessionStorageSnapshot: [],
    isOAuth: true,
    registrableDomain: "example.com",
    phase,
    errorMessage: phase === "oauth-error" ? "Sign-in failed" : null,
    ...extra,
  };
  return render(
    <BlockedNavBanner
      state={state as never}
      panelId="p-1"
      webviewElement={null as never}
      onDispatch={vi.fn()}
    />
  );
}

describe("BlockedNavBanner action selection", () => {
  it("renders the phase-specific 'Sign in via browser' action for a blocked OAuth nav", () => {
    renderPhase("blocked", { isOAuth: true });
    // Regression guard: the phase action must not be dropped in favour of Copy URL.
    expect(screen.getByRole("button", { name: /sign in via browser/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /copy url/i })).toBeTruthy();
  });

  it("renders 'Open in external browser' for a non-OAuth blocked nav", () => {
    renderPhase("blocked", { isOAuth: false, canOpenExternal: true });
    expect(screen.getByRole("button", { name: /open in external browser/i })).toBeTruthy();
  });

  it("keeps 'Try again' as the primary action on an OAuth error, demoting Copy URL", () => {
    renderPhase("oauth-error");
    const tryAgain = screen.getByRole("button", { name: /try again/i });
    const overflow = screen.getByTestId("overflow-content");
    // The recovery action is the inline primary; Copy URL is demoted.
    expect(overflow.contains(tryAgain)).toBe(false);
    expect(overflow.contains(screen.getByRole("button", { name: /copy url/i }))).toBe(true);
  });
});
