// node-pty delivers each PTY exit from a waiter thread through a
// ThreadSafeFunction. When one lands while the pty-host's Node environment is
// being freed, the call into JS fails and node-addon-api rethrows it as a C++
// exception nothing catches, so the helper aborts on quit (#12578). This define
// makes node-addon-api drop an exception the environment can no longer throw.
// Upstream fix: microsoft/node-pty#954. Once a pinned release carries it, the
// patch finds the define already in place and changes nothing.
const DEFINE = "NODE_API_SWALLOW_UNTHROWABLE_EXCEPTIONS";

function skipTrivia(source, i) {
  while (i < source.length) {
    if (/\s/.test(source[i])) {
      i++;
    } else if (source[i] === "#") {
      const eol = source.indexOf("\n", i);
      i = eol === -1 ? source.length : eol + 1;
    } else {
      break;
    }
  }
  return i;
}

// Walks the gyp dict or list opening at `open`, skipping strings and comments.
// Returns its closing index, its own keys (name → where the value starts),
// and its own string items.
function scanContainer(source, open) {
  const keys = new Map();
  const items = [];
  const closers = [];
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
      if (closers.length === 1) {
        const text = source.slice(i + 1, end);
        const next = skipTrivia(source, end + 1);
        if (source[next] !== ":") {
          items.push(text);
        } else if (keys.has(text) || text.includes("\\")) {
          throw new Error(
            `cannot read key '${text}' in node-pty's binding.gyp (duplicate or escaped)`
          );
        } else {
          keys.set(text, next + 1);
        }
      }
      i = end;
    } else if (ch === "{" || ch === "[") {
      closers.push(ch === "{" ? "}" : "]");
    } else if (ch === "}" || ch === "]") {
      if (closers.pop() !== ch) return null;
      if (closers.length === 0) return { open, close: i, keys, items };
    }
  }
  return null;
}

function containerAt(source, index, bracket, name) {
  const open = skipTrivia(source, index);
  const container = source[open] === bracket ? scanContainer(source, open) : null;
  if (!container) throw new Error(`could not read ${name} in node-pty's binding.gyp`);
  return container;
}

function patchNodePtyBindingGyp(source) {
  const root = containerAt(source, 0, "{", "the top-level dict");
  if (!root.keys.has("target_defaults")) {
    throw new Error("node-pty's binding.gyp has no top-level target_defaults");
  }
  const defaults = containerAt(source, root.keys.get("target_defaults"), "{", "target_defaults");

  if (defaults.keys.has("defines")) {
    const defines = containerAt(
      source,
      defaults.keys.get("defines"),
      "[",
      "target_defaults.defines"
    );
    if (defines.items.some((item) => item === DEFINE || item.startsWith(`${DEFINE}=`))) {
      return source;
    }
    // A second `defines` key would silently replace theirs (or ours).
    throw new Error(
      `node-pty's target_defaults already declares defines; add ${DEFINE} to that list instead`
    );
  }

  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const indent = /\n([ \t]*)\S/.exec(source.slice(defaults.open))?.[1] ?? "  ";
  return (
    source.slice(0, defaults.open + 1) +
    `${eol}${indent}'defines': ['${DEFINE}'],` +
    source.slice(defaults.open + 1)
  );
}

module.exports = { patchNodePtyBindingGyp };
