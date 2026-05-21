// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfirmDialog, __devWarnedKeys } from "../ConfirmDialog";
import { TypedNameConfirmInput } from "../TypedNameConfirmInput";

vi.mock("zustand/react/shallow", () => ({
  useShallow: (fn: unknown) => fn,
}));

vi.mock("@/store", () => ({
  usePortalStore: () => ({ isOpen: false, width: 0 }),
}));

vi.mock("@/hooks", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    useOverlayState: () => {},
  };
});

vi.mock("@/hooks/useAnimatedPresence", () => ({
  useAnimatedPresence: ({ isOpen }: { isOpen: boolean }) => ({
    isVisible: isOpen,
    shouldRender: isOpen,
  }),
}));

vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
);

describe("ConfirmDialog destructive-label dev guard", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    __devWarnedKeys.clear();
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));
  });

  afterEach(() => {
    errorSpy.mockRestore();
    vi.unstubAllEnvs();
  });

  it("warns when confirmLabel looks destructive but variant is default", () => {
    render(
      <ConfirmDialog
        isOpen={true}
        onClose={() => {}}
        title="Delete it?"
        confirmLabel="Delete worktree"
        onConfirm={() => {}}
        variant="default"
      />
    );

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0]?.[0]).toContain("[ConfirmDialog]");
    expect(errorSpy.mock.calls[0]?.[0]).toContain("Delete worktree");
    expect(errorSpy.mock.calls[0]?.[0]).toContain('variant="default"');
  });

  it("is silent when variant is destructive", () => {
    render(
      <ConfirmDialog
        isOpen={true}
        onClose={() => {}}
        title="Delete it?"
        confirmLabel="Delete worktree"
        onConfirm={() => {}}
        variant="destructive"
      />
    );

    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("is silent when label does not look destructive", () => {
    render(
      <ConfirmDialog
        isOpen={true}
        onClose={() => {}}
        title="Save?"
        confirmLabel="Save changes"
        onConfirm={() => {}}
        variant="default"
      />
    );

    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("matches case-insensitively and tolerates leading whitespace", () => {
    render(
      <ConfirmDialog
        isOpen={true}
        onClose={() => {}}
        title="Remove?"
        confirmLabel="REMOVE recipe"
        onConfirm={() => {}}
        variant="default"
      />
    );

    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it("is silent in production builds", () => {
    vi.stubEnv("DEV", false);

    render(
      <ConfirmDialog
        isOpen={true}
        onClose={() => {}}
        title="Delete it?"
        confirmLabel="Delete worktree"
        onConfirm={() => {}}
        variant="default"
      />
    );

    expect(errorSpy).not.toHaveBeenCalled();
  });
});

describe("ConfirmDialog inverse-label dev guard", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    __devWarnedKeys.clear();
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));
  });

  afterEach(() => {
    cleanup();
    errorSpy.mockRestore();
    vi.unstubAllEnvs();
  });

  it.each([
    "OK",
    "Confirm",
    "Yes",
    "Save",
    "Continue",
    "Proceed",
    "Done",
    "Got it",
    "Accept",
    "Apply",
    "Submit",
  ])(
    "warns when variant is destructive and confirmLabel is a generic recovery label: %s",
    (label) => {
      render(
        <ConfirmDialog
          isOpen={true}
          onClose={() => {}}
          title="Delete it?"
          confirmLabel={label}
          onConfirm={() => {}}
          variant="destructive"
        />
      );

      expect(errorSpy).toHaveBeenCalledTimes(1);
      const message = String(errorSpy.mock.calls[0]?.[0] ?? "");
      expect(message).toContain("[ConfirmDialog]");
      expect(message).toContain(label);
      expect(message).toContain("verb-noun");
    }
  );

  it("matches case-insensitively and tolerates surrounding whitespace", () => {
    render(
      <ConfirmDialog
        isOpen={true}
        onClose={() => {}}
        title="Delete it?"
        confirmLabel="  ok  "
        onConfirm={() => {}}
        variant="destructive"
      />
    );

    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it("is silent for verb-noun destructive labels", () => {
    render(
      <ConfirmDialog
        isOpen={true}
        onClose={() => {}}
        title="Delete it?"
        confirmLabel="Delete worktree"
        onConfirm={() => {}}
        variant="destructive"
      />
    );

    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("is silent when a generic word is part of a longer label", () => {
    render(
      <ConfirmDialog
        isOpen={true}
        onClose={() => {}}
        title="Confirm?"
        confirmLabel="Confirm deletion"
        onConfirm={() => {}}
        variant="destructive"
      />
    );

    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("is silent when variant is not destructive", () => {
    render(
      <ConfirmDialog
        isOpen={true}
        onClose={() => {}}
        title="Continue?"
        confirmLabel="Continue"
        onConfirm={() => {}}
        variant="default"
      />
    );

    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("is silent in production builds", () => {
    vi.stubEnv("DEV", false);

    render(
      <ConfirmDialog
        isOpen={true}
        onClose={() => {}}
        title="Delete it?"
        confirmLabel="OK"
        onConfirm={() => {}}
        variant="destructive"
      />
    );

    expect(errorSpy).not.toHaveBeenCalled();
  });
});

describe("ConfirmDialog warning dedup", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    __devWarnedKeys.clear();
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));
  });

  afterEach(() => {
    cleanup();
    errorSpy.mockRestore();
    vi.unstubAllEnvs();
  });

  it("logs the forward guard only once across multiple renders of the same label", () => {
    render(
      <ConfirmDialog
        isOpen={true}
        onClose={() => {}}
        title="Delete it?"
        confirmLabel="Delete worktree"
        onConfirm={() => {}}
        variant="default"
      />
    );
    render(
      <ConfirmDialog
        isOpen={true}
        onClose={() => {}}
        title="Delete it?"
        confirmLabel="Delete worktree"
        onConfirm={() => {}}
        variant="default"
      />
    );

    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it("logs the inverse guard only once across multiple renders of the same label", () => {
    render(
      <ConfirmDialog
        isOpen={true}
        onClose={() => {}}
        title="Delete?"
        confirmLabel="OK"
        onConfirm={() => {}}
        variant="destructive"
      />
    );
    render(
      <ConfirmDialog
        isOpen={true}
        onClose={() => {}}
        title="Delete?"
        confirmLabel="OK"
        onConfirm={() => {}}
        variant="destructive"
      />
    );

    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it("does not cross-suppress forward and inverse keys", () => {
    render(
      <ConfirmDialog
        isOpen={true}
        onClose={() => {}}
        title="A"
        confirmLabel="Delete worktree"
        onConfirm={() => {}}
        variant="default"
      />
    );
    render(
      <ConfirmDialog
        isOpen={true}
        onClose={() => {}}
        title="B"
        confirmLabel="OK"
        onConfirm={() => {}}
        variant="destructive"
      />
    );

    expect(errorSpy).toHaveBeenCalledTimes(2);
  });
});

describe("ConfirmDialog — typed-name gate", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    __devWarnedKeys.clear();
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));
  });

  afterEach(() => {
    cleanup();
    errorSpy.mockRestore();
    vi.unstubAllEnvs();
  });

  function findConfirmButton() {
    const buttons = Array.from(document.querySelectorAll("button")) as HTMLButtonElement[];
    const button = buttons.find((b) => b.textContent?.trim() === "Delete it");
    if (!button) throw new Error("Confirm button not found");
    return button;
  }

  function findTypedInput() {
    const input = screen.getByLabelText(/^Type .* to confirm$/i) as HTMLInputElement;
    return input;
  }

  it("renders the typed-name input and disables confirm until exact match", () => {
    render(
      <ConfirmDialog
        isOpen={true}
        onClose={() => {}}
        title="Delete repo?"
        confirmLabel="Delete it"
        onConfirm={() => {}}
        variant="destructive"
        typedNameTarget="my-repo"
      />
    );

    const input = findTypedInput();
    const button = findConfirmButton();

    expect(input).toBeDefined();
    expect(button.disabled).toBe(true);

    fireEvent.change(input, { target: { value: "my-rep" } });
    expect(button.disabled).toBe(true);

    fireEvent.change(input, { target: { value: "My-Repo" } });
    expect(button.disabled).toBe(true);

    fireEvent.change(input, { target: { value: "my-repo" } });
    expect(button.disabled).toBe(false);
  });

  it("does not call onConfirm when primary action is invoked while unmatched", () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmDialog
        isOpen={true}
        onClose={() => {}}
        title="Delete repo?"
        confirmLabel="Delete it"
        onConfirm={onConfirm}
        variant="destructive"
        typedNameTarget="my-repo"
      />
    );

    const input = findTypedInput();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("does not call onConfirm when the primary button is clicked while unmatched", () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmDialog
        isOpen={true}
        onClose={() => {}}
        title="Delete repo?"
        confirmLabel="Delete it"
        onConfirm={onConfirm}
        variant="destructive"
        typedNameTarget="my-repo"
      />
    );

    const button = findConfirmButton();
    fireEvent.click(button);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("submits on Enter when the typed value matches", () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmDialog
        isOpen={true}
        onClose={() => {}}
        title="Delete repo?"
        confirmLabel="Delete it"
        onConfirm={onConfirm}
        variant="destructive"
        typedNameTarget="my-repo"
      />
    );

    const input = findTypedInput();
    fireEvent.change(input, { target: { value: "my-repo" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("resets the typed value when the dialog closes and reopens", () => {
    const { rerender } = render(
      <ConfirmDialog
        isOpen={true}
        onClose={() => {}}
        title="Delete repo?"
        confirmLabel="Delete it"
        onConfirm={() => {}}
        variant="destructive"
        typedNameTarget="my-repo"
      />
    );

    const input = findTypedInput();
    fireEvent.change(input, { target: { value: "my-repo" } });
    expect(findConfirmButton().disabled).toBe(false);

    rerender(
      <ConfirmDialog
        isOpen={false}
        onClose={() => {}}
        title="Delete repo?"
        confirmLabel="Delete it"
        onConfirm={() => {}}
        variant="destructive"
        typedNameTarget="my-repo"
      />
    );
    rerender(
      <ConfirmDialog
        isOpen={true}
        onClose={() => {}}
        title="Delete repo?"
        confirmLabel="Delete it"
        onConfirm={() => {}}
        variant="destructive"
        typedNameTarget="my-repo"
      />
    );

    const reopenedInput = findTypedInput();
    expect(reopenedInput.value).toBe("");
    expect(findConfirmButton().disabled).toBe(true);
  });

  it("does not render the input or gate the button when typedNameTarget is empty", () => {
    render(
      <ConfirmDialog
        isOpen={true}
        onClose={() => {}}
        title="Delete repo?"
        confirmLabel="Delete it"
        onConfirm={() => {}}
        variant="destructive"
        typedNameTarget=""
      />
    );

    expect(screen.queryByLabelText(/^Type .* to confirm$/i)).toBeNull();
    expect(findConfirmButton().disabled).toBe(false);
  });

  it("warns in dev when typedNameTarget is set with a non-destructive variant", () => {
    render(
      // @ts-expect-error — intentionally violates the discriminated union to exercise the runtime fallback guard
      <ConfirmDialog
        isOpen={true}
        onClose={() => {}}
        title="Confirm?"
        confirmLabel="Continue"
        onConfirm={() => {}}
        variant="default"
        typedNameTarget="thing"
      />
    );

    expect(errorSpy).toHaveBeenCalled();
    const messages = errorSpy.mock.calls.map((call: unknown[]) => String(call[0] ?? ""));
    expect(messages.some((m: string) => m.includes("typedNameTarget"))).toBe(true);
    expect(messages.some((m: string) => m.includes('variant="default"'))).toBe(true);
  });

  it("is silent for typedNameTarget on a destructive variant", () => {
    render(
      <ConfirmDialog
        isOpen={true}
        onClose={() => {}}
        title="Delete it?"
        confirmLabel="Delete it"
        onConfirm={() => {}}
        variant="destructive"
        typedNameTarget="thing"
      />
    );

    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("does not warn in production builds", () => {
    vi.stubEnv("DEV", false);

    render(
      // @ts-expect-error — intentionally violates the discriminated union to exercise the runtime fallback guard
      <ConfirmDialog
        isOpen={true}
        onClose={() => {}}
        title="Confirm?"
        confirmLabel="Continue"
        onConfirm={() => {}}
        variant="default"
        typedNameTarget="thing"
      />
    );

    expect(errorSpy).not.toHaveBeenCalled();
  });
});

describe("ConfirmDialog — initialFocus prop forwarding", () => {
  beforeEach(() => {
    __devWarnedKeys.clear();
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllEnvs();
  });

  async function flushRaf() {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }

  it("defaults destructive variant to Cancel focus", async () => {
    render(
      <ConfirmDialog
        isOpen={true}
        onClose={() => {}}
        title="Delete 'foo'?"
        confirmLabel="Delete worktree"
        onConfirm={() => {}}
        variant="destructive"
      />
    );
    await flushRaf();

    expect(document.activeElement?.getAttribute("data-confirm-role")).toBe("cancel");
  });

  it('forwards initialFocus="confirm" to focus the Confirm button on destructive variant', async () => {
    render(
      <ConfirmDialog
        isOpen={true}
        onClose={() => {}}
        title="Delete 'foo'?"
        confirmLabel="Delete worktree"
        onConfirm={() => {}}
        variant="destructive"
        initialFocus="confirm"
      />
    );
    await flushRaf();

    expect(document.activeElement?.getAttribute("data-confirm-role")).toBe("confirm");
  });
});

describe("ConfirmDialog — are-you-sure title guard", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    __devWarnedKeys.clear();
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));
  });

  afterEach(() => {
    cleanup();
    errorSpy.mockRestore();
    vi.unstubAllEnvs();
  });

  it('warns when title is a string starting with "Are you sure"', () => {
    render(
      <ConfirmDialog
        isOpen={true}
        onClose={() => {}}
        title="Are you sure you want to delete?"
        confirmLabel="Delete worktree"
        onConfirm={() => {}}
        variant="destructive"
      />
    );

    const messages = errorSpy.mock.calls.map((call: unknown[]) => String(call[0] ?? ""));
    expect(messages.some((m: string) => m.includes("Are you sure"))).toBe(true);
    expect(messages.some((m: string) => m.includes("[ConfirmDialog]"))).toBe(true);
  });

  it("matches case-insensitively and tolerates surrounding whitespace", () => {
    render(
      <ConfirmDialog
        isOpen={true}
        onClose={() => {}}
        title="  ARE YOU SURE???"
        confirmLabel="Delete worktree"
        onConfirm={() => {}}
        variant="destructive"
      />
    );

    const messages = errorSpy.mock.calls.map((call: unknown[]) => String(call[0] ?? ""));
    expect(messages.some((m: string) => m.includes("Are you sure"))).toBe(true);
  });

  it("is silent for non-matching titles", () => {
    render(
      <ConfirmDialog
        isOpen={true}
        onClose={() => {}}
        title="Delete 'my-repo'?"
        confirmLabel="Delete worktree"
        onConfirm={() => {}}
        variant="destructive"
      />
    );

    const messages = errorSpy.mock.calls.map((call: unknown[]) => String(call[0] ?? ""));
    expect(messages.some((m: string) => m.includes("Are you sure"))).toBe(false);
  });

  it("is silent when title is a non-string ReactNode", () => {
    render(
      <ConfirmDialog
        isOpen={true}
        onClose={() => {}}
        title={<span>Are you sure?</span>}
        confirmLabel="Delete worktree"
        onConfirm={() => {}}
        variant="destructive"
      />
    );

    const messages = errorSpy.mock.calls.map((call: unknown[]) => String(call[0] ?? ""));
    expect(messages.some((m: string) => m.includes("Are you sure"))).toBe(false);
  });

  it("logs only once across multiple renders", () => {
    render(
      <ConfirmDialog
        isOpen={true}
        onClose={() => {}}
        title="Are you sure you want to delete?"
        confirmLabel="Delete worktree"
        onConfirm={() => {}}
        variant="destructive"
      />
    );
    render(
      <ConfirmDialog
        isOpen={true}
        onClose={() => {}}
        title="Are you sure you want to delete something else?"
        confirmLabel="Delete worktree"
        onConfirm={() => {}}
        variant="destructive"
      />
    );

    const messages = errorSpy.mock.calls.map((call: unknown[]) => String(call[0] ?? ""));
    const matchCount = messages.filter((m: string) => m.includes("Are you sure")).length;
    expect(matchCount).toBe(1);
  });

  it("is silent in production builds", () => {
    vi.stubEnv("DEV", false);

    render(
      <ConfirmDialog
        isOpen={true}
        onClose={() => {}}
        title="Are you sure?"
        confirmLabel="Delete worktree"
        onConfirm={() => {}}
        variant="destructive"
      />
    );

    expect(errorSpy).not.toHaveBeenCalled();
  });
});

describe("ConfirmDialog — cannot-be-undone body guard", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    __devWarnedKeys.clear();
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));
  });

  afterEach(() => {
    cleanup();
    errorSpy.mockRestore();
    vi.unstubAllEnvs();
  });

  it('warns when description contains "cannot be undone"', () => {
    render(
      <ConfirmDialog
        isOpen={true}
        onClose={() => {}}
        title="Delete 'foo'?"
        description="This cannot be undone."
        confirmLabel="Delete worktree"
        onConfirm={() => {}}
        variant="destructive"
      />
    );

    const messages = errorSpy.mock.calls.map((call: unknown[]) => String(call[0] ?? ""));
    expect(messages.some((m: string) => m.includes("cannot be undone"))).toBe(true);
  });

  it("warns on the curly-quote contraction can’t be undone", () => {
    render(
      <ConfirmDialog
        isOpen={true}
        onClose={() => {}}
        title="Delete 'foo'?"
        description={"This can’t be undone."}
        confirmLabel="Delete worktree"
        onConfirm={() => {}}
        variant="destructive"
      />
    );

    const messages = errorSpy.mock.calls.map((call: unknown[]) => String(call[0] ?? ""));
    expect(messages.some((m: string) => m.includes("cannot be undone"))).toBe(true);
  });

  it('is silent for apostrophe-less "cant be undone" (typo)', () => {
    render(
      <ConfirmDialog
        isOpen={true}
        onClose={() => {}}
        title="Delete 'foo'?"
        description="This cant be undone."
        confirmLabel="Delete worktree"
        onConfirm={() => {}}
        variant="destructive"
      />
    );

    const messages = errorSpy.mock.calls.map((call: unknown[]) => String(call[0] ?? ""));
    expect(messages.some((m: string) => m.includes("cannot be undone"))).toBe(false);
  });

  it('warns on the contraction "can\'t be undone"', () => {
    render(
      <ConfirmDialog
        isOpen={true}
        onClose={() => {}}
        title="Delete 'foo'?"
        description="This can't be undone."
        confirmLabel="Delete worktree"
        onConfirm={() => {}}
        variant="destructive"
      />
    );

    const messages = errorSpy.mock.calls.map((call: unknown[]) => String(call[0] ?? ""));
    expect(messages.some((m: string) => m.includes("cannot be undone"))).toBe(true);
  });

  it('warns when children contain a string body with "cannot be undone"', () => {
    render(
      <ConfirmDialog
        isOpen={true}
        onClose={() => {}}
        title="Delete 'foo'?"
        confirmLabel="Delete worktree"
        onConfirm={() => {}}
        variant="destructive"
      >
        {"This action cannot be undone."}
      </ConfirmDialog>
    );

    const messages = errorSpy.mock.calls.map((call: unknown[]) => String(call[0] ?? ""));
    expect(messages.some((m: string) => m.includes("cannot be undone"))).toBe(true);
  });

  it("is silent for non-matching body copy", () => {
    render(
      <ConfirmDialog
        isOpen={true}
        onClose={() => {}}
        title="Delete 'foo'?"
        description="The worktree at /tmp/foo and its branch foo-branch will be removed."
        confirmLabel="Delete worktree"
        onConfirm={() => {}}
        variant="destructive"
      />
    );

    const messages = errorSpy.mock.calls.map((call: unknown[]) => String(call[0] ?? ""));
    expect(messages.some((m: string) => m.includes("cannot be undone"))).toBe(false);
  });

  it("is silent when description is a non-string ReactNode containing the phrase", () => {
    render(
      <ConfirmDialog
        isOpen={true}
        onClose={() => {}}
        title="Delete 'foo'?"
        description={<span>This cannot be undone.</span>}
        confirmLabel="Delete worktree"
        onConfirm={() => {}}
        variant="destructive"
      />
    );

    const messages = errorSpy.mock.calls.map((call: unknown[]) => String(call[0] ?? ""));
    expect(messages.some((m: string) => m.includes("cannot be undone"))).toBe(false);
  });

  it("logs only once across multiple renders", () => {
    render(
      <ConfirmDialog
        isOpen={true}
        onClose={() => {}}
        title="Delete 'foo'?"
        description="This cannot be undone."
        confirmLabel="Delete worktree"
        onConfirm={() => {}}
        variant="destructive"
      />
    );
    render(
      <ConfirmDialog
        isOpen={true}
        onClose={() => {}}
        title="Delete 'bar'?"
        description="This cannot be undone."
        confirmLabel="Delete worktree"
        onConfirm={() => {}}
        variant="destructive"
      />
    );

    const messages = errorSpy.mock.calls.map((call: unknown[]) => String(call[0] ?? ""));
    const matchCount = messages.filter((m: string) => m.includes("cannot be undone")).length;
    expect(matchCount).toBe(1);
  });

  it("is silent in production builds", () => {
    vi.stubEnv("DEV", false);

    render(
      <ConfirmDialog
        isOpen={true}
        onClose={() => {}}
        title="Delete 'foo'?"
        description="This cannot be undone."
        confirmLabel="Delete worktree"
        onConfirm={() => {}}
        variant="destructive"
      />
    );

    expect(errorSpy).not.toHaveBeenCalled();
  });
});

describe("TypedNameConfirmInput preamble prop", () => {
  it("renders the preamble before the canonical instruction when no override is provided", () => {
    render(
      <TypedNameConfirmInput
        target="my-thing"
        value=""
        onChange={() => {}}
        preamble="Force-deleting this protected worktree is irreversible."
      />
    );

    const preamble = screen.getByText("Force-deleting this protected worktree is irreversible.");
    const instruction = screen.getByText(/to confirm\.?/);
    expect(preamble).toBeDefined();
    expect(instruction).toBeDefined();

    const position = preamble.compareDocumentPosition(instruction);
    expect(position & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("links the preamble id into aria-describedby alongside the instructions id", () => {
    render(
      <TypedNameConfirmInput target="my-thing" value="" onChange={() => {}} preamble="Heads up." />
    );

    const input = screen.getByLabelText(/^Type my-thing to confirm$/i);
    const tokens = (input.getAttribute("aria-describedby") ?? "").split(" ").filter(Boolean);
    expect(tokens).toHaveLength(2);
    const [first, second] = tokens.map((id) => document.getElementById(id));
    expect(first?.textContent).toBe("Heads up.");
    expect(second?.textContent).toMatch(/to confirm\.?/);
  });

  it("renders only the default instruction when preamble is absent", () => {
    render(<TypedNameConfirmInput target="my-thing" value="" onChange={() => {}} />);

    expect(
      screen.queryByText("Force-deleting this protected worktree is irreversible.")
    ).toBeNull();
    expect(screen.getByText(/to confirm\.?/)).toBeDefined();
  });

  it("suppresses the preamble when an explicit instructions override is provided", () => {
    render(
      <TypedNameConfirmInput
        target="my-thing"
        value=""
        onChange={() => {}}
        preamble="Preamble text."
        instructions={<>Custom instructions only.</>}
      />
    );

    expect(screen.queryByText("Preamble text.")).toBeNull();
    expect(screen.getByText("Custom instructions only.")).toBeDefined();
  });

  it('always sets aria-required="true"', () => {
    render(<TypedNameConfirmInput target="my-thing" value="" onChange={() => {}} />);

    const input = screen.getByLabelText(/^Type my-thing to confirm$/i);
    expect(input.getAttribute("aria-required")).toBe("true");
  });

  it("does not signal aria-invalid for a pristine empty value", () => {
    render(<TypedNameConfirmInput target="my-thing" value="" onChange={() => {}} />);

    const input = screen.getByLabelText(/^Type my-thing to confirm$/i);
    // React omits aria-invalid={false}, so the attribute should be absent or "false"
    expect(input.getAttribute("aria-invalid")).not.toBe("true");
  });

  it('sets aria-invalid="true" once the user has typed something that does not match', () => {
    render(<TypedNameConfirmInput target="my-thing" value="my-thi" onChange={() => {}} />);

    const input = screen.getByLabelText(/^Type my-thing to confirm$/i);
    expect(input.getAttribute("aria-invalid")).toBe("true");
  });

  it("does not signal aria-invalid once the typed value matches the target", () => {
    render(<TypedNameConfirmInput target="my-thing" value="my-thing" onChange={() => {}} />);

    const input = screen.getByLabelText(/^Type my-thing to confirm$/i);
    expect(input.getAttribute("aria-invalid")).not.toBe("true");
  });
});
