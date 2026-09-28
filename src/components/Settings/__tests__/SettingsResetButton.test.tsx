// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { SettingsGroup, SettingsRow } from "../SettingsGroup";
import { SettingsInput } from "../SettingsInput";
import { SettingsSwitch } from "../SettingsSwitch";

let frames: FrameRequestCallback[] = [];

beforeEach(() => {
  frames = [];
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
    frames.push(cb);
    return frames.length;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function flushFrames() {
  act(() => {
    const pending = frames;
    frames = [];
    for (const cb of pending) cb(0);
  });
}

function StandaloneInput() {
  const [modified, setModified] = useState(true);
  return (
    <SettingsInput
      label="Name"
      defaultValue="custom"
      isModified={modified}
      onReset={() => setModified(false)}
    />
  );
}

function GroupedSwitchRow({ onRowClick }: { onRowClick?: () => void }) {
  const [modified, setModified] = useState(true);
  const [on, setOn] = useState(true);
  return (
    <SettingsGroup>
      <SettingsRow
        label="Wrap lines"
        isModified={modified}
        onReset={() => {
          setOn(false);
          setModified(false);
        }}
        onRowClick={onRowClick}
        control={({ labelId }) => (
          <SettingsSwitch checked={on} onCheckedChange={setOn} aria-labelledby={labelId} />
        )}
      />
    </SettingsGroup>
  );
}

describe("SettingsResetButton focus hand-off", () => {
  it("moves focus to the field's input after a keyboard reset unmounts the button", () => {
    render(<StandaloneInput />);
    const reset = screen.getByRole("button", { name: "Reset Name to default" });
    reset.focus();
    expect(document.activeElement).toBe(reset);

    fireEvent.click(reset, { detail: 0 });
    expect(screen.queryByRole("button", { name: "Reset Name to default" })).toBeNull();
    flushFrames();

    expect(document.activeElement).toBe(screen.getByLabelText("Name"));
  });

  it("moves focus to a grouped row's switch after a keyboard reset", () => {
    render(<GroupedSwitchRow />);
    const reset = screen.getByRole("button", { name: "Reset Wrap lines to default" });
    reset.focus();

    fireEvent.click(reset, { detail: 0 });
    expect(screen.queryByRole("button", { name: "Reset Wrap lines to default" })).toBeNull();
    flushFrames();

    const control = screen.getByRole("switch");
    expect(control.getAttribute("aria-checked")).toBe("false");
    expect(document.activeElement).toBe(control);
  });

  it("leaves focus alone after a pointer reset", () => {
    render(<StandaloneInput />);
    const reset = screen.getByRole("button", { name: "Reset Name to default" });
    reset.focus();

    fireEvent.click(reset, { detail: 1 });
    expect(screen.queryByRole("button", { name: "Reset Name to default" })).toBeNull();
    flushFrames();

    expect(document.activeElement).not.toBe(screen.getByLabelText("Name"));
    expect(document.activeElement).toBe(document.body);
  });

  it("leaves focus alone after a pointer reset in a grouped row", () => {
    render(<GroupedSwitchRow />);
    const reset = screen.getByRole("button", { name: "Reset Wrap lines to default" });
    reset.focus();

    fireEvent.click(reset, { detail: 1 });
    flushFrames();

    expect(document.activeElement).not.toBe(screen.getByRole("switch"));
  });
});

describe("SettingsResetButton click containment", () => {
  it("does not bubble the reset click to the row's onRowClick or any ancestor", () => {
    const onRowClick = vi.fn();
    const ancestorClick = vi.fn();
    render(
      <div onClick={ancestorClick}>
        <GroupedSwitchRow onRowClick={onRowClick} />
      </div>
    );

    fireEvent.click(screen.getByRole("button", { name: "Reset Wrap lines to default" }), {
      detail: 1,
    });

    expect(screen.queryByRole("button", { name: "Reset Wrap lines to default" })).toBeNull();
    expect(onRowClick).not.toHaveBeenCalled();
    expect(ancestorClick).not.toHaveBeenCalled();
  });
});
