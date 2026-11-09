// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, cleanup, within } from "@testing-library/react";
import type { ReactNode } from "react";

interface MockAction {
  label: string;
  onClick: () => void;
}

vi.mock("@/components/ui/AppDialog", () => {
  const Dialog = ({ children, isOpen }: { children: ReactNode; isOpen: boolean }) =>
    isOpen ? <div role="dialog">{children}</div> : null;
  Dialog.Header = ({ children }: { children: ReactNode }) => <div>{children}</div>;
  Dialog.Title = ({ children }: { children: ReactNode }) => <h2>{children}</h2>;
  Dialog.CloseButton = () => <button type="button" aria-label="Close dialog" />;
  Dialog.Body = ({ children }: { children: ReactNode }) => <div>{children}</div>;
  Dialog.Footer = ({ primaryAction }: { primaryAction?: MockAction }) =>
    primaryAction ? (
      <button type="button" data-confirm-role="confirm" onClick={primaryAction.onClick}>
        {primaryAction.label}
      </button>
    ) : null;
  return { AppDialog: Dialog };
});
vi.mock("@/components/ui/ConfirmDialog", () => ({ ConfirmDialog: () => null }));
vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
}));
vi.mock("@/components/TerminalRecipe/RecipeVariablePreview", () => ({
  RecipeVariablePreview: () => null,
}));

import { RecipeEditor } from "../RecipeEditor";
import { useRecipeStore } from "@/store/recipeStore";
import { useProjectStore } from "@/store/projectStore";
import type { RecipeLayoutOmissions } from "@/store/recipeStore";
import { BUILT_IN_AGENT_IDS } from "@shared/config/agentIds";
import { getAgentDisplayTitle } from "@/config/agents";
import type { Project, RecipeTerminal, TerminalRecipe } from "@/types";
import { getAvailableVariables } from "@/utils/recipeVariables";
import {
  ENV_KEY_DUPLICATE_MESSAGE,
  ENV_KEY_INVALID_MESSAGE,
} from "@/components/Settings/EnvVarRow";
import { ENV_VALUE_CONTROL_CHAR_MESSAGE } from "../recipeStepEnv";

const RECIPE: TerminalRecipe = {
  id: "r1",
  name: "Full stack",
  projectId: "proj",
  createdAt: 0,
  terminals: [
    { type: "dev-preview", title: "Dev", devCommand: "npm run dev", env: {} },
    { type: "terminal", title: "API", command: "npm run api", env: {} },
    { type: "claude", title: "Agent", initialPrompt: "Go", env: {} },
  ],
};

/** The tokens that make a control read as a field: fill, edge, corner, focus ring. */
function chrome(el: Element): string[] {
  return [...el.classList]
    .filter((t) => /^(bg-surface-|border-border-|rounded-|focus-visible:outline)/.test(t))
    .sort();
}

const updateRecipe = vi.fn<ReturnType<typeof useRecipeStore.getState>["updateRecipe"]>();
const createRecipe = vi.fn();

beforeEach(() => {
  updateRecipe.mockReset().mockResolvedValue("saved");
  createRecipe.mockReset().mockResolvedValue(undefined);
  useRecipeStore.setState({ updateRecipe, createRecipe });
  useProjectStore.setState({
    currentProject: { id: "proj", name: "proj", path: "/p", emoji: "🌲", lastOpened: 0 } as Project,
  });
});

afterEach(cleanup);

const renderEditor = (recipe?: TerminalRecipe) =>
  render(<RecipeEditor recipe={recipe} isOpen onClose={() => {}} />);

describe("RecipeEditor", () => {
  // One form, one field style: a terminal card's controls must be the same
  // control as the recipe's own rows, not a second, near-miss look.
  it("draws every field in the family chrome, cards included", () => {
    renderEditor(RECIPE);
    const fields = document.querySelectorAll(
      '[role="dialog"] input[type="text"], [role="dialog"] textarea, [role="dialog"] [role="combobox"]'
    );
    expect(fields.length).toBeGreaterThan(8);
    // The recipe's own auto-assign row is the reference: whatever the family's
    // chrome is today, every other field in the form must match it.
    const family = chrome(document.getElementById("auto-assign")!);
    expect(family.some((t) => t.startsWith("focus-visible:outline"))).toBe(true);
    expect(family.some((t) => t.startsWith("bg-surface-"))).toBe(true);
    for (const field of fields) {
      expect(chrome(field).join(" "), `#${field.id}`).toEqual(family.join(" "));
    }
  });

  // A select shows nothing for a value it has no item for, so every stored
  // value a recipe can carry has to land on a named choice.
  it("names the stored type and exit behaviour of a captured terminal", () => {
    renderEditor({
      ...RECIPE,
      terminals: [
        { type: "terminal", title: "Loop", command: "npm run w", exitBehavior: "restart", env: {} },
        { type: "no-such-agent", title: "Other", env: {} },
      ],
    });
    for (const id of ["terminal-exit-behavior-0", "terminal-type-1"]) {
      expect(document.getElementById(id)?.textContent?.trim(), id).toBeTruthy();
    }
  });

  it("names each terminal card as a group, with a remove button that says which", () => {
    renderEditor(RECIPE);
    const groups = screen
      .getAllByRole("group")
      .filter((g) => g.querySelector('button[aria-label^="Remove terminal"]'));
    expect(groups).toHaveLength(3);
    const names = groups.map(
      (g) => document.getElementById(g.getAttribute("aria-labelledby") ?? "")?.textContent
    );
    expect(new Set(names).size).toBe(3);
    const removes = screen.getAllByRole("button", { name: /^Remove terminal / });
    expect(new Set(removes.map((b) => b.getAttribute("aria-label"))).size).toBe(3);
  });

  it("lists every recipe variable under an agent's initial prompt (#16381)", () => {
    renderEditor(RECIPE);
    const hint = document.getElementById("terminal-initial-prompt-help-2")!;
    const listed = [...hint.querySelectorAll("code")].map((el) => el.textContent);
    expect(listed).toEqual(getAvailableVariables().map((v) => `{{${v.name}}}`));
    expect(listed).toContain("{{issue_title}}");
  });

  it("submits on Enter from a single-line field, never from the prompt", async () => {
    renderEditor(RECIPE);
    fireEvent.keyDown(document.getElementById("terminal-initial-prompt-2")!, { key: "Enter" });
    expect(updateRecipe).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.keyDown(document.getElementById("terminal-command-1")!, { key: "Enter" });
    });
    expect(updateRecipe).toHaveBeenCalledTimes(1);
  });

  it("marks a missing name on the name field itself and saves nothing", async () => {
    renderEditor();
    await act(async () => {
      screen.getByRole("button", { name: "Create recipe" }).click();
    });
    const name = document.getElementById("recipe-name")!;
    expect(name.getAttribute("aria-invalid")).toBe("true");
    const describedBy = name.getAttribute("aria-describedby") ?? "";
    const error = describedBy
      .split(/\s+/)
      .map((id) => document.getElementById(id))
      .find((el) => el?.dataset.slot === "field-error");
    expect(error?.textContent).toContain("Name the recipe");
    expect(document.activeElement).toBe(name);
    expect(createRecipe).not.toHaveBeenCalled();

    fireEvent.change(name, { target: { value: "Build" } });
    expect(name.getAttribute("aria-invalid")).toBeNull();
  });

  it("reports a failed save in the shared error banner", async () => {
    updateRecipe.mockRejectedValue(new Error("EACCES"));
    renderEditor(RECIPE);
    await act(async () => {
      screen.getByRole("button", { name: "Update recipe" }).click();
    });
    const banner = document.querySelector("[data-inline-status-banner]");
    expect(banner?.textContent).toContain("EACCES");
  });

  it("hands focus to the added card, and to a surviving card after a removal", () => {
    renderEditor(RECIPE);
    act(() => {
      screen.getByRole("button", { name: /Add terminal/ }).click();
    });
    expect(document.activeElement?.closest('[role="group"]')).toBe(
      screen.getByRole("button", { name: "Remove terminal 4" }).closest('[role="group"]')
    );

    const titleOfSecond = document.getElementById("terminal-title-1")?.getAttribute("value");
    expect(titleOfSecond).toBeTruthy();
    act(() => {
      screen.getByRole("button", { name: "Remove terminal 1" }).click();
    });
    const focusedCard = document.activeElement?.closest('[role="group"]');
    expect(
      focusedCard?.querySelector<HTMLInputElement>('input[id^="terminal-title-"]')?.value
    ).toBe(titleOfSecond);
  });

  it("starts a new recipe on a scope it can save to when no project is open", async () => {
    useProjectStore.setState({ currentProject: null });
    renderEditor();
    const scope = document.getElementById("recipe-scope")!;
    expect(scope.textContent).toMatch(/^Global/);
    fireEvent.keyDown(scope, { key: "ArrowDown" });
    const project = await screen.findByRole("option", { name: /^Team/ });
    expect(project.getAttribute("aria-disabled")).toBe("true");
    fireEvent.keyDown(project, { key: "Escape" });

    fireEvent.change(document.getElementById("recipe-name")!, { target: { value: "Build" } });
    await act(async () => {
      screen.getByRole("button", { name: "Create recipe" }).click();
    });
    expect(createRecipe).toHaveBeenCalledTimes(1);
    expect(createRecipe.mock.calls[0]?.[0]).toBeUndefined();
    expect(document.querySelector("[data-inline-status-banner]")).toBeNull();
  });

  it("says a new project recipe is written into the repository before it is saved", () => {
    renderEditor();
    const help = document.getElementById("recipe-scope-help")!;
    expect(help.textContent).toContain(".daintree/recipes/");
    expect(document.getElementById("recipe-scope")!.getAttribute("aria-describedby")).toBe(
      "recipe-scope-help"
    );
  });

  // The type picker is one stray click from a long prompt: a switch keeps what
  // the step had for its old type, for as long as the editor stays open.
  describe("switching a step's type", () => {
    const pickType = async (index: number, label: string) => {
      const trigger = document.getElementById(`terminal-type-${index}`)!;
      fireEvent.keyDown(trigger, { key: "ArrowDown" });
      const option = await screen.findByRole("option", { name: label });
      await act(async () => {
        option.click();
      });
      expect(document.getElementById(`terminal-type-${index}`)?.textContent).toBe(label);
    };
    const value = (id: string) => {
      const field = document.getElementById(id);
      return field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement
        ? field.value
        : undefined;
    };
    const type = (id: string, text: string) =>
      fireEvent.change(document.getElementById(id)!, { target: { value: text } });
    const saveTerminals = async () => {
      await act(async () => {
        screen.getByRole("button", { name: "Update recipe" }).click();
      });
      return updateRecipe.mock.calls.at(-1)?.[1].terminals ?? [];
    };

    const AGENT_RECIPE: TerminalRecipe = {
      ...RECIPE,
      terminals: [
        {
          type: "claude",
          title: "Agent",
          initialPrompt: "Review the diff",
          args: "--model opus",
          env: {},
        },
      ],
    };

    it("brings back an agent's prompt and arguments after a trip through Terminal", async () => {
      renderEditor(AGENT_RECIPE);
      await pickType(0, "Terminal");
      expect(value("terminal-initial-prompt-0")).toBeUndefined();
      expect(value("terminal-command-0")).toBe("");
      type("terminal-command-0", "npm test");

      await pickType(0, "Claude");
      expect(value("terminal-initial-prompt-0")).toBe("Review the diff");
      expect(value("terminal-args-0")).toBe("--model opus");

      await pickType(0, "Terminal");
      expect(value("terminal-command-0")).toBe("npm test");

      type("terminal-command-0", "");
      await pickType(0, "Claude");
      await pickType(0, "Terminal");
      expect(value("terminal-command-0")).toBe("");
    });

    it("carries the prompt to another agent and keeps it when the step comes back", async () => {
      renderEditor(AGENT_RECIPE);
      await pickType(0, "Codex");
      expect(value("terminal-initial-prompt-0")).toBe("Review the diff");
      await pickType(0, "Dev server");
      await pickType(0, "Gemini");
      expect(value("terminal-initial-prompt-0")).toBe("Review the diff");
      expect(value("terminal-args-0")).toBe("--model opus");
    });

    it("brings back a dev server's command", async () => {
      renderEditor(RECIPE);
      await pickType(0, "Terminal");
      expect(value("terminal-dev-command-0")).toBeUndefined();
      await pickType(0, "Dev server");
      expect(value("terminal-dev-command-0")).toBe("npm run dev");

      type("terminal-dev-command-0", "vite");
      await pickType(0, "Claude");
      await pickType(0, "Dev server");
      expect(value("terminal-dev-command-0")).toBe("vite");
    });

    it("still starts each type from its own command", async () => {
      renderEditor({
        ...RECIPE,
        terminals: [{ type: "claude", title: "Agent", command: "claude --resume", env: {} }],
      });
      await pickType(0, "Codex");
      expect((await saveTerminals())[0]).toMatchObject({ type: "codex", command: "" });
      await pickType(0, "Claude");
      expect((await saveTerminals())[0]).toMatchObject({
        type: "claude",
        command: "claude --resume",
      });
    });

    it("saves only the fields of the type the step ends on", async () => {
      renderEditor({
        ...RECIPE,
        terminals: [AGENT_RECIPE.terminals[0]!, RECIPE.terminals[0]!, RECIPE.terminals[0]!],
      });
      await pickType(0, "Dev server");
      await pickType(1, "Terminal");
      await pickType(2, "Codex");
      const saved = await saveTerminals();
      expect(saved[0]).toMatchObject({ type: "dev-preview", initialPrompt: "", args: "" });
      expect(saved[1]).toMatchObject({ type: "terminal", devCommand: "" });
      expect(saved[2]).toMatchObject({ type: "codex", devCommand: "" });
    });

    it("brings back the latest prompt, including one edited under another agent", async () => {
      renderEditor(AGENT_RECIPE);
      await pickType(0, "Codex");
      type("terminal-initial-prompt-0", "");
      type("terminal-args-0", "--model sonnet");
      await pickType(0, "Terminal");
      await pickType(0, "Claude");
      expect(value("terminal-initial-prompt-0")).toBe("");
      expect(value("terminal-args-0")).toBe("--model sonnet");
    });

    it("offers every built-in agent in the registry's order, under the registry's names", () => {
      renderEditor(AGENT_RECIPE);
      fireEvent.keyDown(document.getElementById("terminal-type-0")!, { key: "ArrowDown" });
      const offered = screen.getAllByRole("option").map((o) => o.textContent);
      expect(offered).toEqual([
        "Terminal",
        ...BUILT_IN_AGENT_IDS.map((id) => getAgentDisplayTitle(id)),
        "Dev server",
      ]);
    });

    it("lets a new step pick an agent the editor used to leave out", async () => {
      renderEditor(AGENT_RECIPE);
      await pickType(0, "Aider");
      expect((await saveTerminals())[0]?.type).toBe("aider");
    });

    it("keeps offering a captured agent the picker doesn't list, so the step can go back", async () => {
      renderEditor({
        ...RECIPE,
        terminals: [
          {
            type: "acme-agent" as RecipeTerminal["type"],
            title: "Agent",
            initialPrompt: "Fix it",
            env: {},
          },
        ],
      });
      const captured = document.getElementById("terminal-type-0")!.textContent!;
      await pickType(0, "Terminal");
      await pickType(0, captured);
      expect(value("terminal-initial-prompt-0")).toBe("Fix it");
    });

    it("keeps each step's own fields when an earlier step is removed", async () => {
      renderEditor({
        ...RECIPE,
        terminals: [AGENT_RECIPE.terminals[0]!, RECIPE.terminals[0]!],
      });
      await pickType(0, "Terminal");
      await pickType(1, "Claude");
      expect(value("terminal-initial-prompt-1")).toBe("");
      act(() => {
        screen.getByRole("button", { name: "Remove terminal 1" }).click();
      });
      await pickType(0, "Dev server");
      expect(value("terminal-dev-command-0")).toBe("npm run dev");

      act(() => {
        screen.getByRole("button", { name: /Add terminal/ }).click();
      });
      await pickType(1, "Dev server");
      expect(value("terminal-dev-command-1")).toBe("");
    });

    it("forgets what a step held once the editor is closed and opened again", async () => {
      const view = renderEditor(RECIPE);
      await pickType(0, "Terminal");
      view.rerender(<RecipeEditor recipe={RECIPE} isOpen={false} onClose={() => {}} />);
      view.rerender(
        <RecipeEditor
          recipe={{ ...RECIPE, terminals: [{ type: "terminal", title: "Dev", env: {} }] }}
          isOpen
          onClose={() => {}}
        />
      );
      await pickType(0, "Dev server");
      expect(value("terminal-dev-command-0")).toBe("");
    });
  });

  describe("environment variables (#16446)", () => {
    const ENV_RECIPE: TerminalRecipe = {
      ...RECIPE,
      terminals: [
        { ...RECIPE.terminals[0]!, env: { PORT: "3000", NODE_ENV: "development" } },
        RECIPE.terminals[1]!,
        { ...RECIPE.terminals[2]!, env: { DEBUG: "1" } },
      ],
    };
    const card = (step: number) =>
      screen
        .getByRole("button", { name: `Remove terminal ${step}` })
        .closest<HTMLElement>('[role="group"][aria-labelledby^="terminal-heading-"]')!;
    const variables = (step: number) =>
      [...card(step).querySelectorAll<HTMLElement>("[data-env-row]")].map((row) => {
        const [name, value] = row.querySelectorAll("input");
        return [name!.value, value!.value];
      });
    const nameField = (step: number, row: number) =>
      within(card(step)).getByRole("textbox", { name: `Name of variable ${row}` });
    const valueField = (step: number, row: number) =>
      card(step)
        .querySelectorAll<HTMLElement>("[data-env-row]")
        [row - 1]!.querySelectorAll("input")[1]!;
    const addVariable = (step: number) =>
      act(() => {
        screen.getByRole("button", { name: `Add variable to terminal ${step}` }).click();
      });
    const save = async (label = "Update recipe") => {
      await act(async () => {
        screen.getByRole("button", { name: label }).click();
      });
    };
    const savedTerminals = () => updateRecipe.mock.calls.at(-1)?.[1].terminals ?? [];

    it("shows each step's variables by name and value, whatever the step's type", () => {
      renderEditor(ENV_RECIPE);
      expect(variables(1)).toEqual([
        ["PORT", "3000"],
        ["NODE_ENV", "development"],
      ]);
      expect(variables(2)).toEqual([]);
      expect(variables(3)).toEqual([["DEBUG", "1"]]);
      for (const step of [1, 2, 3]) {
        expect(
          within(card(step)).getByRole("button", { name: `Add variable to terminal ${step}` })
        ).toBeTruthy();
      }
    });

    it("draws a variable's fields in the family chrome", () => {
      renderEditor(ENV_RECIPE);
      const family = chrome(document.getElementById("auto-assign")!);
      const fields = document.querySelectorAll("[data-env-row] input");
      expect(fields.length).toBe(6);
      for (const field of fields) {
        expect(chrome(field).join(" ")).toEqual(family.join(" "));
      }
    });

    it("adds, edits and removes variables, saving each on its own step", async () => {
      renderEditor(ENV_RECIPE);
      addVariable(2);
      expect(document.activeElement).toBe(nameField(2, 1));
      fireEvent.change(nameField(2, 1), { target: { value: " API_URL " } });
      fireEvent.change(valueField(2, 1), { target: { value: "http://localhost:4000" } });
      // A named variable with no value is kept: it still overrides an inherited one.
      addVariable(2);
      fireEvent.change(nameField(2, 2), { target: { value: "CI" } });
      // A row left without a name is dropped, as the settings editors drop one.
      addVariable(2);

      fireEvent.change(valueField(1, 1), { target: { value: "4000" } });
      act(() => {
        within(card(1)).getByRole("button", { name: "Delete NODE_ENV (row 2)" }).click();
      });
      expect(document.activeElement).toBe(nameField(1, 1));
      act(() => {
        within(card(3)).getByRole("button", { name: "Delete DEBUG (row 1)" }).click();
      });
      expect(document.activeElement).toBe(
        within(card(3)).getByRole("button", { name: "Add variable to terminal 3" })
      );

      await save();
      expect(savedTerminals().map((t) => t.env)).toEqual([
        { PORT: "4000" },
        { API_URL: "http://localhost:4000", CI: "" },
        {},
      ]);
    });

    it("refuses a name the shell can't export, on the row that holds it, and saves once fixed", async () => {
      renderEditor(ENV_RECIPE);
      fireEvent.change(nameField(1, 2), { target: { value: "2FAST" } });
      await save();
      expect(updateRecipe).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(nameField(1, 2));
      expect(nameField(1, 2).getAttribute("aria-invalid")).toBe("true");
      const describedBy = nameField(1, 2).getAttribute("aria-describedby") ?? "";
      expect(document.getElementById(describedBy)?.textContent).toBe(ENV_KEY_INVALID_MESSAGE);

      fireEvent.change(nameField(1, 2), { target: { value: "FAST" } });
      expect(nameField(1, 2).getAttribute("aria-invalid")).toBeNull();
      await save();
      expect(savedTerminals()[0]?.env).toEqual({ PORT: "3000", FAST: "development" });
    });

    it("refuses a name used twice in one step, but not the same name in two steps", async () => {
      renderEditor(ENV_RECIPE);
      addVariable(3);
      fireEvent.change(nameField(3, 2), { target: { value: "DEBUG" } });
      addVariable(1);
      fireEvent.change(nameField(1, 3), { target: { value: "DEBUG" } });
      await save();
      expect(updateRecipe).not.toHaveBeenCalled();
      expect(within(card(3)).queryByText(ENV_KEY_DUPLICATE_MESSAGE)).toBeTruthy();
      expect(within(card(1)).queryByText(ENV_KEY_DUPLICATE_MESSAGE)).toBeNull();
      expect(document.activeElement).toBe(nameField(3, 2));

      fireEvent.change(nameField(3, 2), { target: { value: "TRACE" } });
      await save();
      expect(savedTerminals().map((t) => Object.keys(t.env ?? {}))).toEqual([
        ["PORT", "NODE_ENV", "DEBUG"],
        [],
        ["DEBUG", "TRACE"],
      ]);
    });

    it("refuses a value holding a control character, which would drop the step on load", async () => {
      renderEditor(ENV_RECIPE);
      fireEvent.change(valueField(3, 1), { target: { value: "a\tb" } });
      await save();
      expect(updateRecipe).not.toHaveBeenCalled();
      expect(within(card(3)).queryByText(ENV_VALUE_CONTROL_CHAR_MESSAGE)).toBeTruthy();
      // The value is what's wrong, so it is the field marked and focused.
      expect(document.activeElement).toBe(valueField(3, 1));
      expect(valueField(3, 1).getAttribute("aria-invalid")).toBe("true");
      expect(nameField(3, 1).getAttribute("aria-invalid")).toBeNull();
    });

    it("keeps a step's variables through a type switch and the removal of a step above it", async () => {
      renderEditor(ENV_RECIPE);
      fireEvent.change(valueField(3, 1), { target: { value: "2" } });
      const trigger = document.getElementById("terminal-type-2")!;
      fireEvent.keyDown(trigger, { key: "ArrowDown" });
      const option = await screen.findByRole("option", { name: "Terminal" });
      await act(async () => {
        option.click();
      });
      act(() => {
        screen.getByRole("button", { name: "Remove terminal 1" }).click();
      });
      expect(variables(2)).toEqual([["DEBUG", "2"]]);
      await save();
      expect(savedTerminals().map((t) => [t.type, t.env])).toEqual([
        ["terminal", {}],
        ["terminal", { DEBUG: "2" }],
      ]);
    });

    it("says a team recipe's values stay on this machine, and shows a value not set here as empty", () => {
      renderEditor({
        ...ENV_RECIPE,
        id: "inrepo-full-stack",
        scope: "inrepo",
        terminals: [{ ...ENV_RECIPE.terminals[0]!, env: { PORT: "", NODE_ENV: "development" } }],
      });
      const help = document.getElementById("terminal-env-help-0")!.textContent ?? "";
      expect(help).toMatch(/this machine/);
      expect(valueField(1, 1).value).toBe("");
      expect(valueField(1, 1).getAttribute("placeholder")).toMatch(/this machine/);

      cleanup();
      renderEditor(ENV_RECIPE);
      expect(document.getElementById("terminal-env-help-0")!.textContent).not.toMatch(
        /this machine/
      );
      expect(valueField(1, 1).getAttribute("placeholder")).not.toMatch(/this machine/);
    });

    it("tells a new recipe's steps where values go by the scope it will be saved to", async () => {
      renderEditor();
      expect(document.getElementById("terminal-env-help-0")!.textContent).toMatch(/this machine/);
      const scope = document.getElementById("recipe-scope")!;
      fireEvent.keyDown(scope, { key: "ArrowDown" });
      const global = await screen.findByRole("option", { name: /^Global/ });
      await act(async () => {
        global.click();
      });
      expect(document.getElementById("terminal-env-help-0")!.textContent).not.toMatch(
        /this machine/
      );
    });

    it("creates a recipe with the variables its steps were given", async () => {
      renderEditor();
      fireEvent.change(document.getElementById("recipe-name")!, { target: { value: "Build" } });
      addVariable(1);
      fireEvent.change(nameField(1, 1), { target: { value: "PORT" } });
      fireEvent.change(valueField(1, 1), { target: { value: "5173" } });
      await save("Create recipe");
      expect(createRecipe.mock.calls[0]?.[3]).toEqual([
        expect.objectContaining({ type: "terminal", env: { PORT: "5173" } }),
      ]);
    });
  });

  describe("layout capture omissions (#14968)", () => {
    const CAPTURED: RecipeTerminal[] = [
      { type: "terminal", command: "npm test", env: {} },
      { type: "claude", env: {} },
    ];
    const notice = () => screen.queryByTestId("recipe-layout-omissions");
    const renderCapture = (layoutOmissions: RecipeLayoutOmissions, recipe?: TerminalRecipe) =>
      render(
        <RecipeEditor
          recipe={recipe}
          initialTerminals={CAPTURED}
          layoutOmissions={layoutOmissions}
          isOpen
          onClose={() => {}}
        />
      );

    it("says which panels a recipe can't hold and how many steps the cap cut", () => {
      renderCapture({ panelKinds: { browser: 2, file: 1 }, cappedTerminalCount: 3 });
      const paragraphs = [...notice()!.querySelectorAll("p")].map((p) => p.textContent);
      expect(paragraphs).toEqual([
        "Some panels weren't captured",
        "Recipes can't hold 2 browsers and 1 file viewer, so they were left out.",
        "3 more panels were left out: a recipe holds at most 10 terminals.",
      ]);
      expect(notice()!.dataset.callout).toBe("warning");
    });

    it("counts plugin panel kinds together without naming them", () => {
      const view = renderCapture({ panelKinds: { "acme.kanban": 1 }, cappedTerminalCount: 0 });
      expect(notice()!.textContent).toContain(
        "Recipes can't hold 1 other panel, so it was left out."
      );
      expect(notice()!.dataset.callout).toBe("info");
      view.unmount();

      renderCapture({
        panelKinds: { "acme.kanban": 1, review: 1, "acme.board": 2, constructor: 1 },
        cappedTerminalCount: 0,
      });
      expect(notice()!.textContent).toContain(
        "Recipes can't hold 1 review panel and 4 other panels, so they were left out."
      );
      expect(notice()!.textContent).not.toMatch(/acme|constructor/);
    });

    it("stays quiet for a complete capture and for an existing recipe", () => {
      const view = renderCapture({ panelKinds: {}, cappedTerminalCount: 0 });
      expect(notice()).toBeNull();
      view.unmount();

      renderCapture({ panelKinds: { browser: 1 }, cappedTerminalCount: 1 }, RECIPE);
      expect(notice()).toBeNull();
    });

    it("keeps describing the capture after a step is removed", () => {
      renderCapture({ panelKinds: {}, cappedTerminalCount: 1 });
      act(() => {
        screen.getByRole("button", { name: "Remove terminal 2" }).click();
      });
      expect(screen.queryByRole("button", { name: "Remove terminal 2" })).toBeNull();
      expect(notice()!.textContent).toContain(
        "1 more panel was left out: a recipe holds at most 10 terminals."
      );
    });
  });

  describe("When done (#16172)", () => {
    const AGENT: TerminalRecipe = {
      ...RECIPE,
      terminals: [{ type: "claude", title: "Reviewer", initialPrompt: "Review", env: {} }],
    };
    const pick = async (id: string, label: string) => {
      fireEvent.keyDown(document.getElementById(id)!, { key: "ArrowDown" });
      const option = await screen.findByRole("option", { name: label });
      await act(async () => {
        option.click();
      });
    };
    const save = async () => {
      await act(async () => {
        screen.getByRole("button", { name: "Update recipe" }).click();
      });
      return updateRecipe.mock.calls.at(-1)?.[1].terminals ?? [];
    };

    it("saves the choice picked for an agent step, and nothing for keep", async () => {
      renderEditor(AGENT);
      expect(document.getElementById("terminal-when-done-help-0")?.textContent).not.toContain(
        "filled-in"
      );
      expect(document.getElementById("terminal-when-done-0")?.textContent).toBe("Keep open");

      await pick("terminal-when-done-0", "Close, keeping the session");
      expect((await save())[0]?.whenDone).toBe("close");

      await pick("terminal-when-done-0", "Move to background");
      expect((await save())[0]?.whenDone).toBe("background");

      await pick("terminal-when-done-0", "Keep open");
      expect((await save())[0]?.whenDone).toBeUndefined();
    });

    it("carries the choice to another agent", async () => {
      renderEditor({ ...AGENT, terminals: [{ ...AGENT.terminals[0]!, whenDone: "close" }] });
      await pick("terminal-type-0", "Codex");
      expect((await save())[0]).toMatchObject({ type: "codex", whenDone: "close" });
    });

    it("says a prompt led by a variable is armed only if it fills in as a task", () => {
      renderEditor({
        ...AGENT,
        terminals: [{ type: "claude", title: "Path", initialPrompt: "{{worktree_path}}", env: {} }],
      });
      expect(document.getElementById("terminal-when-done-0")!.hasAttribute("disabled")).toBe(false);
      expect(document.getElementById("terminal-when-done-help-0")?.textContent).toContain(
        "if the filled-in prompt isn't empty or a slash command"
      );
    });

    it("names why a slash-command prompt can't set it", () => {
      renderEditor({
        ...AGENT,
        terminals: [
          { type: "codex", title: "Merge", initialPrompt: "/prompts:merge-prs", env: {} },
        ],
      });
      expect(document.getElementById("terminal-when-done-0")!.hasAttribute("disabled")).toBe(true);
      expect(document.getElementById("terminal-when-done-help-0")?.textContent).toContain(
        "slash command"
      );
    });

    it("offers it only once the step has a prompt, pointing at the terminal menu until then", () => {
      renderEditor({
        ...AGENT,
        terminals: [{ type: "claude", title: "Idle", whenDone: "close", env: {} }],
      });
      const trigger = document.getElementById("terminal-when-done-0")!;
      expect(trigger.hasAttribute("disabled")).toBe(true);
      expect(trigger.textContent).toBe("Keep open");
      expect(document.getElementById("terminal-when-done-help-0")?.textContent).toContain(
        "terminal menu"
      );

      fireEvent.change(document.getElementById("terminal-initial-prompt-0")!, {
        target: { value: "Review" },
      });
      expect(trigger.hasAttribute("disabled")).toBe(false);
      expect(trigger.textContent).toBe("Close, keeping the session");
    });

    it("leaves a step that stops being an agent unarmed, and brings the choice back with it", async () => {
      renderEditor({
        ...AGENT,
        terminals: [{ ...AGENT.terminals[0]!, whenDone: "background" }],
      });
      await pick("terminal-type-0", "Terminal");
      expect(document.getElementById("terminal-when-done-0")).toBeNull();
      expect((await save())[0]?.whenDone).toBeUndefined();

      await pick("terminal-type-0", "Claude");
      expect(document.getElementById("terminal-when-done-0")?.textContent).toBe(
        "Move to background"
      );
    });
  });
});
