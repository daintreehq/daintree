import { describe, expect, it, vi } from "vitest";
import type { MouseEvent as ReactMouseEvent } from "react";
import type { MouseSensorOptions } from "@dnd-kit/core";
import { PrimaryMouseSensor } from "../dragActivation";

const press = (button: number) => {
  const onActivation = vi.fn();
  const [activator] = PrimaryMouseSensor.activators;
  const started = activator!.handler(
    { nativeEvent: { button } } as unknown as ReactMouseEvent,
    { onActivation } as unknown as MouseSensorOptions
  );
  return { started, activated: onActivation.mock.calls.length > 0 };
};

describe("PrimaryMouseSensor", () => {
  it("picks up on the primary button only", () => {
    expect(press(0)).toEqual({ started: true, activated: true });
    // Middle and right buttons never start a reorder.
    expect(press(1)).toEqual({ started: false, activated: false });
    expect(press(2)).toEqual({ started: false, activated: false });
  });
});
