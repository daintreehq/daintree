// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { AddPresetDialog } from "../AddPresetDialog";
import type { AgentPreset } from "@/config/agents";

vi.mock("@/utils/logger", () => ({
  logError: vi.fn(),
  logWarn: vi.fn(),
  logInfo: vi.fn(),
  logDebug: vi.fn(),
}));

/**
 * `claude` is the only agent in the roster that ships provider templates, so it
 * and any other id are the two structural shapes this dialog has to render.
 */
const AGENT_WITH_TEMPLATES = "claude";
const AGENT_WITHOUT_TEMPLATES = "codex";

const CURRENT: AgentPreset = {
  id: "preset-1",
  name: "Z.AI (GLM-5.2)",
  env: { ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic" },
  args: ["--verbose"],
};

type CreatePayload = Omit<AgentPreset, "id">;

function renderDialog(overrides: Partial<Parameters<typeof AddPresetDialog>[0]> = {}) {
  const onCreate = vi.fn<(preset: CreatePayload) => void>();
  const onClose = vi.fn();
  render(
    <AddPresetDialog
      isOpen
      onClose={onClose}
      agentId={AGENT_WITH_TEMPLATES}
      currentPreset={null}
      onCreate={onCreate}
      {...overrides}
    />
  );
  return { onCreate, onClose };
}

function optionRadios(): HTMLInputElement[] {
  return screen.queryAllByRole("radio") as HTMLInputElement[];
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("AddPresetDialog — every offered option is one the dialog can honour", () => {
  it("offers no option whose outcome it cannot actually produce", () => {
    // The rule, not the roster: whatever the dialog renders as a choice must
    // correspond to a starting point that exists in this context. Cloning
    // requires something to clone; a template requires a template.
    const cases: { currentPreset: AgentPreset | null; agentId: string }[] = [
      { currentPreset: null, agentId: AGENT_WITH_TEMPLATES },
      { currentPreset: CURRENT, agentId: AGENT_WITH_TEMPLATES },
      { currentPreset: null, agentId: AGENT_WITHOUT_TEMPLATES },
      { currentPreset: CURRENT, agentId: AGENT_WITHOUT_TEMPLATES },
    ];

    for (const { currentPreset, agentId } of cases) {
      const { unmount } = render(
        <AddPresetDialog
          isOpen
          onClose={vi.fn()}
          agentId={agentId}
          currentPreset={currentPreset}
          onCreate={vi.fn()}
        />
      );

      const values = optionRadios().map((r) => r.value);
      expect(values.includes("clone"), `clone offered with currentPreset=${!!currentPreset}`).toBe(
        !!currentPreset
      );
      expect(values.includes("template"), `template offered for agent=${agentId}`).toBe(
        agentId === AGENT_WITH_TEMPLATES
      );

      unmount();
    }
  });

  it("drops the choice group entirely rather than presenting a single option", () => {
    // A one-option radio group is a decision the user cannot make: nothing to
    // compare, and no way to deselect. When only Blank survives, the dialog
    // must say what will happen instead of rendering a lone control.
    renderDialog({ agentId: AGENT_WITHOUT_TEMPLATES, currentPreset: null });

    expect(optionRadios()).toHaveLength(0);
    expect(screen.queryByRole("group")).toBeNull();
    expect(screen.queryByText(/starts empty/i)).not.toBeNull();
  });

  it("never renders a choice group with fewer than two options", () => {
    for (const agentId of [AGENT_WITH_TEMPLATES, AGENT_WITHOUT_TEMPLATES]) {
      for (const currentPreset of [null, CURRENT]) {
        const { unmount } = render(
          <AddPresetDialog
            isOpen
            onClose={vi.fn()}
            agentId={agentId}
            currentPreset={currentPreset}
            onCreate={vi.fn()}
          />
        );
        const count = optionRadios().length;
        expect(count === 0 || count >= 2, `rendered ${count} option(s)`).toBe(true);
        unmount();
      }
    }
  });
});

describe("AddPresetDialog — single-choice semantics", () => {
  it("keeps the options in one native radio group", () => {
    // Native grouping is what supplies arrow-key selection, the single tab
    // stop, and the checked state the UA repaints under forced colors. A
    // roving-tabindex reimplementation would satisfy none of those for free.
    renderDialog({ currentPreset: CURRENT });

    const radios = optionRadios();
    expect(radios.length).toBeGreaterThan(1);
    for (const radio of radios) {
      expect(radio.type).toBe("radio");
    }
    expect(new Set(radios.map((r) => r.name)).size).toBe(1);
  });

  it("keeps exactly one option checked as the choice moves", () => {
    renderDialog({ currentPreset: CURRENT });

    const checkedCount = () => optionRadios().filter((r) => r.checked).length;
    expect(checkedCount()).toBe(1);

    for (const name of ["Clone current", "From template", "Blank"]) {
      fireEvent.click(screen.getByRole("radio", { name }));
      expect(checkedCount(), `after choosing ${name}`).toBe(1);
    }
  });

  it("names each option by its title alone and carries the consequence as a description", () => {
    // The whole card is the label so the row is one click target, which would
    // otherwise fold the consequence line into the accessible name and
    // announce every option as one run-on string.
    renderDialog({ currentPreset: CURRENT });

    const clone = screen.getByRole("radio", { name: "Clone current" });
    const describedBy = clone.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy!)?.textContent).toMatch(/Z\.AI/);
  });

  it("makes the whole option row the click target, not just the control", () => {
    // The consequence line has to sit inside the option's own <label> for the
    // row to be one target; if it drifts outside, the visual card and the
    // clickable area stop agreeing.
    renderDialog({ currentPreset: CURRENT });

    for (const radio of optionRadios()) {
      const label = radio.closest("label");
      expect(label, `option ${radio.value} has no wrapping label`).not.toBeNull();
      const describedBy = radio.getAttribute("aria-describedby")!;
      expect(label!.contains(document.getElementById(describedBy))).toBe(true);
    }
  });
});

describe("AddPresetDialog — the dependent control belongs to the option that owns it", () => {
  it("renders the provider selector only while its option is chosen", () => {
    renderDialog();

    expect(screen.queryByTestId("template-select")).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: "From template" }));
    expect(screen.queryByTestId("template-select")).not.toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: "Blank" }));
    expect(screen.queryByTestId("template-select")).toBeNull();
  });

  it("nests the provider selector inside its own option's row, not beside the group", () => {
    renderDialog();
    fireEvent.click(screen.getByRole("radio", { name: "From template" }));

    const row = screen.getByTestId("template-choice-row");
    expect(within(row).queryByRole("radio", { name: "From template" })).not.toBeNull();
    expect(row.contains(screen.getByTestId("template-select"))).toBe(true);
  });

  it("keeps the provider selector out of the label so choosing a provider cannot retoggle the option", () => {
    renderDialog();
    fireEvent.click(screen.getByRole("radio", { name: "From template" }));

    expect(screen.getByTestId("template-select").closest("label")).toBeNull();
  });
});

describe("AddPresetDialog — what gets created matches what was chosen", () => {
  it("creates from the current preset when cloning, never a silent blank", () => {
    const { onCreate } = renderDialog({ currentPreset: CURRENT });

    fireEvent.click(screen.getByRole("radio", { name: "Clone current" }));
    fireEvent.click(screen.getByRole("button", { name: /create preset/i }));

    expect(onCreate).toHaveBeenCalledTimes(1);
    const payload = onCreate.mock.calls[0]![0];
    expect(payload.name).toContain(CURRENT.name);
    expect(payload.env).toEqual(CURRENT.env);
    expect(payload.env).not.toBe(CURRENT.env);
  });

  it("creates from the chosen template, carrying its settings", () => {
    const { onCreate } = renderDialog();

    fireEvent.click(screen.getByRole("radio", { name: "From template" }));
    const select = screen.getByTestId("template-select") as HTMLSelectElement;
    const target = Array.from(select.options).find((o) => o.value !== select.value)!;
    fireEvent.change(select, { target: { value: target.value } });
    fireEvent.click(screen.getByRole("button", { name: /create preset/i }));

    expect(onCreate).toHaveBeenCalledTimes(1);
    const payload = onCreate.mock.calls[0]![0];
    expect(payload.name).toBe(target.textContent);
    expect(Object.keys(payload.env ?? {}).length).toBeGreaterThan(0);
  });

  it("starts on the blank option every time it opens", () => {
    // Downstream specs depend on the untouched path producing a blank preset,
    // and reopening must not inherit the previous visit's choice.
    const { onCreate } = renderDialog({ currentPreset: CURRENT });
    const checked = optionRadios().find((r) => r.checked);
    expect(checked?.value).toBe("blank");
    expect(onCreate).not.toHaveBeenCalled();
  });
});
