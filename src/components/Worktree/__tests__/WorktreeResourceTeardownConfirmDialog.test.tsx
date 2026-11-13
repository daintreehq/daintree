// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import {
  useWorktreeResourceTeardownConfirmStore,
  type ResourceTeardownConfirmRequest,
} from "@/store/worktreeResourceTeardownConfirmStore";
import { WorktreeResourceTeardownConfirmDialog } from "../WorktreeResourceTeardownConfirmDialog";

function open(overrides: Partial<ResourceTeardownConfirmRequest> = {}): Promise<boolean> {
  let answer!: Promise<boolean>;
  act(() => {
    answer = useWorktreeResourceTeardownConfirmStore.getState().requestConfirmation({
      worktreeId: "/box",
      label: "feature/box",
      commands: ["devbox rm box", "dns rm box.dev"],
      approved: true,
      ...overrides,
    });
  });
  return answer;
}

const dialog = () =>
  waitFor(() => {
    const el = document.querySelector<HTMLElement>('[role="dialog"], [role="alertdialog"]');
    if (!el) throw new Error("dialog not open");
    return el;
  });

const button = (root: HTMLElement, label: string) =>
  Array.from(root.querySelectorAll("button")).find((b) => b.textContent === label)!;

const preview = (root: HTMLElement) =>
  root.querySelector<HTMLElement>('[data-testid="resource-teardown-preview"]')!;

afterEach(() => {
  cleanup();
  useWorktreeResourceTeardownConfirmStore.getState().resolveConfirmation(false);
});

describe("WorktreeResourceTeardownConfirmDialog", () => {
  it("renders nothing until a request is pending", () => {
    render(<WorktreeResourceTeardownConfirmDialog />);
    expect(document.querySelector('[role="dialog"], [role="alertdialog"]')).toBeNull();
  });

  it("names the worktree, lists every command, and resolves true on confirm", async () => {
    render(<WorktreeResourceTeardownConfirmDialog />);
    const answer = open();
    const el = await dialog();
    expect(el.textContent).toContain("Tear down resource for 'feature/box'?");
    expect(preview(el).querySelector("pre")!.textContent).toBe("devbox rm box\ndns rm box.dev");
    expect(preview(el).textContent).toContain("Commands that will run");

    await act(async () => {
      fireEvent.click(button(el, "Tear down resource"));
    });
    expect(await answer).toBe(true);
  });

  it("resolves false on cancel", async () => {
    render(<WorktreeResourceTeardownConfirmDialog />);
    const answer = open();
    const el = await dialog();

    await act(async () => {
      fireEvent.click(button(el, "Cancel"));
    });
    expect(await answer).toBe(false);
  });

  it("says when the commands await approval rather than promising they will run", async () => {
    render(<WorktreeResourceTeardownConfirmDialog />);
    void open({ approved: false });
    const el = preview(await dialog());
    expect(el.textContent).not.toContain("Commands that will run");
    expect(el.textContent).toContain("isn't approved yet");
  });

  it.each([
    [null, "Couldn't read which commands will run."],
    [[], "No teardown commands found."],
  ])("says so when the commands are %j", async (commands, text) => {
    render(<WorktreeResourceTeardownConfirmDialog />);
    void open({ commands });
    const el = preview(await dialog());
    expect(el.querySelector("pre")!.textContent).toBe(text);
    expect(el.textContent).not.toContain("isn't approved yet");
  });

  it("settles a pending request false when the host unmounts", async () => {
    const { unmount } = render(<WorktreeResourceTeardownConfirmDialog />);
    const answer = open();
    await dialog();

    unmount();
    expect(await answer).toBe(false);
  });
});
