import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import ts from "typescript";
import { voiceErrorLogFields, voicePayloadShape } from "../voiceLogFields.js";

const ROOT = path.resolve(__dirname, "../../..");
// Helpers that reduce their argument to a safe shape.
const SANITIZERS = new Set(["voiceErrorLogFields", "voicePayloadShape", "summarizeEchoedSession"]);
const LOG_FUNCTIONS = new Set(["logDebug", "logInfo", "logWarn", "logError"]);

// Names that hold or can hold user content on the voice paths: spoken text,
// file descriptions and paths, keyterms, and provider/error messages (which can
// quote a rejected keyword back). Only a length, count or code of these may be
// logged.
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
  "keyterms",
  "keywords",
  "prompt",
  "candidates",
  "matched",
  "customDictionary",
  "customInstructions",
  "recentContext",
  "utterance",
  "path",
  "filePath",
]);

const SAFE_MEMBERS = new Set(["length", "code", "severity", "name", "type", "size", "byteLength"]);

function voiceSourceFiles(): string[] {
  const out: string[] = [];
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
  return out;
}

function isLogCall(node: ts.Node): node is ts.CallExpression {
  return (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    LOG_FUNCTIONS.has(node.expression.text)
  );
}

function findViolations(file: string): string[] {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true
  );
  const found: string[] = [];

  const check = (node: ts.Node, call: ts.CallExpression) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      SANITIZERS.has(node.expression.text)
    ) {
      return;
    }
    if (ts.isIdentifier(node) && SENSITIVE.has(node.text)) {
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
      if (!safe) {
        const { line } = source.getLineAndCharacterOfPosition(call.getStart());
        found.push(`${path.relative(ROOT, file)}:${line + 1} logs \`${node.text}\``);
      }
    }
    ts.forEachChild(node, (child) => check(child, call));
  };

  const visit = (node: ts.Node) => {
    if (isLogCall(node)) node.arguments.forEach((arg) => check(arg, node));
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
    const violations = voiceSourceFiles().flatMap(findViolations);
    expect(violations).toEqual([]);
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
