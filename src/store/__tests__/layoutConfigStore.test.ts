import { beforeEach, describe, expect, it } from "vitest";
import { useLayoutConfigStore } from "../layoutConfigStore";

describe("layoutConfigStore", () => {
  beforeEach(() => {
    useLayoutConfigStore.setState({
      layoutConfig: { strategy: "automatic", value: 3 },
      gridDimensions: null,
    });
  });

  it("ignores duplicate grid dimension updates", () => {
    const initialDimensions = { width: 1200, height: 800 };

    useLayoutConfigStore.getState().setGridDimensions(initialDimensions);
    const firstState = useLayoutConfigStore.getState().gridDimensions;

    useLayoutConfigStore.getState().setGridDimensions({ width: 1200, height: 800 });
    const secondState = useLayoutConfigStore.getState().gridDimensions;

    expect(firstState).toEqual(initialDimensions);
    expect(secondState).toBe(firstState);
  });

  it("clears dimensions when requested", () => {
    useLayoutConfigStore.getState().setGridDimensions({ width: 1200, height: 800 });
    useLayoutConfigStore.getState().setGridDimensions(null);

    expect(useLayoutConfigStore.getState().gridDimensions).toBeNull();
  });
});
