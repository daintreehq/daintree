// @vitest-environment jsdom
import { createEvent, fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { NoticeText } from "../noticeText";
import { AssistantPanelView } from "../AssistantPanelView";
import { PROSE_SPECIMEN } from "../__preview__/proseSpecimen";
import type { AssistantNotice } from "@/store/assistantStore";

/**
 * Which parts of a notice become navigable, and which never can.
 *
 * A notice is TERMINAL text the engine composed — command output and error guidance —
 * so the linkifier has two jobs and both are asserted here rather than described. It has
 * to reproduce the message exactly (columns, runs of spaces, tabs, newlines), and it has
 * to refuse every address whose displayed characters are not themselves the destination.
 *
 * The tests lean on two invariants rather than on expected strings: the rendered text
 * equals the input character for character, and every anchor's `href` attribute equals
 * its own text. Both hold for any message, so they keep meaning as the parser changes.
 */

vi.mock("@/components/Terminal/HybridInputBar", () => ({ HybridInputBar: () => null }));

vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
);

function renderNotice(message: string): HTMLElement {
  const { container } = render(
    <p>
      <NoticeText message={message} />
    </p>
  );
  return container;
}

function links(el: HTMLElement): HTMLAnchorElement[] {
  return [...el.querySelectorAll("a")];
}

function hrefs(el: HTMLElement): (string | null)[] {
  return links(el).map((a) => a.getAttribute("href"));
}

/** The invariant that makes a link honest: what you read is what opens. */
function expectHrefMatchesText(el: HTMLElement) {
  for (const a of links(el)) {
    expect(a.getAttribute("href")).toBe(a.textContent);
  }
}

/** Every rendered notice keeps its message intact, whatever the linkifier did to it. */
function expectTextPreserved(el: HTMLElement, message: string) {
  expect(el.textContent).toBe(message);
}

function noticeRow(message: string, level: AssistantNotice["level"]): HTMLElement {
  const notice: AssistantNotice = {
    id: "n1",
    level,
    message,
    at: 1_000_001,
    turnId: null,
    afterTurnId: null,
  };
  const { container } = render(
    <AssistantPanelView
      state={{ ...PROSE_SPECIMEN, turns: [], notices: [notice] }}
      onSubmit={() => true}
      onInterrupt={() => {}}
      onDecideApproval={() => {}}
    />
  );
  const row = container.querySelector<HTMLElement>('[data-testid="assistant-notice"]');
  if (!row) throw new Error("the panel rendered no notice row");
  return row;
}

describe("notice links", () => {
  it("makes a single https address navigable", () => {
    const message = "Open https://staging.daintree.test/account to manage your plan.";
    const el = renderNotice(message);

    expect(links(el)).toHaveLength(1);
    expectHrefMatchesText(el);
    expectTextPreserved(el, message);
  });

  it("makes every https address in one message navigable", () => {
    const message =
      "https://staging.daintree.test/subscribe to start\nor sign in at https://staging.daintree.test/account";
    const el = renderNotice(message);

    // The first is at index 0, which is the one position with no preceding character to
    // judge the token boundary by.
    expect(hrefs(el)).toEqual([
      "https://staging.daintree.test/subscribe",
      "https://staging.daintree.test/account",
    ]);
    expectHrefMatchesText(el);
    expectTextPreserved(el, message);
  });

  it("links the token as written rather than a parsed reconstruction of it", () => {
    // Every one of these is an address the URL parser would rewrite on its way to an
    // `href` — it appends the root path to a bare origin, lowercases a host, and
    // lowercases a scheme. Rewriting is the drift the contract forbids: the href has to
    // be the string the reader is looking at, so the parser is asked for a verdict and
    // never for an address.
    const message =
      "Try https://staging.daintree.test then https://Staging.Daintree.test/Account or HTTPS://staging.daintree.test/x";
    const el = renderNotice(message);

    expect(hrefs(el)).toEqual([
      "https://staging.daintree.test",
      "https://Staging.Daintree.test/Account",
      "HTTPS://staging.daintree.test/x",
    ]);
    expectHrefMatchesText(el);
    expectTextPreserved(el, message);
  });

  it("hands the link to the keyboard and opens it away from this document", () => {
    const el = renderNotice("Manage at https://staging.daintree.test/account");
    const [anchor] = links(el);
    if (!anchor) throw new Error("the address was not linked at all");

    // An anchor is reachable by Tab, and activated by Enter, only when it carries an
    // href — an href-less anchor reports tabIndex -1 and refuses focus. jsdom does not
    // navigate, so what is checked of Enter is the part that is ours to get wrong:
    // nothing in the rendered link consumes the key before the platform acts on it.
    expect(anchor.tabIndex).toBe(0);
    anchor.focus();
    expect(document.activeElement).toBe(anchor);

    const enter = createEvent.keyDown(anchor, { key: "Enter" });
    fireEvent(anchor, enter);
    expect(enter.defaultPrevented).toBe(false);

    expect(anchor.target).toBe("_blank");
    const rel = anchor.getAttribute("rel") ?? "";
    expect(rel.split(/\s+/)).toEqual(expect.arrayContaining(["noopener", "noreferrer"]));
  });

  it("leaves a column-aligned command result character-identical", () => {
    // The shape `/account` actually returns: padded columns, one per line. Collapsing a
    // run of spaces or dropping a newline here is the linkifier reflowing terminal text.
    const message = [
      "/account",
      "plan     standard",
      "email    dev@daintree.test",
      "manage   https://staging.daintree.test/account",
      "\tbilling\thttps://staging.daintree.test/billing",
    ].join("\n");
    const el = renderNotice(message);

    expectTextPreserved(el, message);
    expect(links(el)).toHaveLength(2);
    expectHrefMatchesText(el);
  });

  it("leaves sentence punctuation outside the address", () => {
    const cases: [string, string][] = [
      ["See https://a.test/x.", "https://a.test/x"],
      ["See https://a.test/x, then stop", "https://a.test/x"],
      ["See https://a.test/x; also", "https://a.test/x"],
      ["Docs: https://a.test/x: read it", "https://a.test/x"],
      ["See https://a.test/x?q=1!", "https://a.test/x?q=1"],
      ["See (https://a.test/x) now", "https://a.test/x"],
      ["See [https://a.test/x] now", "https://a.test/x"],
      ["See <https://a.test/x>", "https://a.test/x"],
      ['See "https://a.test/x"', "https://a.test/x"],
      // The token can never contain the quote that opened it, so a lone apostrophe
      // inside a path is not one and must not adopt the sentence's closing quote.
      ["See 'https://a.test/what's-new'", "https://a.test/what's-new"],
      // A bracket the address opened for itself is part of the address.
      ["See https://a.test/Foo_(bar)", "https://a.test/Foo_(bar)"],
      // ...and an unmatched closer earlier in the path must not cancel that opener.
      ["See https://a.test/)foo()", "https://a.test/)foo()"],
      // One of the two closes the address, the other closes the sentence.
      ["See https://a.test/(x))", "https://a.test/(x)"],
      // A stray closer of another kind inside a matched pair is path, not punctuation.
      ["See https://a.test/(x])", "https://a.test/(x])"],
      [`See https://a.test/${")".repeat(200)}`, "https://a.test/"],
    ];
    for (const [message, href] of cases) {
      const el = renderNotice(message);
      expect(hrefs(el), message).toEqual([href]);
      expectHrefMatchesText(el);
      expectTextPreserved(el, message);
    }
  });

  it("refuses every address that is not a plain https token", () => {
    const inert = [
      // Plaintext, including the loopback diagnostics notices carry.
      "Backend at http://localhost:8080/healthz",
      "Backend at http://staging.daintree.test/account",
      "javascript:alert(document.cookie)",
      "data:text/html,<script>alert(1)</script>",
      "file:///etc/passwd",
      "daintree-assistant://open?token=abc",
      // Everything before the `@` reads as the site and is not the site — including the
      // empty forms, which carry no username for a parser to report.
      "Go to https://staging.daintree.test@evil.test/account",
      "Go to https://user:pw@evil.test/account",
      "Go to https://@evil.test/account",
      "Go to https://:@evil.test/account",
      // The URL parser reads a backslash as a slash for special schemes, so the host
      // this resolves to is not the host the text names.
      "Go to https://good.test\\@evil.test",
      "Go to https:\\\\evil.test",
      // Stripped, re-encoded or invisible characters: reader and browser disagree.
      "Go to https://good.test\u0000.evil.test",
      "Go to https://good.test\u202E/evil.test",
      "Go to https://good.test\u2060.evil.test",
      "Go to https://good.test\uFEFF.evil.test",
      // The authority is what decides where a click lands, and each of these reads as
      // one host and resolves to another: an extra slash, a percent escape, a fraction
      // slash that is not a path separator, and a Cyrillic homograph.
      "Go to https:///evil.test",
      // Legacy IPv4 spellings: every one of these lands on 127.0.0.1 while naming
      // something that is not it.
      "Go to https://2130706433/",
      "Go to https://0x7f.1/",
      "Go to https://0177.1/",
      "Go to https://127.1/",
      "Go to https://%65xample.com",
      "Go to https://good.test\u2044evil.test",
      "Go to https://\u0440aypal.com",
      // Not a URL at all.
      "Go to https://",
      "Go to https://[unclosed",
      // Glued to the preceding word: linking the tail would show part of a token as if
      // it were the whole address.
      "Go to xhttps://evil.test",
      "Go to data:text/html,https://evil.test",
    ];
    for (const message of inert) {
      const el = renderNotice(message);
      expect(links(el), message).toHaveLength(0);
      expectTextPreserved(el, message);
    }
  });

  it("links a literal address that the parser leaves alone", () => {
    // A dotted quad and a bracketed IPv6 literal both survive the parser character for
    // character, so both are as honest as a domain and neither is special-cased away.
    const message = "Local https://127.0.0.1:8080/healthz and https://[::1]:8443/x";
    const el = renderNotice(message);

    expect(hrefs(el)).toEqual(["https://127.0.0.1:8080/healthz", "https://[::1]:8443/x"]);
    expectHrefMatchesText(el);
    expectTextPreserved(el, message);
  });

  it("keeps looking after refusing a candidate", () => {
    // A refusal is about one candidate, not about the rest of the token it sat in. The
    // second address begins after an opening bracket and stands on its own.
    const message = "See https://[broken](https://good.test)";
    const el = renderNotice(message);

    expect(hrefs(el)).toEqual(["https://good.test"]);
    expectHrefMatchesText(el);
    expectTextPreserved(el, message);
  });

  it("treats markup in an error as text, never as elements", () => {
    const message = "Engine refused: <script>alert(1)</script> in <b>config</b> — see &lt;docs&gt;";
    const el = renderNotice(message);

    expect(el.querySelector("script")).toBeNull();
    expect(el.querySelector("b")).toBeNull();
    expectTextPreserved(el, message);
  });

  it("links a command result rendered through the panel", () => {
    // `command:result` composes the message as `${command}\n${text}`, so what reaches
    // NoticeRow is the echoed slash line with the answer beneath it.
    const message = "/account\nplan     standard\nmanage   https://staging.daintree.test/account";
    const row = noticeRow(message, "info");

    expect(hrefs(row)).toEqual(["https://staging.daintree.test/account"]);
    expectHrefMatchesText(row);
    expectTextPreserved(row, message);
  });

  it("links engine error guidance rendered through the panel", () => {
    // `host:error` carries the engine's message verbatim, and signed-out guidance is
    // where the subscribe address actually reaches a user.
    const message =
      "You are not signed in. Subscribe at https://staging.daintree.test/subscribe, then run /login.";
    const row = noticeRow(message, "error");

    expect(hrefs(row)).toEqual(["https://staging.daintree.test/subscribe"]);
    expectHrefMatchesText(row);
    expectTextPreserved(row, message);
  });
});
