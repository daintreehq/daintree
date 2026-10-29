// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { useCommittedNumberDraft } from "../useCommittedNumberDraft";

const BOUNDS = { min: 4, max: 100 };

function Field({ onCommit, initial = 12 }: { onCommit: (v: number) => void; initial?: number }) {
  const [stored, setStored] = useState(initial);
  const draft = useCommittedNumberDraft(stored, BOUNDS, (v) => {
    setStored(v);
    onCommit(v);
  });
  return (
    <>
      <input
        aria-label="n"
        value={draft.value}
        onChange={draft.onChange}
        onBlur={draft.onBlur}
        onKeyDown={draft.onKeyDown}
      />
      <button onClick={draft.clear}>clear</button>
      <button onClick={() => setStored(50)}>external</button>
      <p data-testid="stored">{stored}</p>
    </>
  );
}

const input = () => screen.getByLabelText("n") as HTMLInputElement;

describe("useCommittedNumberDraft", () => {
  it("holds what is typed and commits it once, on blur", () => {
    const onCommit = vi.fn();
    render(<Field onCommit={onCommit} />);

    fireEvent.change(input(), { target: { value: "2" } });
    fireEvent.change(input(), { target: { value: "20" } });
    expect(input().value).toBe("20");
    expect(onCommit).not.toHaveBeenCalled();

    fireEvent.blur(input());
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(20);
    expect(input().value).toBe("20");
  });

  it("commits on Enter without committing again when the field then blurs", () => {
    const onCommit = vi.fn();
    render(<Field onCommit={onCommit} />);

    fireEvent.change(input(), { target: { value: "30" } });
    fireEvent.keyDown(input(), { key: "Enter" });
    fireEvent.blur(input());

    expect(onCommit).toHaveBeenCalledExactlyOnceWith(30);
  });

  it("corrects a number outside the bounds to the nearest bound only when committed", () => {
    const onCommit = vi.fn();
    render(<Field onCommit={onCommit} />);

    fireEvent.change(input(), { target: { value: "1" } });
    expect(input().value).toBe("1");
    fireEvent.blur(input());
    expect(onCommit).toHaveBeenLastCalledWith(4);
    expect(input().value).toBe("4");

    fireEvent.change(input(), { target: { value: "250" } });
    fireEvent.blur(input());
    expect(onCommit).toHaveBeenLastCalledWith(100);
    expect(input().value).toBe("100");
  });

  it("shows the corrected number even when it equals the one already stored", () => {
    const onCommit = vi.fn();
    render(<Field onCommit={onCommit} initial={100} />);

    fireEvent.change(input(), { target: { value: "500" } });
    fireEvent.blur(input());

    expect(onCommit).not.toHaveBeenCalled();
    expect(input().value).toBe("100");
  });

  it.each(["", "   ", "1.5", "abc"])("puts the stored number back for %j", (raw) => {
    const onCommit = vi.fn();
    render(<Field onCommit={onCommit} />);

    fireEvent.change(input(), { target: { value: raw } });
    fireEvent.blur(input());

    expect(onCommit).not.toHaveBeenCalled();
    expect(input().value).toBe("12");
  });

  it("does not commit a number that is already stored", () => {
    const onCommit = vi.fn();
    render(<Field onCommit={onCommit} />);

    fireEvent.change(input(), { target: { value: "12" } });
    fireEvent.blur(input());

    expect(onCommit).not.toHaveBeenCalled();
  });

  it("drops a half-typed entry when the stored number changes elsewhere", () => {
    const onCommit = vi.fn();
    render(<Field onCommit={onCommit} />);

    fireEvent.change(input(), { target: { value: "7" } });
    fireEvent.click(screen.getByText("external"));

    expect(input().value).toBe("50");
    fireEvent.blur(input());
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("clear() drops the entry even when the stored number is unchanged", () => {
    const onCommit = vi.fn();
    render(<Field onCommit={onCommit} />);

    fireEvent.change(input(), { target: { value: "7" } });
    fireEvent.click(screen.getByText("clear"));

    expect(input().value).toBe("12");
  });

  it("keeps an entry across a rerender with a new commit callback", () => {
    const { rerender } = render(<Field onCommit={vi.fn()} />);

    fireEvent.change(input(), { target: { value: "2" } });
    rerender(<Field onCommit={vi.fn()} />);

    expect(input().value).toBe("2");
  });

  it("ignores Enter while an IME composition is open", () => {
    const onCommit = vi.fn();
    render(<Field onCommit={onCommit} />);

    fireEvent.change(input(), { target: { value: "30" } });
    fireEvent.keyDown(input(), { key: "Enter", isComposing: true });

    expect(onCommit).not.toHaveBeenCalled();
    expect(input().value).toBe("30");
  });
});
