/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { render as rtlRender, screen, fireEvent, cleanup, act } from "@testing-library/react";
import { primeRadix } from "@/components/ui/radix-loader";
import { TooltipProvider } from "@/components/ui/tooltip";

const { dispatch, registered } = vi.hoisted(() => ({
  dispatch: vi.fn(),
  registered: { current: new Map<string, string>() },
}));
const listeners = new Set<() => void>();

vi.mock("@/services/ActionService", () => ({ actionService: { dispatch } }));
vi.mock("@/services/plugin/registeredPluginActions", () => ({
  getRegisteredPluginActionsSnapshot: () => registered.current,
  subscribeToRegisteredPluginActions: (cb: () => void) => {
    listeners.add(cb);
    return () => listeners.delete(cb);
  },
}));
vi.mock("@/hooks/usePluginAttribution", () => ({
  usePluginAttribution: (key: string) => ({ name: `Plugin ${key}` }),
}));

import { PluginReadinessChecks } from "../PluginReadinessChecks";

class StubResizeObserver implements ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeAll(async () => {
  await primeRadix();
});

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", StubResizeObserver);
  registered.current = new Map();
  dispatch.mockReset();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const render = (ui: React.ReactElement) => rtlRender(<TooltipProvider>{ui}</TooltipProvider>);

const plugins = [
  {
    pluginId: "acme.lint",
    checks: [
      {
        label: "3 broken links",
        severity: "warning" as const,
        detail: "in docs/",
        command: "acme.lint.openReport",
      },
      { label: "Schema ok", severity: "info" as const },
    ],
  },
];

describe("PluginReadinessChecks", () => {
  it("renders nothing when no plugin published a check", () => {
    const { container } = render(<PluginReadinessChecks worktreeId="wt-1" plugins={[]} />);
    expect(container.querySelector('[data-testid="plugin-readiness-checks"]')).toBeNull();
  });

  it("lists each check with its severity, label and plugin attribution", () => {
    render(<PluginReadinessChecks worktreeId="wt-1" plugins={plugins} />);
    const rows = screen.getAllByTestId("plugin-readiness-check");
    expect(rows.map((r) => r.getAttribute("data-severity"))).toEqual(["warning", "info"]);
    expect(rows[0]!.textContent).toContain("3 broken links");
    expect(rows[0]!.textContent).toContain("Plugin acme.lint");
  });

  it("shows a command button only once its action is registered, and dispatches with the worktree", () => {
    render(<PluginReadinessChecks worktreeId="wt-1" plugins={plugins} />);
    expect(screen.queryByTestId("plugin-readiness-check-command")).toBeNull();

    act(() => {
      registered.current = new Map([["acme.lint.openReport", "Open report"]]);
      listeners.forEach((cb) => cb());
    });
    const button = screen.getByTestId("plugin-readiness-check-command");
    expect(button.textContent).toBe("Open report");
    fireEvent.click(button);
    expect(dispatch).toHaveBeenCalledWith(
      "acme.lint.openReport",
      { worktreeId: "wt-1" },
      { source: "user" }
    );
  });

  it("hands focus to the list when the focused command button goes", async () => {
    registered.current = new Map([["acme.lint.openReport", "Open report"]]);
    const { rerender } = render(<PluginReadinessChecks worktreeId="wt-1" plugins={plugins} />);
    const button = screen.getByTestId("plugin-readiness-check-command");
    button.focus();
    expect(document.activeElement).toBe(button);

    // The action unregisters while the row stays.
    act(() => {
      registered.current = new Map();
      listeners.forEach((cb) => cb());
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByTestId("plugin-readiness-check-command")).toBeNull();
    expect(document.activeElement).toBe(screen.getByTestId("plugin-readiness-checks"));

    rerender(
      <TooltipProvider>
        <PluginReadinessChecks worktreeId="wt-1" plugins={[]} />
      </TooltipProvider>
    );
  });

  it("keeps a row's identity when an earlier check is removed", () => {
    registered.current = new Map([
      ["acme.lint.a", "Run a"],
      ["acme.lint.b", "Run b"],
    ]);
    const first = {
      pluginId: "acme.lint",
      checks: [
        { label: "A", severity: "info" as const, command: "acme.lint.a" },
        { label: "B", severity: "info" as const, command: "acme.lint.b" },
      ],
    };
    const { rerender } = render(<PluginReadinessChecks worktreeId="wt-1" plugins={[first]} />);
    const buttonB = screen.getAllByTestId("plugin-readiness-check-command")[1]!;
    expect(buttonB.textContent).toBe("Run b");

    rerender(
      <TooltipProvider>
        <PluginReadinessChecks
          worktreeId="wt-1"
          plugins={[{ pluginId: "acme.lint", checks: [first.checks[1]!] }]}
        />
      </TooltipProvider>
    );
    expect(screen.getByTestId("plugin-readiness-check-command")).toBe(buttonB);
  });

  it("never offers another plugin's action", () => {
    registered.current = new Map([["other.plugin.run", "Run"]]);
    render(
      <PluginReadinessChecks
        worktreeId="wt-1"
        plugins={[
          {
            pluginId: "acme.lint",
            checks: [{ label: "x", severity: "info", command: "other.plugin.run" }],
          },
        ]}
      />
    );
    expect(screen.queryByTestId("plugin-readiness-check-command")).toBeNull();
  });
});
