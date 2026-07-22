// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { PLUGIN_ICON_COMPONENTS } from "@/components/icons/pluginIconRegistry";
import type { ToolbarButtonConfig } from "@shared/config/toolbarButtonRegistry";

// Radix primitives and the shortcut hooks aren't under test — the visible
// button's icon resolution is. Mounting the real ones drags in portals,
// keybinding state, and the action registry for no added coverage.
vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("@/components/ui/context-menu", () => ({
  ContextMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ContextMenuContent: () => null,
  ContextMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ContextMenuItem: () => null,
  ContextMenuSeparator: () => null,
  ContextMenuSub: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ContextMenuSubContent: () => null,
  ContextMenuSubTrigger: () => null,
}));

const { PluginToolbarButton } = await import("../Toolbar");

function config(iconId: string): ToolbarButtonConfig {
  return {
    id: "acme.plan" as ToolbarButtonConfig["id"],
    label: "Plan",
    iconId,
    actionId: "acme.plan-from-issue",
    priority: 3,
    pluginId: "acme",
  };
}

function renderButton(iconId: string): string {
  const { container } = render(
    <PluginToolbarButton
      pluginId={"acme.plan" as ToolbarButtonConfig["id"]}
      config={config(iconId)}
    />
  );
  return container.querySelector("svg")!.innerHTML;
}

function registryGlyph(id: keyof typeof PLUGIN_ICON_COMPONENTS): string {
  const Icon = PLUGIN_ICON_COMPONENTS[id];
  return render(<Icon />).container.querySelector("svg")!.innerHTML;
}

describe("PluginToolbarButton", () => {
  it("renders the icon the manifest declared", () => {
    // Before #11298 every plugin toolbar button rendered McpServerIcon and
    // config.iconId was never read.
    expect(renderButton("list")).toBe(registryGlyph("list"));
  });

  it("varies the glyph with iconId, holding every other field fixed", () => {
    expect(renderButton("list")).not.toBe(renderButton("gauge"));
    expect(renderButton("gauge")).toBe(registryGlyph("gauge"));
  });

  it("falls back to the generic plugin glyph for an unrecognized id", () => {
    expect(renderButton("no-such-icon")).toBe(registryGlyph("package"));
  });

  it("does not resolve agent brand ids on the toolbar", () => {
    // The toolbar has no brand-icon path, which is why the CLI warns here.
    expect(renderButton("claude")).toBe(registryGlyph("package"));
  });
});
