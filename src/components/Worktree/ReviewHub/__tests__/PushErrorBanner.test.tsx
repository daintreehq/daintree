/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render as rtlRender, screen, cleanup } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { GitOperationReason } from "@shared/types/ipc/errors";
import { PushErrorBanner } from "../PushErrorBanner";
import { PUSH_BANNER_CONFIGS } from "../reviewHubUtils";

afterEach(() => {
  cleanup();
});

const render = (ui: React.ReactElement) => rtlRender(<TooltipProvider>{ui}</TooltipProvider>);

const REASONS = Object.keys(PUSH_BANNER_CONFIGS).filter(
  (r): r is GitOperationReason => r in PUSH_BANNER_CONFIGS
);

function renderBanner(
  reason: GitOperationReason,
  opts: { lease?: boolean; provider?: boolean; behind?: number; rawMessage?: string } = {}
) {
  return render(
    <PushErrorBanner
      pushError={{
        reason,
        rawMessage: opts.rawMessage ?? "remote: error: something the server said",
        ...(opts.lease ? { leaseSha: "4f1c9a2e", branchName: "main" } : {}),
      }}
      behindCount={opts.behind}
      forgeProviderId={opts.provider ? "daintree.github.github" : null}
      showPushDetails={false}
      onToggleDetails={vi.fn()}
      pullRebasing={false}
      onOpenForgeSettings={vi.fn()}
      onRetryPush={vi.fn()}
      onPullRebase={vi.fn()}
      onForcePush={vi.fn()}
      onDismiss={vi.fn()}
    />
  );
}

/** Visual weight of the Button variants the banner may use, lowest first. */
const WEIGHT: Record<string, number> = {
  link: 0,
  ghost: 0,
  "ghost-danger": 0,
  subtle: 1,
  outline: 2,
  secondary: 2,
  default: 3,
  contrast: 3,
  destructive: 3,
};

describe("PushErrorBanner", () => {
  it("never offers a force push in its copy without the control for it", () => {
    for (const reason of REASONS) {
      for (const lease of [false, true]) {
        for (const behind of [undefined, 3]) {
          renderBanner(reason, { lease, behind });
          const banner = screen.getByTestId("review-hub-push-error");
          const hasForcePush = banner.querySelector('[data-cta-kind="force-push"]') !== null;
          if (!hasForcePush) {
            expect(banner.textContent, `${reason} lease=${lease}`).not.toMatch(/force push/i);
          }
          cleanup();
        }
      }
    }
  });

  it("never gives the destructive recovery more weight than the safe fix", () => {
    for (const reason of REASONS) {
      renderBanner(reason, { lease: true, provider: true, behind: 2 });
      const force = screen.queryByTestId("review-hub-push-error-secondary-cta");
      const primary = screen.queryByTestId("review-hub-push-error-cta");
      if (force && primary) {
        const forceWeight = WEIGHT[force.getAttribute("data-variant") ?? ""];
        const primaryWeight = WEIGHT[primary.getAttribute("data-variant") ?? ""];
        expect(forceWeight, reason).toBeDefined();
        expect(primaryWeight, reason).toBeDefined();
        expect(forceWeight, reason).toBeLessThan(primaryWeight!);
      }
      cleanup();
    }
  });

  it("says a confirm follows before force pushing", () => {
    renderBanner("push-rejected-outdated", { lease: true });
    const force = screen.getByTestId("review-hub-push-error-secondary-cta");
    expect(force.getAttribute("data-cta-kind")).toBe("force-push");
    expect(force.textContent).toMatch(/…$/);
    expect(force.getAttribute("aria-haspopup")).toBe("dialog");
  });

  it("carries severity in the glyph and wash, never in the type", () => {
    for (const reason of REASONS) {
      renderBanner(reason, { lease: true, provider: true });
      const banner = screen.getByTestId("review-hub-push-error");
      for (const el of Array.from(banner.querySelectorAll<HTMLElement>("*"))) {
        if (el.closest("svg")) continue;
        const ownText = Array.from(el.childNodes).some(
          (n) => n.nodeType === Node.TEXT_NODE && n.textContent?.trim()
        );
        if (!ownText) continue;
        expect(el.className, `${reason}: "${el.textContent}"`).not.toMatch(/status-|opacity-/);
        expect(el.getAttribute("style") ?? "", reason).not.toMatch(/status-/);
      }
      expect(banner.querySelector("svg[data-severity-glyph]"), reason).not.toBeNull();
      cleanup();
    }
  });

  it("announces a failure once, not again when its supporting copy updates", () => {
    const props = (behind?: number) => (
      <TooltipProvider>
        <PushErrorBanner
          pushError={{ reason: "push-rejected-outdated", rawMessage: "rejected" }}
          behindCount={behind}
          forgeProviderId={null}
          showPushDetails={false}
          onToggleDetails={vi.fn()}
          pullRebasing={false}
          onOpenForgeSettings={vi.fn()}
          onRetryPush={vi.fn()}
          onPullRebase={vi.fn()}
          onForcePush={vi.fn()}
          onDismiss={vi.fn()}
        />
      </TooltipProvider>
    );
    const { rerender } = rtlRender(props(undefined));
    const banner = screen.getByTestId("review-hub-push-error");
    const announced = () =>
      Array.from(
        banner.querySelectorAll(
          '[role="alert"], [aria-live="polite"], [aria-live="assertive"], [role="status"]:not([aria-live="off"])'
        )
      )
        .map((el) => el.textContent)
        .join("|");
    const before = announced();
    const visibleBefore = banner.textContent;
    rerender(props(3));
    // The visible copy did change — the count is useful — but nothing live did.
    expect(banner.textContent).not.toBe(visibleBefore);
    expect(announced()).toBe(before);
    expect(before).toMatch(/Push failed/);
  });

  it("keeps controls and output out of the live announcement", () => {
    renderBanner("hook-rejected", { lease: true });
    const banner = screen.getByTestId("review-hub-push-error");
    const live = Array.from(
      banner.querySelectorAll<HTMLElement>(
        '[role="alert"], [aria-live="polite"], [aria-live="assertive"], [role="status"]:not([aria-live="off"])'
      )
    );
    expect(live.length).toBeGreaterThan(0);
    for (const region of live) {
      expect(region.querySelector("button, pre, [tabindex]")).toBeNull();
    }
  });

  it("titles every failure without terminal punctuation", () => {
    for (const reason of REASONS) {
      renderBanner(reason);
      const visible = screen.getByTestId("review-hub-push-error").querySelector('[role="status"]');
      const title = Array.from(visible!.querySelectorAll("span")).find((el) =>
        /^Push failed/.test(el.textContent ?? "")
      )!;
      expect(title.textContent, reason).not.toMatch(/[.!]$/);
      cleanup();
    }
  });
});
