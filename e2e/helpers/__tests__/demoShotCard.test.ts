import { describe, it, expect } from "vitest";
import { renderShotCard } from "../demoShotCard";
import { validateScene, type BuiltScene, type DemoScene } from "../demoScene";

function built(overrides: Partial<BuiltScene> = {}): BuiltScene {
  return {
    slug: "scene",
    dir: "/tmp/daintree-demos/scene",
    remotePath: "/tmp/daintree-demos/scene-origin.git",
    worktrees: [{ branch: "feature/refund-retries", path: "/tmp/wt/feature-refund-retries" }],
    cleanup: () => {},
    ...overrides,
  };
}

function scene(overrides: Partial<DemoScene> = {}): DemoScene {
  return {
    slug: "scene",
    files: { "README.md": "# scene\n" },
    remote: true,
    worktrees: [
      {
        branch: "feature/refund-retries",
        push: true,
        uncommittedFiles: { "src/a.ts": "x", "src/b.ts": "y" },
        aheadCommits: [{ message: "m", files: { "src/c.ts": "z" } }],
      },
    ],
    ...overrides,
  };
}

describe("renderShotCard", () => {
  it("describes the state the harness actually built, not the state declared", () => {
    // The card's whole value is that its "already true" section comes from the
    // built scene, so it cannot drift from what the app boots into.
    const card = renderShotCard(scene(), built());

    expect(card).toContain("/tmp/daintree-demos/scene");
    expect(card).toContain("feature/refund-retries");
    expect(card).toContain("2 uncommitted files");
    expect(card).toContain("1 ahead of origin");
  });

  it("says plainly what a local remote cannot do", () => {
    const card = renderShotCard(scene(), built());
    expect(card).toContain("PR and CI chips do not");
  });

  it("says so when there is no remote at all", () => {
    const card = renderShotCard(scene({ remote: false }), built({ remotePath: null }));
    expect(card).toContain("No remote");
    expect(card).not.toContain("PR and CI chips do not");
  });

  it("singularises a lone uncommitted file", () => {
    const card = renderShotCard(
      scene({
        worktrees: [{ branch: "feature/refund-retries", uncommittedFiles: { "src/a.ts": "x" } }],
      }),
      built()
    );
    expect(card).toContain("1 uncommitted file");
    expect(card).not.toContain("1 uncommitted files");
  });

  it("accumulates timecodes across beats rather than restating durations", () => {
    const card = renderShotCard(
      scene({
        beats: [
          { name: "Broadcast", action: "Press Enter", seconds: 11 },
          { name: "Isolation", action: "Hover the sidebar", seconds: 9 },
          { name: "Waiting", action: "Click the pill", seconds: 65 },
        ],
      }),
      built()
    );

    expect(card).toContain("0:00–0:11");
    expect(card).toContain("0:11–0:20");
    expect(card).toContain("0:20–1:25");
    expect(card).toContain("1:25 of material");
  });

  it("warns when the beats overrun the target", () => {
    const card = renderShotCard(
      scene({ beats: [{ name: "Long", action: "Wait", seconds: 200 }] }),
      built(),
      { targetSeconds: 120 }
    );

    expect(card).toContain("Over target");
    expect(card).toContain("3:20");
    expect(card).toContain("2:00");
  });

  it("stays quiet when the beats fit", () => {
    const card = renderShotCard(
      scene({ beats: [{ name: "Short", action: "Click", seconds: 30 }] }),
      built(),
      { targetSeconds: 120 }
    );
    expect(card).not.toContain("Over target");
  });

  it("renders every beat field a recordist needs, and omits the ones not given", () => {
    const card = renderShotCard(
      scene({
        beats: [
          {
            name: "Attention handoff",
            given: "Three agents are working",
            action: "Click the Waiting pill",
            waitFor: "The pane to ping",
            expect: "The worktree switched",
            super: "Daintree reads the terminals.",
            seconds: 12,
          },
          { name: "Bare", action: "Do the thing", seconds: 4 },
        ],
      }),
      built()
    );

    expect(card).toContain("**Already true:** Three agents are working");
    expect(card).toContain("**Do:** Click the Waiting pill");
    expect(card).toContain("**Wait for:** The pane to ping");
    expect(card).toContain("**Good take if:** The worktree switched");
    expect(card).toContain("Daintree reads the terminals.");
    // The bare beat must not sprout empty headings.
    const bareSection = card.slice(card.indexOf("2. Bare"));
    expect(bareSection).toContain("**Do:** Do the thing");
    expect(bareSection).not.toContain("**Wait for:**");
    expect(bareSection).not.toContain("**Already true:**");
  });

  it("omits timecodes for a beat with no duration instead of inventing one", () => {
    const card = renderShotCard(scene({ beats: [{ name: "Untimed", action: "Click" }] }), built());
    expect(card).toContain("1. Untimed");
    expect(card).not.toContain("0:00–0:00");
  });

  it("tells the author what to do when a scene declares no beats", () => {
    const card = renderShotCard(scene(), built());
    expect(card).toContain("declares no beats");
    // The preflight is still worth printing — the state exists regardless.
    expect(card).toContain("feature/refund-retries");
  });

  it("keeps a super's own backticks from escaping its code span", () => {
    // A super is literal on-screen text and routinely contains punctuation.
    const card = renderShotCard(
      scene({ beats: [{ name: "A", action: "B", super: "Press `Enter` now", seconds: 5 }] }),
      built()
    );

    expect(card).toContain("``Press `Enter` now``");
  });

  it("refuses to render when the scene and the built scene are different builds", () => {
    // A card that mixes two builds is internally consistent and wrong, which is
    // exactly the failure this generator exists to prevent.
    expect(() => renderShotCard(scene(), built({ slug: "other-scene" }))).toThrow(
      /does not match built scene/
    );
  });

  it("refuses to render when the worktree sets disagree", () => {
    expect(() =>
      renderShotCard(scene(), built({ worktrees: [{ branch: "feature/other", path: "/tmp/x" }] }))
    ).toThrow(/disagree about worktrees/);
  });

  it("is honest that a new take does not reset the repository", () => {
    // startTake restores the profile only. Commits, edits and agent output all
    // survive into the next take, and the card used to claim otherwise.
    const card = renderShotCard(scene(), built());
    expect(card).toContain("does not reset");
    expect(card).toContain("rebuild the scene");
    expect(card).not.toContain("nothing carries over");
  });

  it("prints the commands it was given for reset and teardown", () => {
    const card = renderShotCard(scene(), built(), {
      takeCommand: "npm run demo:take -- my-scene",
      teardownCommand: "npm run demo:clean -- my-scene",
    });

    expect(card).toContain("npm run demo:take -- my-scene");
    expect(card).toContain("npm run demo:clean -- my-scene");
  });
});

describe("beat validation", () => {
  it("accepts a scene whose beats are complete", () => {
    expect(() =>
      validateScene(scene({ beats: [{ name: "A", action: "Click", seconds: 5 }] }))
    ).not.toThrow();
  });

  it("requires a name and an action", () => {
    let message = "";
    try {
      validateScene(scene({ beats: [{ name: "", action: "" }] }));
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("beats[0].name is required");
    expect(message).toContain("beats[0].action is required");
  });

  it("rejects a misspelled beat field rather than dropping it", () => {
    // A dropped `waitFor` would silently strip the cue from the shot card.
    let message = "";
    try {
      validateScene(scene({ beats: [{ name: "A", action: "B", waitfor: "C" }] } as never));
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('unknown field "waitfor"');
  });

  it.each([0, -5, Number.NaN, "12"])("rejects seconds: %s", (seconds) => {
    expect(() =>
      validateScene(scene({ beats: [{ name: "A", action: "B", seconds }] } as never))
    ).toThrow(/positive number/);
  });

  it.each(["name", "action", "given", "waitFor", "expect", "super"])(
    "rejects a newline in %s, which would break the card's structure",
    (field) => {
      // Each field becomes one Markdown line. A newline lets a beat inject its
      // own headings or fences into the shot card.
      expect(() =>
        validateScene(
          scene({ beats: [{ name: "A", action: "B", [field]: "one\n## injected" }] } as never)
        )
      ).toThrow(/single line/);
    }
  );

  it("rejects a whitespace-only action", () => {
    expect(() => validateScene(scene({ beats: [{ name: "A", action: "   " }] }))).toThrow(
      /action is required/
    );
  });

  it("rejects a half-timed beat list, which would misreport the timeline", () => {
    // An untimed beat contributes zero, so every beat after it would claim a
    // start time earlier than it actually happens.
    expect(() =>
      validateScene(
        scene({
          beats: [
            { name: "A", action: "x", seconds: 10 },
            { name: "B", action: "y" },
            { name: "C", action: "z", seconds: 5 },
          ],
        })
      )
    ).toThrow(/time all of them or none/);
  });

  it("accepts a beat list with no durations at all", () => {
    expect(() =>
      validateScene(
        scene({
          beats: [
            { name: "A", action: "x" },
            { name: "B", action: "y" },
          ],
        })
      )
    ).not.toThrow();
  });
});
