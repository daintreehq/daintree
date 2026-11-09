// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { FallbackChainEditor } from "../FallbackChainEditor";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { AgentPreset } from "@/config/agents";
import { FALLBACK_CHAIN_MAX } from "@shared/config/agentRegistry";

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

describe("FallbackChainEditor — chain length (#16587)", () => {
  const rotation: AgentPreset[] = Array.from({ length: FALLBACK_CHAIN_MAX + 3 }, (_, i) => ({
    id: `account-${i}`,
    name: `Account ${i}`,
  }));
  const ids = rotation.map((p) => p.id);

  function renderChain(fallbacks: string[], storedFallbacks?: unknown) {
    const selected: AgentPreset = { id: "primary", name: "Primary", fallbacks };
    const onUpdatePreset = vi.fn();
    render(
      <TooltipProvider>
        <FallbackChainEditor
          selectedPreset={selected}
          storedFallbacks={storedFallbacks}
          allPresets={[selected, ...rotation]}
          onUpdatePreset={onUpdatePreset}
        />
      </TooltipProvider>
    );
    return onUpdatePreset;
  }

  function addFallbackDescription(): string {
    const label = screen.getByText("Fallback presets");
    const row = label.closest("[data-settings-row]") as HTMLElement;
    return row.textContent ?? "";
  }

  it("still offers a slot one short of the cap, and stops at it", () => {
    const short = ids.slice(0, FALLBACK_CHAIN_MAX - 1);
    renderChain(short, short);
    expect(screen.getByText("Add a fallback")).toBeTruthy();
    cleanup();

    const full = ids.slice(0, FALLBACK_CHAIN_MAX);
    renderChain(full, full);
    expect(screen.queryByText("Add a fallback")).toBeNull();
    expect(addFallbackDescription()).toContain(
      `Maximum of ${FALLBACK_CHAIN_MAX} fallbacks reached`
    );
  });

  it("says a fallback's own chain isn't followed", () => {
    renderChain([ids[0]!], [ids[0]]);
    expect(addFallbackDescription()).toContain("own fallbacks aren't followed");
  });

  it("flags a saved chain the read cut short, with how many were saved", () => {
    const saved = ids.slice(0, FALLBACK_CHAIN_MAX + 2);
    renderChain(saved.slice(0, FALLBACK_CHAIN_MAX), saved);
    const note = screen.getByTestId("fallback-chain-cut");
    expect(note.textContent).toContain(`${saved.length} fallbacks are saved`);
    expect(note.textContent).toContain(`first ${FALLBACK_CHAIN_MAX}`);
  });

  it.each([
    ["a saved chain at the cap", ids.slice(0, FALLBACK_CHAIN_MAX)],
    [
      "a saved chain whose extras are repeats or invalid",
      [...ids.slice(0, FALLBACK_CHAIN_MAX), ids[0], "primary", "not valid"],
    ],
    ["no saved chain to compare", undefined],
  ])("says nothing for %s", (_label, stored) => {
    renderChain(ids.slice(0, FALLBACK_CHAIN_MAX), stored);
    expect(screen.queryByTestId("fallback-chain-cut")).toBeNull();
  });
});
