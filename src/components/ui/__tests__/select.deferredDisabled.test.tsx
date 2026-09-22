// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";

// Hold Radix back so the stand-in trigger is what renders.
vi.mock("../radix-loader", () => ({
  useRadixPrimitives: () => null,
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

afterEach(() => {
  cleanup();
});

function trigger(container: HTMLElement): HTMLButtonElement {
  const el = container.querySelector<HTMLButtonElement>("button");
  if (!el) throw new Error("no trigger");
  return el;
}

describe("Select before Radix loads", () => {
  it("renders the stand-in trigger disabled and queues no open when the root is disabled", () => {
    const onOpenChange = vi.fn();
    const { container } = render(
      <Select disabled onOpenChange={onOpenChange}>
        <SelectTrigger>
          <SelectValue placeholder="Pick one" />
        </SelectTrigger>
      </Select>
    );

    expect(trigger(container).disabled).toBe(true);
    fireEvent.click(trigger(container));
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("still queues an open from an enabled root", () => {
    const onOpenChange = vi.fn();
    const { container } = render(
      <Select onOpenChange={onOpenChange}>
        <SelectTrigger>
          <SelectValue placeholder="Pick one" />
        </SelectTrigger>
      </Select>
    );

    expect(trigger(container).disabled).toBe(false);
    fireEvent.click(trigger(container));
    expect(onOpenChange).toHaveBeenCalledWith(true);
  });
});
