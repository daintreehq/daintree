// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SshSignInDialog } from "../SshSignInDialog";
import type { SshSignInState } from "../useSshSignIn";

const SSH = { kind: "ssh" as const, target: "greg@studio" };

function asking(id: string, text: string, error?: string): SshSignInState {
  return {
    phase: "signing-in",
    connection: SSH,
    prompt: { id, kind: "secret", text },
    ...(error ? { error } : {}),
  };
}

function renderDialog(state: SshSignInState) {
  const handlers = { onAnswer: vi.fn(), onRetry: vi.fn(), onClose: vi.fn() };
  const view = render(<SshSignInDialog hostLabel="studio" state={state} {...handlers} />);
  const rerender = (next: SshSignInState) =>
    view.rerender(<SshSignInDialog hostLabel="studio" state={next} {...handlers} />);
  return { ...handlers, rerender };
}

const answerField = () => screen.getByTestId("ssh-sign-in-answer") as HTMLInputElement;

describe("SshSignInDialog", () => {
  it("shows ssh's question as written, describes the field with it, and hands back what was typed", () => {
    const text =
      "Duo two-factor login for greg\n\n 1. Duo Push to XXX-XXX-1234\n\nPasscode or option (1-1):";
    const state = asking("p1", text);
    const { onAnswer } = renderDialog(state);
    const shown = screen.getByTestId("ssh-sign-in-prompt");
    expect(shown.textContent).toBe(text);
    expect(answerField().type).toBe("password");
    expect(answerField().getAttribute("aria-describedby")).toBe(shown.id);
    fireEvent.change(answerField(), { target: { value: "1" } });
    fireEvent.keyDown(answerField(), { key: "Enter" });
    expect(onAnswer).toHaveBeenCalledWith(state.phase === "signing-in" && state.prompt, "1");
    expect(answerField().value).toBe("");
  });

  it("ignores an Enter that commits an IME candidate or is held from the last question", () => {
    const { onAnswer } = renderDialog(asking("p1", "Password:"));
    fireEvent.change(answerField(), { target: { value: "パス" } });
    fireEvent.keyDown(answerField(), { key: "Enter", isComposing: true });
    fireEvent.keyDown(answerField(), { key: "Enter", keyCode: 229 });
    fireEvent.keyDown(answerField(), { key: "Enter", repeat: true });
    expect(onAnswer).not.toHaveBeenCalled();
  });

  it("keeps nothing typed once its question has gone, even if the same one comes back", () => {
    const { rerender } = renderDialog(asking("p1", "Password:"));
    fireEvent.change(answerField(), { target: { value: "typed" } });
    rerender({ phase: "signing-in", connection: SSH, prompt: null });
    expect(screen.queryByTestId("ssh-sign-in-answer")).toBeNull();
    rerender(asking("p1", "Password:"));
    expect(answerField().value).toBe("");
  });

  it("says why an answer didn't reach ssh and asks again", () => {
    renderDialog(asking("p1", "Password:", "ssh takes up to 1022 bytes here."));
    expect(screen.getByRole("alert").textContent).toBe("ssh takes up to 1022 bytes here.");
    expect(answerField().value).toBe("");
  });

  it("announces a notice's instruction with nothing to type and only a way out", () => {
    const { onClose } = renderDialog({
      phase: "signing-in",
      connection: SSH,
      prompt: {
        id: "p1",
        kind: "notice",
        text: "Confirm user presence for key ECDSA-SK SHA256:abc",
      },
    });
    expect(screen.getByRole("status").textContent).toContain(
      "Confirm user presence for key ECDSA-SK SHA256:abc"
    );
    expect(screen.queryByTestId("ssh-sign-in-answer")).toBeNull();
    expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("says in ssh's words why it didn't get in, with a way to try again", () => {
    const { onRetry } = renderDialog({
      phase: "failed",
      connection: SSH,
      detail: "greg@studio: Permission denied (keyboard-interactive)",
    });
    expect(screen.getByRole("alert").textContent).toContain(
      "greg@studio: Permission denied (keyboard-interactive)"
    );
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalled();
  });
});
