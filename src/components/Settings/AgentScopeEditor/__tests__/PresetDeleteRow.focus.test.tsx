// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { PresetDeleteRow } from "../CustomPresetChrome";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { AgentPreset } from "@/config/agents";

vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
);

const preset: AgentPreset = { id: "user-fast", name: "Fast reviewer" };

function renderRow(onDelete = vi.fn()) {
  const addRef = createRef<HTMLButtonElement>();
  render(
    <>
      <button ref={addRef} type="button">
        Add preset
      </button>
      <PresetDeleteRow preset={preset} onDelete={onDelete} restoreFocusTo={addRef} />
    </>,
    { wrapper: TooltipProvider }
  );
  return { onDelete, add: screen.getByRole("button", { name: "Add preset" }) };
}

async function openConfirm(): Promise<HTMLElement> {
  const trigger = screen.getByRole("button", { name: "Delete Fast reviewer" });
  trigger.focus();
  fireEvent.click(trigger);
  await screen.findByRole("button", { name: "Delete preset" });
  return trigger;
}

describe("PresetDeleteRow focus", () => {
  afterEach(cleanup);

  it("hands focus to the successor once the delete is confirmed, while the save is still out", async () => {
    const { onDelete, add } = renderRow();
    await openConfirm();

    fireEvent.click(screen.getByRole("button", { name: "Delete preset" }));

    expect(onDelete).toHaveBeenCalledWith("user-fast");
    await waitFor(() => expect(document.activeElement).toBe(add));
  });

  it("returns to its own button when the delete is cancelled", async () => {
    renderRow();
    const trigger = await openConfirm();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });
});
