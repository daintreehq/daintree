import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { patchNodePtyBindingGyp } from "./patchNodePtyBinding.cjs";

const DEFINE = "NODE_API_SWALLOW_UNTHROWABLE_EXCEPTIONS";

// node-pty 1.2.0-beta.14's binding.gyp, trimmed: target_defaults as shipped
// minus msvs_settings, and a single target.
const BETA_14_HEAD = `{
  'target_defaults': {
    'dependencies': [
      "<!(node -p \\"require('node-addon-api').targets\\"):node_addon_api_except",
    ],
    'conditions': [
      ['OS=="win"', {
        'msvs_configuration_attributes': {
          'SpectreMitigation': 'Spectre'
        },
      }, {
        'cflags': ['-O2', '-fstack-protector-strong'],
      }],
    ],
  },
  'conditions': [
    ['OS!="win"', {
      'targets': [{ 'target_name': 'pty', 'sources': ['src/unix/pty.cc'] }],
    }],
  ],
}
`;

const PATCHED_HEAD = BETA_14_HEAD.replace(
  "  'target_defaults': {\n",
  `  'target_defaults': {\n    'defines': ['${DEFINE}'],\n`
);

describe("patchNodePtyBindingGyp", () => {
  it("adds the define as the first key of target_defaults", () => {
    expect(patchNodePtyBindingGyp(BETA_14_HEAD)).toBe(PATCHED_HEAD);
  });

  it("is idempotent", () => {
    expect(patchNodePtyBindingGyp(PATCHED_HEAD)).toBe(PATCHED_HEAD);
  });

  it("leaves upstream's own fix alone (microsoft/node-pty#954 shape)", () => {
    const upstream = BETA_14_HEAD.replace(
      "    ],\n    'conditions': [\n      ['OS==\"win\"'",
      `    ],\n    # Let node-addon-api swallow exceptions it cannot throw.\n    'defines': [ '${DEFINE}' ],\n    'conditions': [\n      ['OS=="win"'`
    );
    expect(upstream).not.toBe(BETA_14_HEAD);
    expect(patchNodePtyBindingGyp(upstream)).toBe(upstream);
  });

  it("accepts the define with a value", () => {
    const withValue = PATCHED_HEAD.replace(`'${DEFINE}'`, `"${DEFINE}=1"`);
    expect(patchNodePtyBindingGyp(withValue)).toBe(withValue);
  });

  it("does not count a comment naming the define", () => {
    const commented = BETA_14_HEAD.replace(
      "  'target_defaults': {\n",
      `  'target_defaults': {\n    # TODO: ${DEFINE}\n`
    );
    expect(patchNodePtyBindingGyp(commented)).toContain(`    'defines': ['${DEFINE}'],\n`);
  });

  it("does not count a define scoped to one platform", () => {
    const winOnly = BETA_14_HEAD.replace(
      "        'msvs_configuration_attributes': {",
      `        'defines': ['${DEFINE}'],\n        'msvs_configuration_attributes': {`
    );
    const patched = patchNodePtyBindingGyp(winOnly);
    expect(patched).toContain(`  'target_defaults': {\n    'defines': ['${DEFINE}'],\n`);
  });

  it("ignores braces inside strings and comments when finding the block", () => {
    const tricky = `{
  'target_defaults': {
    'note': 'closes with } early',  # and so does this }
    'escaped': "a \\" } b",
    'defines': ['${DEFINE}'],
  },
}
`;
    expect(patchNodePtyBindingGyp(tricky)).toBe(tricky);
  });

  it("preserves CRLF line endings", () => {
    const crlf = BETA_14_HEAD.replace(/\n/g, "\r\n");
    const patched = patchNodePtyBindingGyp(crlf);
    expect(patched).toBe(PATCHED_HEAD.replace(/\n/g, "\r\n"));
  });

  it("refuses to add a second defines key beside an existing one", () => {
    const otherDefines = BETA_14_HEAD.replace(
      "  'target_defaults': {\n",
      "  'target_defaults': {\n    'defines': ['SOMETHING_ELSE'],\n"
    );
    expect(() => patchNodePtyBindingGyp(otherDefines)).toThrow(/already declares defines/);
  });

  it("only patches the top-level target_defaults", () => {
    const decoys = `# e.g. 'target_defaults': {}
{
  'variables': { 'target_defaults': "'target_defaults': {" },
  'target_defaults': {
    'dependencies': [],
  },
}
`;
    expect(patchNodePtyBindingGyp(decoys)).toContain(
      `  'target_defaults': {\n    'defines': ['${DEFINE}'],\n    'dependencies': [],\n`
    );
  });

  it("does not trust a mention of the define outside the top-level defines list", () => {
    const withOther = BETA_14_HEAD.replace(
      "  'target_defaults': {\n",
      `  'target_defaults': {\n    # '${DEFINE}'\n    'defines': ['OTHER'],\n`
    ).replace(
      "        'msvs_configuration_attributes': {",
      `        'defines': ['${DEFINE}'],\n        'msvs_configuration_attributes': {`
    );
    expect(() => patchNodePtyBindingGyp(withOther)).toThrow(/already declares defines/);
  });

  it("finds a defines key whose colon follows a comment", () => {
    const split = BETA_14_HEAD.replace(
      "  'target_defaults': {\n",
      "  'target_defaults': {\n    'defines'  # existing flags\n    : ['OTHER'],\n"
    );
    expect(() => patchNodePtyBindingGyp(split)).toThrow(/already declares defines/);
  });

  it("refuses keys it cannot compare reliably", () => {
    const escaped = BETA_14_HEAD.replace(
      "  'target_defaults': {\n",
      "  'target_defaults': {\n    'def\\x69nes': ['OTHER'],\n"
    );
    expect(() => patchNodePtyBindingGyp(escaped)).toThrow(/duplicate or escaped/);

    const twice = `{\n  'target_defaults': {},\n  'target_defaults': {},\n}\n`;
    expect(() => patchNodePtyBindingGyp(twice)).toThrow(/duplicate or escaped/);
  });

  it("throws when target_defaults is missing", () => {
    expect(() => patchNodePtyBindingGyp("{\n  'targets': [],\n}\n")).toThrow(
      /no top-level target_defaults/
    );
  });

  it("throws on an unterminated or mismatched block", () => {
    expect(() => patchNodePtyBindingGyp("{\n  'target_defaults': {\n    'a': [\n")).toThrow(
      /could not read/
    );
    expect(() => patchNodePtyBindingGyp("{\n  'target_defaults': { 'a': [1} },\n}\n")).toThrow(
      /could not read/
    );
  });

  it("patches the full installed node-pty binding.gyp", () => {
    const gypPath = path.resolve(__dirname, "..", "node_modules", "node-pty", "binding.gyp");
    const installed = fs.readFileSync(gypPath, "utf8");
    // postinstall has usually patched it already; take our line back out so
    // the insertion runs against the complete upstream file too.
    const pristine = installed.replace(`\n    'defines': ['${DEFINE}'],`, "");

    const patched = patchNodePtyBindingGyp(pristine);

    expect(patched).toContain(`'${DEFINE}'`);
    expect(patchNodePtyBindingGyp(installed)).toBe(patched);
    expect(patchNodePtyBindingGyp(patched)).toBe(patched);
  });
});
