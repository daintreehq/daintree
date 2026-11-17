// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SshSignInDialog } from "../SshSignInDialog";
import type { SshSignInState } from "../useSshSignIn";

const SSH = { kind: "ssh" as const, target: "greg@studio" };

function renderDialog(state: SshSignInState) {
  const handlers = { onAnswer: vi.fn(), onRetry: vi.fn(), onClose: vi.fn() };
  const view = render(<SshSignInDialog hostLabel="studio" state={state} {...handlers} />);
  return { ...handlers, view };
}

describe("SshSignInDialog", () => {
  it("shows ssh's question as written and hands back what was typed, on Enter too", () => {
    const text =
      "Duo two-factor login for greg\n\n 1. Duo Push to XXX-XXX-1234\n\nPasscode or option (1-1):";
    const { onAnswer } = renderDialog({
      phase: "signing-in",
      connection: SSH,
      prompt: { id: "p1", kind: "secret", text },
    });
    expect(screen.getByTestId("ssh-sign-in-prompt").textContent).toBe(text);
    const field = screen.getByTestId("ssh-sign-in-answer") as HTMLInputElement;
    expect(field.type).toBe("password");
    fireEvent.change(field, { target: { value: "1" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(onAnswer).toHaveBeenCalledWith("p1", "1");
  });

  it("starts each new question with an empty field", () => {
    const { view } = renderDialog({
      phase: "signing-in",
      connection: SSH,
      prompt: { id: "p1", kind: "secret", text: "Password:" },
    });
    fireEvent.change(screen.getByTestId("ssh-sign-in-answer"), { target: { value: "typed" } });
    view.rerender(
      <SshSignInDialog
        hostLabel="studio"
        state={{
          phase: "signing-in",
          connection: SSH,
          prompt: { id: "p2", kind: "secret", text: "Verification code:" },
        }}
        onAnswer={() => {}}
        onRetry={() => {}}
        onClose={() => {}}
      />
    );
    expect((screen.getByTestId("ssh-sign-in-answer") as HTMLInputElement).value).toBe("");
  });

  it("shows a notice with nothing to type and only a way out", () => {
    const { onClose } = renderDialog({
      phase: "signing-in",
      connection: SSH,
      prompt: {
        id: "p1",
        kind: "notice",
        text: "Confirm user presence for key ECDSA-SK SHA256:abc",
      },
    });
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
