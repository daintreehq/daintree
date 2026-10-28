/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";
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

vi.mock("@/lib/notify", () => ({ notify: vi.fn() }));

import { systemClient } from "@/clients/systemClient";
import { notify } from "@/lib/notify";

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

  it("keeps the status word neutral and gives failing and starting results a shape of their own", () => {
    const statusWord = (status: string) => {
      const { unmount } = renderPopover({ reportedStatus: status, resourceStatusLabel: status });
      const dialog = openPopover();
      const word = Array.from(dialog.querySelectorAll("span")).find(
        (el) => el.textContent === status && el.children.length <= 1
      );
      const classes = word?.getAttribute("class") ?? "";
      const glyph = word?.querySelector("svg")?.getAttribute("class") ?? "";
      unmount();
      return { classes, glyph };
    };
    const failing = statusWord("unhealthy");
    const starting = statusWord("provisioning");
    const healthy = statusWord("ready");
    const paused = statusWord("paused");

    // Status hues miss 4.5:1 as text on some themes; the word never wears one.
    for (const { classes } of [failing, starting, healthy, paused]) {
      expect(classes).not.toMatch(/text-status-/);
    }
    expect(failing.glyph).not.toBe("");
    expect(starting.glyph).not.toBe("");
    const shape = (glyph: string) => glyph.match(/lucide-[a-z-]+/g)?.find((c) => c !== "lucide");
    expect(shape(failing.glyph)).not.toBe(shape(starting.glyph));
    expect(healthy.glyph).toBe("");
    expect(paused.glyph).toBe("");
  });

  it("leaves no empty band when only the environment's name is known", () => {
    renderPopover({
      worktreeMode: undefined,
      reportedStatus: undefined,
      resourceStatusLabel: undefined,
      onCheckResourceStatus: vi.fn(),
    });
    const dialog = openPopover();
    expect(dialog.textContent).toContain("Not checked yet");
    for (const section of Array.from(dialog.children)) {
      expect(section.textContent?.trim()).not.toBe("");
    }
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

  it("lands focus on the popover itself, not on a control whose tooltip would cover it", () => {
    renderPopover({ resourceEndpoint: "https://gpu.staging.dev", onCheckResourceStatus: vi.fn() });
    const dialog = openPopover();
    expect(document.activeElement).toBe(dialog);
  });

  it("frees Check status once the host reports the check settled", () => {
    const onCheck = vi.fn();
    for (const state of ["success", "failed", "timed-out"] as const) {
      const { unmount } = renderPopover({
        onCheckResourceStatus: onCheck,
        resourceLastCheckedAt: Date.now(),
        lifecycle: { phase: "resource-status", state, startedAt: Date.now() },
      });
      openPopover();
      fireEvent.click(screen.getByRole("button", { name: /check status/i }));
      unmount();
    }
    expect(onCheck).toHaveBeenCalledTimes(3);
  });

  it("points an environment without a status command at the setting that would add one", () => {
    renderPopover({
      worktreeMode: "edge-lab",
      resourceStatusLabel: undefined,
      resourceStatusColor: undefined,
      reportedStatus: undefined,
    });
    openPopover();
    expect(screen.getByRole("button", { name: /worktree setup/i })).toBeTruthy();
  });

  it("says how long ago the check ran rather than a bare clock time", () => {
    renderPopover({ resourceLastCheckedAt: Date.now() - 5 * 60_000 });
    const dialog = openPopover();
    const time = dialog.querySelector("time");
    expect(time?.textContent).toMatch(/ago|just now/);
    expect(time?.getAttribute("dateTime")).toBeTruthy();
  });

  it("offers the endpoint in the dev preview and closes itself once asked", () => {
    const onPreviewEndpoint = vi.fn();
    renderPopover({ resourceEndpoint: "http://box.example.ts.net:5173", onPreviewEndpoint });
    openPopover();

    fireEvent.click(screen.getByRole("button", { name: "Preview endpoint" }));

    expect(onPreviewEndpoint).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("offers no preview for an endpoint that isn't an http(s) URL, or with nowhere to open it", () => {
    const { unmount } = renderPopover({
      resourceEndpoint: "ssh://box.example.ts.net",
      onPreviewEndpoint: vi.fn(),
    });
    openPopover();
    expect(screen.queryByRole("button", { name: "Preview endpoint" })).toBeNull();
    unmount();

    renderPopover({ resourceEndpoint: "http://box.example.ts.net:5173" });
    openPopover();
    expect(screen.queryByRole("button", { name: "Preview endpoint" })).toBeNull();
    expect(screen.getByRole("button", { name: "Open endpoint in browser" })).toBeTruthy();
  });

  describe("in a view on a remote host", () => {
    const forward = vi.fn();

    function bindToHost() {
      window.__DAINTREE_HOST_ID__ = { id: "build-box" };
      Object.defineProperty(window, "electron", {
        configurable: true,
        writable: true,
        value: { portForwards: { forward } },
      });
    }

    afterEach(() => {
      delete (window as { __DAINTREE_HOST_ID__?: unknown }).__DAINTREE_HOST_ID__;
      delete (window as { electron?: unknown }).electron;
      forward.mockReset();
      vi.mocked(systemClient.openExternal).mockClear();
      vi.mocked(notify).mockClear();
    });

    it("offers no preview, since the host refuses every endpoint session", () => {
      bindToHost();
      renderPopover({
        resourceEndpoint: "http://box.example.ts.net:5173",
        onPreviewEndpoint: vi.fn(),
      });
      openPopover();
      expect(screen.queryByRole("button", { name: "Preview endpoint" })).toBeNull();
      expect(screen.getByRole("button", { name: "Open endpoint in browser" })).toBeTruthy();
    });

    it("forwards a host loopback endpoint's port before opening it here", async () => {
      bindToHost();
      forward.mockResolvedValue({ localPort: 8080 });
      renderPopover({ resourceEndpoint: "http://127.0.0.1:8080" });
      openPopover();

      fireEvent.click(screen.getByRole("button", { name: "Open endpoint in browser" }));

      await waitFor(() => expect(systemClient.openExternal).toHaveBeenCalledTimes(1));
      // Opened outside Daintree, so it is kept while in use rather than until stopped.
      expect(forward).toHaveBeenCalledWith(
        expect.objectContaining({ hostId: "build-box", remotePort: 8080, origin: "oauth-callback" })
      );
      expect(systemClient.openExternal).toHaveBeenCalledWith("http://127.0.0.1:8080/");
    });

    it("opens nothing and says why when the port is taken on this machine", async () => {
      bindToHost();
      forward.mockResolvedValue({ localPort: 8081 });
      renderPopover({ resourceEndpoint: "http://127.0.0.1:8080" });
      openPopover();

      fireEvent.click(screen.getByRole("button", { name: "Open endpoint in browser" }));

      await waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
      expect(systemClient.openExternal).not.toHaveBeenCalled();
      expect(vi.mocked(notify).mock.calls[0]?.[0]).toMatchObject({
        type: "error",
        message: expect.stringContaining("Port 8080 is in use on this machine"),
      });
    });

    it("opens the endpoint once a retry gets the forward through", async () => {
      bindToHost();
      forward.mockRejectedValueOnce(new Error("host gone")).mockResolvedValueOnce({
        localPort: 8080,
      });
      renderPopover({ resourceEndpoint: "http://127.0.0.1:8080" });
      openPopover();

      fireEvent.click(screen.getByRole("button", { name: "Open endpoint in browser" }));
      await waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
      expect(systemClient.openExternal).not.toHaveBeenCalled();

      act(() => void vi.mocked(notify).mock.calls[0]?.[0].action?.onClick());

      await waitFor(() =>
        expect(systemClient.openExternal).toHaveBeenCalledWith("http://127.0.0.1:8080/")
      );
      expect(forward).toHaveBeenCalledTimes(2);
    });

    it("opens a non-loopback endpoint as is, with no forward", async () => {
      bindToHost();
      renderPopover({ resourceEndpoint: "https://gpu.staging.dev" });
      openPopover();

      fireEvent.click(screen.getByRole("button", { name: "Open endpoint in browser" }));

      await waitFor(() =>
        expect(systemClient.openExternal).toHaveBeenCalledWith("https://gpu.staging.dev")
      );
      expect(forward).not.toHaveBeenCalled();
    });
  });

  it("offers to open the worktree on the machine the status named, and closes itself once asked", () => {
    const onOpenOnHost = vi.fn();
    renderPopover({ resourceSsh: "dt-feature-x", onOpenOnHost });
    const dialog = openPopover();

    expect(dialog.textContent).toContain("dt-feature-x");
    fireEvent.click(screen.getByRole("button", { name: "Open on its machine" }));

    expect(onOpenOnHost).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows the machine without the offer where it can't be opened as a host", () => {
    renderPopover({ resourceSsh: "dt-feature-x" });
    const dialog = openPopover();

    expect(dialog.textContent).toContain("dt-feature-x");
    expect(screen.queryByRole("button", { name: "Open on its machine" })).toBeNull();
  });
});
