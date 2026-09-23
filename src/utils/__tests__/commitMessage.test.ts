import { describe, it, expect } from "vitest";
import { parseCommitBody } from "../commitMessage";

describe("parseCommitBody", () => {
  it("lifts the trailer block out of the prose and keeps co-authors in order", () => {
    const parsed = parseCommitBody(
      [
        "Resume a dropped part instead of restarting.",
        "",
        "- cap concurrent parts",
        "",
        "Co-authored-by: Sam Okafor <sam@helios.dev>",
        "Signed-off-by: Priya Raman <priya@helios.dev>",
        "Co-authored-by: Claude <noreply@anthropic.com>",
      ].join("\n")
    );
    expect(parsed.text).toBe(
      "Resume a dropped part instead of restarting.\n\n- cap concurrent parts"
    );
    expect(parsed.coAuthors.map((p) => p.name)).toEqual(["Sam Okafor", "Claude"]);
    expect(parsed.text).not.toMatch(/-by:/);
  });

  it("leaves a final paragraph alone unless every line in it is a trailer", () => {
    const body = "Why this changed.\n\nNote: this also fixes the flake.\nIt was the retry timer.";
    expect(parseCommitBody(body)).toEqual({ text: body, coAuthors: [] });
  });

  it("returns empty prose when the body is nothing but trailers", () => {
    const parsed = parseCommitBody("Signed-off-by: dependabot[bot] <support@github.com>");
    expect(parsed.text).toBe("");
    expect(parsed.coAuthors).toEqual([]);
  });

  it("de-duplicates a co-author credited twice", () => {
    const parsed = parseCommitBody(
      "Co-authored-by: Sam <sam@x.dev>\nCo-authored-by: Sam Okafor <SAM@x.dev>"
    );
    expect(parsed.coAuthors).toHaveLength(1);
  });

  it("treats empty and CRLF bodies safely", () => {
    expect(parseCommitBody(undefined)).toEqual({ text: "", coAuthors: [] });
    expect(parseCommitBody("One.\r\n\r\nCo-authored-by: A <a@x>").coAuthors).toHaveLength(1);
  });
});
