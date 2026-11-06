// On Windows, node-pty's kill() forks `conpty_console_list_agent` to list the
// processes attached to the shell's console. Packaged Daintree ships with the
// runAsNode fuse off, and since Electron 45 `child_process.fork()` throws there
// instead of spawning a child that never answers. The throw rejects a promise
// nothing handles, and the pty-host exits on unhandled rejections, so every
// terminal kill took the pty-host and every running agent with it. This edit
// falls back to the shell PID, which is what the agent's own 5 s timeout
// resolved to before. When a pinned release changes this code the anchor stops
// matching and the install fails: check whether node-pty stopped forking here
// and drop the patch if so.

const FIND =
  "            var agent = (0, child_process_1.fork)(path.join(__dirname, 'conpty_console_list_agent'), [_this._innerPid.toString()]);\n";

const REPLACE =
  "            var agent;\n" +
  "            try {\n" +
  "                agent = (0, child_process_1.fork)(path.join(__dirname, 'conpty_console_list_agent'), [_this._innerPid.toString()]);\n" +
  "            }\n" +
  "            catch (_forkError) {\n" +
  "                // Electron refuses fork() with the runAsNode fuse off (daintree patch).\n" +
  "                resolve([_this._innerPid]);\n" +
  "                return;\n" +
  "            }\n";

function patchNodePtyConsoleListSource(source) {
  const crlf = source.includes("\r\n");
  const text = crlf ? source.replace(/\r\n/g, "\n") : source;
  if (text.includes(REPLACE)) return source;
  const first = text.indexOf(FIND);
  if (first === -1 || text.indexOf(FIND, first + 1) !== -1) {
    throw new Error(
      "node-pty's windowsPtyAgent.js no longer matches the console-list fork edit; " +
        "check whether node-pty still forks conpty_console_list_agent and drop this patch if not"
    );
  }
  const patched = text.replace(FIND, () => REPLACE);
  return crlf ? patched.replace(/\n/g, "\r\n") : patched;
}

module.exports = { patchNodePtyConsoleListSource };
