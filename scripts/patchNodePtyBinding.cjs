// node-pty delivers each PTY exit from a waiter thread through a
// ThreadSafeFunction. When one lands while the pty-host's Node environment is
// being freed, the call into JS fails and node-addon-api rethrows it as a C++
// exception nothing catches, so the helper aborts on quit (#12578). This define
// makes node-addon-api drop an exception the environment can no longer throw.
// Upstream fix: microsoft/node-pty#954. Once a pinned release carries it, the
// patch finds the define already in place and changes nothing.
const DEFINE = "NODE_API_SWALLOW_UNTHROWABLE_EXCEPTIONS";

const ANCHOR = /(['"])target_defaults\1\s*:\s*\{/g;
const KEY_COLON = /\s*:/y;

// Top-level keys of the gyp dict whose `{` sits at `open`, plus its closing index.
function scanDict(source, open) {
  const keys = [];
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    if (ch === "#") {
      const eol = source.indexOf("\n", i);
      if (eol === -1) return null;
      i = eol;
    } else if (ch === "'" || ch === '"') {
      let end = i + 1;
      while (end < source.length && source[end] !== ch) end += source[end] === "\\" ? 2 : 1;
      if (end >= source.length) return null;
      KEY_COLON.lastIndex = end + 1;
      if (depth === 1 && KEY_COLON.test(source)) keys.push(source.slice(i + 1, end));
      i = end;
    } else if (ch === "{" || ch === "[") {
      depth++;
    } else if (ch === "}" || ch === "]") {
      depth--;
      if (depth === 0) return { keys, close: i };
    }
  }
  return null;
}

function patchNodePtyBindingGyp(source) {
  const anchors = [...source.matchAll(ANCHOR)];
  if (anchors.length !== 1) {
    throw new Error(
      `expected one target_defaults block in node-pty's binding.gyp, found ${anchors.length}`
    );
  }
  const open = anchors[0].index + anchors[0][0].length - 1;
  const dict = scanDict(source, open);
  if (!dict) {
    throw new Error("could not find the end of target_defaults in node-pty's binding.gyp");
  }

  if (dict.keys.includes("defines")) {
    const block = source.slice(open, dict.close);
    if (new RegExp(`['"]${DEFINE}(=[^'"]*)?['"]`).test(block)) return source;
    // A second `defines` key would silently replace theirs (or ours).
    throw new Error(
      `node-pty's target_defaults already declares defines; add ${DEFINE} to that list instead`
    );
  }

  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const indent = /\n([ \t]*)\S/.exec(source.slice(open))?.[1] ?? "  ";
  return (
    source.slice(0, open + 1) + `${eol}${indent}'defines': ['${DEFINE}'],` + source.slice(open + 1)
  );
}

module.exports = { patchNodePtyBindingGyp };
