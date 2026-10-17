// node-pty 1.2.0-beta.14's src/win/conpty.cc, trimmed to the code
// scripts/patchNodePtyConpty.cjs edits.

typedef void (__stdcall *PFNCLOSEPSEUDOCONSOLE)(HPCON hpc);

struct pty_baton {
  int id;
  HANDLE hIn;
  HANDLE hOut;
  HPCON hpc;

  HANDLE hShell = nullptr;

  pty_baton(int _id, HANDLE _hIn, HANDLE _hOut, HPCON _hpc) : id(_id), hIn(_hIn), hOut(_hOut), hpc(_hpc) {};
};

struct ExitEvent {
  int exit_code = 0;
};

void SetupExitCallback(Napi::Env env, Napi::Function cb, pty_baton* baton) {
  *th = std::thread([tsfn = std::move(tsfn), baton] {
    auto callback = [](Napi::Env env, Napi::Function cb, ExitEvent *exit_event) {
      cb.Call({Napi::Number::New(env, exit_event->exit_code)});
      delete exit_event;
    };

    ExitEvent *exit_event = new ExitEvent;
    // Wait for process to complete.
    WaitForSingleObject(baton->hShell, INFINITE);
    {
      std::lock_guard<std::mutex> lock(g_ptyHandlesMutex);
      GetExitCodeProcess(baton->hShell, (LPDWORD)(&exit_event->exit_code));
      CloseHandle(baton->hShell);
      const int id = baton->id;
      std::erase_if(ptyHandles, [id](const auto& ptyHandle) {
        return ptyHandle->id == id;
      });
    }

    auto status = tsfn.BlockingCall(exit_event, callback); // In main thread
  });
}

static Napi::Value PtyConnect(const Napi::CallbackInfo& info) {
  HANDLE hLibrary = LoadConptyDll(info, useConptyDll);
  bool fLoadedDll = hLibrary != nullptr;

  // Update handle
  handle->hShell = piClient.hProcess;

  SetupExitCallback(env, exitCallback, handle);
}

static Napi::Value PtyKill(const Napi::CallbackInfo& info) {
  std::lock_guard<std::mutex> lock(g_ptyHandlesMutex);
  pty_baton* handle = get_pty_baton(lock, id);

  if (handle != nullptr) {
    HANDLE hLibrary = LoadConptyDll(info, useConptyDll);
    bool fLoadedDll = hLibrary != nullptr;
    if (fLoadedDll)
    {
      PFNCLOSEPSEUDOCONSOLE const pfnClosePseudoConsole = (PFNCLOSEPSEUDOCONSOLE)GetProcAddress(
        (HMODULE)hLibrary,
        useConptyDll ? "ConptyClosePseudoConsole" : "ClosePseudoConsole");
      if (pfnClosePseudoConsole)
      {
        pfnClosePseudoConsole(handle->hpc);
      }
    }
  }

  return env.Undefined();
}
