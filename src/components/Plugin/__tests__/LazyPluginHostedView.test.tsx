// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
import type { PanelKindConfig } from "@shared/config/panelKindRegistry";

const CONTENT_MODULE = "@/components/Plugin/PluginViewContent";

function surfaceKind(): PanelKindConfig {
  return {
    id: "project:p1/acme.dash/overview",
    name: "Mission Control",
    iconId: "puzzle",
    color: "#ffffff",
    hasPty: false,
    canRestart: false,
    canConvert: false,
    extensionId: "project__p1__acme.dash",
    componentPath: "plugin://acme.dash/1/overview.js",
  };
}

/**
 * Stand the content in for the loader, which does a `plugin://` import over
 * IPC. The hosted-view chunk resolves once this module does, so `gate` holds
 * the chunk back for as long as a test needs.
 */
function mockContent(gate?: Promise<void>): void {
  vi.doMock(CONTENT_MODULE, async () => {
    await gate;
    return {
      makePluginViewContent: () => () => <div data-testid="content" />,
      pluginViewHostContext: (kind: string) => ({ kind }),
    };
  });
}

async function renderSurface() {
  const { LazyPluginHostedView } = await import("../LazyPluginHostedView");
  return render(
    <LazyPluginHostedView
      source={{ from: "panel-kind", config: surfaceKind() }}
      host="surface"
      mountId="surface:overview"
      className="h-full w-full"
      testId="hosted-box"
    />
  );
}

afterEach(() => {
  vi.doUnmock(CONTENT_MODULE);
  vi.resetModules();
});

describe("LazyPluginHostedView (#16802)", () => {
  it("holds the view's own box while the chunk loads, then draws the view in that box", async () => {
    let release!: () => void;
    mockContent(new Promise<void>((resolve) => (release = resolve)));

    await renderSurface();

    const placeholder = screen.getByTestId("hosted-box");
    expect(screen.queryByTestId("content")).toBeNull();
    const placeholderClass = placeholder.className;
    const placeholderStyle = placeholder.getAttribute("style");

    await act(async () => release());

    const content = await screen.findByTestId("content");
    const box = screen.getByTestId("hosted-box");
    expect(box.contains(content)).toBe(true);
    // The same box, sized and contained alike, so the swap moves nothing
    // around it.
    expect(box.className).toBe(placeholderClass);
    expect(box.getAttribute("style")).toBe(placeholderStyle);
  });

  it("draws the view in its first commit once the chunk has loaded", async () => {
    mockContent();
    const { preloadPluginHostedView } = await import("../LazyPluginHostedView");
    await preloadPluginHostedView();

    await renderSurface();

    expect(screen.getByTestId("content")).toBeTruthy();
  });

  it("reports a chunk that fails to load inside the box, where the host's way out still reaches it", async () => {
    vi.doMock(CONTENT_MODULE, () => {
      throw new Error("chunk missing");
    });

    await renderSurface();

    const box = screen.getByTestId("hosted-box");
    expect(await within(box).findByText("Mission Control unavailable")).toBeTruthy();
    expect(screen.queryByTestId("content")).toBeNull();
  });

  it("names a hosted view's own title when its chunk fails to load", async () => {
    vi.doMock(CONTENT_MODULE, () => {
      throw new Error("chunk missing");
    });
    const { LazyPluginHostedView } = await import("../LazyPluginHostedView");

    render(
      <LazyPluginHostedView
        source={{
          from: "hosted",
          view: {
            id: "plugin-view:acme.beads/board",
            pluginId: "acme.beads",
            viewId: "board",
            location: "sidebar",
            name: "Acme Beads Board",
            title: "Board",
            pluginName: "Acme Beads",
            iconId: "list",
            priority: 10,
            componentPath: "plugin://acme.beads/__dtv-1/board.js",
          },
        }}
        host="sidebar"
        mountId="sidebar:board"
        testId="hosted-box"
      />
    );

    const box = screen.getByTestId("hosted-box");
    expect(await within(box).findByText("Acme Beads Board unavailable")).toBeTruthy();
  });
});
