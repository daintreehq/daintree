// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StackLines } from "../StackLines";

const STACK = [
  "TypeError: boom",
  "    at Widget (file:///Users/USER/app/dist/assets/index-C3f9.js:1:42)",
  "",
  "Component stack:",
  "    at Panel",
].join("\n");

function renderLines(text: string) {
  const { container } = render(<pre>{<StackLines text={text} />}</pre>);
  return container.querySelector("pre")!;
}

describe("StackLines", () => {
  it("shows exactly the text it was given, line for line", () => {
    const pre = renderLines(STACK);
    const shown = Array.from(pre.children)
      .map((line) => (line.textContent === " " ? "" : line.textContent))
      .join("\n");
    expect(shown).toBe(STACK);
  });

  it("offers a line break after every slash and nowhere else", () => {
    const pre = renderLines(STACK);
    const slashes = STACK.split("").filter((c) => c === "/").length;
    expect(pre.querySelectorAll("wbr")).toHaveLength(slashes);
  });
});
