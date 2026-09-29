// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { getAgentConfig } from "@/config/agents";
import { HelpAssistantAgentChooser } from "../HelpAssistantAgentChooser";

const AGENT_IDS = ["claude", "codex", "gemini"] as const;

describe("HelpAssistantAgentChooser", () => {
  // A whole-card button is named by its title alone; the agent's blurb is its
  // description. Named by all its text, each card read as one run-on sentence.
  it("names each card by the agent and describes it with the blurb", () => {
    render(<HelpAssistantAgentChooser agentIds={AGENT_IDS} onChoose={vi.fn()} />);
    for (const id of AGENT_IDS) {
      const config = getAgentConfig(id)!;
      const card = screen.getByRole("button", { name: config.name });
      const describedBy = card.getAttribute("aria-describedby");
      if (config.tooltip) {
        expect(document.getElementById(describedBy ?? "")?.textContent).toBe(config.tooltip);
      } else {
        expect(describedBy).toBeNull();
      }
    }
  });

  it("chooses the agent whose card is clicked", () => {
    const onChoose = vi.fn();
    render(<HelpAssistantAgentChooser agentIds={AGENT_IDS} onChoose={onChoose} />);
    fireEvent.click(screen.getByTestId("help-choose-agent-codex"));
    expect(onChoose).toHaveBeenCalledWith("codex");
  });
});
