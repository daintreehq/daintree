// When a Windows shell exits on its own, node-pty's exit watcher erases the
// PTY's handle record without closing its pseudoconsole, and kill() finds
// nothing to close afterwards. Every such shell leaves a headless conhost.exe
// (and any child still attached to that console) running until the pty-host
// exits, so a long session piles them up (microsoft/node-pty#965). These edits
// are the fix proposed in microsoft/node-pty#991: the watcher hands the
// pseudoconsole to the exit callback, which closes it once JS has the exit
// code, and kill() nulls what it closed so the two never close it twice.
// When a pinned release changes this code the anchors stop matching and the
// install fails: check whether #965 is fixed upstream and drop the patch if so.

const EDITS = [
  {
    name: "pty_baton close function",
    find: "  HANDLE hShell = nullptr;\n\n  pty_baton(",
    replace:
      "  HANDLE hShell = nullptr;\n" +
      "  // How to close hpc, for the exit watcher, which has no useConptyDll of its own\n" +
      "  PFNCLOSEPSEUDOCONSOLE pfnClosePseudoConsole = nullptr;\n\n  pty_baton(",
  },
  {
    name: "ExitEvent pseudoconsole",
    find: "struct ExitEvent {\n  int exit_code = 0;\n};",
    replace:
      "struct ExitEvent {\n  int exit_code = 0;\n" +
      "  // The pseudoconsole a shell that exited on its own leaves open, null if\n" +
      "  // kill() closed it first\n" +
      "  HPCON hpc = nullptr;\n" +
      "  PFNCLOSEPSEUDOCONSOLE pfnClosePseudoConsole = nullptr;\n};",
  },
  {
    name: "exit callback close",
    find:
      "      cb.Call({Napi::Number::New(env, exit_event->exit_code)});\n" +
      "      delete exit_event;",
    replace:
      "      cb.Call({Napi::Number::New(env, exit_event->exit_code)});\n" +
      "      // Closed only once JS has the exit code, so it has it before the output\n" +
      "      // pipe closes, and on a thread of its own: before Windows 11 24H2,\n" +
      "      // ClosePseudoConsole waits until the output pipe is drained, and a paused\n" +
      "      // pty's output drains only as the main thread reads it.\n" +
      "      if (exit_event->hpc != nullptr && exit_event->pfnClosePseudoConsole != nullptr) {\n" +
      "        // The thread runs this module's code, so pin the module: a Worker that\n" +
      "        // loaded node-pty unloads it when it ends, maybe mid-close.\n" +
      "        static std::once_flag pinned;\n" +
      "        std::call_once(pinned, [] {\n" +
      "          HMODULE module;\n" +
      "          GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_PIN | GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS,\n" +
      "                             reinterpret_cast<LPCWSTR>(&SetupExitCallback), &module);\n" +
      "        });\n" +
      "        std::thread([hpc = exit_event->hpc, pfnClose = exit_event->pfnClosePseudoConsole] {\n" +
      "          pfnClose(hpc);\n" +
      "        }).detach();\n" +
      "      }\n" +
      "      delete exit_event;",
  },
  {
    name: "exit watcher hand-off",
    find: "      CloseHandle(baton->hShell);\n      const int id = baton->id;",
    replace:
      "      CloseHandle(baton->hShell);\n" +
      "      // kill() can't find the baton once it's erased, so the exit callback\n" +
      "      // closes the pseudoconsole unless kill() already has.\n" +
      "      exit_event->hpc = baton->hpc;\n" +
      "      exit_event->pfnClosePseudoConsole = baton->pfnClosePseudoConsole;\n" +
      "      baton->hpc = nullptr;\n" +
      "      const int id = baton->id;",
  },
  {
    name: "PtyConnect close function",
    find: "  // Update handle\n  handle->hShell = piClient.hProcess;",
    replace:
      "  if (fLoadedDll)\n  {\n" +
      "    handle->pfnClosePseudoConsole = (PFNCLOSEPSEUDOCONSOLE)GetProcAddress(\n" +
      "      (HMODULE)hLibrary,\n" +
      '      useConptyDll ? "ConptyClosePseudoConsole" : "ClosePseudoConsole");\n' +
      "  }\n\n" +
      "  // Update handle\n  handle->hShell = piClient.hProcess;",
  },
  {
    name: "PtyKill single close",
    find:
      "      if (pfnClosePseudoConsole)\n      {\n" +
      "        pfnClosePseudoConsole(handle->hpc);\n      }",
    replace:
      "      if (pfnClosePseudoConsole && handle->hpc != nullptr)\n      {\n" +
      "        pfnClosePseudoConsole(handle->hpc);\n" +
      "        // The handle stays in ptyHandles until the exit watcher erases it, so\n" +
      "        // null hpc to keep a later call from using the closed pseudoconsole.\n" +
      "        handle->hpc = nullptr;\n      }",
  },
];

function occurrences(source, text) {
  let count = 0;
  for (let i = source.indexOf(text); i !== -1; i = source.indexOf(text, i + 1)) count++;
  return count;
}

function patchNodePtyConptySource(source) {
  const crlf = source.includes("\r\n");
  let text = crlf ? source.replace(/\r\n/g, "\n") : source;
  let changed = false;

  for (const edit of EDITS) {
    if (text.includes(edit.replace)) continue;
    if (occurrences(text, edit.find) !== 1) {
      throw new Error(
        `node-pty's conpty.cc no longer matches the "${edit.name}" edit; ` +
          "check whether microsoft/node-pty#965 is fixed upstream and drop this patch if so"
      );
    }
    text = text.replace(edit.find, () => edit.replace);
    changed = true;
  }

  if (!changed) return source;
  return crlf ? text.replace(/\n/g, "\r\n") : text;
}

module.exports = { patchNodePtyConptySource };
