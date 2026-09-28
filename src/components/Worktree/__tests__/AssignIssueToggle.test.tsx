// @vitest-environment jsdom
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AssignIssueToggle } from "../views/IssueSelectorView";

describe("AssignIssueToggle", () => {
  it("is a checkbox named by the words it shows", () => {
    render(
      <AssignIssueToggle
        assignWorktreeToSelf={false}
        onSetAssignWorktreeToSelf={() => {}}
        currentUser="mira-okafor"
      />
    );
    const box = screen.getByRole("checkbox");
    const visible = screen.getByText("Assign to @mira-okafor");
    expect(box.getAttribute("aria-label")).toBeNull();
    expect(box.closest("label")?.textContent).toContain(visible.textContent);
  });

  it("toggles from its label text", () => {
    const onSet = vi.fn();
    render(<AssignIssueToggle assignWorktreeToSelf={false} onSetAssignWorktreeToSelf={onSet} />);
    fireEvent.click(screen.getByText("Assign to me"));
    expect(onSet).toHaveBeenCalledTimes(1);
    expect(onSet).toHaveBeenLastCalledWith(true);
  });
});
