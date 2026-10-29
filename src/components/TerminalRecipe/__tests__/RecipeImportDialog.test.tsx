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
import { RecipeImportDropsTerminalsError } from "@/utils/recipeImport";
import { inspectRecipeTerminals } from "@shared/utils/recipeSanitizer";

const importRecipe = vi.fn();

beforeEach(() => {
  importRecipe.mockReset().mockResolvedValue(undefined);
  useRecipeStore.setState({ importRecipe });
});

afterEach(cleanup);

const textarea = () => screen.getByTestId("recipe-import-textarea");
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
    const project = screen.getByRole("option", { name: /^Project/ });
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

    it("withdraws the offer when the scope changes", async () => {
      importRecipe.mockRejectedValueOnce(refusalFor(MIXED_TERMINALS));
      render(<RecipeImportDialog isOpen onClose={() => {}} projectId="proj" />);
      await submit(MIXED);

      fireEvent.change(screen.getByRole("combobox"), { target: { value: "global" } });

      expect(banner()).toBeNull();
      await click("Import recipe");
      expect(importRecipe).toHaveBeenLastCalledWith(undefined, MIXED, undefined);
    });

    it("offers nothing to import when no terminal would survive", async () => {
      const terminals = [{ type: "acme-agent" }, { type: "terminal", command: "a\nb" }];
      importRecipe.mockRejectedValue(refusalFor(terminals));
      render(<RecipeImportDialog isOpen onClose={() => {}} projectId="proj" />);
      await submit(JSON.stringify({ name: "Gone", terminals }));

      expect(banner()!.textContent).toContain("None of the recipe's terminals can be imported");
      expect(banner()!.querySelectorAll("li")).toHaveLength(2);
      await click("Import recipe");
      expect(importRecipe).toHaveBeenLastCalledWith("proj", expect.any(String), undefined);
    });

    it("keeps the review when saving the rest fails, so it can be tried again", async () => {
      importRecipe
        .mockRejectedValueOnce(refusalFor(MIXED_TERMINALS))
        .mockRejectedValueOnce(new Error("Disk full"));
      render(<RecipeImportDialog isOpen onClose={() => {}} projectId="proj" />);
      await submit(MIXED);
      await click("Import 2 terminals");

      expect(document.body.textContent).toContain("Disk full");
      await click("Import 2 terminals");
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
          refusedImport={{ json: MIXED, error: refusalFor(MIXED_TERMINALS) }}
        />
      );

      expect((textarea() as HTMLTextAreaElement).value).toBe(MIXED);
      expect(banner()!.textContent).toContain("Plugin agent");
      expect(screen.queryByRole("button", { name: "Import 2 terminals" })).not.toBeNull();
    });

    it("seeds a file's JSON once per opening and forgets it on close", () => {
      const seed = { json: MIXED, error: refusalFor(MIXED_TERMINALS) };
      const { rerender } = render(
        <RecipeImportDialog isOpen onClose={() => {}} projectId="proj" refusedImport={seed} />
      );
      fireEvent.change(textarea(), { target: { value: "{}" } });
      rerender(
        <RecipeImportDialog isOpen onClose={() => {}} projectId="proj" refusedImport={seed} />
      );
      expect((textarea() as HTMLTextAreaElement).value).toBe("{}");
      expect(banner()).toBeNull();

      rerender(
        <RecipeImportDialog
          isOpen={false}
          onClose={() => {}}
          projectId="proj"
          refusedImport={null}
        />
      );
      rerender(
        <RecipeImportDialog isOpen onClose={() => {}} projectId="proj" refusedImport={null} />
      );
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
          refusedImport={{ json: "{}", error: new Error("Invalid recipe format") }}
        />
      );

      expect((textarea() as HTMLTextAreaElement).value).toBe("{}");
      expect(banner()!.textContent).toContain("Invalid recipe format");
      expect(screen.queryByRole("button", { name: "Import recipe" })).not.toBeNull();
    });
  });
});
