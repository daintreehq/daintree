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

function renderEditor(selected: AgentPreset) {
  const onUpdatePreset = vi.fn();
  render(
    <TooltipProvider>
      <FallbackChainEditor
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
