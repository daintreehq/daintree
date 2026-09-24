// @vitest-environment jsdom
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";

const { radixState, rootProps } = vi.hoisted(() => ({
  radixState: { current: null as unknown },
  rootProps: [] as Array<Record<string, unknown>>,
}));

vi.mock("../radix-loader", () => ({
  useRadixPrimitives: () => radixState.current,
  primeOnEvent: vi.fn(),
}));

import { DropdownMenu, DropdownMenuTrigger } from "../dropdown-menu";

const fakeRadix = {
  DropdownMenuPrimitive: {
    Root: (props: Record<string, unknown> & { children?: React.ReactNode }) => {
      rootProps.push(props);
      return <>{props.children}</>;
    },
    Trigger: React.forwardRef<HTMLButtonElement, React.ComponentProps<"button">>(
      ({ children, ...props }, ref) => (
        <button ref={ref} type="button" {...props}>
          {children}
        </button>
      )
    ),
  },
};

afterEach(() => {
  cleanup();
  radixState.current = null;
  rootProps.length = 0;
});

function Menu({ asChild }: { asChild?: boolean }) {
  return (
    <DropdownMenu>
      {asChild ? (
        <DropdownMenuTrigger asChild>
          <button type="button">Scope</button>
        </DropdownMenuTrigger>
      ) : (
        <DropdownMenuTrigger>Scope</DropdownMenuTrigger>
      )}
    </DropdownMenu>
  );
}

describe("DropdownMenuTrigger before Radix loads", () => {
  it.each([false, true])(
    "announces a closed menu button and queues ArrowDown as an open (asChild=%s)",
    (asChild) => {
      const { getByRole, rerender } = render(<Menu asChild={asChild} />);
      const trigger = getByRole("button", { name: "Scope" });

      expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
      expect(trigger.getAttribute("aria-expanded")).toBe("false");

      fireEvent.keyDown(trigger, { key: "ArrowDown" });

      radixState.current = fakeRadix;
      rerender(<Menu asChild={asChild} />);
      expect(rootProps.at(-1)?.defaultOpen).toBe(true);
    }
  );

  it("leaves other keys alone", () => {
    const { getByRole, rerender } = render(<Menu />);
    fireEvent.keyDown(getByRole("button", { name: "Scope" }), { key: "ArrowUp" });

    radixState.current = fakeRadix;
    rerender(<Menu />);
    expect(rootProps.at(-1)?.defaultOpen).toBeUndefined();
  });
});
