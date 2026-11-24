import { describe, expect, it } from "vitest";
import {
  conversationStoreFor,
  readConversationStore,
  reopensFromConversationStore,
} from "../conversationStore.js";

const sessionId = "006fdfc0-67bf-4df0-ad82-48ebfe4df184";

describe("readConversationStore", () => {
  it("reads an absolute POSIX or Windows folder", () => {
    for (const configDir of ["/Users/me/.claude-a", "C:\\Users\\me\\.claude-a", "\\\\nas\\share"]) {
      expect(readConversationStore({ sessionId, configDir })).toEqual({ sessionId, configDir });
    }
  });

  it("drops anything else it was handed", () => {
    expect(readConversationStore({ sessionId, configDir: "/a", extra: 1 })).toEqual({
      sessionId,
      configDir: "/a",
    });
  });

  it("refuses a folder the CLI would resolve against its own cwd", () => {
    for (const configDir of ["relative/dir", "~/.claude", "", " /a", "/a\n", "\\work"]) {
      expect(readConversationStore({ sessionId, configDir })).toBeUndefined();
    }
  });

  it("refuses what isn't a store at all", () => {
    for (const value of [undefined, null, "x", [], { sessionId }, { configDir: "/a" }]) {
      expect(readConversationStore(value)).toBeUndefined();
    }
    expect(readConversationStore({ sessionId: 7, configDir: "/a" })).toBeUndefined();
  });
});

describe("conversationStoreFor", () => {
  const store = { sessionId, configDir: "/Users/me/.claude-a" };

  it("answers only for the conversation the store holds", () => {
    expect(conversationStoreFor(store, sessionId)).toEqual(store);
    expect(conversationStoreFor(store, "1ad2578c-b710-4302-90c1-b222c4c29aa2")).toBeUndefined();
    expect(conversationStoreFor(store, undefined)).toBeUndefined();
    expect(conversationStoreFor(store, null)).toBeUndefined();
    expect(conversationStoreFor(undefined, sessionId)).toBeUndefined();
  });
});

describe("reopensFromConversationStore", () => {
  it("holds for Claude Code alone", () => {
    expect(reopensFromConversationStore("claude")).toBe(true);
    expect(reopensFromConversationStore("codex")).toBe(false);
    expect(reopensFromConversationStore(undefined)).toBe(false);
  });
});
