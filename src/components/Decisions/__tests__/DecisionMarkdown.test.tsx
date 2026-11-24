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

  it("shows a link's label and an image's alt text whatever the URL", () => {
    const root = rendered(
      "[js](javascript:alert(1)) ![local](file:///etc/passwd) ![data](data:image/png;base64,AAAA)"
    );
    expect(root.textContent).toContain("js");
    expect(root.textContent).toContain("[local]");
    expect(root.textContent).toContain("[data]");
  });

  it("keeps reference links, bare URLs, emails and footnotes inert, with their words", () => {
    const root = rendered(
      [
        "See [the docs][d], https://example.com/bare and someone@example.com.",
        "",
        "A claim.[^1]",
        "",
        "[d]: https://example.com/docs",
        "[^1]: The note, with ![pic](https://example.com/c.png) and [a](https://example.com).",
      ].join("\n")
    );
    expect(root.querySelector("a, img, [href], [src]")).toBeNull();
    expect(root.textContent).toContain("the docs");
    expect(root.textContent).toContain("https://example.com/bare");
    expect(root.textContent).toContain("someone@example.com");
    expect(root.textContent).toContain("The note");
    expect(root.textContent).toContain("[pic]");
  });

  it("shows an encoded tag as text, not markup", () => {
    const root = rendered("&lt;img src=x onerror=alert(1)&gt; and &amp;");
    expect(root.querySelector("img")).toBeNull();
    expect(root.textContent).toContain("<img src=x onerror=alert(1)>");
  });
});

describe("DecisionMarkdown GitHub alerts (#17333)", () => {
  it("draws an agent's alert as GitHub's titled box, without the marker", () => {
    const root = rendered("> [!WARNING]\n> This drops the **old** table.\n\nProceed?");
    const box = root.querySelector(".markdown-alert");
    expect(box?.getAttribute("data-markdown-alert")).toBe("warning");
    expect(box?.querySelector(".markdown-alert-title")?.textContent).toBe("Warning");
    expect(box?.querySelector("strong")?.textContent).toBe("old");
    expect(root.textContent).not.toContain("[!WARNING]");
  });

  it("keeps a link inside an alert as words with nothing to follow", () => {
    const root = rendered("> [!NOTE]\n> See [the docs](https://example.com).");
    expect(root.querySelector(".markdown-alert")).not.toBeNull();
    expect(root.querySelector("a, [href]")).toBeNull();
    expect(root.textContent).toContain("the docs");
  });
});
