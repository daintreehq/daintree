// @vitest-environment jsdom
import { createElement } from "react";
import { afterEach, describe, it, expect } from "vitest";
import { act, render } from "@testing-library/react";
import { SquareTerminal } from "lucide-react";
import { resolveAgentIcon, AGENT_ICON_MAP } from "../agentIcons";
import { setPluginCustomIcons } from "@/components/icons/pluginCustomIconStore";

const KEY = "plugin-icon:acme.agents:./icons/pi.svg";
const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M4 4h16v16H4z"/></svg>';
const ASSET = { key: KEY, pluginId: "acme.agents", pluginName: "Acme", svg: SVG };

function draw(iconId: string, props: { size?: number; className?: string } = {}) {
  return render(createElement(resolveAgentIcon(iconId), props)).container.querySelector("svg")!;
}

const terminalGlyph = () =>
  render(createElement(SquareTerminal)).container.querySelector("svg")!.innerHTML;

describe("agentIcons", () => {
  afterEach(() => {
    setPluginCustomIcons([]);
  });

  it("draws the neutral terminal glyph, never another agent's mark, for an unknown iconId", () => {
    expect(resolveAgentIcon("nonexistent")).not.toBe(AGENT_ICON_MAP["claude"]);
    expect(draw("nonexistent").innerHTML).toBe(terminalGlyph());
  });

  it.each(["toString", "constructor", "hasOwnProperty", "valueOf", "__proto__"])(
    "treats the inherited key %s as an unknown iconId",
    (iconId) => {
      // `iconId` reaches here from plugin manifests; a bare index lookup would
      // return an `Object.prototype` member and render it as a component.
      expect(resolveAgentIcon(iconId)).toBe(resolveAgentIcon("nonexistent"));
    }
  );

  it("draws the neutral glyph for a reference that failed to load", () => {
    // Main keeps the authored `./…svg` value when the file is refused.
    expect(draw("./icons/missing.svg").innerHTML).toBe(terminalGlyph());
  });

  it("draws a plugin's mark once it arrives and the neutral glyph after it unloads", () => {
    const { container } = render(createElement(resolveAgentIcon(KEY)));
    const svg = () => container.querySelector("svg")!;
    expect(svg().innerHTML).toBe(terminalGlyph());

    act(() => setPluginCustomIcons([ASSET]));
    expect(svg().getAttribute("data-plugin-icon")).toBe(KEY);

    act(() => setPluginCustomIcons([]));
    expect(svg().getAttribute("data-plugin-icon")).toBeNull();
    expect(svg().innerHTML).toBe(terminalGlyph());
  });

  it("keeps one component identity per key, so resolving on each render never remounts", () => {
    expect(resolveAgentIcon(KEY)).toBe(resolveAgentIcon(KEY));
    expect(resolveAgentIcon(KEY)).not.toBe(resolveAgentIcon(`${KEY}.other`));
  });

  it("sizes every agent glyph like a brand mark, for surfaces that pass no size", () => {
    const brandSize = draw("claude").getAttribute("width");
    setPluginCustomIcons([ASSET]);

    expect(draw(KEY).getAttribute("width")).toBe(brandSize);
    expect(draw(KEY).getAttribute("height")).toBe(brandSize);
    expect(draw("nonexistent").getAttribute("width")).toBe(brandSize);
    expect(draw(KEY, { size: 20 }).getAttribute("width")).toBe("20");
    expect(draw("nonexistent", { size: 20 }).getAttribute("width")).toBe("20");
  });

  it("AGENT_ICON_MAP contains all expected agent icons", () => {
    expect(AGENT_ICON_MAP["claude"]).toBeDefined();
    expect(AGENT_ICON_MAP["gemini"]).toBeDefined();
    expect(AGENT_ICON_MAP["antigravity"]).toBeDefined();
    expect(AGENT_ICON_MAP["codex"]).toBeDefined();
    expect(AGENT_ICON_MAP["opencode"]).toBeDefined();
    expect(AGENT_ICON_MAP["cursor"]).toBeDefined();
    expect(AGENT_ICON_MAP["kiro"]).toBeDefined();
    expect(AGENT_ICON_MAP["copilot"]).toBeDefined();
    expect(AGENT_ICON_MAP["goose"]).toBeDefined();
    expect(AGENT_ICON_MAP["crush"]).toBeDefined();
    expect(AGENT_ICON_MAP["qwen"]).toBeDefined();
    expect(AGENT_ICON_MAP["interpreter"]).toBeDefined();
    expect(AGENT_ICON_MAP["kimi"]).toBeDefined();
    expect(AGENT_ICON_MAP["amp"]).toBeDefined();
  });
});
