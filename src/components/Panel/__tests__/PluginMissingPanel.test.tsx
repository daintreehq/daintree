// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { PluginMissingPanel } from "../PluginMissingPanel";

describe("PluginMissingPanel", () => {
  it("shows the plugin name from pluginId when provided", () => {
    render(
      <PluginMissingPanel kind="my-plugin.custom-panel" pluginId="my-plugin" onRemove={() => {}} />
    );
    expect(screen.getByText("my-plugin")).toBeDefined();
    expect(screen.getByText("Plugin unavailable")).toBeDefined();
  });

  it("falls back to the first dotted segment of kind when pluginId is absent", () => {
    render(<PluginMissingPanel kind="legacy-plugin.panel" onRemove={() => {}} />);
    expect(screen.getByText("legacy-plugin")).toBeDefined();
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
});
