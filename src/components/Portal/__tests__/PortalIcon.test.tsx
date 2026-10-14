// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PortalIcon } from "../PortalIcon";

describe("PortalIcon — privacy", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders Globe (no img) for unknown icons regardless of url, so user-added link hostnames never leak to a third party", () => {
    const { container } = render(<PortalIcon icon="some-custom-icon" size="launchpad" />);

    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("svg")).not.toBeNull();
  });
});
