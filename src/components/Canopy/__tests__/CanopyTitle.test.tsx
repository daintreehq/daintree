// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render } from "@testing-library/react";
import type { ReactElement } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { CanopyTitle } from "../CanopyTitle";

function renderTitle(ui: ReactElement) {
  const onPanelKey = vi.fn();
  // The panel around it: a key the field lets through would reach this.
  const view = render(
    <TooltipProvider>
      <div onKeyDown={onPanelKey}>{ui}</div>
    </TooltipProvider>
  );
  const name = () => view.container.querySelector<HTMLElement>('[role="button"]');
  const field = () => view.container.querySelector<HTMLInputElement>("input");
  return { ...view, name, field, onPanelKey };
}

describe("CanopyTitle", () => {
  it("renames on double-click and Enter, with nothing reaching the panel", async () => {
    const onRename = vi.fn(async () => {});
    const { name, field, onPanelKey } = renderTitle(
      <CanopyTitle title="Claude" onRename={onRename} />
    );
    fireEvent.doubleClick(name()!);
    expect(document.activeElement).toBe(field());
    fireEvent.change(field()!, { target: { value: "  auth fix " } });
    fireEvent.keyDown(field()!, { key: "e" });
    await act(async () => {
      fireEvent.keyDown(field()!, { key: "Enter" });
    });
    expect(onRename).toHaveBeenCalledWith("auth fix");
    expect(onPanelKey).not.toHaveBeenCalled();
    // The new name shows at once, ahead of main's report of it.
    expect(name()?.textContent).toBe("auth fix");
  });

  it("leaves the name as it was on Escape, without closing the panel around it", () => {
    const onRename = vi.fn(async () => {});
    const { name, field, onPanelKey } = renderTitle(
      <CanopyTitle title="Claude" onRename={onRename} />
    );
    fireEvent.keyDown(name()!, { key: "F2" });
    fireEvent.change(field()!, { target: { value: "other" } });
    fireEvent.keyDown(field()!, { key: "Escape" });
    expect(field()).toBeNull();
    expect(name()?.textContent).toBe("Claude");
    expect(onRename).not.toHaveBeenCalled();
    expect(onPanelKey).not.toHaveBeenCalled();
  });

  it("puts back the default on an empty Enter, but never clears the name on leaving", () => {
    const onRename = vi.fn(async () => {});
    const { name, field } = renderTitle(<CanopyTitle title="auth fix" onRename={onRename} />);
    fireEvent.doubleClick(name()!);
    fireEvent.change(field()!, { target: { value: "" } });
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 1_000);
    fireEvent.blur(field()!);
    expect(onRename).not.toHaveBeenCalled();
    vi.restoreAllMocks();

    fireEvent.doubleClick(name()!);
    fireEvent.change(field()!, { target: { value: "   " } });
    fireEvent.keyDown(field()!, { key: "Enter" });
    expect(onRename).toHaveBeenCalledWith("");
  });

  it("never brings back a name typed before a reset once main reports the default", async () => {
    const onRename = vi.fn(async () => {});
    const view = renderTitle(<CanopyTitle title="Claude" onRename={onRename} />);
    const wrap = (title: string) => (
      <TooltipProvider>
        <div>
          <CanopyTitle title={title} onRename={onRename} />
        </div>
      </TooltipProvider>
    );
    fireEvent.doubleClick(view.name()!);
    fireEvent.change(view.field()!, { target: { value: "auth fix" } });
    await act(async () => {
      fireEvent.keyDown(view.field()!, { key: "Enter" });
    });
    view.rerender(wrap("auth fix"));
    fireEvent.doubleClick(view.name()!);
    fireEvent.change(view.field()!, { target: { value: "" } });
    await act(async () => {
      fireEvent.keyDown(view.field()!, { key: "Enter" });
    });
    expect(onRename).toHaveBeenLastCalledWith("");
    view.rerender(wrap("Claude"));
    expect(view.name()?.textContent).toBe("Claude");
  });

  it("starts from Space, or a press from assistive technology, but not a single mouse click", () => {
    const onRename = vi.fn(async () => {});
    const { name, field } = renderTitle(<CanopyTitle title="Claude" onRename={onRename} />);
    fireEvent.click(name()!, { detail: 1 });
    expect(field()).toBeNull();
    fireEvent.click(name()!, { detail: 0 });
    expect(field()).not.toBeNull();
    fireEvent.keyDown(field()!, { key: "Escape" });
    fireEvent.keyDown(name()!, { key: " " });
    expect(field()).not.toBeNull();
  });

  it("renames nothing for an unchanged name", () => {
    const onRename = vi.fn(async () => {});
    const { name, field } = renderTitle(<CanopyTitle title="Claude" onRename={onRename} />);
    fireEvent.doubleClick(name()!);
    fireEvent.keyDown(field()!, { key: "Enter" });
    expect(onRename).not.toHaveBeenCalled();
  });

  it("goes back to the old name when the rename is refused", async () => {
    const onRename = vi.fn(async () => {
      throw new Error("That agent isn't running any more.");
    });
    const { name, field } = renderTitle(<CanopyTitle title="Claude" onRename={onRename} />);
    fireEvent.doubleClick(name()!);
    fireEvent.change(field()!, { target: { value: "auth fix" } });
    await act(async () => {
      fireEvent.keyDown(field()!, { key: "Enter" });
    });
    expect(name()?.textContent).toBe("Claude");
  });

  it("starts a rename asked for from the row, once per request", () => {
    const onRename = vi.fn(async () => {});
    // Asked for as the pane opens: renaming another run from its row opens it first.
    const { field, rerender } = renderTitle(
      <CanopyTitle title="Claude" onRename={onRename} renameRequest={1} />
    );
    expect(field()).not.toBeNull();
    fireEvent.keyDown(field()!, { key: "Escape" });
    const wrap = (request: number) => (
      <TooltipProvider>
        <div>
          <CanopyTitle title="Claude" onRename={onRename} renameRequest={request} />
        </div>
      </TooltipProvider>
    );
    // The same request again starts nothing; a new one does.
    rerender(wrap(1));
    expect(field()).toBeNull();
    rerender(wrap(2));
    expect(field()).not.toBeNull();
  });

  it("keeps the field when a menu closing hands focus away just after it opened", () => {
    const onRename = vi.fn(async () => {});
    const { field } = renderTitle(
      <CanopyTitle title="Claude" onRename={onRename} renameRequest={1} />
    );
    fireEvent.blur(field()!);
    expect(field()).not.toBeNull();
  });
});
