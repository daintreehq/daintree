// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { DecisionMarkdown } from "../DecisionMarkdown";

afterEach(cleanup);

function rendered(text: string): HTMLElement {
  render(<DecisionMarkdown text={text} />);
  return screen.getByTestId("decision-markdown");
}

describe("DecisionMarkdown", () => {
  it("keeps markdown formatting", () => {
    const root = rendered("Ship **now** or `later`?\n\n- one\n- two");
    expect(root.querySelector("strong")?.textContent).toBe("now");
    expect(root.querySelector("code")?.textContent).toBe("later");
    expect(root.querySelectorAll("li")).toHaveLength(2);
  });

  it("drops raw HTML before it reaches the DOM", () => {
    const root = rendered(
      'Before <img src="https://example.com/x.png" onerror="alert(1)"> <script>alert(1)</script><iframe src="https://example.com"></iframe> after'
    );
    expect(root.querySelector("img, script, iframe")).toBeNull();
    expect(root.innerHTML).not.toContain("onerror");
  });

  it("never loads an image, local or remote, and shows its alt text instead", () => {
    const root = rendered(
      "![remote](https://example.com/a.png) ![local](file:///etc/passwd) ![data](data:image/png;base64,AAAA)\n\n![ref][r]\n\n[r]: https://example.com/b.png"
    );
    expect(root.querySelector("img, picture, video, audio, source")).toBeNull();
    expect(root.textContent).toContain("[remote]");
    expect(root.textContent).toContain("[ref]");
  });

  it("shows a link's words without anything to follow", () => {
    const root = rendered(
      "[click](https://example.com) [js](javascript:alert(1)) <https://example.com/auto>"
    );
    expect(root.querySelector("a, [href]")).toBeNull();
    expect(root.textContent).toContain("click");
    expect(root.innerHTML).not.toContain("javascript:");
  });

  it("keeps a mermaid fence as plain text", () => {
    const root = rendered("```mermaid\ngraph TD; A-->B\n```");
    expect(root.querySelector("svg")).toBeNull();
    expect(root.querySelector("pre")?.textContent).toContain("A-->B");
  });
});
