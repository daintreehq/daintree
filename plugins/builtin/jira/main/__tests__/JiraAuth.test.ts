import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CLOUD_BINDING,
  digestToken,
  getToken,
  getTokenVersion,
  recordProvenValidation,
  setMemoryToken,
  setProvenanceAccessors,
  tokenMayGoTo,
  type CredentialProvenance,
} from "../JiraAuth.js";

const CLOUD = "https://acme.atlassian.net";
const OTHER_CLOUD = "https://beta.atlassian.net";
const DATA_CENTER = "https://example.com/jira";

let stored: CredentialProvenance | null | "unknown";
let writes: Array<CredentialProvenance | null>;

function wire() {
  setProvenanceAccessors(
    () => stored,
    (record) => {
      writes.push(record);
      stored = record;
    }
  );
}

beforeEach(() => {
  stored = null;
  writes = [];
  setProvenanceAccessors(null, null);
  setMemoryToken(null);
  wire();
});

afterEach(() => {
  vi.useRealTimers();
  setProvenanceAccessors(null, null);
  setMemoryToken(null);
});

describe("where a token may go", () => {
  it("binds a token proven against a Data Center base to exactly that base", () => {
    recordProvenValidation("pat", DATA_CENTER);
    setMemoryToken("pat");

    expect(tokenMayGoTo(DATA_CENTER)).toBe(true);
    for (const other of [
      "https://example.com/jira-b",
      "https://example.com",
      "https://example.com:8443/jira",
      "https://jira.example.com",
      CLOUD,
    ]) {
      expect(tokenMayGoTo(other)).toBe(false);
    }
    expect(writes).toEqual([{ binding: DATA_CENTER, tokenDigest: digestToken("pat") }]);
  });

  it("lets a Cloud token go to any Atlassian tenant, and nowhere else", () => {
    recordProvenValidation("api-token", CLOUD);
    setMemoryToken("api-token");

    expect(tokenMayGoTo(CLOUD)).toBe(true);
    expect(tokenMayGoTo(OTHER_CLOUD)).toBe(true);
    expect(tokenMayGoTo(DATA_CENTER)).toBe(false);
    expect(stored).toEqual({ binding: CLOUD_BINDING, tokenDigest: digestToken("api-token") });
  });

  it("replays a token where its record says, whatever the settings say now", () => {
    stored = { binding: DATA_CENTER, tokenDigest: digestToken("pat") };
    setMemoryToken("pat");

    expect(tokenMayGoTo(DATA_CENTER)).toBe(true);
    expect(tokenMayGoTo(CLOUD)).toBe(false);
    expect(writes).toEqual([]);
  });

  it("takes a token saved before any record was kept as Cloud, and records it", () => {
    setMemoryToken("legacy");

    expect(tokenMayGoTo(CLOUD)).toBe(true);
    expect(tokenMayGoTo(DATA_CENTER)).toBe(false);
    expect(writes).toEqual([{ binding: CLOUD_BINDING, tokenDigest: digestToken("legacy") }]);
  });

  it("sends a token whose record is for another token nowhere", () => {
    stored = { binding: CLOUD_BINDING, tokenDigest: digestToken("old") };
    setMemoryToken("new");

    expect(getToken()).toBe("new");
    expect(tokenMayGoTo(CLOUD)).toBe(false);
    expect(tokenMayGoTo(DATA_CENTER)).toBe(false);
  });

  it("sends a token nowhere when its record can't be known", () => {
    stored = "unknown";
    setMemoryToken("pat");

    expect(tokenMayGoTo(CLOUD)).toBe(false);
    expect(tokenMayGoTo(DATA_CENTER)).toBe(false);
    expect(writes).toEqual([]);
  });

  it("falls back to the record once a proof has expired", () => {
    vi.useFakeTimers();
    stored = { binding: CLOUD_BINDING, tokenDigest: digestToken("pat") };
    recordProvenValidation("pat", DATA_CENTER);
    vi.advanceTimersByTime(5 * 60_000 + 1);
    setMemoryToken("pat");

    expect(tokenMayGoTo(DATA_CENTER)).toBe(false);
    expect(tokenMayGoTo(CLOUD)).toBe(true);
  });

  it("keeps each candidate's proof, so saving the first after checking the second binds it to its own site", () => {
    recordProvenValidation("pat-a", "https://example.com/jira-a");
    recordProvenValidation("pat-b", "https://example.com/jira-b");
    setMemoryToken("pat-a");

    expect(tokenMayGoTo("https://example.com/jira-a")).toBe(true);
    expect(tokenMayGoTo("https://example.com/jira-b")).toBe(false);
  });

  it("takes the latest proof for the same token", () => {
    recordProvenValidation("pat", "https://example.com/jira-a");
    recordProvenValidation("pat", "https://example.com/jira-b");
    setMemoryToken("pat");

    expect(tokenMayGoTo("https://example.com/jira-b")).toBe(true);
    expect(tokenMayGoTo("https://example.com/jira-a")).toBe(false);
  });

  it("binds where the caller names, when it names somewhere", () => {
    setMemoryToken("pat", DATA_CENTER);
    expect(tokenMayGoTo(DATA_CENTER)).toBe(true);
    expect(writes).toEqual([]);
  });
});

describe("token changes", () => {
  it("moves the version when the same token is saved again for another site", () => {
    recordProvenValidation("pat", "https://example.com/jira-a");
    setMemoryToken("pat");
    const before = getTokenVersion();

    recordProvenValidation("pat", "https://example.com/jira-b");
    setMemoryToken("pat");

    expect(getTokenVersion()).toBe(before + 1);
    expect(tokenMayGoTo("https://example.com/jira-b")).toBe(true);
  });

  it("leaves the version alone for a replay of the same token to the same place", () => {
    setMemoryToken("legacy");
    const before = getTokenVersion();
    setMemoryToken("legacy");
    expect(getTokenVersion()).toBe(before);
  });

  it("drops the record and proofs on a clear, even with nothing in memory", () => {
    recordProvenValidation("pat", DATA_CENTER);
    setMemoryToken(null);
    expect(writes).toEqual([null]);

    // The proof went with the clear, so a replay finds only the (now empty) record.
    stored = { binding: CLOUD_BINDING, tokenDigest: digestToken("other") };
    setMemoryToken("pat");
    expect(tokenMayGoTo(DATA_CENTER)).toBe(false);
  });

  it("keeps the record when the accessors are detached first, as disposal does", () => {
    recordProvenValidation("pat", DATA_CENTER);
    setMemoryToken("pat");
    setProvenanceAccessors(null, null);
    setMemoryToken(null);

    expect(stored).toEqual({ binding: DATA_CENTER, tokenDigest: digestToken("pat") });
    wire();
    setMemoryToken("pat");
    expect(tokenMayGoTo(DATA_CENTER)).toBe(true);
  });
});
