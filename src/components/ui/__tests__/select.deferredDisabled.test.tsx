// @vitest-environment jsdom
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";

const { radixState, rootProps } = vi.hoisted(() => ({
  // `null` holds the stand-in trigger in place; tests swap in a fake Radix to
  // watch what the queued intent turns into once it "arrives".
  radixState: { current: null as unknown },
  rootProps: [] as Array<Record<string, unknown>>,
}));

vi.mock("../radix-loader", () => ({
  useRadixPrimitives: () => radixState.current,
  primeOnEvent: vi.fn(),
  composeHandlers: <T,>(
    first: ((event: T) => void) | undefined,
    second: ((event: T) => void) | undefined
  ) =>
    !first
      ? second
      : !second
        ? first
        : (event: T) => {
            first(event);
            second(event);
          },
}));

import { Select, SelectTrigger, SelectValue } from "../select";

const FakeTrigger = React.forwardRef<HTMLButtonElement, React.ComponentProps<"button">>(
  ({ children, ...props }, ref) => (
    <button ref={ref} type="button" {...props}>
      {children}
    </button>
  )
);
const FakeValue = React.forwardRef<HTMLSpanElement, { placeholder?: React.ReactNode }>(
  ({ placeholder }, ref) => <span ref={ref}>{placeholder}</span>
);

const fakeRadix = {
  SelectPrimitive: {
    Root: (props: Record<string, unknown> & { children?: React.ReactNode }) => {
      rootProps.push(props);
      return <>{props.children}</>;
    },
    Trigger: FakeTrigger,
    Value: FakeValue,
    Icon: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  },
};

afterEach(() => {
  cleanup();
  radixState.current = null;
  rootProps.length = 0;
});

function trigger(container: HTMLElement): HTMLButtonElement {
  const el = container.querySelector<HTMLButtonElement>("button");
  if (!el) throw new Error("no trigger");
  return el;
}

function SelectUnderTest({
  disabled,
  onOpenChange,
}: {
  disabled?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  return (
    <Select disabled={disabled} onOpenChange={onOpenChange}>
      <SelectTrigger>
        <SelectValue placeholder="Pick one" />
      </SelectTrigger>
    </Select>
  );
}

describe("Select before Radix loads", () => {
  it("renders the stand-in trigger disabled when the root is disabled", () => {
    const onOpenChange = vi.fn();
    const { container } = render(<SelectUnderTest disabled onOpenChange={onOpenChange} />);

    expect(trigger(container).disabled).toBe(true);
    fireEvent.click(trigger(container));
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("opens once Radix arrives when the stand-in was clicked", () => {
    const onOpenChange = vi.fn();
    const { container, rerender } = render(<SelectUnderTest onOpenChange={onOpenChange} />);

    expect(trigger(container).disabled).toBe(false);
    fireEvent.click(trigger(container));
    expect(onOpenChange).toHaveBeenCalledWith(true);

    radixState.current = fakeRadix;
    rerender(<SelectUnderTest onOpenChange={onOpenChange} />);

    expect(rootProps.at(-1)?.defaultOpen).toBe(true);
  });

  it("drops an open queued while enabled if the root is disabled before Radix arrives", () => {
    const { container, rerender } = render(<SelectUnderTest />);
    fireEvent.click(trigger(container));

    rerender(<SelectUnderTest disabled />);
    expect(trigger(container).disabled).toBe(true);

    radixState.current = fakeRadix;
    rerender(<SelectUnderTest disabled />);

    expect(rootProps.at(-1)?.defaultOpen).toBeUndefined();
    expect(rootProps.at(-1)?.disabled).toBe(true);
  });
});
