// @vitest-environment jsdom
import * as React from "react";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { _resetTooltipFocusSuppressionForTests } from "@/lib/tooltipFocusSuppression";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../dropdown-menu";

// A stand-in for a dialog that has claimed focus by the time the menu's close
// handler runs. In the app AppDialog takes focus a frame after it opens while
// the menu's exit animation lasts 120ms; jsdom has no exit animation, so the
// order is reproduced by claiming focus in a microtask, ahead of the close's
// own task but after the menu has stopped trapping focus.
function Harness({ focusHandoff }: { focusHandoff: boolean }) {
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const fieldRef = React.useRef<HTMLInputElement>(null);
  React.useEffect(() => {
    if (dialogOpen) queueMicrotask(() => fieldRef.current?.focus());
  }, [dialogOpen]);
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger>open menu</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem focusHandoff={focusHandoff} onSelect={() => setDialogOpen(true)}>
            Clear conversation
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {dialogOpen && <input aria-label="dialog field" ref={fieldRef} />}
    </>
  );
}

const CLOSE_SETTLE_MS = 250;
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, CLOSE_SETTLE_MS));

async function openAndPick(focusHandoff: boolean) {
  const utils = render(<Harness focusHandoff={focusHandoff} />);
  const trigger = utils.getByRole("button", { name: "open menu" });
  trigger.focus();
  await act(async () => {
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: "mouse" });
  });
  const item = await utils.findByRole("menuitem", { name: "Clear conversation" });
  await act(async () => {
    fireEvent.pointerDown(item, { button: 0, pointerType: "mouse" });
    fireEvent.click(item, { detail: 1 });
  });
  return { trigger, ...utils };
}

describe("DropdownMenuItem focusHandoff", () => {
  afterEach(() => {
    cleanup();
    _resetTooltipFocusSuppressionForTests();
  });

  it("keeps focus in the surface the item opened once the menu has finished closing", async () => {
    const { findByLabelText } = await openAndPick(true);
    await act(async () => {
      await settle();
    });
    const field = await findByLabelText("dialog field");

    expect(document.activeElement).toBe(field);
  });

  it("lets the close take focus back from a destination when the item is no handoff", async () => {
    // The control: the same flow without the prop is the bug this prevents.
    const { trigger } = await openAndPick(false);
    await act(async () => {
      await settle();
    });

    expect(document.activeElement).toBe(trigger);
  });

  it("returns focus to the trigger when nothing took it", async () => {
    // A handoff that never arrives must not strand focus on document.body.
    const utils = render(
      <DropdownMenu>
        <DropdownMenuTrigger>open menu</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem focusHandoff>Pick</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
    const trigger = utils.getByRole("button", { name: "open menu" });
    trigger.focus();
    await act(async () => {
      fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: "mouse" });
    });
    const item = await utils.findByRole("menuitem", { name: "Pick" });
    await act(async () => {
      fireEvent.pointerDown(item, { button: 0, pointerType: "mouse" });
      fireEvent.click(item, { detail: 1 });
    });
    await act(async () => {
      await settle();
    });

    expect(document.activeElement).toBe(trigger);
  });
});
