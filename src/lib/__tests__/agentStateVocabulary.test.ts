import { describe, it, expect } from "vitest";
import { agentStatePhrase, bucketCountPhrase } from "../agentStateVocabulary";

describe("agentStatePhrase", () => {
  it("names its unit and pluralizes it", () => {
    expect(agentStatePhrase(1, "waiting")).toBe("1 agent waiting");
    expect(agentStatePhrase(3, "unread")).toBe("3 agents unread");
    expect(agentStatePhrase(0, "blocked")).toBe("0 agents blocked");
  });
});

describe("bucketCountPhrase", () => {
  it("agrees the attention verb with its count", () => {
    expect(bucketCountPhrase(1, "attention")).toBe("1 needs attention");
    expect(bucketCountPhrase(2, "attention")).toBe("2 need attention");
  });

  it("uses the bucket's own word for working and finished", () => {
    expect(bucketCountPhrase(2, "working")).toBe("2 working");
    expect(bucketCountPhrase(1, "finished")).toBe("1 finished");
  });
});
