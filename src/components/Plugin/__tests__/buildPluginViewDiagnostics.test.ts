import { describe, expect, it } from "vitest";
import {
  buildPluginViewDiagnostics,
  type PluginViewDiagnosticsInput,
} from "../buildPluginViewDiagnostics";

// A distinct token per field, so an assertion can prove *which* field leaked
// rather than only that something did.
const MSG_TOKEN = `ghp_${"m".repeat(36)}`;
const STACK_TOKEN = `ghp_${"s".repeat(36)}`;
const CAUSE_TOKEN = `ghp_${"c".repeat(36)}`;
const PATH_TOKEN = `ghp_${"p".repeat(36)}`;

function build(overrides: Partial<PluginViewDiagnosticsInput> = {}) {
  return buildPluginViewDiagnostics({
    error: new Error("boom"),
    componentStack: "    at View",
    devMode: false,
    pluginId: "acme",
    pluginDisplayName: "Acme Tools",
    kindId: "acme.dashboard",
    panelDisplayName: "Dashboard",
    componentPath: "plugin://acme/dashboard.js",
    incidentId: null,
    ...overrides,
  });
}

function errorWith(message: string, stack?: string, extra: Record<string, unknown> = {}): Error {
  const error = new Error(message);
  error.stack = stack;
  return Object.assign(error, extra);
}

describe("buildPluginViewDiagnostics", () => {
  describe("redaction", () => {
    it("scrubs the message, not just the trace", () => {
      const { message, report } = build({
        error: errorWith(`Failed to load /Users/alice/config.json ${MSG_TOKEN}`),
      });

      expect(message).toBe("Failed to load /Users/USER/config.json [REDACTED]");
      expect(report).not.toContain(MSG_TOKEN);
      expect(report).not.toContain("/Users/alice");
    });

    it("leaves the message raw for a dev-mode plugin", () => {
      const { message, mode } = build({
        devMode: true,
        error: errorWith(`Failed to load /Users/alice/config.json ${MSG_TOKEN}`),
      });

      expect(message).toContain(MSG_TOKEN);
      expect(message).toContain("/Users/alice");
      expect(mode).toBe("raw (dev mode)");
    });

    // The whole-document pass is what stops the next field added to the report
    // from shipping raw the way `Message:` did. Only the metadata carries this
    // token, so nothing but that final pass can remove it.
    it("scrubs metadata the per-field passes never see", () => {
      const { report } = build({
        componentPath: `plugin:///Users/alice/dev/acme/dashboard.js?t=${PATH_TOKEN}`,
      });

      expect(report).not.toContain(PATH_TOKEN);
      expect(report).not.toContain("/Users/alice");
    });

    it("keeps the code location and the structured code through redaction", () => {
      const { code, report } = build({
        error: errorWith(
          "boom",
          `Error: boom ${STACK_TOKEN}\n    at Widget (/Users/alice/plugins/acme/dashboard.js:10:5)`,
          { code: "E_PLUGIN_RENDER" }
        ),
      });

      expect(report).toContain("dashboard.js:10:5");
      expect(report).toContain("Code: E_PLUGIN_RENDER");
      expect(code).toBe("E_PLUGIN_RENDER");
      expect(report).not.toContain(STACK_TOKEN);
    });

    it("keeps a numeric zero code rather than dropping it as falsy", () => {
      expect(build({ error: errorWith("boom", undefined, { code: 0 }) }).code).toBe("0");
    });

    it("omits the code line entirely when the error carries none", () => {
      expect(build().report).not.toContain("Code:");
    });

    it("is stable across a devMode round trip", () => {
      const error = errorWith(`boom ${MSG_TOKEN}`, `Error: boom\n    at V (/Users/alice/a.js:1:1)`);

      const first = build({ error }).report;
      build({ error, devMode: true });

      expect(build({ error }).report).toBe(first);
    });
  });

  describe("cause chain", () => {
    it("surfaces an Error cause with its name, message, code and frames", () => {
      const cause = errorWith(
        "fetch failed",
        "TypeError: fetch failed\n    at fetch (net.js:2:1)",
        {
          code: "ECONNRESET",
        }
      );
      cause.name = "TypeError";
      const { trace } = build({ error: errorWith("boom", "Error: boom", { cause }) });

      expect(trace).toContain("Caused by: TypeError: fetch failed (code: ECONNRESET)");
      expect(trace).toContain("at fetch (net.js:2:1)");
      // Counted, not pattern-matched: a `stackFrames` that stopped stripping
      // the header would print the name twice, and a forbidden-substring
      // assertion misses that as soon as the header gains a suffix.
      expect(trace.match(/TypeError: fetch failed/g)).toHaveLength(1);
    });

    it("scrubs a cause the same way it scrubs the root", () => {
      const cause = errorWith(
        `token is ${CAUSE_TOKEN}`,
        `Error: x\n    at f (/Users/bob/a.js:1:1)`
      );
      const { trace, report } = build({ error: errorWith("boom", "Error: boom", { cause }) });

      expect(trace).not.toContain(CAUSE_TOKEN);
      expect(trace).not.toContain("/Users/bob");
      expect(report).not.toContain(CAUSE_TOKEN);
    });

    it("renders non-Error causes with their type intact", () => {
      const q = (cause: unknown) => build({ error: errorWith("boom", "s", { cause }) }).trace;

      // Quoted, so an empty-string cause reads as one rather than as nothing.
      expect(q("socket hang up")).toContain('Caused by: "socket hang up"');
      expect(q("")).toContain('Caused by: ""');
      expect(q(null)).toContain("Caused by: null");
      expect(q(undefined)).toContain("Caused by: undefined");
      expect(q(42)).toContain("Caused by: 42");
      expect(q(false)).toContain("Caused by: false");
    });

    it("renders an object cause as readable JSON, keeping nested Errors legible", () => {
      const { trace } = build({
        error: errorWith("boom", "s", { cause: { step: "fetch", err: new Error("inner") } }),
      });

      expect(trace).toContain('"step": "fetch"');
      expect(trace).toContain('"message": "inner"');
      expect(trace).not.toContain("[object Object]");
    });

    it("stops at a cycle instead of hanging", () => {
      const outer = errorWith("outer", "s");
      const inner = errorWith("inner", "s");
      Object.assign(outer, { cause: inner });
      Object.assign(inner, { cause: outer });

      const { trace } = build({ error: outer });

      expect(trace).toContain("Caused by: Error: inner");
      expect(trace).toContain("Caused by: [Circular]");
    });

    it("stops at a depth cap instead of walking an unbounded chain", () => {
      let error = errorWith("deepest", "s");
      for (let i = 9; i >= 1; i -= 1) error = errorWith(`level ${i}`, "s", { cause: error });

      const { trace } = build({ error });

      // Root is `level 1`, so the eight walked links are `level 2`..`level 9`.
      expect(trace).toContain("Caused by: Error: level 9");
      expect(trace).not.toContain("deepest");
      expect(trace).toContain("Caused by: [MaxDepth]");
    });

    it("omits the cause section when there is no cause property", () => {
      expect(build().trace).not.toContain("Caused by:");
    });
  });

  describe("hostile and malformed input", () => {
    it("survives throwing accessors rather than becoming the second failure", () => {
      const hostile = new Error("outer");
      Object.defineProperty(hostile, "stack", {
        get() {
          throw new Error("stack getter");
        },
      });
      Object.defineProperty(hostile, "cause", {
        get() {
          throw new Error("cause getter");
        },
      });

      const { trace } = build({ error: hostile });

      expect(trace).toContain("No stack trace available");
      expect(trace).toContain("Caused by: undefined");
    });

    it("describes a cause that cannot be serialized", () => {
      const cause: Record<string, unknown> = {};
      cause.self = {
        get boom(): never {
          throw new Error("nope");
        },
      };

      expect(build({ error: errorWith("boom", "s", { cause }) }).trace).toContain(
        "Caused by: [Unserializable]"
      );
    });

    it("accepts a thrown value that is not an Error", () => {
      expect(build({ error: "just a string" }).message).toBe("just a string");
      expect(build({ error: { reason: "nope" } }).message).toContain('"reason": "nope"');
      expect(build({ error: null }).message).toBe("Unknown render error");
      expect(build({ error: undefined }).message).toBe("Unknown render error");
      expect(build({ error: errorWith("") }).message).toBe("Unknown render error");
    });

    it("never writes the scrubbed text back onto the error", () => {
      const stack = `Error: boom ${STACK_TOKEN}\n    at V (/Users/alice/a.js:1:1)`;
      const cause = errorWith(`inner ${CAUSE_TOKEN}`, "Error: inner");
      const error = errorWith(`boom ${MSG_TOKEN}`, stack, { cause });
      // Read first: V8 caches the formatted stack on first access, so a
      // implementation that mutated `message` afterwards would desync the two.
      void error.stack;

      build({ error });

      expect(error.message).toBe(`boom ${MSG_TOKEN}`);
      expect(error.stack).toBe(stack);
      expect(cause.message).toBe(`inner ${CAUSE_TOKEN}`);
    });
  });

  it("lays the report out with metadata, mode, message and trace in order", () => {
    const { report } = build({
      devMode: true,
      incidentId: "abc-123",
      error: errorWith("boom", "Error: boom\n    at View (dashboard.js:3:1)", { code: "E_RENDER" }),
    });

    expect(report).toBe(
      [
        "Plugin: Acme Tools (acme)",
        "Panel: Dashboard (acme.dashboard)",
        "Module: plugin://acme/dashboard.js",
        "Error ID: abc-123",
        "Code: E_RENDER",
        "Report: raw (dev mode)",
        "",
        "Message: boom",
        "",
        "Stack:",
        "Error: boom",
        "    at View (dashboard.js:3:1)",
        "",
        "Component stack:",
        "    at View",
      ].join("\n")
    );
  });

  it("substitutes placeholders when the value carries no stacks", () => {
    const { trace } = build({ error: errorWith("boom", undefined), componentStack: undefined });

    expect(trace).toContain("No stack trace available");
    expect(trace).toContain("No component stack available");
  });
});

describe("buildPluginViewDiagnostics — redaction survives formatting", () => {
  // Each of these plants a secret in a position where the *shape* of the
  // finished document, not the scrubber's patterns, decides whether it is
  // caught. Scrubbing the assembled text alone leaks every one of them.

  it("scrubs a leaf before a label can move it off its line anchor", () => {
    // `oauth-query-param` anchors on `(^|[?&])`. Prefixing `Caused by: Error: `
    // moves it off the line start, so the credential only dies if the cause
    // message is scrubbed before the label is attached.
    const cause = errorWith("access_token=opaque-secret-value&other=1", undefined);
    const { trace, report } = build({ error: errorWith("boom", "s", { cause }) });

    expect(trace).not.toContain("opaque-secret-value");
    expect(report).not.toContain("opaque-secret-value");
    expect(trace).toContain("Caused by: Error:");
  });

  it("scrubs a string cause before quoting escapes its anchors", () => {
    const { trace } = build({
      error: errorWith("boom", "s", { cause: "access_token=opaque-secret-value" }),
    });

    expect(trace).not.toContain("opaque-secret-value");
  });

  it("scrubs an object cause before JSON encoding breaks the sigil boundary", () => {
    // JSON turns the newline into the two characters `\` and `n`, putting a
    // word character against `ghp_` and defeating the `\b` every secret
    // pattern anchors on. Only scrubbing before encoding catches it.
    const { trace, report } = build({
      error: errorWith("boom", "s", { cause: { detail: `\n${CAUSE_TOKEN}` } }),
    });

    expect(trace).not.toContain(CAUSE_TOKEN);
    expect(report).not.toContain(CAUSE_TOKEN);
  });

  it("scrubs object keys, which JSON never offers to a replacer", () => {
    const { trace } = build({ error: errorWith("boom", "s", { cause: { [CAUSE_TOKEN]: 1 } }) });

    expect(trace).not.toContain(CAUSE_TOKEN);
  });

  it("scrubs the manifest identity the pane prints beside its redacted label", () => {
    const built = build({
      pluginDisplayName: `Tools ${MSG_TOKEN}`,
      componentPath: "plugin:///Users/alice/dev/acme/dashboard.js",
      kindId: `acme.${STACK_TOKEN}`,
      incidentId: `id-${PATH_TOKEN}`,
    });

    for (const value of [MSG_TOKEN, STACK_TOKEN, PATH_TOKEN, "/Users/alice"]) {
      expect(built.report).not.toContain(value);
      expect(built.pluginDisplayName + built.componentPath + built.kindId).not.toContain(value);
      expect(built.incidentId ?? "").not.toContain(value);
    }
    // Redaction must not cost the identity itself.
    expect(built.pluginDisplayName).toContain("Tools");
    expect(built.componentPath).toContain("dashboard.js");
  });

  it("keeps every report section when a home path ends a field", () => {
    // `/Users/USER` is idempotent alone, but the username class used to run past
    // the newline and swallow the rest of the document into the replacement.
    const { report } = build({ error: "/Users/alice", componentStack: undefined });

    expect(report).toContain("Message: /Users/USER");
    expect(report).toContain("Stack:");
    expect(report).toContain("No stack trace available");
    expect(report).toContain("Component stack:");
    expect(report).toContain("Report: redacted");
  });

  it("bounds a cause that would otherwise park JSON.stringify", () => {
    // Cheap to construct, ruinous to serialize: the outer depth cap bounds the
    // chain, not the width of a single link.
    const { trace } = build({ error: errorWith("boom", "s", { cause: new Array(0xffffffff) }) });

    expect(trace).toContain("[Truncated]");
    expect(trace.length).toBeLessThan(10_000);
  });
});

describe("buildPluginViewDiagnostics — value shapes", () => {
  it("falls back rather than showing a blank pane for a whitespace-only message", () => {
    expect(build({ error: errorWith("   \n  ") }).message).toBe("Unknown render error");
  });

  it("keeps a literal [REDACTED] in the input while still removing a fresh secret", () => {
    const { message } = build({ error: errorWith(`saw [REDACTED] then ${MSG_TOKEN}`) });

    expect(message).toBe("saw [REDACTED] then [REDACTED]");
  });

  it("renders symbol and function causes readably, scrubbing the description", () => {
    const symbol = build({ error: errorWith("b", "s", { cause: Symbol(`k ${CAUSE_TOKEN}`) }) });
    expect(symbol.trace).toContain("Caused by: Symbol(");
    expect(symbol.trace).not.toContain(CAUSE_TOKEN);

    expect(build({ error: errorWith("b", "s", { cause: () => 1 }) }).trace).toContain(
      "Caused by: [Function]"
    );
  });

  it("serializes a null-prototype cause rather than failing on it", () => {
    const cause: Record<string, unknown> = Object.create(null);
    cause.step = "fetch";
    cause.token = CAUSE_TOKEN;
    const { trace } = build({ error: errorWith("boom", "s", { cause }) });

    expect(trace).toContain('"step": "fetch"');
    expect(trace).not.toContain(CAUSE_TOKEN);
  });

  it("puts a scrubbed code in the report and keeps a zero one visible", () => {
    const coded = build({ error: errorWith("b", "s", { code: `/Users/alice/${PATH_TOKEN}` }) });
    expect(coded.report).not.toContain(PATH_TOKEN);
    expect(coded.code).not.toContain("/Users/alice");
    expect(build({ error: errorWith("b", "s", { code: 0 }) }).report).toContain("Code: 0");
  });

  it("keeps the report's own structure present, not merely free of secrets", () => {
    const { report } = build({
      error: errorWith(`boom ${MSG_TOKEN}`, `Error: boom\n    at V (/Users/alice/a.js:9:9)`, {
        cause: errorWith("inner", "Error: inner\n    at C (nested.js:4:4)"),
      }),
    });

    // Negative assertions alone stay green if a section goes missing entirely.
    expect(report).toContain("Message: boom [REDACTED]");
    expect(report).toContain("Report: redacted");
    expect(report).toContain("Caused by: Error: inner");
    expect(report).toContain("a.js:9:9");
    expect(report).toContain("nested.js:4:4");
    expect(report).toContain("Module: plugin://acme/dashboard.js");
  });
});
