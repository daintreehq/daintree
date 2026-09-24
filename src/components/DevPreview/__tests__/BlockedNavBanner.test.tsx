// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

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
  PopoverTrigger: ({
    children,
    asChild,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & { asChild?: boolean }) =>
    asChild ? <>{children}</> : <button {...props}>{children}</button>,
  PopoverContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="overflow-content">{children}</div>
  ),
}));

import {
  BlockedNavBanner,
  blockedNavReducer,
  type BlockedNavAction,
  type BlockedNavState,
} from "../BlockedNavBanner";

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

const openExternal = vi.fn<(url: string) => Promise<void>>();

beforeEach(() => {
  openExternal.mockReset();
  (window as unknown as { electron: unknown }).electron = {
    webview: {
      onOAuthLoopbackStatus: vi.fn(() => () => {}),
      cancelOAuthLoopback: vi.fn().mockResolvedValue(undefined),
    },
    clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
    system: { openExternal },
  };
});

function renderPhase(phase: Phase, extra: Partial<Record<string, unknown>> = {}) {
  const state = {
    url: "https://accounts.example.com/o/oauth2/auth",
    canOpenExternal: false,
    sessionStorageSnapshot: [],
    isOAuth: true,
    phase,
    errorCause: phase === "oauth-error" ? "failed" : null,
    errorMessage: null,
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

  it("keeps 'Retry' as the primary action on an OAuth error, demoting Copy URL", () => {
    renderPhase("oauth-error");
    const tryAgain = screen.getByRole("button", { name: /^retry$/i });
    const overflow = screen.getByTestId("overflow-content");
    // The recovery action is the inline primary; Copy URL is demoted.
    expect(overflow.contains(tryAgain)).toBe(false);
    expect(overflow.contains(screen.getByRole("button", { name: /copy url/i }))).toBe(true);
  });
});

describe("blockedNavReducer phase coalescing", () => {
  const blocked = (url: string): BlockedNavAction => ({
    type: "BLOCKED",
    url,
    canOpenExternal: true,
    sessionStorageSnapshot: [],
  });

  function phaseAfterSecondBlock(phase: Parameters<typeof reachPhase>[0]) {
    const state = reachPhase(phase);
    return blockedNavReducer(state, blocked("https://example.com/second"))?.phase;
  }

  function reachPhase(phase: Phase) {
    let state = blockedNavReducer(null, blocked("https://accounts.example.com/authorize"));
    if (phase === "blocked") return state;
    state = blockedNavReducer(state, { type: "OAUTH_STARTED" });
    if (phase === "oauth-started") return state;
    if (phase === "oauth-intercepting")
      return blockedNavReducer(state, { type: "OAUTH_TOKEN_INTERCEPTED" });
    if (phase === "oauth-completed") return blockedNavReducer(state, { type: "OAUTH_COMPLETED" });
    if (phase === "oauth-timed-out") return blockedNavReducer(state, { type: "OAUTH_TIMED_OUT" });
    return blockedNavReducer(state, { type: "OAUTH_ERROR", message: "boom" });
  }

  it("keeps a sign-in that is still in flight", () => {
    expect(phaseAfterSecondBlock("oauth-started")).toBe("oauth-started");
    expect(phaseAfterSecondBlock("oauth-intercepting")).toBe("oauth-intercepting");
  });

  // The completed phase carries a dismiss timer (#12002). Inheriting it would
  // let the previous banner's timer tear down a navigation blocked after it.
  it("resets a terminal phase so its dismiss timer cannot close the next block", () => {
    expect(phaseAfterSecondBlock("oauth-completed")).toBe("blocked");
    expect(phaseAfterSecondBlock("oauth-timed-out")).toBe("blocked");
    expect(phaseAfterSecondBlock("oauth-error")).toBe("blocked");
  });

  // Retry and the loopback act on the attempt's own URL and session snapshot,
  // so an unrelated link blocked mid sign-in must not swap them out.
  it("keeps the attempt's URL while a sign-in is in flight", () => {
    for (const phase of ["oauth-started", "oauth-intercepting"] as const) {
      const state = reachPhase(phase);
      expect(blockedNavReducer(state, blocked("https://example.com/second"))).toBe(state);
    }
  });

  it("adopts the new URL once the previous sign-in has settled", () => {
    for (const phase of ["blocked", "oauth-completed", "oauth-timed-out", "oauth-error"] as const) {
      const next = blockedNavReducer(reachPhase(phase), blocked("https://example.com/second"));
      expect(next?.url).toBe("https://example.com/second");
    }
  });

  const ATTEMPT_URL = "https://accounts.example.com/authorize";

  it("lets a dropped-event fallback end an attempt but never rewrite how it ended", () => {
    const failed: BlockedNavAction = {
      type: "OAUTH_RESULT_FAILED",
      url: ATTEMPT_URL,
      timedOut: false,
    };
    expect(blockedNavReducer(reachPhase("oauth-started"), failed)?.phase).toBe("oauth-error");
    expect(
      blockedNavReducer(reachPhase("oauth-intercepting"), {
        type: "OAUTH_RESULT_FAILED",
        url: ATTEMPT_URL,
        timedOut: true,
      })?.phase
    ).toBe("oauth-timed-out");
    for (const phase of ["oauth-completed", "oauth-timed-out", "oauth-error"] as const) {
      expect(blockedNavReducer(reachPhase(phase), failed)?.phase).toBe(phase);
    }
  });
});

describe("blockedNavReducer stale results", () => {
  const blocked = (url: string): BlockedNavAction => ({
    type: "BLOCKED",
    url,
    canOpenExternal: true,
    sessionStorageSnapshot: [],
  });

  // An action awaited on one link must not settle the notice for the next.
  it("ignores a result that belongs to a URL the banner has moved on from", () => {
    const first = "https://docs.example.com/a";
    const newer = blockedNavReducer(
      blockedNavReducer(null, blocked(first)),
      blocked("https://b.example.com/")
    );
    expect(blockedNavReducer(newer, { type: "DISMISS_IF_URL", url: first })).toBe(newer);

    let attempt = blockedNavReducer(null, blocked("https://accounts.example.com/authorize"));
    attempt = blockedNavReducer(attempt, { type: "OAUTH_STARTED" });
    expect(
      blockedNavReducer(attempt, {
        type: "OAUTH_RESULT_FAILED",
        url: "https://other.example.com/authorize",
        timedOut: false,
      })
    ).toBe(attempt);
  });

  it("settles the notice the result belongs to", () => {
    const url = "https://docs.example.com/a";
    expect(
      blockedNavReducer(blockedNavReducer(null, blocked(url)), { type: "DISMISS_IF_URL", url })
    ).toBeNull();
  });
});

const ALL_PHASES: Phase[] = [
  "blocked",
  "oauth-started",
  "oauth-intercepting",
  "oauth-completed",
  "oauth-timed-out",
  "oauth-error",
];

function bannerRoot(container: HTMLElement): HTMLElement {
  const root = container.querySelector<HTMLElement>('[role="status"], [role="alert"]');
  if (!root) throw new Error("banner did not render a live region");
  return root;
}

describe("BlockedNavBanner phase presentation", () => {
  // An assertive interruption is for something that went wrong; progress and
  // a finished sign-in wait for a pause (WCAG 4.1.3).
  it("interrupts only for failures", () => {
    for (const phase of ALL_PHASES) {
      const { container, unmount } = renderPhase(phase);
      const isFailure = phase === "oauth-timed-out" || phase === "oauth-error";
      expect(bannerRoot(container).getAttribute("role")).toBe(isFailure ? "alert" : "status");
      unmount();
    }
  });

  // A phase the user cannot tell from its neighbour is a phase with no message.
  it("gives every phase its own title", () => {
    const titles = ALL_PHASES.map((phase) => {
      const { container, unmount } = renderPhase(phase);
      const title = bannerRoot(container).querySelector(".font-medium")?.textContent ?? "";
      unmount();
      return title;
    });
    expect(titles.every(Boolean)).toBe(true);
    expect(new Set(titles).size).toBe(titles.length);
  });

  // A title must never repeat an action on the same banner: a state that reads
  // like an instruction is how the old started phase looked like its own button.
  it("never titles a phase with one of its own action labels", () => {
    for (const phase of ALL_PHASES) {
      const { container, unmount } = renderPhase(phase);
      const root = bannerRoot(container);
      const title = root.querySelector(".font-medium")?.textContent?.trim().toLowerCase();
      const labels = Array.from(root.querySelectorAll("button")).map((b) =>
        (b.getAttribute("aria-label") ?? b.textContent ?? "").trim().toLowerCase()
      );
      expect(labels).not.toContain(title);
      unmount();
    }
  });
});

describe("BlockedNavBanner destination naming", () => {
  function titleFor(url: string, isOAuth = false): string {
    const { container, unmount } = renderPhase("blocked", {
      url,
      isOAuth,
      canOpenExternal: true,
    });
    const title = bannerRoot(container).querySelector(".font-medium")?.textContent ?? "";
    unmount();
    return title;
  }

  it("names a web destination by its whole host, never a guessed suffix", () => {
    for (const url of [
      "https://shop.example.co.uk/basket",
      "https://orchid.github.io/docs",
      "https://accounts.google.com/o/oauth2/auth",
    ]) {
      expect(titleFor(url)).toContain(new URL(url).host);
    }
  });

  it("names a custom-scheme destination by its scheme, not its first path word", () => {
    const title = titleFor("slack://open?team=T1");
    expect(title).toContain("slack:");
  });
});

describe("BlockedNavBanner action feedback", () => {
  const linkState = (url: string): BlockedNavState => ({
    url,
    canOpenExternal: true,
    sessionStorageSnapshot: [],
    isOAuth: false,
    phase: "blocked",
    errorCause: null,
    errorMessage: null,
  });

  function deferred() {
    let reject!: (err: Error) => void;
    const promise = new Promise<void>((_, r) => {
      reject = r;
    });
    return { promise, reject };
  }

  // Asking for the system browser and not getting it is a failure of the
  // user's own action: it interrupts, and copying is the one way left.
  it("turns a refused open into an error whose recovery is copying", async () => {
    const open = deferred();
    openExternal.mockImplementation(() => open.promise);
    const { container } = render(
      <BlockedNavBanner
        state={linkState("https://docs.example.com/a")}
        panelId="p-1"
        webviewElement={null}
        onDispatch={vi.fn()}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: /open in external browser/i }));
    await act(async () => {
      open.reject(new Error("no handler"));
      await open.promise.catch(() => {});
    });
    const root = bannerRoot(container);
    expect(root.getAttribute("role")).toBe("alert");
    const labels = Array.from(root.querySelectorAll("button")).map((b) =>
      (b.getAttribute("aria-label") ?? b.textContent ?? "").trim()
    );
    expect(labels.some((l) => /open in external browser/i.test(l))).toBe(false);
    expect(labels.some((l) => /copy url/i.test(l))).toBe(true);
  });

  // A result awaited on one link must not describe the link that replaced it.
  it("never shows a late result against a different link", async () => {
    const open = deferred();
    openExternal.mockImplementation(() => open.promise);
    const props = { panelId: "p-1", webviewElement: null, onDispatch: vi.fn() };
    const { container, rerender } = render(
      <BlockedNavBanner state={linkState("https://a.example.com/")} {...props} />
    );
    fireEvent.click(screen.getByRole("button", { name: /open in external browser/i }));
    rerender(<BlockedNavBanner state={linkState("https://b.example.com/")} {...props} />);
    await act(async () => {
      open.reject(new Error("no handler"));
      await open.promise.catch(() => {});
    });
    expect(bannerRoot(container).getAttribute("role")).toBe("status");
    expect(bannerRoot(container).textContent).toContain("b.example.com");
  });
});
