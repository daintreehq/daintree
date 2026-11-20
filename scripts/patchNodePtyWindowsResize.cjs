const ORIGINAL = `        this._deferNoArgs(function () {
            _this._agent.resize(cols, rows);`;
const PATCHED = `        var deferred = !this._isReady;
        this._deferNoArgs(function () {
            // First socket data can arrive after the shell has already exited.
            if (deferred && _this._agent.exitCode !== undefined) return;
            _this._agent.resize(cols, rows);`;

function patchNodePtyWindowsResize(source) {
  if (source.includes(PATCHED)) return source;
  if (!source.includes(ORIGINAL) || source.indexOf(ORIGINAL) !== source.lastIndexOf(ORIGINAL)) {
    throw new Error("node-pty's Windows resize changed; review the deferred resize patch");
  }
  return source.replace(ORIGINAL, PATCHED);
}

module.exports = { patchNodePtyWindowsResize };
