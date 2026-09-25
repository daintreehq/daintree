// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { PluginMissingPanel } from "../PluginMissingPanel";

const placeholderMock = vi.hoisted(() => vi.fn());
vi.mock("@/components/Plugin/PluginNotOnHostPlaceholder", () => ({
  PluginNotOnHostPlaceholder: (props: {
    pluginId: string;
    kind?: string;
    onRemove?: () => void;
  }) => {
    placeholderMock(props);
    return (
      <div data-testid="plugin-not-on-host">
        <button type="button" onClick={props.onRemove}>
          remove {props.pluginId}
        </button>
      </div>
    );
  },
}));

afterEach(() => {
  delete (window as { __DAINTREE_HOST_ID__?: unknown }).__DAINTREE_HOST_ID__;
  placeholderMock.mockClear();
});

describe("PluginMissingPanel", () => {
  it("shows the plugin name from pluginId when provided", () => {
    render(
      <PluginMissingPanel kind="my-plugin.custom-panel" pluginId="my-plugin" onRemove={() => {}} />
    );
    expect(screen.getByText("my-plugin")).toBeDefined();
    expect(screen.getByText("Plugin unavailable")).toBeDefined();
  });

  it("recovers an unscoped plugin name from kind when pluginId is absent", () => {
    render(<PluginMissingPanel kind="legacy-plugin.panel" onRemove={() => {}} />);
    expect(screen.getByText("legacy-plugin")).toBeDefined();
  });

  it("recovers a dotted manifest id from kind rather than its first segment", () => {
    render(<PluginMissingPanel kind="daintree.github.prs" onRemove={() => {}} />);
    expect(screen.getByText("daintree.github")).toBeDefined();
  });

  it("recovers the manifest id from a project-qualified kind", () => {
    render(
      <PluginMissingPanel kind="project:project-7/acme.dashboard/overview" onRemove={() => {}} />
    );
    expect(screen.getByText("acme.dashboard")).toBeDefined();
  });

  it("falls back to the full kind string when there is no dot", () => {
    render(<PluginMissingPanel kind="singleword" onRemove={() => {}} />);
    expect(screen.getByText("singleword")).toBeDefined();
  });

  it("invokes onRemove when the Remove panel button is clicked", () => {
    const onRemove = vi.fn();
    render(<PluginMissingPanel kind="plug.panel" pluginId="plug" onRemove={onRemove} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove panel" }));
    expect(onRemove).toHaveBeenCalledOnce();
  });

  it("is composed from the EmptyState and Button primitives", () => {
    const { container } = render(
      <PluginMissingPanel kind="plug.panel" pluginId="plug" onRemove={() => {}} />
    );
    expect(container.querySelector("[data-empty-state-icon]")).not.toBeNull();
    expect(
      screen.getByRole("button", { name: "Remove panel" }).getAttribute("data-variant")
    ).not.toBeNull();
  });

  it("scrolls rather than clips when the pane is shorter than the explanation", () => {
    render(<PluginMissingPanel kind="plug.panel" pluginId="plug" onRemove={() => {}} />);
    const region = screen.getByRole("region", { name: "Plugin unavailable" });
    expect(region.className).toMatch(/overflow-y-auto/);
  });

  describe("in a window attached to another machine", () => {
    it("offers the host placeholder instead, naming the plugin recovered from the kind", () => {
      window.__DAINTREE_HOST_ID__ = { id: "studio-01" };
      const onRemove = vi.fn();
      render(
        <PluginMissingPanel kind="project:project-7/acme.dashboard/overview" onRemove={onRemove} />
      );
      expect(screen.queryByText("Plugin unavailable")).toBeNull();
      expect(placeholderMock).toHaveBeenCalledWith({
        pluginId: "acme.dashboard",
        kind: "project:project-7/acme.dashboard/overview",
        onRemove,
      });
      fireEvent.click(screen.getByRole("button", { name: "remove acme.dashboard" }));
      expect(onRemove).toHaveBeenCalledOnce();
    });

    it("prefers the explicit plugin id", () => {
      window.__DAINTREE_HOST_ID__ = { id: "studio-01" };
      render(<PluginMissingPanel kind="plug.panel" pluginId="plug" onRemove={() => {}} />);
      expect(placeholderMock.mock.calls[0]![0]).toMatchObject({ pluginId: "plug" });
    });

    it("keeps the local placeholder for a window on this machine", () => {
      window.__DAINTREE_HOST_ID__ = { id: "local" };
      render(<PluginMissingPanel kind="plug.panel" pluginId="plug" onRemove={() => {}} />);
      expect(screen.getByText("Plugin unavailable")).toBeDefined();
      expect(placeholderMock).not.toHaveBeenCalled();
    });
  });
});
