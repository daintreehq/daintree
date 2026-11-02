// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { FallbackChainEditor } from "../FallbackChainEditor";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { AgentPreset } from "@/config/agents";

const presets: AgentPreset[] = [
  { id: "home", name: "Home" },
  { id: "work", name: "Work" },
];

function renderEditor(selected: AgentPreset, agentId?: string) {
  const onUpdatePreset = vi.fn();
  render(
    <TooltipProvider>
      <FallbackChainEditor
        agentId={agentId}
        selectedPreset={selected}
        allPresets={[selected, ...presets.filter((p) => p.id !== selected.id)]}
        onUpdatePreset={onUpdatePreset}
      />
    </TooltipProvider>
  );
  return onUpdatePreset;
}

describe("FallbackChainEditor — usage-limit opt-in (#14370)", () => {
  it("offers no switch until there is a fallback to move to", () => {
    renderEditor({ id: "home", name: "Home" });
    expect(screen.queryByRole("switch", { name: "Fall back on usage limits" })).toBeNull();
  });

  it("is off by default and says the conversation ends", () => {
    const onUpdatePreset = renderEditor({ id: "home", name: "Home", fallbacks: ["work"] });
    const toggle = screen.getByRole("switch", { name: "Fall back on usage limits" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    const description = (toggle.getAttribute("aria-describedby") ?? "")
      .split(" ")
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" ");
    expect(description).toContain("conversation ends");

    fireEvent.click(toggle);
    expect(onUpdatePreset).toHaveBeenCalledWith("home", { fallbackOnRateLimit: true });
  });

  it("clears the opt-in rather than storing false", () => {
    const onUpdatePreset = renderEditor({
      id: "home",
      name: "Home",
      fallbacks: ["work"],
      fallbackOnRateLimit: true,
    });
    const toggle = screen.getByRole("switch", { name: "Fall back on usage limits" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");

    fireEvent.click(toggle);
    expect(onUpdatePreset).toHaveBeenCalledWith("home", { fallbackOnRateLimit: undefined });
  });
});

describe("FallbackChainEditor — keeping the conversation on a usage limit (#16045)", () => {
  const optedIn: AgentPreset = {
    id: "home",
    name: "Home",
    fallbacks: ["work"],
    fallbackOnRateLimit: true,
  };

  it("offers it under the usage-limit opt-in, and stores only true", () => {
    const onUpdatePreset = renderEditor(optedIn, "codex");
    const toggle = screen.getByRole("switch", { name: "Keep the conversation" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");

    fireEvent.click(toggle);
    expect(onUpdatePreset).toHaveBeenCalledWith("home", { keepConversationOnRateLimit: true });
  });

  it.each([
    ["an agent that can keep it", "codex", "unless you keep it"],
    ["an agent that can't", "gemini", "conversation ends"],
  ])("tells the usage-limit opt-in's consequence for %s", (_label, agentId, words) => {
    renderEditor(optedIn, agentId);
    const toggle = screen.getByRole("switch", { name: "Fall back on usage limits" });
    const description = (toggle.getAttribute("aria-describedby") ?? "")
      .split(" ")
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" ");
    expect(description).toContain(words);
  });

  it("clears it rather than storing false", () => {
    const onUpdatePreset = renderEditor({ ...optedIn, keepConversationOnRateLimit: true }, "codex");
    const toggle = screen.getByRole("switch", { name: "Keep the conversation" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");

    fireEvent.click(toggle);
    expect(onUpdatePreset).toHaveBeenCalledWith("home", { keepConversationOnRateLimit: undefined });
  });

  it.each([
    ["the usage-limit opt-in is off", { ...optedIn, fallbackOnRateLimit: undefined }, "codex"],
    ["the agent's refusal isn't recognised", optedIn, "gemini"],
    [
      "there is no fallback to move to",
      { ...optedIn, fallbacks: undefined, keepConversationOnRateLimit: true },
      "codex",
    ],
  ])("offers nothing while %s", (_label, preset, agentId) => {
    renderEditor(preset, agentId);
    expect(screen.queryByRole("switch", { name: "Keep the conversation" })).toBeNull();
  });
});
