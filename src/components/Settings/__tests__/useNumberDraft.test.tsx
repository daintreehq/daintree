// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { useNumberDraft } from "../useNumberDraft";

const parsePositive = (raw: string) => {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : undefined;
};

function Field({ onCommit }: { onCommit: (v: number | undefined) => void }) {
  const [stored, setStored] = useState<number | undefined>(10);
  const draft = useNumberDraft(stored === undefined ? "" : String(stored), parsePositive, (v) => {
    setStored(v);
    onCommit(v);
  });
  return (
    <>
      <input aria-label="n" value={draft.value} onChange={draft.onChange} />
      {draft.invalid && <p>invalid</p>}
      <p data-testid="stored">{String(stored)}</p>
    </>
  );
}

describe("useNumberDraft", () => {
  it("never commits an entry that doesn't parse, and keeps it on screen", () => {
    const onCommit = vi.fn();
    render(<Field onCommit={onCommit} />);
    fireEvent.change(screen.getByLabelText("n"), { target: { value: "0" } });
    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.getByLabelText<HTMLInputElement>("n").value).toBe("0");
    expect(screen.getByText("invalid")).toBeTruthy();
    expect(screen.getByTestId("stored").textContent).toBe("10");
  });

  it("commits a valid entry and drops the error", () => {
    const onCommit = vi.fn();
    render(<Field onCommit={onCommit} />);
    fireEvent.change(screen.getByLabelText("n"), { target: { value: "-3" } });
    fireEvent.change(screen.getByLabelText("n"), { target: { value: "25" } });
    expect(onCommit).toHaveBeenLastCalledWith(25);
    expect(screen.queryByText("invalid")).toBeNull();
  });

  it("treats a cleared field as a reset to the default, not an error", () => {
    const onCommit = vi.fn();
    render(<Field onCommit={onCommit} />);
    fireEvent.change(screen.getByLabelText("n"), { target: { value: "" } });
    expect(onCommit).toHaveBeenLastCalledWith(undefined);
    expect(screen.queryByText("invalid")).toBeNull();
  });
});
