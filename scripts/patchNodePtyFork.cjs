// Electron's packaged runAsNode fuse forbids node-pty's optional console-list
// helper. Keep the system ConPTY backend and use node-pty's existing timeout
// fallback (the shell PID) for this specific unavailable-helper condition.
// Daintree's ProcessTreeKiller owns descendant cleanup independently.
const ORIGINAL =
  "            var agent = (0, child_process_1.fork)(path.join(__dirname, 'conpty_console_list_agent'), [_this._innerPid.toString()]);";
const PATCHED = `            // Daintree: packaged Electron forbids the optional Node helper.
            var agent;
            try {
                agent = (0, child_process_1.fork)(path.join(__dirname, 'conpty_console_list_agent'), [_this._innerPid.toString()]);
            } catch (error) {
                if (error && typeof error.message === 'string' && error.message.includes('runAsNode fuse is disabled')) {
                    resolve([_this._innerPid]);
                    return;
                }
                throw error;
            }`;

function patchNodePtyFork(source) {
  if (source.includes(PATCHED)) return source;
  if (!source.includes(ORIGINAL) || source.indexOf(ORIGINAL) !== source.lastIndexOf(ORIGINAL)) {
    throw new Error(
      "node-pty's Windows helper changed; review the packaged fork compatibility patch"
    );
  }
  return source.replace(ORIGINAL, PATCHED);
}

module.exports = { patchNodePtyFork };
