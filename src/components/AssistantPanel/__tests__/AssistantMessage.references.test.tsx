// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { refractor } from "refractor/core";
import { AssistantMessage, type AssistantReference } from "../AssistantMessage";

/**
 * The recognition policy, asserted from the OUTSIDE — through the real markdown
 * pipeline rather than against the plugin's internals — because what matters is what a
 * reader can click, not what a tree walk produced.
 *
 * The bias under test is deliberate and asymmetric. A reference that stays plain text
 * costs a reader one copy-paste. A reference linked to the wrong thing costs them their
 * confidence in every other link in the transcript, and gives them no way to tell which
 * ones to doubt. So most of these cases assert that something is NOT a link.
 */

function renderProse(
  content: string,
  opts: { forge?: boolean; onActivate?: (r: AssistantReference) => void } = {}
): HTMLElement {
  const { container } = render(
    <AssistantMessage
      content={content}
      forgeAvailable={opts.forge ?? true}
      onActivateReference={opts.onActivate ?? (() => {})}
    />
  );
  return container.querySelector<HTMLElement>(".assistant-prose")!;
}

/** Internal references render as buttons; external ones as anchors. */
const refs = (el: HTMLElement) => [...el.querySelectorAll("button")];
const links = (el: HTMLElement) => [...el.querySelectorAll("a")];

describe("reference recognition", () => {
  it("links a pull request the model named as one", () => {
    const el = renderProse("Landed in PR #11250 this morning.");
    expect(refs(el).map((b) => b.textContent)).toEqual(["PR #11250"]);
  });

  it("links an issue the model named as one", () => {
    const el = renderProse("Tracked as issue #11244.");
    expect(refs(el).map((b) => b.textContent)).toEqual(["issue #11244"]);
  });

  it("routes the two nouns to DIFFERENT kinds", () => {
    // The whole point of requiring the noun is that it disambiguates. If both resolved
    // to the same kind, requiring it would be ceremony.
    const seen: AssistantReference[] = [];
    const el = renderProse("See issue #1 and PR #2.", { onActivate: (r) => seen.push(r) });
    refs(el).forEach((b) => b.click());
    expect(seen).toEqual([
      { kind: "issue", number: 1 },
      { kind: "pr", number: 2 },
    ]);
  });

  it("leaves a BARE number alone", () => {
    // `#5167` is an issue, a pull request, a heading anchor, or a number in prose, and
    // nothing here says which. This is the single most important case in the file.
    const el = renderProse("Both #5167 and #11244 mention forge.");
    expect(refs(el)).toHaveLength(0);
    expect(links(el)).toHaveLength(0);
  });

  it("reads only the word DIRECTLY before a backticked number", () => {
    const withNoun = renderProse("Tracked as issue `#11244`.");
    expect(refs(withNoun).map((b) => b.textContent)).toEqual(["#11244"]);

    // The noun appears, but a sentence away. Scanning that far starts inferring, and a
    // reference that resolves differently depending on how far back a word appeared is
    // worse than one that never resolves.
    const distant = renderProse("The issue is subtle. Anyway, `#11244`.");
    expect(refs(distant)).toHaveLength(0);
  });

  it("leaves every reference plain when no forge provider resolved", () => {
    // There is nowhere for it to go. A link that cannot navigate is a broken promise,
    // and inventing a github.com URL would be this panel deciding which forge the
    // project uses.
    const el = renderProse("Landed in PR #11250, tracked as issue `#11244`.", { forge: false });
    expect(refs(el)).toHaveLength(0);
    expect(links(el)).toHaveLength(0);
  });

  it("leaves a reference plain when nothing can route it", () => {
    const { container } = render(
      <AssistantMessage content="Landed in PR #11250." forgeAvailable />
    );
    const el = container.querySelector<HTMLElement>(".assistant-prose")!;
    expect(refs(el)).toHaveLength(0);
    expect(el.textContent).toContain("PR #11250");
  });

  it("does not linkify inside a fenced code block", () => {
    // A fence is literal by definition. Its content is frequently a command or a diff,
    // and a control inside one changes what the reader thinks they are looking at.
    const el = renderProse("```\ngh pr view PR #11250\n```");
    expect(refs(el)).toHaveLength(0);
    expect(el.querySelector("pre")?.textContent).toContain("PR #11250");
  });
});

describe("URLs in code spans", () => {
  it("links a backticked URL, keeping it styled as the literal it is", () => {
    const el = renderProse("Reachable at `https://example.com/mcp`.");
    const anchor = links(el)[0];
    expect(anchor?.getAttribute("href")).toBe("https://example.com/mcp");
    // The <code> survives inside the anchor: the link adds an affordance, it does not
    // take away the fact that this is a literal.
    expect(anchor?.querySelector("code")).not.toBeNull();
  });

  it("opens external targets out of the app, without a referrer", () => {
    const el = renderProse("Reachable at `https://example.com/mcp`.");
    const anchor = links(el)[0];
    expect(anchor?.getAttribute("target")).toBe("_blank");
    expect(anchor?.getAttribute("rel")).toContain("noreferrer");
  });

  it("does not link a code span that merely CONTAINS a URL", () => {
    // This is a command to run, not a destination to follow.
    const el = renderProse("Run `curl https://example.com/mcp -H x:1` to check.");
    expect(links(el)).toHaveLength(0);
  });

  it("does not link a non-http scheme in a code span", () => {
    const el = renderProse("Set `file:///etc/passwd` as the target.");
    expect(links(el)).toHaveLength(0);
  });

  it("leaves a reference alone inside an existing link's LABEL", () => {
    // The case that actually risks nesting: the reference is the anchor text. An
    // internal reference renders as a <button>, so `a a` would not have caught it —
    // the earlier version of this test put the reference OUTSIDE the link and proved
    // nothing.
    const el = renderProse("See [PR #1](https://example.com/x) for details.");
    expect(el.querySelectorAll("a")).toHaveLength(1);
    expect(el.querySelectorAll("a button")).toHaveLength(0);
    expect(el.querySelector("a")?.getAttribute("href")).toBe("https://example.com/x");
  });

  it("does not re-link what remark-gfm already autolinked", () => {
    const el = renderProse("See https://example.com/issues and PR #1.");
    expect(el.querySelectorAll("a a")).toHaveLength(0);
    expect(el.querySelectorAll("a button")).toHaveLength(0);
  });
});

describe("structural context", () => {
  // The transform recurses through container nodes to reach the text inside them. A
  // missed container is invisible in a paragraph-only test and means every reference a
  // model writes in a bulleted summary — which is most of them — stays plain.
  const CONTAINERS: [string, string][] = [
    ["list item", "- Landed in PR #11250"],
    ["ordered list item", "1. Landed in PR #11250"],
    ["heading", "## Landed in PR #11250"],
    ["blockquote", "> Landed in PR #11250"],
    ["table cell", "| a |\n| --- |\n| PR #11250 |"],
    ["bold", "**Landed in PR #11250**"],
    ["italic", "*Landed in PR #11250*"],
    ["nested list", "- outer\n  - Landed in PR #11250"],
  ];

  for (const [name, markdown] of CONTAINERS) {
    it(`recognises a reference inside a ${name}`, () => {
      const el = renderProse(markdown);
      expect(refs(el).map((b) => b.textContent)).toEqual(["PR #11250"]);
    });
  }
});

describe("lexical variants", () => {
  // What counts as "the model said which kind it is". These pin the POLICY, not the
  // regex: each asserts a reading a person would agree with.
  const ACCEPTED: [string, string, "issue" | "pr"][] = [
    ["lowercase noun", "landed in pr #7", "pr"],
    ["capitalised noun", "Tracked as Issue #7", "issue"],
    ["shouted noun", "LANDED IN PULL REQUEST #7", "pr"],
    ["plural noun", "See issues #7", "issue"],
    ["plural abbreviation", "See PRs #7", "pr"],
    ["trailing comma", "PR #7, then the next one", "pr"],
    ["at the very start", "PR #7 landed", "pr"],
    ["at the very end", "landed in PR #7", "pr"],
  ];

  for (const [name, markdown, kind] of ACCEPTED) {
    it(`accepts ${name}`, () => {
      const seen: AssistantReference[] = [];
      const el = renderProse(markdown, { onActivate: (r) => seen.push(r) });
      refs(el).forEach((b) => b.click());
      expect(seen).toEqual([{ kind, number: 7 }]);
    });
  }

  it("rejects a number too long to be a real reference", () => {
    // No forge numbers issues into the tens of millions. Rejecting is the conservative
    // half of the policy: an unrecognised reference costs a copy-paste, a wrong one
    // costs trust in every other link.
    const el = renderProse("See issue #123456789 for context.");
    expect(refs(el)).toHaveLength(0);
  });

  it("rejects #0, which no forge issues", () => {
    const el = renderProse("See issue #0 for context.");
    expect(refs(el)).toHaveLength(0);
    expect(el.textContent).toContain("#0");
  });

  it("does not run two references together without separation", () => {
    // `PR #1issue #2` is not two references, it is a typo. Linking either half would be
    // asserting a reading of text that has none.
    const el = renderProse("PR #1issue #2");
    expect(refs(el)).toHaveLength(0);
  });
});

describe("streaming", () => {
  it("leaves a fenced block unhighlighted while text is still arriving", () => {
    // Mid-stream a fence is a syntactically broken fragment. Highlighting it re-tokenises
    // a growing buffer every frame to show colours that are wrong until the last
    // character lands.
    const streaming = render(
      <AssistantMessage content={"```ts\nconst x = 1;\n```"} streaming />
    ).container;
    expect(streaming.querySelectorAll("pre .token")).toHaveLength(0);

    const settled = render(<AssistantMessage content={"```ts\nconst x = 1;\n```"} />).container;
    expect(settled.querySelectorAll("pre .token").length).toBeGreaterThan(0);
  });

  it("falls back to plain text when a grammar throws", () => {
    // The downgrade path. A grammar that throws mid-highlight must lose the COLOUR and
    // nothing else: the reader still needs every character of the snippet, and losing
    // the block would lose the answer.
    const source = "const x = 1;";
    vi.spyOn(refractor, "highlight").mockImplementationOnce(() => {
      throw new Error("bad grammar");
    });
    const { container } = render(<AssistantMessage content={`\`\`\`ts\n${source}\n\`\`\``} />);
    const code = container.querySelector("pre code");
    expect(code?.textContent).toBe(source);
    expect(code?.className).toContain("language-typescript");
    expect(container.querySelectorAll("pre .token")).toHaveLength(0);
  });

  it("leaves an unknown grammar as plain text rather than failing", () => {
    // `brainfuck` has no loader. The block must still render its characters.
    const { container } = render(<AssistantMessage content={"```brainfuck\n+[--->++<]>+.\n```"} />);
    expect(container.querySelector("pre code")?.textContent).toBe("+[--->++<]>+.");
  });

  it("does not highlight a fence with no language", () => {
    // refractor cannot guess a grammar, and choosing one would colour a paste of log
    // output as though it were source.
    const { container } = render(<AssistantMessage content={"```\nsome output\n```"} />);
    expect(container.querySelectorAll("pre .token")).toHaveLength(0);
  });

  it("re-recognises when the forge capability arrives late", () => {
    // The plugin list is memoized, and the failure mode of memoizing it is memoizing it
    // on the WRONG key — an empty dependency array holds the first value forever. A
    // forge provider resolves asynchronously, so the first render of a transcript
    // routinely happens before it lands: if the plugins never rebuilt, every reference
    // in that transcript would stay plain text for the life of the session.
    //
    // Asserted as behaviour rather than by inspecting the memo, which is why it is a
    // rerender rather than a fresh mount — a fresh mount would pass even with `[]`.
    const onActivate = vi.fn();
    const { rerender, container } = render(
      <AssistantMessage
        content="Landed in PR #11250."
        forgeAvailable={false}
        onActivateReference={onActivate}
      />
    );
    expect(container.querySelectorAll("button")).toHaveLength(0);

    rerender(
      <AssistantMessage
        content="Landed in PR #11250."
        forgeAvailable
        onActivateReference={onActivate}
      />
    );
    expect(container.querySelectorAll("button")).toHaveLength(1);
  });
});
