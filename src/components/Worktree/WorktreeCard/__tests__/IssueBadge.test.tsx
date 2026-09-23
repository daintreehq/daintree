/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { UI_DOHERTY_THRESHOLD } from "@/lib/animationUtils";
import type { IssueTooltipData } from "@shared/types/forge";

vi.mock("react-dom", async () => {
  const actual = await vi.importActual<typeof import("react-dom")>("react-dom");
  return { ...actual, createPortal: (children: ReactNode) => children };
});

let mockMissingCredential = false;
let mockLoading = false;
let mockError = false;
let mockData: IssueTooltipData | null = null;
let mockFreshnessCause: "rate-limit" | "circuit-breaker" | undefined = undefined;
let mockIsOpen = true;

vi.mock("@/hooks/useForgeTooltip", () => ({
  useIssueTooltip: () => ({
    data: mockData,
    loading: mockLoading,
    error: mockError,
    missingCredential: mockMissingCredential,
    providerId: "daintree.github.github",
    fetchTooltip: vi.fn(),
    reset: vi.fn(),
  }),
}));

vi.mock("../hooks/useForgeBadgeTooltip", () => ({
  useForgeBadgeTooltip: () => ({
    isOpen: mockIsOpen,
    handleOpenChange: vi.fn(),
    handleClick: vi.fn(),
  }),
}));

vi.mock("../hooks/useForgeBadgeFreshness", () => ({
  useForgeBadgeFreshness: () => ({
    freshnessLevel: mockFreshnessCause ? "aging" : "fresh",
    freshnessCause: mockFreshnessCause,
    rateLimitResetAt: null,
    now: Date.now(),
  }),
}));

import { IssueBadge } from "../IssueBadge";

const DATA: IssueTooltipData = {
  number: 42,
  title: "Something is broken",
  bodyExcerpt: "Steps to reproduce",
  state: "open",
  rawState: "OPEN",
  createdAt: Date.parse("2026-01-02T00:00:00.000Z"),
  author: { login: "octocat", rawData: null },
  assignees: [],
  labels: [],
};

function badge(extra: Partial<Parameters<typeof IssueBadge>[0]> = {}) {
  return (
    <TooltipProvider>
      <IssueBadge issueNumber={42} worktreePath="/repo" isActive {...extra} />
    </TooltipProvider>
  );
}

function trigger(): HTMLElement {
  return screen.getAllByRole("button")[0]!;
}

beforeEach(() => {
  mockMissingCredential = false;
  mockLoading = false;
  mockError = false;
  mockData = null;
  mockFreshnessCause = undefined;
  mockIsOpen = true;
});

describe("IssueBadge cold-number gap (#8079)", () => {
  beforeEach(() => {
    mockIsOpen = false;
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows the glyph alone inside the window, even across re-renders, then the number", () => {
    const { rerender } = render(badge({ isHeadline: true }));
    expect(trigger().textContent).not.toContain("#42");

    act(() => {
      vi.advanceTimersByTime(UI_DOHERTY_THRESHOLD - 50);
    });
    rerender(badge({ isHeadline: true }));
    expect(trigger().textContent).not.toContain("#42");

    act(() => {
      vi.advanceTimersByTime(50);
    });
    expect(trigger().textContent).toContain("#42");
  });

  it("shows the title straight away when it is already known", () => {
    render(badge({ isHeadline: true, issueTitle: "Something is broken" }));
    expect(trigger().textContent).toContain("Something is broken");
  });
});

describe("IssueBadge trigger", () => {
  it("is aria-disabled only while the card is inactive", () => {
    const { rerender } = render(badge({ isActive: false }));
    expect(trigger().getAttribute("aria-disabled")).toBe("true");
    rerender(badge({ isActive: true }));
    expect(trigger().getAttribute("aria-disabled")).toBeNull();
  });

  it("names the item and its title", () => {
    render(badge({ issueTitle: "Something is broken" }));
    expect(trigger().getAttribute("aria-label")).toBe("Open issue #42: Something is broken");
  });

  it("names the settings route, not the issue, when no token is configured", () => {
    mockMissingCredential = true;
    render(badge({ issueTitle: "Something is broken", isHeadline: true }));
    expect(trigger().getAttribute("aria-label")).toMatch(/access token/);
    // Still a working control, so nothing on it drops to the muted tier, which
    // has no dark-theme contrast floor.
    for (const el of trigger().querySelectorAll("*")) {
      expect(el.getAttribute("class") ?? "").not.toContain("text-text-muted");
    }
  });

  it("adds the paused glyph and dims under a rate limit, and neither without a token", () => {
    const fresh = render(badge({ issueTitle: "T" }));
    const freshClass = trigger().className;
    expect(trigger().querySelector(".lucide-cloud-off")).toBeNull();
    fresh.unmount();

    mockFreshnessCause = "rate-limit";
    const limited = render(badge({ issueTitle: "T" }));
    expect(trigger().querySelector(".lucide-cloud-off")).toBeTruthy();
    expect(trigger().className).not.toBe(freshClass);
    limited.unmount();

    mockMissingCredential = true;
    render(badge({ issueTitle: "T" }));
    expect(trigger().querySelector(".lucide-cloud-off")).toBeNull();
  });
});

describe("IssueBadge hover card", () => {
  it("leads with the identity the badge already knows while details load", () => {
    mockLoading = true;
    render(badge({ issueTitle: "Something is broken" }));
    expect(screen.getAllByText("#42").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Something is broken").length).toBeGreaterThan(0);
  });

  it("offers a retry route when the fetch failed", () => {
    mockError = true;
    render(badge({ issueTitle: "Something is broken" }));
    expect(screen.getAllByText(/Couldn't load details/).length).toBeGreaterThan(0);
  });

  it("shows the token prompt instead of any issue body when no token is configured", () => {
    mockMissingCredential = true;
    mockData = DATA;
    render(badge({ issueTitle: "Something is broken" }));
    expect(screen.getAllByText(/Add a forge access token/).length).toBeGreaterThan(0);
    expect(screen.queryByText("Steps to reproduce")).toBeNull();
  });

  it("renders the loaded issue with its state in words", () => {
    mockData = DATA;
    render(badge({ issueTitle: "Something is broken" }));
    expect(screen.getAllByText("Steps to reproduce").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Open").length).toBeGreaterThan(0);
  });
});
