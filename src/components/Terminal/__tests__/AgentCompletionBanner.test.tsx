// @vitest-environment jsdom
import { beforeAll, describe, it, expect, vi } from "vitest";
import { render as rtlRender, screen, fireEvent, type RenderOptions } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AgentCompletionBanner } from "../AgentCompletionBanner";

// The icon-only "Send to agent" action wraps its button in a Radix Tooltip,
// which requires a TooltipProvider ancestor (supplied app-wide in App.tsx).
function Providers({ children }: { children: ReactNode }) {
  return <TooltipProvider>{children}</TooltipProvider>;
}

function render(ui: ReactElement, options?: Omit<RenderOptions, "wrapper">) {
  return rtlRender(ui, { wrapper: Providers, ...options });
}

vi.mock("@/lib/utils", () => ({
  cn: (...args: unknown[]) => {
    const out: string[] = [];
    const walk = (v: unknown) => {
      if (!v) return;
      if (typeof v === "string" || typeof v === "number") out.push(String(v));
      else if (Array.isArray(v)) for (const item of v) walk(item);
      else if (typeof v === "object")
        for (const [key, val] of Object.entries(v as Record<string, unknown>))
          if (val) out.push(key);
    };
    for (const a of args) walk(a);
    return out.join(" ");
  },
}));

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

describe("AgentCompletionBanner", () => {
  it("renders artifact-first copy with file count and plural noun", () => {
    render(<AgentCompletionBanner fileCount={3} onReview={() => {}} onDismiss={() => {}} />);
    expect(screen.getByText("3 files changed, review when ready")).toBeTruthy();
  });

  it("uses singular 'file' when exactly one file changed", () => {
    render(<AgentCompletionBanner fileCount={1} onReview={() => {}} onDismiss={() => {}} />);
    expect(screen.getByText("1 file changed, review when ready")).toBeTruthy();
  });

  it("falls back to generic copy when fileCount is omitted or zero", () => {
    const { rerender } = render(<AgentCompletionBanner onReview={() => {}} onDismiss={() => {}} />);
    expect(screen.getByText("Files changed, review when ready")).toBeTruthy();

    rerender(<AgentCompletionBanner fileCount={0} onReview={() => {}} onDismiss={() => {}} />);
    expect(screen.getByText("Files changed, review when ready")).toBeTruthy();
  });

  it("invokes onReview when the Review button is clicked", () => {
    const onReview = vi.fn();
    render(<AgentCompletionBanner onReview={onReview} onDismiss={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /review/i }));
    expect(onReview).toHaveBeenCalledTimes(1);
  });

  it("invokes onDismiss when the dismiss button is clicked", () => {
    const onDismiss = vi.fn();
    render(<AgentCompletionBanner onReview={() => {}} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("hides the handoff buttons when their callbacks are omitted", () => {
    render(<AgentCompletionBanner onReview={() => {}} onDismiss={() => {}} />);
    expect(screen.queryByRole("button", { name: /send to assistant/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /send to agent/i })).toBeNull();
  });

  it("renders and fires onSendToAssistant when provided", () => {
    const onSendToAssistant = vi.fn();
    render(
      <AgentCompletionBanner
        onReview={() => {}}
        onDismiss={() => {}}
        onSendToAssistant={onSendToAssistant}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: /send to assistant/i }));
    expect(onSendToAssistant).toHaveBeenCalledTimes(1);
  });

  it("renders and fires onSendToAgent when provided", () => {
    const onSendToAgent = vi.fn();
    render(
      <AgentCompletionBanner
        onReview={() => {}}
        onDismiss={() => {}}
        onSendToAgent={onSendToAgent}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: /send to agent/i }));
    expect(onSendToAgent).toHaveBeenCalledTimes(1);
  });

  it("renders all three action buttons when both handoff callbacks are provided", () => {
    render(
      <AgentCompletionBanner
        onReview={() => {}}
        onDismiss={() => {}}
        onSendToAssistant={() => {}}
        onSendToAgent={() => {}}
      />
    );
    expect(screen.getByRole("button", { name: /review/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /send to assistant/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /send to agent/i })).toBeTruthy();
  });

  it("stops click propagation on all buttons (incl. handoff) so the pane doesn't grab focus", () => {
    const onParentClick = vi.fn();
    const { container } = render(
      <div onClick={onParentClick}>
        <AgentCompletionBanner
          onReview={() => {}}
          onDismiss={() => {}}
          onSendToAssistant={() => {}}
          onSendToAgent={() => {}}
        />
      </div>
    );
    const buttons = container.querySelectorAll("button");
    expect(buttons.length).toBe(4); // review + assistant + agent + dismiss
    buttons.forEach((b) => fireEvent.click(b));
    expect(onParentClick).not.toHaveBeenCalled();
  });

  it("uses neutral surface tokens (no accent color in container)", () => {
    const { container } = render(
      <AgentCompletionBanner onReview={() => {}} onDismiss={() => {}} />
    );
    const root = container.firstElementChild as HTMLElement;
    const cls = root.getAttribute("class")!;
    expect(cls).toContain("bg-overlay-subtle");
    expect(cls).toContain("border-divider");
    expect(cls).not.toContain("text-accent-primary");
    expect(cls).not.toContain("bg-accent-primary");
  });

  it("uses Tier-1 transition-colors on interactive controls (no transition-all)", () => {
    const { container } = render(
      <AgentCompletionBanner onReview={() => {}} onDismiss={() => {}} />
    );
    const buttons = container.querySelectorAll("button");
    buttons.forEach((b) => {
      const cls = b.getAttribute("class")!;
      expect(cls).toContain("transition-colors");
      expect(cls).not.toMatch(/\btransition-all\b/);
    });
  });
});
