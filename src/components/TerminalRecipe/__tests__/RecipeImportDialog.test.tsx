// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, cleanup } from "@testing-library/react";
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
      <button type="button" onClick={primaryAction.onClick}>
        {primaryAction.label}
      </button>
    ) : null;
  return { AppDialog: Dialog };
});

import { RecipeImportDialog } from "../RecipeImportDialog";
import { useRecipeStore } from "@/store/recipeStore";

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
  await act(async () => {
    screen.getByRole("button", { name: "Import recipe" }).click();
  });
}

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
    expect(importRecipe).toHaveBeenCalledWith(undefined, '{"name": "Ok", "terminals": []}');
  });
});
