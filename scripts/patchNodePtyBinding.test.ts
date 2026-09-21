import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { patchNodePtyBindingGyp } from "./patchNodePtyBinding.cjs";

const DEFINE = "NODE_API_SWALLOW_UNTHROWABLE_EXCEPTIONS";

// The head of node-pty 1.2.0-beta.14's binding.gyp, verbatim.
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

  it("throws when target_defaults is missing", () => {
    expect(() => patchNodePtyBindingGyp("{\n  'targets': [],\n}\n")).toThrow(/found 0/);
  });

  it("throws when target_defaults appears twice", () => {
    const twice = `{\n  'target_defaults': {},\n  'x': { 'target_defaults': {} },\n}\n`;
    expect(() => patchNodePtyBindingGyp(twice)).toThrow(/found 2/);
  });

  it("throws when target_defaults never closes", () => {
    expect(() => patchNodePtyBindingGyp("{\n  'target_defaults': {\n    'a': [\n")).toThrow(
      /could not find the end/
    );
  });

  it("patches the installed node-pty binding.gyp", () => {
    const gypPath = path.resolve(__dirname, "..", "node_modules", "node-pty", "binding.gyp");
    const installed = fs.readFileSync(gypPath, "utf8");

    // Already patched once postinstall has run; either way the result must
    // carry the define in target_defaults, which a second pass recognises.
    const patched = patchNodePtyBindingGyp(installed);

    expect(patched).toContain(`'${DEFINE}'`);
    expect(patchNodePtyBindingGyp(patched)).toBe(patched);
  });
});
