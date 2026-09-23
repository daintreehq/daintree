/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeAll } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import type { ComponentProps, ReactNode } from "react";
import { EnvironmentPopover } from "../EnvironmentPopover";
import { TooltipProvider } from "@/components/ui/tooltip";

vi.mock("react-dom", async () => {
  const actual = await vi.importActual<typeof import("react-dom")>("react-dom");
  return { ...actual, createPortal: (children: ReactNode) => children };
});

vi.mock("@/clients/systemClient", () => ({
  systemClient: { openExternal: vi.fn(() => Promise.resolve()) },
}));

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeAll(() => {
  if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = ResizeObserverStub as typeof ResizeObserver;
  }
});

type Props = ComponentProps<typeof EnvironmentPopover>;

const BASE: Props = {
  worktreeMode: "staging-gpu",
  environmentIcon: "Cpu",
  isLifecycleRunning: false,
  resourceStatusLabel: "ready",
  resourceStatusColor: "green",
  reportedStatus: "ready",
  resourceLastOutput: undefined,
  resourceEndpoint: undefined,
  resourceLastCheckedAt: undefined,
  onCheckResourceStatus: undefined,
};

function renderPopover(overrides: Partial<Props> = {}) {
  return render(
    <TooltipProvider>
      <EnvironmentPopover {...BASE} {...overrides} />
    </TooltipProvider>
  );
}

function trigger(): HTMLButtonElement {
  return screen.getByRole("button", { name: /environment/ }) as HTMLButtonElement;
}

function iconClasses(overrides: Partial<Props>): string {
  const { unmount } = renderPopover(overrides);
  const svg = trigger().querySelector("svg");
  const classes = svg?.getAttribute("class") ?? "";
  unmount();
  return classes;
}

function openPopover(): HTMLElement {
  fireEvent.click(trigger());
  return screen.getByRole("dialog");
}

describe("EnvironmentPopover trigger", () => {
  it("gives failing and starting environments a colour of their own, and keeps healthy neutral", () => {
    const healthy = iconClasses({ resourceStatusColor: "green" });
    const neutral = iconClasses({ resourceStatusColor: "neutral", resourceStatusLabel: "paused" });
    const warning = iconClasses({
      resourceStatusColor: "yellow",
      resourceStatusLabel: "provisioning",
    });
    const failing = iconClasses({ resourceStatusColor: "red", resourceStatusLabel: "unhealthy" });

    // Healthy is not a signal of its own (status-success policy), so it must
    // look exactly like any other neutral state — and both must differ from
    // the states that are worth opening the popover for.
    expect(healthy).toBe(neutral);
    expect(new Set([healthy, warning, failing]).size).toBe(3);
  });

  it("marks a running lifecycle differently from every settled state", () => {
    const running = iconClasses({ isLifecycleRunning: true, resourceStatusColor: "yellow" });
    for (const color of ["green", "yellow", "red", "neutral"] as const) {
      expect(running).not.toBe(iconClasses({ resourceStatusColor: color }));
    }
  });

  it("carries the status in the trigger's accessible name, so colour is never the only cue", () => {
    renderPopover({
      resourceStatusColor: "red",
      resourceStatusLabel: "unhealthy",
      reportedStatus: "unhealthy",
    });
    expect(trigger().getAttribute("aria-label")).toContain("staging-gpu");
    expect(trigger().getAttribute("aria-label")).toContain("unhealthy");
  });

  it("is a real button that opens even when the environment has no status command", () => {
    renderPopover({
      worktreeMode: "edge-lab",
      environmentIcon: undefined,
      resourceStatusLabel: undefined,
      resourceStatusColor: undefined,
      reportedStatus: undefined,
    });
    expect(trigger().tagName).toBe("BUTTON");
    const dialog = openPopover();
    expect(dialog.textContent).toContain("edge-lab");
    expect(dialog.textContent).toMatch(/status command/i);
  });
});

describe("EnvironmentPopover content", () => {
  it("never calls a worktree without a named environment remote", () => {
    renderPopover({ worktreeMode: undefined });
    const dialog = openPopover();
    expect(dialog.textContent).not.toMatch(/remote/i);
    expect(trigger().getAttribute("aria-label")).not.toMatch(/remote/i);
  });

  it("keeps the last check's own status beside its output while another phase runs", () => {
    renderPopover({
      isLifecycleRunning: true,
      lifecycle: { phase: "resource-provision", state: "running", startedAt: Date.now() },
      resourceStatusLabel: "provisioning",
      resourceStatusColor: "yellow",
      reportedStatus: "unhealthy",
      resourceLastOutput: "probe: 503 Service Unavailable",
      resourceLastCheckedAt: Date.now(),
    });
    const dialog = openPopover();
    expect(dialog.textContent).toContain("unhealthy");
    expect(dialog.textContent).toContain("probe: 503 Service Unavailable");
  });

  it("makes long output a named region a keyboard user can reach", () => {
    renderPopover({ resourceLastOutput: "line one\nline two" });
    openPopover();
    const region = screen.getByRole("region", { name: /output/i });
    expect(region.tabIndex).toBe(0);
  });

  it("hides output that only repeats the status and endpoint, and keeps anything more", () => {
    const { unmount } = renderPopover({
      resourceLastOutput: JSON.stringify({ status: "ready", endpoint: "https://x.dev" }),
      resourceEndpoint: "https://x.dev",
    });
    openPopover();
    expect(screen.queryByRole("region", { name: /output/i })).toBeNull();
    unmount();

    renderPopover({
      resourceLastOutput: JSON.stringify({ status: "ready", meta: { replicas: 2 } }),
    });
    openPopover();
    expect(screen.getByRole("region", { name: /output/i }).textContent).toContain("replicas");
  });

  it("runs one check per press while a check is in flight", async () => {
    let resolveCheck: () => void = () => {};
    const onCheck = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveCheck = resolve;
        })
    );
    renderPopover({ onCheckResourceStatus: onCheck, resourceLastCheckedAt: Date.now() });
    openPopover();
    const button = screen.getByRole("button", { name: /check status/i });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(onCheck).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolveCheck();
    });
    fireEvent.click(button);
    expect(onCheck).toHaveBeenCalledTimes(2);
  });

  it("says how long ago the check ran rather than a bare clock time", () => {
    renderPopover({ resourceLastCheckedAt: Date.now() - 5 * 60_000 });
    const dialog = openPopover();
    const time = dialog.querySelector("time");
    expect(time?.textContent).toMatch(/ago|just now/);
    expect(time?.getAttribute("dateTime")).toBeTruthy();
  });
});
