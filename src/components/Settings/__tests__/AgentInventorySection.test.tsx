// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, fireEvent, screen } from "@testing-library/react";
import { AgentInventorySection, type InventoryAgent } from "../AgentInventorySection";

const Icon = () => null;
const agent = (id: string): InventoryAgent => ({ id, name: id, color: "#888", Icon });

function renderInventory(availability: Record<string, string>, ids: string[]) {
  return render(
    <AgentInventorySection
      agents={ids.map(agent)}
      availability={availability as never}
      isLoading={false}
      error={null}
      isRefreshing={false}
      onRefresh={() => {}}
      onOpenAgent={() => {}}
      onRunSetupWizard={() => {}}
    />
  );
}

describe("AgentInventorySection", () => {
  it("counts only agents the probe reported on, and only confirmed misses as not installed", () => {
    renderInventory({ claude: "ready", codex: "blocked", copilot: "missing" }, [
      "claude",
      "codex",
      "copilot",
      "daintree-assistant",
    ]);
    fireEvent.click(screen.getByRole("button", { name: /that isn't installed$/ }));
    const listed = Array.from(document.querySelectorAll("[data-inventory-agent]")).map(
      (el) => (el as HTMLElement).dataset.inventoryAgent
    );
    expect(listed).toContain("copilot");
    expect(listed).not.toContain("daintree-assistant");
    expect(document.body.textContent).toContain("1 of 2 installed agents ready");
  });

  it("always shows the agents that need attention and hides the healthy ones", () => {
    renderInventory({ claude: "ready", codex: "blocked" }, ["claude", "codex"]);
    const listed = Array.from(document.querySelectorAll("[data-inventory-agent]")).map(
      (el) => (el as HTMLElement).dataset.inventoryAgent
    );
    expect(listed).toEqual(["codex"]);
  });
});
