// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AssistantApprovalCard } from "../AssistantApprovalCard";
import type { AssistantApproval } from "@/store/assistantStore";

const approval: AssistantApproval = {
  approvalId: "approval-focus",
  toolId: "terminal.sendCommand",
  grantKey: "terminal.sendCommand",
  summary: "Run the terminal command",
  needsTypedConfirm: false,
  rememberable: true,
  requestedAt: 0,
};

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

describe("approval focus ownership", () => {
  it.each([false, true])(
    "preserves an external editor when typed confirmation is %s",
    (needsTypedConfirm) => {
      const editor = document.createElement("textarea");
      document.body.append(editor);
      editor.focus();
      const decide = vi.fn();
      render(
        <AssistantApprovalCard approval={{ ...approval, needsTypedConfirm }} onDecide={decide} />
      );

      expect(document.activeElement).toBe(editor);
      fireEvent.keyDown(editor, { key: "y" });
      expect(decide).not.toHaveBeenCalled();
    }
  );

  it("preserves a draft being typed inside the assistant", () => {
    const surface = document.createElement("div");
    surface.dataset.assistantSurface = "";
    const editor = document.createElement("textarea");
    surface.append(editor);
    document.body.append(surface);
    editor.focus();
    const decide = vi.fn();
    const mount = surface.appendChild(document.createElement("div"));
    render(<AssistantApprovalCard approval={approval} onDecide={decide} />, { container: mount });
    expect(document.activeElement).toBe(editor);
    fireEvent.keyDown(editor, { key: "f" });
    expect(decide).not.toHaveBeenCalled();
  });

  it("keeps explicit approval and decline controls operable without taking focus", () => {
    const decide = vi.fn();
    const { getByRole } = render(<AssistantApprovalCard approval={approval} onDecide={decide} />);
    fireEvent.click(getByRole("button", { name: "Decline" }));
    expect(decide).toHaveBeenCalledExactlyOnceWith(approval.approvalId, "rejected");
  });
});
