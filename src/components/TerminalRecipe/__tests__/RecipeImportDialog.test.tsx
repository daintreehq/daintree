// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, cleanup } from "@testing-library/react";
import type { ReactNode } from "react";

interface MockAction {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  loading?: boolean;
}

vi.mock("@/components/ui/select", () => import("@/components/ui/__tests__/nativeSelectMock"));

vi.mock("@/components/ui/AppDialog", () => {
  const Dialog = ({ children, isOpen }: { children: ReactNode; isOpen: boolean }) =>
    isOpen ? <div role="dialog">{children}</div> : null;
  Dialog.Header = ({ children }: { children: ReactNode }) => <div>{children}</div>;
  Dialog.Title = ({ children }: { children: ReactNode }) => <h2>{children}</h2>;
  Dialog.CloseButton = () => <button type="button" aria-label="Close dialog" />;
  Dialog.Body = ({ children }: { children: ReactNode }) => <div>{children}</div>;
  Dialog.Footer = ({
    primaryAction,
    secondaryAction,
  }: {
    primaryAction?: MockAction;
    secondaryAction?: MockAction;
  }) => (
    <>
      {[secondaryAction, primaryAction].map(
        (action) =>
          action && (
            <button
              key={action.label}
              type="button"
              disabled={action.disabled || action.loading}
              onClick={action.onClick}
            >
              {action.label}
            </button>
          )
      )}
    </>
  );
  return { AppDialog: Dialog };
});

import { RecipeImportDialog } from "../RecipeImportDialog";
import { useRecipeStore } from "@/store/recipeStore";
import {
  RecipeImportDropsTerminalsError,
  RecipeImportInvalidError,
  type RecipeFileImport,
} from "@/utils/recipeImport";
import { inspectRecipeTerminals } from "@shared/utils/recipeSanitizer";

const importRecipe = vi.fn();

beforeEach(() => {
  importRecipe.mockReset().mockResolvedValue(undefined);
  useRecipeStore.setState({ importRecipe });
});

afterEach(cleanup);

const textarea = () => screen.getByTestId("recipe-import-textarea");
const importButton = () =>
  screen.getByRole("button", {
    name: /^(Import (recipe|\d+ terminals?)|Retry import)$/,
  }) as HTMLButtonElement;
const refusedFile = (json: string, error: unknown): RecipeFileImport => ({
  status: "refused",
  fileName: "recipe.json",
  json,
  error,
});
const banner = () => document.querySelector("[data-inline-status-banner]");

async function submit(json: string) {
  fireEvent.change(textarea(), { target: { value: json } });
  await click("Import recipe");
}

async function click(name: string) {
  await act(async () => {
    screen.getByRole("button", { name }).click();
  });
}

/** The refusal the store raises for `terminals`, from the real sanitizer. */
function refusalFor(terminals: unknown[]) {
  const { accepted, rejected } = inspectRecipeTerminals(terminals);
  return new RecipeImportDropsTerminalsError(accepted.length, rejected);
}

const MIXED_TERMINALS = [
  { type: "terminal", command: "npm test" },
  { type: "acme-agent", title: "Plugin agent" },
  { type: "claude" },
];
const MIXED = JSON.stringify({ name: "Mixed", terminals: MIXED_TERMINALS });

describe("RecipeImportDialog", () => {
  // What is wrong with the pasted text is the field's error; a store that
  // refused a well-formed recipe is the operation's. Neither wears the other's.
  it("marks unparseable JSON on the field and imports nothing", async () => {
    render(<RecipeImportDialog isOpen onClose={() => {}} projectId="proj" />);
    await submit('{"name": "Broken", "terminals": [');

    expect(textarea().getAttribute("aria-invalid")).toBe("true");
    expect(banner()).toBeNull();
    expect(importRecipe).not.toHaveBeenCalled();
  });

  it("reports a refused import as a failed operation, not a bad field", async () => {
    importRecipe.mockRejectedValue(new Error("Recipe has no terminals"));
    render(<RecipeImportDialog isOpen onClose={() => {}} projectId="proj" />);
    await submit('{"name": "Empty", "terminals": []}');

    expect(textarea().getAttribute("aria-invalid")).toBeNull();
    expect(banner()?.textContent).toContain("Recipe has no terminals");
  });

  it("offers only a scope that can succeed when no project is open", async () => {
    render(<RecipeImportDialog isOpen onClose={() => {}} projectId={undefined} />);
    const project = screen.getByRole("option", { name: /^Team/ });
    expect(project.hasAttribute("disabled")).toBe(true);

    await submit('{"name": "Ok", "terminals": []}');
    expect(importRecipe).toHaveBeenCalledWith(
      undefined,
      '{"name": "Ok", "terminals": []}',
      undefined
    );
  });

  describe("an import that would drop terminals (#15044)", () => {
    it("names each dropped terminal and why, and saves nothing until the rest is confirmed", async () => {
      importRecipe.mockRejectedValueOnce(refusalFor(MIXED_TERMINALS));
      const onClose = vi.fn();
      render(<RecipeImportDialog isOpen onClose={onClose} projectId="proj" />);
      await submit(MIXED);

      expect(onClose).not.toHaveBeenCalled();
      expect(importRecipe).toHaveBeenLastCalledWith("proj", MIXED, undefined);
      const items = Array.from(banner()!.querySelectorAll("li")).map((li) => li.textContent);
      expect(items).toEqual([
        `Terminal 2 · Plugin agent — this version of Daintree can't launch type "acme-agent"`,
      ]);
      expect(banner()!.textContent).toContain("1 terminal can't be imported");
      expect(banner()!.textContent).toContain("import the other 2 terminals without it");

      await click("Import 2 terminals");

      expect(importRecipe).toHaveBeenLastCalledWith("proj", MIXED, {
        allowDroppedTerminals: true,
      });
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("withdraws the offer to import the rest once the JSON changes", async () => {
      importRecipe.mockRejectedValueOnce(refusalFor(MIXED_TERMINALS));
      render(<RecipeImportDialog isOpen onClose={() => {}} projectId="proj" />);
      await submit(MIXED);
      expect(screen.queryByRole("button", { name: "Import 2 terminals" })).not.toBeNull();

      const fixed = MIXED.replace("acme-agent", "codex");
      fireEvent.change(textarea(), { target: { value: fixed } });
      expect(banner()).toBeNull();
      await click("Import recipe");
      expect(importRecipe).toHaveBeenLastCalledWith("proj", fixed, undefined);
    });

    // Which terminals can't come across depends on the JSON, not on where it
    // goes, so choosing the other scope keeps the review and its offer.
    it("keeps the review when the scope changes", async () => {
      importRecipe.mockRejectedValueOnce(refusalFor(MIXED_TERMINALS));
      render(<RecipeImportDialog isOpen onClose={() => {}} projectId="proj" />);
      await submit(MIXED);

      fireEvent.change(screen.getByRole("combobox"), { target: { value: "global" } });

      expect(banner()!.textContent).toContain("1 terminal can't be imported");
      await click("Import 2 terminals");
      expect(importRecipe).toHaveBeenLastCalledWith(undefined, MIXED, {
        allowDroppedTerminals: true,
      });
    });

    it("offers nothing to import when no terminal would survive, until the JSON changes", async () => {
      const terminals = [{ type: "acme-agent" }, { type: "terminal", command: "a\nb" }];
      importRecipe.mockRejectedValue(refusalFor(terminals));
      render(<RecipeImportDialog isOpen onClose={() => {}} projectId="proj" />);
      await submit(JSON.stringify({ name: "Gone", terminals }));

      expect(banner()!.textContent).toContain("None of the recipe's terminals can be imported");
      expect(banner()!.querySelectorAll("li")).toHaveLength(2);
      expect(importButton().disabled).toBe(true);

      fireEvent.change(textarea(), { target: { value: MIXED } });
      expect(importButton().disabled).toBe(false);
    });

    it("shows what importing the rest would keep", async () => {
      importRecipe.mockRejectedValueOnce(refusalFor(MIXED_TERMINALS));
      render(<RecipeImportDialog isOpen onClose={() => {}} projectId="proj" />);
      await submit(MIXED);

      expect(document.body.textContent).toContain("2 of 3 terminals");
      const kept = Array.from(document.querySelectorAll("ol li")).map((li) => li.textContent);
      expect(kept).toHaveLength(2);
      expect(kept.join(" ")).not.toContain("Plugin agent");
      expect(kept[0]).toContain("$ npm test");
    });

    it("shows the repaired recipe once the JSON is fixed, and drops the old offer", () => {
      render(
        <RecipeImportDialog
          isOpen
          onClose={() => {}}
          projectId="proj"
          fileImport={refusedFile(MIXED, refusalFor(MIXED_TERMINALS))}
        />
      );
      expect(document.body.textContent).toContain("2 of 3 terminals");

      fireEvent.change(textarea(), { target: { value: MIXED.replace("acme-agent", "codex") } });

      expect(banner()).toBeNull();
      expect(document.body.textContent).not.toContain("2 of 3 terminals");
      const items = Array.from(document.querySelectorAll("ol li")).map((li) => li.textContent);
      expect(items).toHaveLength(3);
      expect(items[1]).toContain("Plugin agent");
      expect(importButton().textContent).toBe("Import recipe");
    });

    it("keeps the review when saving the rest fails, so it can be tried again", async () => {
      importRecipe
        .mockRejectedValueOnce(refusalFor(MIXED_TERMINALS))
        .mockRejectedValueOnce(new Error("Disk full"));
      render(<RecipeImportDialog isOpen onClose={() => {}} projectId="proj" />);
      await submit(MIXED);
      await click("Import 2 terminals");

      expect(document.body.textContent).toContain("Disk full");
      // Still the rest, retried: the review and what it keeps stay in view.
      expect(document.body.textContent).toContain("2 of 3 terminals");
      await click("Retry import");
      expect(importRecipe).toHaveBeenCalledTimes(3);
      expect(importRecipe).toHaveBeenLastCalledWith("proj", MIXED, {
        allowDroppedTerminals: true,
      });
    });

    it("opens a refused file import with its JSON and the review", () => {
      render(
        <RecipeImportDialog
          isOpen
          onClose={() => {}}
          projectId="proj"
          fileImport={refusedFile(MIXED, refusalFor(MIXED_TERMINALS))}
        />
      );

      expect((textarea() as HTMLTextAreaElement).value).toBe(MIXED);
      expect(banner()!.textContent).toContain("Plugin agent");
      expect(screen.queryByRole("button", { name: "Import 2 terminals" })).not.toBeNull();
    });

    it("seeds a file's JSON once per opening and forgets it on close", () => {
      const seed = refusedFile(MIXED, refusalFor(MIXED_TERMINALS));
      const { rerender } = render(
        <RecipeImportDialog isOpen onClose={() => {}} projectId="proj" fileImport={seed} />
      );
      fireEvent.change(textarea(), { target: { value: "{}" } });
      rerender(<RecipeImportDialog isOpen onClose={() => {}} projectId="proj" fileImport={seed} />);
      expect((textarea() as HTMLTextAreaElement).value).toBe("{}");
      expect(banner()).toBeNull();

      rerender(
        <RecipeImportDialog isOpen={false} onClose={() => {}} projectId="proj" fileImport={null} />
      );
      rerender(<RecipeImportDialog isOpen onClose={() => {}} projectId="proj" fileImport={null} />);
      expect((textarea() as HTMLTextAreaElement).value).toBe("");
      expect(banner()).toBeNull();
      expect(screen.queryByRole("button", { name: "Import 2 terminals" })).toBeNull();
    });

    it("opens a file the store refused outright with its JSON and the reason", () => {
      render(
        <RecipeImportDialog
          isOpen
          onClose={() => {}}
          projectId="proj"
          fileImport={refusedFile("{}", new Error("Disk full"))}
        />
      );

      expect((textarea() as HTMLTextAreaElement).value).toBe("{}");
      expect(banner()!.textContent).toContain("Disk full");
      // A failed save may work if tried again.
      expect(importButton().disabled).toBe(false);
    });

    it("marks a file that isn't JSON on the field, with where it broke", () => {
      render(
        <RecipeImportDialog
          isOpen
          onClose={() => {}}
          projectId="proj"
          fileImport={refusedFile('{"name": "Cut', new RecipeImportInvalidError("x", "y"))}
        />
      );

      expect(textarea().getAttribute("aria-invalid")).toBe("true");
      expect(document.body.textContent).toContain("That isn't valid JSON");
      expect(banner()).toBeNull();
      expect(importButton().disabled).toBe(true);
    });
  });

  describe("JSON that can't be a recipe", () => {
    const notARecipe = () =>
      new RecipeImportInvalidError(
        "This JSON isn't a recipe",
        "A recipe needs a name and a list of terminals."
      );

    it("says what a recipe needs and holds the import until the JSON changes", async () => {
      importRecipe.mockRejectedValueOnce(notARecipe());
      render(<RecipeImportDialog isOpen onClose={() => {}} projectId="proj" />);
      await submit('{"theme": "bondi"}');

      expect(banner()!.textContent).toContain("This JSON isn't a recipe");
      expect(banner()!.textContent).toContain("A recipe needs a name and a list of terminals.");
      expect(importButton().disabled).toBe(true);
      // The field names the banner as what is wrong with it.
      const describedBy = textarea().getAttribute("aria-describedby") ?? "";
      expect(
        describedBy.split(" ").some((id) => document.getElementById(id)?.contains(banner()))
      ).toBe(true);

      fireEvent.change(textarea(), { target: { value: MIXED } });
      expect(banner()).toBeNull();
      expect(importButton().disabled).toBe(false);
    });

    it("keeps the refusal when the scope changes", async () => {
      importRecipe.mockRejectedValueOnce(notARecipe());
      render(<RecipeImportDialog isOpen onClose={() => {}} projectId="proj" />);
      await submit('{"theme": "bondi"}');

      fireEvent.change(screen.getByRole("combobox"), { target: { value: "global" } });

      expect(banner()!.textContent).toContain("This JSON isn't a recipe");
      expect(importButton().disabled).toBe(true);
    });
  });

  // With a project open a picked file is confirmed here before anything is
  // saved, so where it goes is a choice made with the file in view (#16658).
  describe("a clean file", () => {
    const CLEAN = JSON.stringify({ name: "Review fleet", terminals: [] });
    const cleanFile = (): RecipeFileImport => ({
      status: "ready",
      fileName: "review-fleet.json",
      json: CLEAN,
      recipe: {
        name: "Review fleet",
        terminals: [
          { type: "claude", title: "Reviewer" },
          { type: "terminal", title: "Dev server", command: "npm run dev" },
          { type: "terminal" },
          { type: "codex" },
          { type: "terminal", command: "npm test" },
        ],
      },
    });

    it("shows the file and every terminal it would save, and saves nothing yet", () => {
      render(
        <RecipeImportDialog isOpen onClose={() => {}} projectId="proj" fileImport={cleanFile()} />
      );

      expect(document.body.textContent).toContain("review-fleet.json");
      expect(document.body.textContent).toContain("Review fleet");
      const items = Array.from(document.querySelectorAll("ol li")).map((li) => li.textContent);
      expect(items).toHaveLength(5);
      expect(items[0]).toContain("Reviewer");
      expect(items[1]).toContain("$ npm run dev");
      expect(items[4]).toContain("$ npm test");
      expect(screen.queryByTestId("recipe-import-textarea")).toBeNull();
      expect(importRecipe).not.toHaveBeenCalled();
    });

    it("imports to Team by default and reports the saved recipe", async () => {
      const saved = { id: "recipe-1", name: "Review fleet" };
      importRecipe.mockResolvedValueOnce(saved);
      const onImported = vi.fn();
      const onClose = vi.fn();
      render(
        <RecipeImportDialog
          isOpen
          onClose={onClose}
          onImported={onImported}
          projectId="proj"
          fileImport={cleanFile()}
        />
      );
      expect(document.body.textContent).toContain(".daintree/recipes/");

      await click("Import recipe");

      expect(importRecipe).toHaveBeenCalledWith("proj", CLEAN, undefined);
      expect(onImported).toHaveBeenCalledWith(saved);
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("imports the same file as Global when that is chosen", async () => {
      render(
        <RecipeImportDialog isOpen onClose={() => {}} projectId="proj" fileImport={cleanFile()} />
      );

      fireEvent.change(screen.getByRole("combobox"), { target: { value: "global" } });
      expect(document.body.textContent).toContain("Stays on this machine");
      await click("Import recipe");

      expect(importRecipe).toHaveBeenCalledWith(undefined, CLEAN, undefined);
    });

    it("keeps the file in view when the save fails, so it can be tried again", async () => {
      importRecipe.mockRejectedValueOnce(new Error("Disk full"));
      const onClose = vi.fn();
      render(
        <RecipeImportDialog isOpen onClose={onClose} projectId="proj" fileImport={cleanFile()} />
      );

      await click("Import recipe");

      expect(onClose).not.toHaveBeenCalled();
      expect(banner()!.textContent).toContain("Disk full");
      expect(document.querySelectorAll("ol li")).toHaveLength(5);
      expect(importButton().textContent).toBe("Retry import");
      expect(importButton().disabled).toBe(false);
    });

    it("shows a long command whole, since this is the look before it can run", () => {
      const command = `npm run e2e -- ${"--grep some-long-pattern ".repeat(12).trim()}`;
      const file = cleanFile();
      if (file.status !== "ready") return;
      file.recipe.terminals = [{ type: "terminal", command }];
      render(<RecipeImportDialog isOpen onClose={() => {}} projectId="proj" fileImport={file} />);

      expect(document.querySelector("ol li")!.textContent).toContain(command);
    });
  });

  it("shows what a pasted recipe would save before it is imported", () => {
    render(<RecipeImportDialog isOpen onClose={() => {}} projectId="proj" />);
    expect(document.querySelector("ol")).toBeNull();

    fireEvent.change(textarea(), {
      target: {
        value: JSON.stringify({ name: "Pasted", terminals: [{ type: "terminal", command: "ls" }] }),
      },
    });

    expect(document.body.textContent).toContain("Pasted");
    expect(document.querySelector("ol li")!.textContent).toContain("$ ls");
    expect(importRecipe).not.toHaveBeenCalled();

    fireEvent.change(textarea(), { target: { value: '{"name": "Pasted", "terminals": [' } });
    expect(document.querySelector("ol")).toBeNull();
  });

  it("says before importing that a project recipe is written into the repository", () => {
    render(<RecipeImportDialog isOpen onClose={() => {}} projectId="proj" />);
    expect(document.body.textContent).toContain(".daintree/recipes/");

    fireEvent.change(screen.getByRole("combobox"), { target: { value: "global" } });
    expect(document.body.textContent).toContain("Stays on this machine");
    expect(document.body.textContent).not.toContain(".daintree/recipes/");
  });
});
