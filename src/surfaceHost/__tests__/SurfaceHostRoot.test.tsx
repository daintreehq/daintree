/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { SurfaceHostRoot } from "../SurfaceHostRoot";

afterEach(cleanup);

describe("SurfaceHostRoot", () => {
  it("mounts the surface container tagged with its surface id", () => {
    const { getByTestId } = render(<SurfaceHostRoot surfaceId="surface-aux-1" />);
    const host = getByTestId("paint-surface-host");
    expect(host.dataset.surfaceId).toBe("surface-aux-1");
  });
});
