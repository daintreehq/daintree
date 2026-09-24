// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, act } from "@testing-library/react";
import type { ReactNode } from "react";

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

class ResizeObserverStub implements ResizeObserver {
  constructor(_callback: ResizeObserverCallback) {}
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver ??= ResizeObserverStub;

const { checkDirectory, openDialog, updateTerminalCwd, restartTerminal, focusPanelInput } =
  vi.hoisted(() => ({
    checkDirectory: vi.fn<(path: string) => Promise<boolean>>(),
    openDialog: vi.fn<() => Promise<string | null>>(() => Promise.resolve(null)),
    updateTerminalCwd: vi.fn<(id: string, cwd: string) => void>(),
    restartTerminal: vi.fn<(id: string, opts?: unknown) => Promise<void>>(() => Promise.resolve()),
    focusPanelInput: vi.fn<(id: string) => boolean>(() => false),
  }));

vi.mock("@/clients/systemClient", () => ({ systemClient: { checkDirectory } }));
vi.mock("@/clients/projectClient", () => ({ projectClient: { openDialog } }));
vi.mock("@/components/Panel/panelFocusRegistry", () => ({ focusPanelInput }));

vi.mock("@/store/panelStore", () => ({
  usePanelStore: (
    selector: (s: {
      updateTerminalCwd: typeof updateTerminalCwd;
      restartTerminal: typeof restartTerminal;
    }) => unknown
  ) => selector({ updateTerminalCwd, restartTerminal }),
}));

const PROJECT_ROOT = "/repos/proj";
vi.mock("@/store/projectStore", () => ({
  useProjectStore: (selector: (s: { currentProject: { path: string } }) => unknown) =>
    selector({ currentProject: { path: PROJECT_ROOT } }),
}));

import { UpdateCwdDialog } from "../UpdateCwdDialog";

const MISSING = "/repos/proj-worktrees/gone";

function field(): HTMLInputElement {
  const input = document.getElementById("new-cwd-input");
  if (!(input instanceof HTMLInputElement)) throw new Error("path field not rendered");
  return input;
}

function submit(value: string) {
  fireEvent.change(field(), { target: { value } });
  fireEvent.keyDown(field(), { key: "Enter" });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

function renderDialog(props: Partial<Parameters<typeof UpdateCwdDialog>[0]> = {}) {
  const onClose = vi.fn();
  const view = render(
    <UpdateCwdDialog isOpen terminalId="t1" currentCwd={MISSING} onClose={onClose} {...props} />
  );
  return { ...view, onClose };
}

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  checkDirectory.mockImplementation((path) => Promise.resolve(!path.includes("gone")));
  restartTerminal.mockResolvedValue();
});

describe("UpdateCwdDialog", () => {
  it("keeps showing the folder that went missing after the store rewrites the terminal's cwd", async () => {
    const restart = deferred<void>();
    restartTerminal.mockReturnValue(restart.promise);
    const { rerender, onClose } = renderDialog();

    submit("/repos/other");
    await waitFor(() => expect(updateTerminalCwd).toHaveBeenCalledWith("t1", "/repos/other"));
    // The host re-renders with the store's new cwd before the restart resolves.
    rerender(
      <UpdateCwdDialog isOpen terminalId="t1" currentCwd="/repos/other" onClose={onClose} />
    );

    expect(screen.getByTestId("update-cwd-missing-path").getAttribute("aria-label")).toBe(MISSING);
    expect(field().value).toBe("/repos/other");
    await act(async () => restart.resolve());
  });

  it("never touches the terminal when the dialog closes while the check is in flight", async () => {
    const check = deferred<boolean>();
    checkDirectory.mockImplementation((path) =>
      path === "/repos/slow" ? check.promise : Promise.resolve(true)
    );
    const { rerender, onClose } = renderDialog();

    submit("/repos/slow");
    rerender(
      <UpdateCwdDialog isOpen={false} terminalId="t1" currentCwd={MISSING} onClose={onClose} />
    );
    await act(async () => check.resolve(true));

    expect(updateTerminalCwd).not.toHaveBeenCalled();
    expect(restartTerminal).not.toHaveBeenCalled();
  });

  it("drops a check answer for a path the user has since edited", async () => {
    const check = deferred<boolean>();
    checkDirectory.mockImplementation((path) =>
      path === "/repos/slow" ? check.promise : Promise.resolve(true)
    );
    renderDialog();

    submit("/repos/slow");
    fireEvent.change(field(), { target: { value: "/repos/slower" } });
    await act(async () => check.resolve(true));

    expect(updateTerminalCwd).not.toHaveBeenCalled();
  });

  it("lets a suggestion picked mid-check be submitted", async () => {
    const check = deferred<boolean>();
    checkDirectory.mockImplementation((path) =>
      path === "/repos/slow" ? check.promise : Promise.resolve(!path.includes("gone"))
    );
    const { onClose } = renderDialog();
    const root = await screen.findByRole("button", { name: `Use ${PROJECT_ROOT}` });

    submit("/repos/slow");
    fireEvent.click(root);
    fireEvent.keyDown(field(), { key: "Enter" });

    await waitFor(() => expect(updateTerminalCwd).toHaveBeenCalledWith("t1", PROJECT_ROOT));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    await act(async () => check.resolve(true));
    expect(updateTerminalCwd).toHaveBeenCalledTimes(1);
  });

  it("moves focus to the field when a submit from the footer is rejected", async () => {
    renderDialog();
    // The open-time focus lands on a later frame; let it, so it can't pass for the fix.
    await waitFor(() => expect(document.activeElement).toBe(field()));
    fireEvent.change(field(), { target: { value: "/repos/gone-typo" } });
    const restart = screen.getByRole("button", { name: "Restart terminal" });
    restart.focus();
    fireEvent.click(restart);
    expect(document.activeElement).toBe(restart);

    await waitFor(() => expect(field().getAttribute("aria-invalid")).toBe("true"));
    expect(document.activeElement).toBe(field());
  });

  it("marks the field invalid for a folder that doesn't exist, and keeps what was typed", async () => {
    renderDialog();
    submit("/repos/gone-typo");

    await waitFor(() => expect(field().getAttribute("aria-invalid")).toBe("true"));
    const describedBy = field().getAttribute("aria-describedby");
    expect(describedBy && document.getElementById(describedBy)?.textContent).toMatch(
      /doesn't exist/
    );
    expect(field().value).toBe("/repos/gone-typo");
    expect(updateTerminalCwd).not.toHaveBeenCalled();
  });

  it("reports a failed check against the field, not as a failed restart", async () => {
    checkDirectory.mockImplementation((path) =>
      path === "/repos/locked" ? Promise.reject(new Error("EACCES")) : Promise.resolve(true)
    );
    renderDialog();
    submit("/repos/locked");

    await waitFor(() => expect(field().getAttribute("aria-invalid")).toBe("true"));
    expect(screen.queryByText("Couldn't restart the terminal")).toBeNull();
    expect(restartTerminal).not.toHaveBeenCalled();
  });

  it("reports a failed restart at form level without declaring the path invalid", async () => {
    restartTerminal.mockRejectedValue(new Error("spawn failed"));
    const { onClose } = renderDialog();
    submit("/repos/other");

    await screen.findByText("Couldn't restart the terminal");
    expect(field().getAttribute("aria-invalid")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("submits the trimmed path", async () => {
    const { onClose } = renderDialog();
    submit("  /repos/other  ");

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(checkDirectory).toHaveBeenCalledWith("/repos/other");
    expect(updateTerminalCwd).toHaveBeenCalledWith("t1", "/repos/other");
  });

  it("offers the project root and the nearest surviving ancestor, and fills the field from one", async () => {
    renderDialog();

    const root = await screen.findByRole("button", { name: `Use ${PROJECT_ROOT}` });
    expect(screen.getByRole("button", { name: "Use /repos/proj-worktrees" })).toBeTruthy();

    fireEvent.click(root);
    expect(field().value).toBe(PROJECT_ROOT);
  });

  it("never offers a folder the check didn't confirm", async () => {
    checkDirectory.mockImplementation((path) =>
      Promise.resolve(path !== PROJECT_ROOT && !path.includes("gone"))
    );
    renderDialog();

    await screen.findByRole("button", { name: "Use /repos/proj-worktrees" });
    expect(screen.queryByRole("button", { name: `Use ${PROJECT_ROOT}` })).toBeNull();
  });

  it("fills the field from the folder picker and leaves it alone when the picker is dismissed", async () => {
    renderDialog();
    const browse = screen.getByRole("button", { name: "Browse for the new folder" });

    openDialog.mockResolvedValueOnce(null);
    fireEvent.click(browse);
    await act(async () => undefined);
    expect(field().value).toBe(MISSING);

    openDialog.mockResolvedValueOnce("/picked/folder");
    fireEvent.click(browse);
    await waitFor(() => expect(field().value).toBe("/picked/folder"));
  });
});
