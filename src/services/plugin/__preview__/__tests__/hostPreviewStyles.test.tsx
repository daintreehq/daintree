// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "@testing-library/react";
import {
  PLUGIN_STYLE_OWNER_ATTRIBUTE as PREVIEW_OWNER_ATTRIBUTE,
  PREVIEW_THEMES,
  applyPreviewTheme,
  mountPanelStory,
  type MountedPanelPreview,
} from "@daintreehq/plugin-sdk/testing/preview";
import { BUILT_IN_APP_SCHEMES } from "@shared/theme/themes";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";
import { PLUGIN_STYLE_OWNER_ATTRIBUTE } from "@/services/plugin/pluginStyleOwner";
import { createHostPreviewStyles, type HostPreviewStyles } from "../hostPreviewStyles";

let preview: MountedPanelPreview | null = null;
let styles: HostPreviewStyles | null = null;

afterEach(() => {
  if (preview) void act(() => preview?.unmount());
  styles?.dispose();
  preview = null;
  styles = null;
  vi.restoreAllMocks();
  document.body.innerHTML = "";
  document.head.innerHTML = "";
});

function installedCss(): string {
  return document.querySelector("style[data-daintree-plugin-styles]")?.textContent ?? "";
}

function Panel() {
  return <div className="p-3 text-text-primary">Styled by the host</div>;
}

async function mountWithHostStyles(): Promise<HTMLElement> {
  styles = await createHostPreviewStyles(document);
  const container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => {
    preview = mountPanelStory({ component: Panel }, undefined, { container, styles: styles! });
  });
  return container;
}

describe("plugin panel preview styled by the host runtime", () => {
  it("compiles the view's classes through the host's style runtime before it is ready", async () => {
    await mountWithHostStyles();
    await act(async () => {
      expect(await preview!.ready).toEqual({ status: "ready" });
    });
    const css = installedCss();
    expect(css).toContain(".p-3");
    expect(css).toContain(".text-text-primary");
  });

  it("reports failed when the host runtime could not install the styles", async () => {
    // jsdom has no constructable stylesheets, so the runtime installs through a
    // `<style>` element; refusing that write is a failed install.
    const textContent = Object.getOwnPropertyDescriptor(Node.prototype, "textContent")!;
    vi.spyOn(Node.prototype, "textContent", "set").mockImplementation(function (
      this: Node,
      value: string | null
    ) {
      if (this instanceof HTMLStyleElement && this.hasAttribute("data-daintree-plugin-styles")) {
        throw new Error("sink refused the sheet");
      }
      textContent.set!.call(this, value);
    });
    await mountWithHostStyles();
    await act(async () => {
      expect(await preview!.ready).toEqual({
        status: "failed",
        reason: "styles failed to install: rebuild: sink refused the sheet",
      });
    });
  });
});

describe("plugin panel preview stays in step with the app", () => {
  it("applies every built-in theme exactly as the app applies it", () => {
    expect(PREVIEW_THEMES.map((theme) => theme.id)).toEqual(
      BUILT_IN_APP_SCHEMES.map((scheme) => scheme.id)
    );
    for (const scheme of BUILT_IN_APP_SCHEMES) {
      const app = document.createElement("div");
      const previewRoot = document.createElement("div");
      applyAppThemeToRoot(app, scheme);
      applyPreviewTheme(previewRoot, scheme.id);
      expect(previewRoot.getAttribute("style")).toBe(app.getAttribute("style"));
      expect(previewRoot.className).toBe(app.className);
      expect({ ...previewRoot.dataset }).toEqual({ ...app.dataset });
    }
  });

  it("marks the style root's owner with the host's attribute", () => {
    expect(PREVIEW_OWNER_ATTRIBUTE).toBe(PLUGIN_STYLE_OWNER_ATTRIBUTE);
  });
});
