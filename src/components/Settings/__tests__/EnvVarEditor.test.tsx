// @vitest-environment jsdom
/**
 * EnvVarEditor — draft-row env CRUD with validation.
 *
 * These tests lock in the behaviour that prevents silent data loss and the
 * "my changes disappeared" classes of bugs the uncontrolled `defaultValue`
 * pattern caused in the earlier implementation:
 *
 *  - Empty key after blur surfaces a visible error and does NOT persist.
 *  - Duplicate keys are detected on-change and flagged on both rows.
 *  - Removing a row commits the updated env immediately.
 *  - Renaming a key commits only when the new name is non-empty and unique.
 */
import { useState } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, screen } from "@testing-library/react";
import { EnvVarEditor } from "../EnvVarEditor";

vi.mock("lucide-react", () => ({
  X: () => <span data-testid="x-icon" />,
  Eye: () => <span data-testid="eye-icon" />,
  EyeOff: () => <span data-testid="eye-off-icon" />,
  Plus: () => <span data-testid="plus-icon" />,
  RotateCcw: () => <span data-testid="rotate-ccw-icon" />,
  Upload: () => <span data-testid="upload-icon" />,
  AlertTriangle: () => <span data-testid="alert-triangle-icon" />,
  ChevronDown: () => <span data-testid="chevron-down-icon" />,
}));

// Render Popover children inline so jsdom doesn't need to wrestle Radix's
// Portal / focus-trap machinery — we're asserting on the picker behavior,
// not on portal mechanics.
vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverAnchor: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

interface DialogAction {
  label: string;
  onClick: () => void;
  disabled?: boolean;
}

vi.mock("@/components/ui/AppDialog", () => {
  const Dialog = ({
    children,
    isOpen,
    "data-testid": testId,
  }: {
    children: React.ReactNode;
    isOpen: boolean;
    onClose?: () => void;
    size?: string;
    zIndex?: string;
    "data-testid"?: string;
  }) => (isOpen ? <div data-testid={testId ?? "app-dialog"}>{children}</div> : null);
  Dialog.Header = ({ children }: { children: React.ReactNode }) => <div>{children}</div>;
  Dialog.Title = ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>;
  Dialog.CloseButton = () => <button type="button" aria-label="Close dialog" />;
  Dialog.Body = ({ children }: { children: React.ReactNode }) => <div>{children}</div>;
  Dialog.Description = ({ children }: { children: React.ReactNode }) => <p>{children}</p>;
  Dialog.Footer = ({
    primaryAction,
    secondaryAction,
  }: {
    primaryAction?: DialogAction;
    secondaryAction?: DialogAction;
  }) => (
    <div>
      {secondaryAction && (
        <button
          type="button"
          onClick={secondaryAction.onClick}
          disabled={secondaryAction.disabled}
          data-testid="app-dialog-secondary"
        >
          {secondaryAction.label}
        </button>
      )}
      {primaryAction && (
        <button
          type="button"
          onClick={primaryAction.onClick}
          disabled={primaryAction.disabled}
          data-testid="app-dialog-primary"
        >
          {primaryAction.label}
        </button>
      )}
    </div>
  );
  return { AppDialog: Dialog };
});

describe("EnvVarEditor", () => {
  let onChange: ReturnType<typeof vi.fn<(env: Record<string, string>) => void>>;

  beforeEach(() => {
    onChange = vi.fn<(env: Record<string, string>) => void>();
  });

  function renderEditor(initial: Record<string, string>) {
    return render(<EnvVarEditor env={initial} onChange={onChange} />);
  }

  it("renders one row per env var key", () => {
    const { getAllByTestId } = renderEditor({ FOO: "bar", BAZ: "qux" });
    expect(getAllByTestId("env-editor-key")).toHaveLength(2);
  });

  it("shows an empty-state affordance inviting the first variable", () => {
    const { getByText } = renderEditor({});
    expect(getByText(/Add your first variable/i)).toBeTruthy();
  });

  it("renaming a key to a unique non-empty name commits the updated env", () => {
    const { getAllByTestId } = renderEditor({ OLD: "v" });
    const keyInput = getAllByTestId("env-editor-key")[0] as HTMLInputElement;

    fireEvent.change(keyInput, { target: { value: "NEW" } });
    fireEvent.blur(keyInput);

    expect(onChange).toHaveBeenLastCalledWith({ NEW: "v" });
  });

  it("editing a value commits after the value input blurs", () => {
    const { getAllByTestId } = renderEditor({ FOO: "one" });
    const valueInput = getAllByTestId("env-editor-value")[0] as HTMLInputElement;

    fireEvent.change(valueInput, { target: { value: "two" } });
    fireEvent.blur(valueInput);

    expect(onChange).toHaveBeenLastCalledWith({ FOO: "two" });
  });

  it("blurring with an empty key surfaces 'Key required' and does NOT commit", () => {
    const { getAllByTestId, getByTestId, queryByTestId } = renderEditor({ FOO: "v" });
    const keyInput = getAllByTestId("env-editor-key")[0] as HTMLInputElement;

    fireEvent.change(keyInput, { target: { value: "" } });
    expect(queryByTestId("env-editor-error-empty")).toBeNull(); // not yet touched
    fireEvent.blur(keyInput);

    expect(getByTestId("env-editor-error-empty")).toBeTruthy();
    // onChange should NOT have been called with an empty-key commit because
    // invalid drafts are held.
    const lastCall = onChange.mock.calls[onChange.mock.calls.length - 1];
    if (lastCall) {
      // If a call happened, it must not contain an empty key.
      expect(Object.keys(lastCall[0])).not.toContain("");
    }
  });

  it("entering a duplicate key flags both rows and holds the commit", () => {
    const { getAllByTestId, getAllByText } = renderEditor({ FOO: "a", BAR: "b" });
    const keyInputs = getAllByTestId("env-editor-key") as HTMLInputElement[];

    // Change the second row's key to match the first.
    fireEvent.change(keyInputs[1]!, { target: { value: "FOO" } });
    fireEvent.blur(keyInputs[1]!);

    // Duplicate key error surfaces (the first row also gets flagged because it
    // matches the duplicate set).
    expect(getAllByText(/Duplicate key/).length).toBeGreaterThanOrEqual(1);

    // Commit must not include the duplicate (the resolver drops the second
    // occurrence and keeps {FOO: "a"}).
    const latestCommit = onChange.mock.calls[onChange.mock.calls.length - 1]?.[0];
    if (latestCommit) {
      expect(Object.keys(latestCommit)).toEqual(expect.arrayContaining(["FOO"]));
      expect(Object.keys(latestCommit)).not.toContain("BAR"); // second row with duplicate key is dropped
    }
  });

  it("removing a row commits the env without that key", () => {
    const { getAllByTestId } = renderEditor({ KEEP: "a", REMOVE: "b" });
    const removeButtons = getAllByTestId("env-editor-remove");

    fireEvent.click(removeButtons[1]!);

    expect(onChange).toHaveBeenLastCalledWith({ KEEP: "a" });
  });

  it("clicking Add appends a row with a non-colliding KEY name", () => {
    const { getByTestId, getAllByTestId } = renderEditor({ NEW_VAR: "already" });
    const addButton = getByTestId("env-editor-add");

    fireEvent.click(addButton);

    const keyInputs = getAllByTestId("env-editor-key") as HTMLInputElement[];
    expect(keyInputs).toHaveLength(2);
    // Second row should pick NEW_VAR_1 (first collides).
    expect(keyInputs[1]!.value).toBe("NEW_VAR_1");
  });

  it("newly-added rows do not show 'Key required' before first blur", () => {
    const { getByTestId, queryByTestId } = renderEditor({});
    fireEvent.click(getByTestId("env-editor-add"));
    expect(queryByTestId("env-editor-error-empty")).toBeNull();
  });

  it("context key change reseeds draft rows (switching between presets)", () => {
    const { rerender, getAllByTestId } = render(
      <EnvVarEditor env={{ ALPHA: "1" }} onChange={onChange} contextKey="preset-a" />
    );
    expect(getAllByTestId("env-editor-key")).toHaveLength(1);

    rerender(
      <EnvVarEditor env={{ BETA: "2", GAMMA: "3" }} onChange={onChange} contextKey="preset-b" />
    );
    const keyInputs = getAllByTestId("env-editor-key") as HTMLInputElement[];
    expect(keyInputs).toHaveLength(2);
    expect(keyInputs.map((el) => el.value)).toEqual(expect.arrayContaining(["BETA", "GAMMA"]));
  });

  describe("literal secret warning", () => {
    it("warns when a value looks like a literal API key", () => {
      const { getAllByTestId, getByTestId } = renderEditor({ ANTHROPIC_API_KEY: "" });
      const valueInput = getAllByTestId("env-editor-value")[0] as HTMLInputElement;

      fireEvent.change(valueInput, {
        target: { value: "sk-ant-abcdefghijklmnopqrstuvwxyz123456" },
      });

      expect(getByTestId("env-editor-warning-secret")).toBeTruthy();
    });

    it("does NOT warn when the value is a ${ENV_VAR} safe-form reference", () => {
      const { getAllByTestId, queryByTestId } = renderEditor({ ANTHROPIC_API_KEY: "" });
      const valueInput = getAllByTestId("env-editor-value")[0] as HTMLInputElement;

      fireEvent.change(valueInput, { target: { value: "${ANTHROPIC_API_KEY}" } });

      expect(queryByTestId("env-editor-warning-secret")).toBeNull();
    });

    it("warning does not block commit — literal secret still persists on blur", () => {
      const { getAllByTestId, getByTestId } = renderEditor({ ANTHROPIC_API_KEY: "" });
      const valueInput = getAllByTestId("env-editor-value")[0] as HTMLInputElement;

      const literal = "sk-ant-abcdefghijklmnopqrstuvwxyz123456";
      fireEvent.change(valueInput, { target: { value: literal } });
      fireEvent.blur(valueInput);

      expect(getByTestId("env-editor-warning-secret")).toBeTruthy();
      expect(onChange).toHaveBeenLastCalledWith({ ANTHROPIC_API_KEY: literal });
    });

    it("warning clears when the value changes to a safe-form reference", () => {
      const { getAllByTestId, queryByTestId } = renderEditor({ ANTHROPIC_API_KEY: "" });
      const valueInput = getAllByTestId("env-editor-value")[0] as HTMLInputElement;

      fireEvent.change(valueInput, {
        target: { value: "sk-ant-abcdefghijklmnopqrstuvwxyz123456" },
      });
      expect(queryByTestId("env-editor-warning-secret")).not.toBeNull();

      fireEvent.change(valueInput, { target: { value: "${ANTHROPIC_API_KEY}" } });
      expect(queryByTestId("env-editor-warning-secret")).toBeNull();
    });

    it("warning is row-scoped in a multi-row editor", () => {
      const { getAllByTestId, queryAllByTestId } = renderEditor({ FOO: "", BAR: "" });
      const valueInputs = getAllByTestId("env-editor-value") as HTMLInputElement[];

      fireEvent.change(valueInputs[1]!, {
        target: { value: "sk-ant-abcdefghijklmnopqrstuvwxyz123456" },
      });

      const warnings = queryAllByTestId("env-editor-warning-secret");
      expect(warnings).toHaveLength(1);
    });
  });

  describe("reveal toggle", () => {
    it("shows eye toggle when the key is sensitive (isSensitiveEnvKey)", () => {
      const { getByTestId } = renderEditor({ ANTHROPIC_API_KEY: "sk-real-secret-value" });
      expect(getByTestId("env-editor-reveal")).toBeTruthy();
    });

    it("does NOT show eye toggle for ordinary key + ordinary value", () => {
      const { queryByTestId } = renderEditor({ MY_VAR: "hello" });
      expect(queryByTestId("env-editor-reveal")).toBeNull();
    });

    it("masks value by default and reveals on toggle", () => {
      const { getByTestId, getAllByTestId } = renderEditor({ ANTHROPIC_API_KEY: "abc-12345" });
      const valueInput = getAllByTestId("env-editor-value")[0] as HTMLInputElement;
      expect(valueInput.type).toBe("password");

      fireEvent.click(getByTestId("env-editor-reveal"));
      expect(valueInput.type).toBe("text");

      fireEvent.click(getByTestId("env-editor-reveal"));
      expect(valueInput.type).toBe("password");
    });

    it("reveal state is independent per row", () => {
      const { getAllByTestId } = renderEditor({
        ANTHROPIC_API_KEY: "v1",
        OPENAI_API_KEY: "v2",
      });
      const reveals = getAllByTestId("env-editor-reveal");
      const values = getAllByTestId("env-editor-value") as HTMLInputElement[];

      expect(values[0]!.type).toBe("password");
      expect(values[1]!.type).toBe("password");

      fireEvent.click(reveals[0]!);
      expect(values[0]!.type).toBe("text");
      expect(values[1]!.type).toBe("password");
    });

    it("reveal state is cleared when contextKey changes", () => {
      const { getByTestId, getAllByTestId, rerender } = render(
        <EnvVarEditor env={{ ANTHROPIC_API_KEY: "v1" }} onChange={onChange} contextKey="preset-a" />
      );
      fireEvent.click(getByTestId("env-editor-reveal"));
      expect((getAllByTestId("env-editor-value")[0] as HTMLInputElement).type).toBe("text");

      rerender(
        <EnvVarEditor env={{ ANTHROPIC_API_KEY: "v2" }} onChange={onChange} contextKey="preset-b" />
      );
      expect((getAllByTestId("env-editor-value")[0] as HTMLInputElement).type).toBe("password");
    });
  });

  describe("keyboard ergonomics", () => {
    it("Enter on a value input appends a new row", () => {
      const { getAllByTestId } = renderEditor({ FOO: "bar" });
      const valueInput = getAllByTestId("env-editor-value")[0] as HTMLInputElement;

      fireEvent.keyDown(valueInput, { key: "Enter" });

      expect(getAllByTestId("env-editor-key")).toHaveLength(2);
    });

    it("Enter on a value input does NOT commit a placeholder NEW_VAR entry", () => {
      const { getAllByTestId } = renderEditor({ FOO: "bar" });
      const valueInput = getAllByTestId("env-editor-value")[0] as HTMLInputElement;

      // Change value then press Enter — the old row's value must commit, but
      // the newly-appended placeholder row (NEW_VAR: "") must NOT leak into
      // the committed env.
      fireEvent.change(valueInput, { target: { value: "baz" } });
      fireEvent.keyDown(valueInput, { key: "Enter" });

      for (const call of onChange.mock.calls) {
        expect(Object.keys(call[0])).not.toContain("NEW_VAR");
      }
    });

    it("Escape on a value input blurs it", () => {
      const { getAllByTestId } = renderEditor({ FOO: "bar" });
      const valueInput = getAllByTestId("env-editor-value")[0] as HTMLInputElement;
      valueInput.focus();
      expect(document.activeElement).toBe(valueInput);

      fireEvent.keyDown(valueInput, { key: "Escape" });

      expect(document.activeElement).not.toBe(valueInput);
    });

    it("Escape on a key input blurs it", () => {
      const { getAllByTestId } = renderEditor({ FOO: "bar" });
      const keyInput = getAllByTestId("env-editor-key")[0] as HTMLInputElement;
      keyInput.focus();
      expect(document.activeElement).toBe(keyInput);

      fireEvent.keyDown(keyInput, { key: "Escape" });

      expect(document.activeElement).not.toBe(keyInput);
    });
  });

  describe("key suggestion picker", () => {
    const sampleSuggestions = [
      { key: "ANTHROPIC_API_KEY", hint: "Claude auth" },
      { key: "OPENAI_API_KEY", hint: "OpenAI auth" },
      { key: "DEBUG", hint: "Verbose logging" },
    ];

    it("renders a chevron trigger when suggestions are provided and the key has room to change", () => {
      const { getAllByTestId } = render(
        <EnvVarEditor env={{ FOO: "v" }} onChange={onChange} suggestions={sampleSuggestions} />
      );
      // FOO is not in the suggestions list, so all 3 are still available.
      expect(getAllByTestId("env-editor-key-suggestions-trigger")).toHaveLength(1);
    });

    it("does not render a chevron when the suggestions list is empty", () => {
      const { queryAllByTestId } = render(
        <EnvVarEditor env={{ FOO: "v" }} onChange={onChange} suggestions={[]} />
      );
      expect(queryAllByTestId("env-editor-key-suggestions-trigger")).toHaveLength(0);
    });

    it("does not render a chevron on inherited (disabled) rows", () => {
      const { queryAllByTestId } = render(
        <EnvVarEditor
          env={{}}
          onChange={onChange}
          inheritedEnv={{ ANTHROPIC_API_KEY: "from-global" }}
          suggestions={sampleSuggestions}
        />
      );
      expect(queryAllByTestId("env-editor-key-suggestions-trigger")).toHaveLength(0);
    });

    it("excludes keys already used in OTHER rows from the suggestion list", () => {
      const { getAllByTestId } = render(
        <EnvVarEditor
          env={{ ANTHROPIC_API_KEY: "v1", DEBUG: "v2" }}
          onChange={onChange}
          suggestions={sampleSuggestions}
        />
      );
      // Row 0 (ANTHROPIC_API_KEY) — the row's own current key is also filtered
      // out (you can't pick what you already have), so OPENAI_API_KEY only.
      // Row 1 (DEBUG) — only OPENAI_API_KEY remains as well (ANTHROPIC used by row 0).
      const allOptions = getAllByTestId("env-editor-key-suggestion");
      const optionTexts = allOptions.map((el) => el.textContent ?? "");
      expect(optionTexts.every((t) => t.includes("OPENAI_API_KEY"))).toBe(true);
      expect(optionTexts.some((t) => t.includes("ANTHROPIC_API_KEY"))).toBe(false);
      expect(optionTexts.some((t) => t.includes("DEBUG"))).toBe(false);
    });

    it("clicking a suggestion commits the new key without requiring a follow-up blur", () => {
      const { getAllByTestId } = render(
        <EnvVarEditor env={{ FOO: "v" }} onChange={onChange} suggestions={sampleSuggestions} />
      );
      const options = getAllByTestId("env-editor-key-suggestion");
      const anthropicOption = options.find((el) =>
        (el.textContent ?? "").includes("ANTHROPIC_API_KEY")
      );
      expect(anthropicOption).toBeTruthy();

      // No blur after click — picker selections must commit synchronously,
      // otherwise the blur-before-click race (browser fires input.blur before
      // option.click) loses the selection: the blur commits the OLD key, then
      // the click updates rows but never commits, leaving the parent stuck
      // with the pre-pick value.
      fireEvent.click(anthropicOption!);

      expect(onChange).toHaveBeenLastCalledWith({ ANTHROPIC_API_KEY: "v" });
    });

    it("blur firing before a suggestion click does NOT lose the selection", () => {
      const { getAllByTestId } = render(
        <EnvVarEditor env={{ FOO: "v" }} onChange={onChange} suggestions={sampleSuggestions} />
      );
      const keyInput = getAllByTestId("env-editor-key")[0] as HTMLInputElement;
      const options = getAllByTestId("env-editor-key-suggestion");
      const anthropicOption = options.find((el) =>
        (el.textContent ?? "").includes("ANTHROPIC_API_KEY")
      );
      expect(anthropicOption).toBeTruthy();

      // Replicate the real browser event order: blur first, then click.
      fireEvent.blur(keyInput);
      fireEvent.click(anthropicOption!);

      expect(onChange).toHaveBeenLastCalledWith({ ANTHROPIC_API_KEY: "v" });
    });

    it("ArrowDown opens the popover and Enter selects the highlighted suggestion", () => {
      const { getAllByTestId } = render(
        <EnvVarEditor env={{ FOO: "v" }} onChange={onChange} suggestions={sampleSuggestions} />
      );
      const keyInput = getAllByTestId("env-editor-key")[0] as HTMLInputElement;
      expect(keyInput.getAttribute("aria-expanded")).toBe("false");

      fireEvent.keyDown(keyInput, { key: "ArrowDown" });
      expect(keyInput.getAttribute("aria-expanded")).toBe("true");

      // Enter on a highlighted suggestion goes through the picker-select path
      // and commits synchronously — no follow-up blur required.
      fireEvent.keyDown(keyInput, { key: "Enter" });

      expect(keyInput.getAttribute("aria-expanded")).toBe("false");
      expect(onChange).toHaveBeenLastCalledWith({ ANTHROPIC_API_KEY: "v" });
    });

    it("Escape closes an open popover without blurring the input", () => {
      const { getAllByTestId } = render(
        <EnvVarEditor env={{ FOO: "v" }} onChange={onChange} suggestions={sampleSuggestions} />
      );
      const keyInput = getAllByTestId("env-editor-key")[0] as HTMLInputElement;
      keyInput.focus();
      fireEvent.keyDown(keyInput, { key: "ArrowDown" });
      expect(keyInput.getAttribute("aria-expanded")).toBe("true");

      fireEvent.keyDown(keyInput, { key: "Escape" });

      expect(keyInput.getAttribute("aria-expanded")).toBe("false");
      // First Escape closes the popover; input keeps focus so the user can
      // continue typing without losing context.
      expect(document.activeElement).toBe(keyInput);
    });

    it("input has combobox role and listbox wiring for screen readers", () => {
      const { getAllByTestId } = render(
        <EnvVarEditor env={{ FOO: "v" }} onChange={onChange} suggestions={sampleSuggestions} />
      );
      const keyInput = getAllByTestId("env-editor-key")[0] as HTMLInputElement;
      expect(keyInput.getAttribute("role")).toBe("combobox");
      expect(keyInput.getAttribute("aria-autocomplete")).toBe("list");
      const controls = keyInput.getAttribute("aria-controls");
      expect(controls).toBeTruthy();
      // The listbox referenced by aria-controls must exist in the DOM.
      expect(document.getElementById(controls!)).toBeTruthy();
    });
  });

  describe("inherited env", () => {
    it("renders inherited-only keys as muted rows with disabled inputs and an Override action", () => {
      const { getAllByTestId, queryAllByTestId } = render(
        <EnvVarEditor
          env={{}}
          onChange={onChange}
          inheritedEnv={{ API_KEY: "from-global", NODE_ENV: "dev" }}
        />
      );

      const keyInputs = getAllByTestId("env-editor-key") as HTMLInputElement[];
      const valueInputs = getAllByTestId("env-editor-value") as HTMLInputElement[];
      expect(keyInputs).toHaveLength(2);
      expect(keyInputs.every((el) => el.disabled)).toBe(true);
      expect(valueInputs.every((el) => el.disabled)).toBe(true);
      expect(getAllByTestId("env-editor-override")).toHaveLength(2);
      // No remove/revert buttons when all rows are inherited.
      expect(queryAllByTestId("env-editor-remove")).toHaveLength(0);
      expect(queryAllByTestId("env-editor-revert")).toHaveLength(0);
    });

    it("shows overrides first (insertion order), then inherited-only keys (insertion order)", () => {
      const { getAllByTestId } = render(
        <EnvVarEditor
          env={{ ZETA: "z", ALPHA: "a" }}
          onChange={onChange}
          inheritedEnv={{ BETA: "b", GAMMA: "g", ZETA: "inherited-z" }}
        />
      );
      const keyInputs = getAllByTestId("env-editor-key") as HTMLInputElement[];
      // Override rows keep env's insertion order; ZETA is an override of the
      // inherited ZETA, ALPHA is preset-only. Then inherited-only tail in
      // inheritedEnv's insertion order: BETA, GAMMA.
      expect(keyInputs.map((el) => el.value)).toEqual(["ZETA", "ALPHA", "BETA", "GAMMA"]);
    });

    it("clicking Override promotes an inherited row to an editable override and commits", () => {
      const { getAllByTestId, queryAllByTestId } = render(
        <EnvVarEditor env={{}} onChange={onChange} inheritedEnv={{ API_KEY: "from-global" }} />
      );

      fireEvent.click(getAllByTestId("env-editor-override")[0]!);

      // The row is no longer inherited — value input is editable now.
      const valueInput = getAllByTestId("env-editor-value")[0] as HTMLInputElement;
      expect(valueInput.disabled).toBe(false);
      // Override got seeded with the inherited value and committed.
      expect(onChange).toHaveBeenLastCalledWith({ API_KEY: "from-global" });
      // Action cell now shows Revert (this key is still inherited), not Override.
      expect(queryAllByTestId("env-editor-override")).toHaveLength(0);
      expect(queryAllByTestId("env-editor-revert")).toHaveLength(1);
    });

    it("editing an override's value commits the new value, not the inherited one", () => {
      const { getAllByTestId } = render(
        <EnvVarEditor
          env={{ API_KEY: "preset-val" }}
          onChange={onChange}
          inheritedEnv={{ API_KEY: "from-global" }}
        />
      );
      const valueInput = getAllByTestId("env-editor-value")[0] as HTMLInputElement;
      expect(valueInput.value).toBe("preset-val");
      expect(valueInput.disabled).toBe(false);

      fireEvent.change(valueInput, { target: { value: "edited" } });
      fireEvent.blur(valueInput);

      expect(onChange).toHaveBeenLastCalledWith({ API_KEY: "edited" });
    });

    it("clicking Revert on an override drops the key and commits without it", () => {
      const { getAllByTestId } = render(
        <EnvVarEditor
          env={{ API_KEY: "preset-val", STAY: "s" }}
          onChange={onChange}
          inheritedEnv={{ API_KEY: "from-global" }}
        />
      );

      fireEvent.click(getAllByTestId("env-editor-revert")[0]!);

      // Revert falls back to inherited — preset env should no longer carry the key.
      expect(onChange).toHaveBeenLastCalledWith({ STAY: "s" });
    });

    it("clearing an override's value on blur reverts to inherited (no empty-string override)", () => {
      const { getAllByTestId } = render(
        <EnvVarEditor
          env={{ API_KEY: "preset-val" }}
          onChange={onChange}
          inheritedEnv={{ API_KEY: "from-global" }}
        />
      );
      const valueInput = getAllByTestId("env-editor-value")[0] as HTMLInputElement;

      fireEvent.change(valueInput, { target: { value: "" } });
      fireEvent.blur(valueInput);

      // Must revert to inherited — an empty-string override would silently
      // mask the inherited value.
      expect(onChange).toHaveBeenLastCalledWith({});
      for (const call of onChange.mock.calls) {
        expect(call[0]).not.toMatchObject({ API_KEY: "" });
      }
    });

    it("clearing a preset-only (non-inherited) value keeps the empty-string override", () => {
      const { getAllByTestId } = render(
        <EnvVarEditor env={{ LOCAL_ONLY: "v" }} onChange={onChange} inheritedEnv={{ OTHER: "x" }} />
      );
      const valueInput = getAllByTestId("env-editor-value")[0] as HTMLInputElement;

      fireEvent.change(valueInput, { target: { value: "" } });
      fireEvent.blur(valueInput);

      // LOCAL_ONLY has no inherited counterpart — cleared value persists as "".
      expect(onChange).toHaveBeenLastCalledWith({ LOCAL_ONLY: "" });
    });

    it("Remove on an override that shadows an inherited key reverts to inherited (preserves row)", () => {
      const { getAllByTestId, queryAllByTestId } = render(
        <EnvVarEditor
          env={{ API_KEY: "preset-val" }}
          onChange={onChange}
          inheritedEnv={{ API_KEY: "from-global" }}
        />
      );

      // An override that shadows an inherited key renders the Revert action
      // (not Remove) — there's no X button to click for this row.
      expect(queryAllByTestId("env-editor-remove")).toHaveLength(0);
      fireEvent.click(getAllByTestId("env-editor-revert")[0]!);
      expect(onChange).toHaveBeenLastCalledWith({});
    });

    it("inherited-only editor with no overrides is not 'empty' (renders inherited rows, not the empty-state CTA)", () => {
      const { queryByText, getAllByTestId } = render(
        <EnvVarEditor env={{}} onChange={onChange} inheritedEnv={{ A: "1" }} />
      );
      expect(queryByText(/Add your first variable/i)).toBeNull();
      expect(getAllByTestId("env-editor-key")).toHaveLength(1);
    });

    it("fully-empty editor (no env, no inherited keys) shows the empty-state CTA", () => {
      const { getByText } = render(<EnvVarEditor env={{}} onChange={onChange} inheritedEnv={{}} />);
      expect(getByText(/Add your first variable/i)).toBeTruthy();
    });

    it("inheritedEnv prop updates trigger a reseed when keys/values differ", () => {
      const { rerender, getAllByTestId } = render(
        <EnvVarEditor env={{}} onChange={onChange} inheritedEnv={{ A: "1" }} contextKey="p" />
      );
      expect(getAllByTestId("env-editor-key")).toHaveLength(1);

      rerender(
        <EnvVarEditor
          env={{}}
          onChange={onChange}
          inheritedEnv={{ A: "1", B: "2" }}
          contextKey="p"
        />
      );
      const keyInputs = getAllByTestId("env-editor-key") as HTMLInputElement[];
      expect(keyInputs).toHaveLength(2);
      expect(keyInputs.map((el) => el.value)).toEqual(["A", "B"]);
    });

    it("a fresh empty-object identity for env/inheritedEnv does NOT trigger a spurious reseed", () => {
      const { rerender, getAllByTestId } = render(
        <EnvVarEditor env={{}} onChange={onChange} inheritedEnv={{ A: "1" }} />
      );
      fireEvent.click(getAllByTestId("env-editor-override")[0]!);
      // Onchange fires with the override commit.
      expect(onChange).toHaveBeenLastCalledWith({ A: "1" });
      const commitsBeforeRerender = onChange.mock.calls.length;

      // Parent re-renders with the same logical env (now {A:"1"}) but passes a
      // fresh inherited-env object identity — this must not stomp the override.
      rerender(<EnvVarEditor env={{ A: "1" }} onChange={onChange} inheritedEnv={{ A: "1" }} />);
      expect(onChange.mock.calls.length).toBe(commitsBeforeRerender);
      const valueInput = getAllByTestId("env-editor-value")[0] as HTMLInputElement;
      expect(valueInput.disabled).toBe(false); // still an override, not reseeded back to inherited
    });
  });

  describe("Import .env flow", () => {
    it("renders Import button in the empty state", () => {
      renderEditor({});
      expect(screen.getByTestId("env-editor-import")).toBeTruthy();
    });

    it("renders Import button in the non-empty toolbar", () => {
      renderEditor({ FOO: "bar" });
      expect(screen.getByTestId("env-editor-import")).toBeTruthy();
    });

    it("clicking Import opens the dialog", () => {
      renderEditor({ FOO: "bar" });
      fireEvent.click(screen.getByTestId("env-editor-import"));
      expect(screen.getByTestId("import-env-dialog")).toBeTruthy();
      expect(screen.getByTestId("import-env-textarea")).toBeTruthy();
    });

    it("parse errors block the confirm button and surface the error block", () => {
      renderEditor({});
      fireEvent.click(screen.getByTestId("env-editor-import"));
      const textarea = screen.getByTestId("import-env-textarea") as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: "NOT_A_PAIR" } });

      expect(screen.getByTestId("import-env-errors")).toBeTruthy();
      const primary = screen.getByTestId("app-dialog-primary") as HTMLButtonElement;
      expect(primary.disabled).toBe(true);
    });

    it("no-conflict import merges additively and calls onChange", () => {
      renderEditor({ EXISTING: "keep" });
      fireEvent.click(screen.getByTestId("env-editor-import"));
      const textarea = screen.getByTestId("import-env-textarea") as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: "NEW_ONE=1\nNEW_TWO=2" } });

      const primary = screen.getByTestId("app-dialog-primary") as HTMLButtonElement;
      expect(primary.disabled).toBe(false);
      expect(primary.textContent).toMatch(/Import 2/);
      fireEvent.click(primary);

      expect(onChange).toHaveBeenLastCalledWith({
        EXISTING: "keep",
        NEW_ONE: "1",
        NEW_TWO: "2",
      });
      // Dialog closes after import
      expect(screen.queryByTestId("import-env-dialog")).toBeNull();
    });

    it("conflicting import advances to conflict step and 'keep existing' preserves old values", () => {
      renderEditor({ EXISTING: "old", OTHER: "untouched" });
      fireEvent.click(screen.getByTestId("env-editor-import"));
      fireEvent.change(screen.getByTestId("import-env-textarea"), {
        target: { value: "EXISTING=new\nBRAND_NEW=fresh" },
      });

      const primary = screen.getByTestId("app-dialog-primary") as HTMLButtonElement;
      expect(primary.textContent).toMatch(/Review 1 conflict/);
      fireEvent.click(primary);

      // Now on the conflict step — "keep" is the default.
      expect(screen.getByTestId("import-env-conflict-list")).toBeTruthy();
      const confirm = screen.getByTestId("app-dialog-primary") as HTMLButtonElement;
      expect(confirm.textContent).toMatch(/Import, keep existing/);
      fireEvent.click(confirm);

      expect(onChange).toHaveBeenLastCalledWith({
        EXISTING: "old",
        OTHER: "untouched",
        BRAND_NEW: "fresh",
      });
    });

    it("'overwrite conflicts' replaces colliding values", () => {
      renderEditor({ EXISTING: "old" });
      fireEvent.click(screen.getByTestId("env-editor-import"));
      fireEvent.change(screen.getByTestId("import-env-textarea"), {
        target: { value: "EXISTING=new" },
      });
      fireEvent.click(screen.getByTestId("app-dialog-primary"));

      // Switch to overwrite mode.
      fireEvent.click(screen.getByTestId("import-env-mode-overwrite"));
      fireEvent.click(screen.getByTestId("app-dialog-primary"));

      expect(onChange).toHaveBeenLastCalledWith({ EXISTING: "new" });
    });

    it("imported rows appear in the editor after merge (controlled parent)", () => {
      function Controlled() {
        const [env, setEnv] = useState<Record<string, string>>({});
        return (
          <EnvVarEditor
            env={env}
            onChange={(next) => {
              onChange(next);
              setEnv(next);
            }}
          />
        );
      }
      const { getAllByTestId } = render(<Controlled />);
      fireEvent.click(screen.getByTestId("env-editor-import"));
      fireEvent.change(screen.getByTestId("import-env-textarea"), {
        target: { value: 'FOO=bar\nBAZ="hello world"' },
      });
      fireEvent.click(screen.getByTestId("app-dialog-primary"));

      const keyInputs = getAllByTestId("env-editor-key") as HTMLInputElement[];
      expect(keyInputs.map((el) => el.value).sort()).toEqual(["BAZ", "FOO"]);
      const valueInputs = getAllByTestId("env-editor-value") as HTMLInputElement[];
      expect(valueInputs.some((el) => el.value === "hello world")).toBe(true);
    });

    it("closing and reopening the dialog clears the textarea", () => {
      renderEditor({});
      fireEvent.click(screen.getByTestId("env-editor-import"));
      const first = screen.getByTestId("import-env-textarea") as HTMLTextAreaElement;
      fireEvent.change(first, { target: { value: "FOO=bar" } });
      expect(first.value).toBe("FOO=bar");

      // Cancel closes the dialog.
      fireEvent.click(screen.getByTestId("app-dialog-secondary"));
      expect(screen.queryByTestId("import-env-dialog")).toBeNull();

      // Reopening yields a fresh empty textarea.
      fireEvent.click(screen.getByTestId("env-editor-import"));
      const second = screen.getByTestId("import-env-textarea") as HTMLTextAreaElement;
      expect(second.value).toBe("");
    });

    it("imported value that looks like a secret triggers the row warning (controlled parent)", () => {
      function Controlled() {
        const [env, setEnv] = useState<Record<string, string>>({});
        return (
          <EnvVarEditor
            env={env}
            onChange={(next) => {
              onChange(next);
              setEnv(next);
            }}
          />
        );
      }
      render(<Controlled />);
      fireEvent.click(screen.getByTestId("env-editor-import"));
      fireEvent.change(screen.getByTestId("import-env-textarea"), {
        target: { value: "ANTHROPIC_API_KEY=sk-ant-abcdefghijklmnopqrstuvwxyz123456" },
      });
      fireEvent.click(screen.getByTestId("app-dialog-primary"));

      expect(screen.getByTestId("env-editor-warning-secret")).toBeTruthy();
    });

    it("same-value paste is NOT flagged as a conflict", () => {
      renderEditor({ FOO: "bar" });
      fireEvent.click(screen.getByTestId("env-editor-import"));
      fireEvent.change(screen.getByTestId("import-env-textarea"), {
        target: { value: "FOO=bar\nBAZ=baz" },
      });

      const primary = screen.getByTestId("app-dialog-primary") as HTMLButtonElement;
      // No conflict — primary should be direct Import, not Review.
      expect(primary.textContent).toMatch(/Import/);
      expect(primary.textContent).not.toMatch(/conflict/i);
      fireEvent.click(primary);

      expect(onChange).toHaveBeenLastCalledWith({ FOO: "bar", BAZ: "baz" });
    });

    it("duplicate keys within the paste collapse with last-value-wins", () => {
      renderEditor({ API_KEY: "old" });
      fireEvent.click(screen.getByTestId("env-editor-import"));
      fireEvent.change(screen.getByTestId("import-env-textarea"), {
        target: { value: "API_KEY=one\nAPI_KEY=two" },
      });

      // Summary should note the collapsed duplicate.
      expect(screen.getByTestId("import-env-summary").textContent).toMatch(/duplicate key/i);

      // Advance to conflict step and overwrite.
      fireEvent.click(screen.getByTestId("app-dialog-primary"));
      fireEvent.click(screen.getByTestId("import-env-mode-overwrite"));
      fireEvent.click(screen.getByTestId("app-dialog-primary"));

      // Last-value-wins → "two", not "one".
      expect(onChange).toHaveBeenLastCalledWith({ API_KEY: "two" });
    });

    it("Back button from conflict step returns to paste step preserving text", () => {
      renderEditor({ FOO: "old" });
      fireEvent.click(screen.getByTestId("env-editor-import"));
      fireEvent.change(screen.getByTestId("import-env-textarea"), {
        target: { value: "FOO=new" },
      });
      fireEvent.click(screen.getByTestId("app-dialog-primary"));

      // On conflict step — secondary is "Back".
      const back = screen.getByTestId("app-dialog-secondary") as HTMLButtonElement;
      expect(back.textContent).toBe("Back");
      fireEvent.click(back);

      // Paste step with retained text.
      const textarea = screen.getByTestId("import-env-textarea") as HTMLTextAreaElement;
      expect(textarea.value).toBe("FOO=new");
    });
  });
});
