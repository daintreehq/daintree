/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, act, cleanup } from "@testing-library/react";
import { DevServerIndicator } from "../DevServerIndicator";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { DevPreviewSessionState, DevPreviewSessionStatus } from "@shared/types/ipc/devPreview";

function makeSession(
  status: DevPreviewSessionStatus,
  overrides: Partial<DevPreviewSessionState> = {}
): DevPreviewSessionState {
  return {
    panelId: "p1",
    projectId: "proj",
    worktreeId: "w1",
    status,
    url: null,
    predictedUrl: null,
    error: null,
    terminalId: null,
    isRestarting: false,
    generation: 0,
    updatedAt: 1,
    ...overrides,
  };
}

function renderIndicator(session: DevPreviewSessionState | undefined) {
  return render(
    <TooltipProvider>
      <DevServerIndicator session={session} />
    </TooltipProvider>
  );
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("DevServerIndicator", () => {
  it("renders nothing when there is no session", () => {
    renderIndicator(undefined);
    expect(screen.queryByTestId("dev-server-indicator")).toBeNull();
  });

  it.each<DevPreviewSessionStatus>(["stopped", "restored-stopped", "stopping"])(
    "renders nothing for %s",
    (status) => {
      renderIndicator(makeSession(status));
      expect(screen.queryByTestId("dev-server-indicator")).toBeNull();
    }
  );

  it("renders a running indicator with the port and a URL aria-label", () => {
    renderIndicator(makeSession("running", { url: "http://localhost:5173" }));
    const el = screen.getByTestId("dev-server-indicator");
    expect(el.getAttribute("data-dev-server-status")).toBe("running");
    expect(el.textContent).toContain(":5173");
    expect(el.getAttribute("aria-label")).toBe("Dev server running at http://localhost:5173");
  });

  it("renders a running indicator without port text when the URL has no port", () => {
    renderIndicator(makeSession("running", { url: "http://localhost" }));
    const el = screen.getByTestId("dev-server-indicator");
    expect(el.getAttribute("data-dev-server-status")).toBe("running");
    expect(el.textContent).not.toContain(":");
  });

  it("renders an error indicator", () => {
    renderIndicator(makeSession("error", { error: { type: "unknown", message: "boom" } }));
    const el = screen.getByTestId("dev-server-indicator");
    expect(el.getAttribute("data-dev-server-status")).toBe("error");
    expect(el.getAttribute("aria-label")).toBe("Dev server error");
  });

  it("defers the starting spinner until the Doherty threshold elapses", () => {
    vi.useFakeTimers();
    renderIndicator(makeSession("starting"));
    // Sub-400ms: nothing shown (no flicker).
    expect(screen.queryByTestId("dev-server-indicator")).toBeNull();
    act(() => {
      vi.advanceTimersByTime(500);
    });
    const el = screen.getByTestId("dev-server-indicator");
    expect(el.getAttribute("data-dev-server-status")).toBe("starting");
  });

  it("shows the installing spinner after the gate", () => {
    vi.useFakeTimers();
    renderIndicator(makeSession("installing"));
    act(() => {
      vi.advanceTimersByTime(500);
    });
    const el = screen.getByTestId("dev-server-indicator");
    expect(el.getAttribute("data-dev-server-status")).toBe("installing");
    expect(el.getAttribute("aria-label")).toBe("Installing dependencies");
  });
});
