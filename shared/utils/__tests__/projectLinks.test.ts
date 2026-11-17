import { describe, expect, it } from "vitest";
import type { ProjectLink } from "../../types/projectLinks.js";
import {
  MAX_PROJECT_LINKS,
  applyProjectLinkChange,
  parseProjectLinkUrl,
  linkHost,
} from "../projectLinks.js";

const ids = () => {
  let next = 0;
  return () => `id-${++next}`;
};

describe("parseProjectLinkUrl (#17091)", () => {
  it.each([
    ["https://staging.example.com", "https://staging.example.com/"],
    ["https://example.com:8443/ci?x=1", "https://example.com:8443/ci?x=1"],
    ["http://localhost:3000", "http://localhost:3000/"],
    ["http://LOCALHOST:3000/app", "http://localhost:3000/app"],
    ["http://127.0.0.1:5173", "http://127.0.0.1:5173/"],
    // WHATWG normalizes these spellings to the loopback address itself.
    ["http://127.1/", "http://127.0.0.1/"],
  ])("lets the Assistant add %s", (url, href) => {
    expect(parseProjectLinkUrl(url, "assistant")).toEqual({ ok: true, href });
  });

  it.each([
    "http://staging.example.com",
    "http://10.0.0.5:8080",
    "http://localhost.evil.com",
    "http://[::1]:3000",
    "ftp://example.com",
    "javascript:alert(1)",
    "file:///etc/passwd",
    "data:text/html,hi",
    "https://user:pass@example.com",
    "https://prod.example.com@evil.com",
    "staging.example.com",
    "",
  ])("refuses the Assistant %s", (url) => {
    expect(parseProjectLinkUrl(url, "assistant").ok).toBe(false);
  });

  it("lets the user add any http or https address, but no other scheme or credentials", () => {
    expect(parseProjectLinkUrl("http://10.0.0.5:8080", "user")).toEqual({
      ok: true,
      href: "http://10.0.0.5:8080/",
    });
    expect(parseProjectLinkUrl("javascript:alert(1)", "user").ok).toBe(false);
    expect(parseProjectLinkUrl("https://a:b@example.com", "user").ok).toBe(false);
  });
});

describe("applyProjectLinkChange (#17091)", () => {
  const assistantLink: ProjectLink = {
    id: "mine",
    title: "Staging",
    url: "https://staging.example.com/",
    addedByAssistant: true,
  };
  const userLink: ProjectLink = {
    id: "theirs",
    title: "Prod",
    url: "https://prod.example.com/",
  };

  it("marks a link the Assistant adds, and not one the user adds", () => {
    const createId = ids();
    const byAssistant = applyProjectLinkChange(
      [],
      { op: "add", title: "CI", url: "https://ci.example.com" },
      "assistant",
      createId
    );
    const byUser = applyProjectLinkChange(
      [],
      { op: "add", title: "CI", url: "https://ci.example.com" },
      "user",
      createId
    );
    expect(byAssistant).toMatchObject({ saved: true, link: { addedByAssistant: true } });
    expect(byUser.saved && byUser.link).toEqual({
      id: "id-2",
      title: "CI",
      url: "https://ci.example.com/",
    });
  });

  it("refuses a title it can't show and a list at its limit", () => {
    expect(
      applyProjectLinkChange(
        [],
        { op: "add", title: "a\nb", url: "https://x.example.com" },
        "assistant",
        ids()
      )
    ).toMatchObject({ saved: false, code: "invalid-title" });
    const full = Array.from({ length: MAX_PROJECT_LINKS }, (_, i) => ({
      ...userLink,
      id: `l${i}`,
    }));
    expect(
      applyProjectLinkChange(
        full,
        { op: "add", title: "One more", url: "https://x.example.com" },
        "user",
        ids()
      )
    ).toMatchObject({ saved: false, code: "limit" });
  });

  it("holds the Assistant to its own links for updates and removals", () => {
    const links = [assistantLink, userLink];
    expect(
      applyProjectLinkChange(
        links,
        { op: "update", id: "theirs", title: "Renamed" },
        "assistant",
        ids()
      )
    ).toMatchObject({ saved: false, code: "not-added-by-assistant" });
    expect(
      applyProjectLinkChange(links, { op: "remove", id: "theirs" }, "assistant", ids())
    ).toMatchObject({ saved: false, code: "not-added-by-assistant" });

    const updated = applyProjectLinkChange(
      links,
      { op: "update", id: "mine", url: "https://staging2.example.com" },
      "assistant",
      ids()
    );
    expect(updated.saved && updated.links).toEqual([
      { ...assistantLink, url: "https://staging2.example.com/" },
      userLink,
    ]);
  });

  it("holds an Assistant update to the Assistant's address rule", () => {
    expect(
      applyProjectLinkChange(
        [assistantLink],
        { op: "update", id: "mine", url: "http://staging.example.com" },
        "assistant",
        ids()
      )
    ).toMatchObject({ saved: false, code: "invalid-url" });
  });

  it("hands a link the user edits over to the user, out of the Assistant's reach", () => {
    const edited = applyProjectLinkChange(
      [assistantLink, userLink],
      { op: "update", id: "mine", title: "Staging EU" },
      "user",
      ids()
    );
    if (!edited.saved) throw new Error(edited.message);
    expect(edited.links).toEqual([
      { id: "mine", title: "Staging EU", url: "https://staging.example.com/" },
      userLink,
    ]);

    for (const change of [
      { op: "update", id: "mine", title: "Back" } as const,
      { op: "remove", id: "mine" } as const,
    ]) {
      expect(applyProjectLinkChange(edited.links, change, "assistant", ids())).toMatchObject({
        saved: false,
        code: "not-added-by-assistant",
      });
    }
  });

  it("undoes the Assistant's add only while the link is still the Assistant's", () => {
    const undo = { op: "remove", id: "mine", onlyIfAddedByAssistant: true } as const;
    expect(applyProjectLinkChange([userLink, assistantLink], undo, "user", ids())).toMatchObject({
      saved: true,
      links: [userLink],
    });
    const takenOver = { ...assistantLink, addedByAssistant: undefined };
    expect(applyProjectLinkChange([takenOver], undo, "user", ids())).toMatchObject({
      saved: false,
      code: "not-added-by-assistant",
    });
  });

  it("says when a link is gone", () => {
    expect(applyProjectLinkChange([], { op: "remove", id: "gone" }, "user", ids())).toMatchObject({
      saved: false,
      code: "not-found",
    });
  });
});

describe("linkHost", () => {
  it("prints the host without www, and the text itself when it isn't a URL", () => {
    expect(linkHost("https://www.example.com/path")).toBe("example.com");
    expect(linkHost("not a url")).toBe("not a url");
  });
});
