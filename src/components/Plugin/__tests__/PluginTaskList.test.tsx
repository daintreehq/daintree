// @vitest-environment jsdom

import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { PluginTaskSnapshot } from "@shared/types/plugin";

const client = vi.hoisted(() => ({
  cancelTask: vi.fn(async (_pluginId: string, _taskId: string) => true),
  dismissTask: vi.fn(async (_pluginId: string, _taskId: string) => true),
}));
vi.mock("@/clients", () => ({ pluginClient: client }));

import { PluginTaskList } from "../PluginTaskList";

const wrapper = ({ children }: { children: ReactNode }) => (
  <TooltipProvider>{children}</TooltipProvider>
);

function task(over: Partial<PluginTaskSnapshot> = {}): PluginTaskSnapshot {
  return {
    id: "t-1",
    pluginId: "acme",
    pluginName: "Acme",
    title: "Importing records",
    fraction: null,
    cancellable: true,
    state: "working",
    startedAt: 1,
    ...over,
  };
}

function row(): HTMLElement {
  const item = document.querySelector<HTMLElement>("[data-plugin-task]");
  if (!item) throw new Error("no task row");
  return item;
}

beforeEach(() => {
  client.cancelTask.mockClear();
  client.dismissTask.mockClear();
});

afterEach(() => cleanup());

describe("PluginTaskList", () => {
  it("names the plugin beside its detail and shows a measured share", () => {
    render(<PluginTaskList tasks={[task({ detail: "250 of 1,000", fraction: 0.25 })]} />, {
      wrapper,
    });

    expect(row().textContent).toContain("Acme · 250 of 1,000");
    expect(row().textContent).toContain("25%");
    const bar = screen.getByRole("progressbar");
    expect(bar.getAttribute("aria-valuenow")).toBe("25");
    expect(bar.getAttribute("aria-valuetext")).toBe("25%");
  });

  it("leaves an unmeasured task's bar without a value", () => {
    render(<PluginTaskList tasks={[task()]} />, { wrapper });

    expect(screen.getByRole("progressbar").hasAttribute("aria-valuenow")).toBe(false);
    expect(row().textContent).not.toContain("%");
  });

  it("asks main to cancel, and holds the button inert while it's cancelling", () => {
    const { rerender } = render(<PluginTaskList tasks={[task()]} />, { wrapper });

    fireEvent.click(screen.getByRole("button", { name: "Cancel Importing records" }));
    expect(client.cancelTask).toHaveBeenCalledWith("acme", "t-1");

    rerender(<PluginTaskList tasks={[task({ state: "cancelling" })]} />);
    const button = screen.getByRole("button", { name: "Cancel Importing records" });
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(row().textContent).toContain("Cancelling…");
    fireEvent.click(button);
    expect(client.cancelTask).toHaveBeenCalledTimes(1);
  });

  it("offers no Cancel for a task that didn't allow one", () => {
    render(<PluginTaskList tasks={[task({ cancellable: false })]} />, { wrapper });

    expect(screen.queryByRole("button")).toBeNull();
  });

  it("shows an interrupted task without a bar and lets the user dismiss it", () => {
    render(<PluginTaskList tasks={[task({ state: "interrupted", fraction: 0.5 })]} />, {
      wrapper,
    });

    expect(row().textContent).toContain("Interrupted");
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Cancel/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss Importing records" }));
    expect(client.dismissTask).toHaveBeenCalledWith("acme", "t-1");
  });
});
