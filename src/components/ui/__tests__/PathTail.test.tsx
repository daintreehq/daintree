// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { PathTail } from "../PathTail";

describe("PathTail", () => {
  it("keeps the path whole and isolated from the clipping direction", () => {
    const path = "src/components/Settings/AgentSettings/";
    const { container } = render(<PathTail data-testid="dir">{path}</PathTail>);
    const span = container.querySelector("[data-testid='dir']")!;
    // Only the box runs right-to-left; the path's own order must not flip.
    expect(span.textContent).toBe(path);
    expect(span.querySelector("bdi")?.textContent).toBe(path);
  });

  it("forces the path left-to-right even when it starts with an RTL segment", () => {
    // A bare <bdi> takes its direction from the first strong character, so a
    // Hebrew-leading directory would render its separators on the wrong side.
    const { container } = render(<PathTail>{"א/src/"}</PathTail>);
    expect(container.querySelector("bdi")?.getAttribute("dir")).toBe("ltr");
  });
});
