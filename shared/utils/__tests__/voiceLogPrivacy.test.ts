import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import ts from "typescript";
import { voiceErrorLogFields, voicePayloadShape } from "../voiceLogFields.js";

const ROOT = path.resolve(__dirname, "../../..");
// Helpers that reduce their argument to a safe shape.
const SANITIZERS = new Set([
  "voiceErrorLogFields",
  "voicePayloadShape",
  "summarizeEchoedSession",
  "summarizeOpeningChunks",
  "Boolean",
]);
// logStep is the renderer's start-diagnostics wrapper around logInfo, so its call
// sites are scanned too and the wrapper may forward its `details` untouched.
const LOG_FUNCTIONS = new Set(["logDebug", "logInfo", "logWarn", "logError", "logStep"]);

// Names that hold or can hold user content on the voice paths: spoken text,
// file descriptions and paths, keyterms, provider/error messages (which can
// quote a rejected keyword back), and microphone names (which carry the
// owner's name: "Greg's AirPods"). Only a length, count or code of these may
// be logged.
const SENSITIVE = new Set([
  "description",
  "replacement",
  "rawText",
  "raw",
  "text",
  "transcript",
  "payload",
  "message",
  "msg",
  "error",
  "err",
  "e",
  "failure",
  "cause",
  "exception",
  "keyterms",
  "keywords",
  "prompt",
  "candidates",
  "matched",
  "customDictionary",
  "dictionary",
  "heardAs",
  "customInstructions",
  "recentContext",
  "utterance",
  "path",
  "filePath",
  "label",
  "deviceLabel",
  "micDeviceLabel",
]);

const SAFE_MEMBERS = new Set(["length", "code", "severity", "name", "type", "size", "byteLength"]);

// Files outside a voice-named path that still log voice-session data.
const EXTRA_FILES = ["src/hooks/useAudioDevices.ts"];

function voiceSourceFiles(): string[] {
  const out: string[] = EXTRA_FILES.map((f) => path.join(ROOT, f));
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "__tests__") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/voice/i.test(full.slice(ROOT.length)) && /\.tsx?$/.test(entry.name)) {
        if (!/\.(test|spec)\.tsx?$/.test(entry.name)) out.push(full);
      }
    }
  };
  for (const dir of ["electron", "src", "shared"]) walk(path.join(ROOT, dir));
  return [...new Set(out)];
}

const LOG_METHODS = new Set(["debug", "info", "warn", "error", "log"]);

/** Local names that the logger module's log functions are imported as. */
function loggerAliases(source: ts.SourceFile): Set<string> {
  const names = new Set<string>(LOG_FUNCTIONS);
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (!/logger/i.test(statement.moduleSpecifier.text)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      if (LOG_FUNCTIONS.has((element.propertyName ?? element.name).text)) {
        names.add(element.name.text);
      }
    }
  }
  return names;
}

function isLogCall(node: ts.Node, aliases: Set<string>): node is ts.CallExpression {
  if (!ts.isCallExpression(node)) return false;
  const callee = node.expression;
  if (ts.isIdentifier(callee)) return aliases.has(callee.text);
  if (ts.isPropertyAccessExpression(callee) && LOG_METHODS.has(callee.name.text)) {
    const target = callee.expression;
    if (ts.isIdentifier(target))
      return target.text === "console" || /logger|^log$/i.test(target.text);
    return ts.isCallExpression(target) && /createLogger/.test(target.expression.getText());
  }
  return false;
}

function isSanitizerCall(node: ts.Node): boolean {
  return (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    SANITIZERS.has(node.expression.text)
  );
}

function isCatchVariable(id: ts.Identifier): boolean {
  for (let node: ts.Node | undefined = id.parent; node; node = node.parent) {
    if (
      ts.isCatchClause(node) &&
      node.variableDeclaration &&
      ts.isIdentifier(node.variableDeclaration.name) &&
      node.variableDeclaration.name.text === id.text
    ) {
      return true;
    }
  }
  return false;
}

function findViolations(file: string, text = readFileSync(file, "utf8")): string[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const aliases = loggerAliases(source);
  const found: string[] = [];

  const report = (call: ts.CallExpression, what: string) => {
    const { line } = source.getLineAndCharacterOfPosition(call.getStart());
    found.push(`${path.relative(ROOT, file)}:${line + 1} logs ${what}`);
  };

  const check = (node: ts.Node, call: ts.CallExpression) => {
    if (isSanitizerCall(node)) return;
    // A spread forwards fields the scan cannot see; only sanitizers may be spread.
    if (
      ts.isSpreadAssignment(node) &&
      !isSanitizerCall(node.expression) &&
      node.expression.getText() !== "details"
    ) {
      report(call, `a spread of \`${node.expression.getText()}\``);
    }
    if (
      ts.isElementAccessExpression(node) &&
      ts.isStringLiteralLike(node.argumentExpression) &&
      SENSITIVE.has(node.argumentExpression.text)
    ) {
      report(call, `\`${node.argumentExpression.text}\``);
    }
    if (ts.isIdentifier(node)) {
      if (SENSITIVE.has(node.text) || isCatchVariable(node)) {
        // `error.code` and `transcript.length` log a code or a size, not content.
        const access =
          ts.isPropertyAccessExpression(node.parent) && node.parent.name === node
            ? node.parent
            : node;
        const parent = access.parent;
        const safe =
          ts.isPropertyAccessExpression(parent) &&
          parent.expression === access &&
          SAFE_MEMBERS.has(parent.name.text);
        if (!safe) report(call, `\`${node.text}\``);
      }
    }
    ts.forEachChild(node, (child) => check(child, call));
  };

  const visit = (node: ts.Node) => {
    if (isLogCall(node, aliases)) node.arguments.forEach((arg) => check(arg, node));
    ts.forEachChild(node, visit);
  };
  visit(source);
  return [...new Set(found)];
}

describe("voice log privacy", () => {
  it("scans the voice sources", () => {
    const files = voiceSourceFiles().map((f) => path.relative(ROOT, f));
    expect(files).toContain("src/services/VoiceRecordingService.ts");
    expect(files).toContain("electron/services/voice/OpenAITranscriptionProvider.ts");
    expect(files).toContain("electron/services/VoiceFileLinkResolver.ts");
  });

  it("never passes a raw text field to a log call in voice code", () => {
    const violations = voiceSourceFiles().flatMap((file) => findViolations(file));
    expect(violations).toEqual([]);
  });
});

describe("the log-call scan", () => {
  const scan = (body: string) =>
    findViolations(
      path.join(ROOT, "src/fixture.ts"),
      `import { logWarn as warn } from "@/utils/logger";\n${body}`
    );

  it("flags aliased loggers, console and createLogger members", () => {
    expect(scan("try {} catch (x) { warn('a', { m: x.message }); }")).not.toEqual([]);
    expect(scan("console.warn('a', err.message);")).not.toEqual([]);
    expect(scan("createLogger('v').warn('a', { transcript });")).not.toEqual([]);
  });

  it("flags spreads, element access, bare catch variables and template interpolation", () => {
    expect(scan("warn('a', { ...extra });")).not.toEqual([]);
    expect(scan("warn('a', { v: event['message'] });")).not.toEqual([]);
    expect(scan("try {} catch (failure2) { warn('a', failure2); }")).not.toEqual([]);
    expect(scan("warn(`heard ${transcript}`);")).not.toEqual([]);
  });

  it("flags microphone names", () => {
    expect(scan("warn('a', { mic: track.label });")).not.toEqual([]);
    expect(scan("warn('a', { deviceLabel });")).not.toEqual([]);
    expect(scan("warn('a', { mic: state.micDeviceLabel });")).not.toEqual([]);
    expect(scan("warn('a', { hasLabel: Boolean(track.label) });")).toEqual([]);
  });

  it("allows lengths, codes and sanitized errors", () => {
    expect(
      scan("warn('a', { n: transcript.length, c: error.code, ...voiceErrorLogFields(err) });")
    ).toEqual([]);
  });
});

describe("voiceErrorLogFields", () => {
  it("keeps the error name and code but never the message", () => {
    const error = Object.assign(new Error('Invalid keyword "secret-project"'), { code: "E_BAD" });
    const fields = voiceErrorLogFields(error);
    expect(fields).toEqual({ errorName: "Error", errorCode: "E_BAD" });
    expect(JSON.stringify(fields)).not.toContain("secret-project");
  });

  it("returns nothing for non-objects", () => {
    expect(voiceErrorLogFields("some spoken text")).toEqual({});
    expect(voiceErrorLogFields(undefined)).toEqual({});
  });
});

describe("voicePayloadShape", () => {
  it("reports key names and size without values", () => {
    const shape = voicePayloadShape({ type: "x", transcript: "my secret words" });
    expect(shape.keys).toEqual(["transcript", "type"]);
    expect(shape.length).toBeGreaterThan(0);
    expect(JSON.stringify(shape)).not.toContain("secret");
  });
});
