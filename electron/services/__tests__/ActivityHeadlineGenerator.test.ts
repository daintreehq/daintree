import { describe, expect, it } from "vitest";
import { ActivityHeadlineGenerator } from "../ActivityHeadlineGenerator.js";

describe("ActivityHeadlineGenerator", () => {
  const generator = new ActivityHeadlineGenerator();

  it("classifies sudo-prefixed commands using the underlying command", () => {
    const result = generator.generate({
      terminalId: "term-1",
      activity: "busy",
      lastCommand: "sudo npm install",
    });

    expect(result).toEqual({
      headline: "Installing dependencies",
      status: "working",
      type: "background",
    });
  });

  it("classifies env-assignment and npx wrappers before command matching", () => {
    const result = generator.generate({
      terminalId: "term-2",
      activity: "busy",
      lastCommand: "FOO=1 BAR=2 npx vitest run",
    });

    expect(result.headline).toBe("Running tests");
  });

  it("classifies time-wrapper commands using the wrapped command", () => {
    const result = generator.generate({
      terminalId: "term-3",
      activity: "busy",
      lastCommand: "time yarn build",
    });

    expect(result.headline).toBe("Building project");
  });

  it("classifies npx commands when wrapper options are present", () => {
    const result = generator.generate({
      terminalId: "term-4",
      activity: "busy",
      lastCommand: "npx --yes vitest run",
    });

    expect(result.headline).toBe("Running tests");
  });

  it("classifies time commands when wrapper options are present", () => {
    const result = generator.generate({
      terminalId: "term-5",
      activity: "busy",
      lastCommand: "time -p npm test",
    });

    expect(result.headline).toBe("Running tests");
  });
});
