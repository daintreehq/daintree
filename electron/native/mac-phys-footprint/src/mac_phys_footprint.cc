// macOS physical-footprint reader for process memory accounting (#13526).
//
// `ps` RSS and Electron's workingSetSize are resident size, which drops every
// page the kernel has compressed or swapped out — so under memory pressure
// they read an order of magnitude low. phys_footprint is the figure Activity
// Monitor's Memory column and Chromium's task manager report: dirty memory
// whether resident, compressed or swapped.
//
// proc_pid_rusage reads it from the task's ledger. It needs no task port, no
// entitlement and no root for same-user processes, and it never walks the
// address space, so it stays O(1) per pid while the machine is swapping — the
// moment the exec-based probes time out.

#include <napi.h>
#include <libproc.h>
#include <sys/resource.h>

#include <climits>
#include <cmath>

namespace {

// readPhysFootprints(pids: number[]): Array<number | null>
//
// Bytes per pid, positionally. null where the read failed: another user's or
// a protected process (EPERM), or a pid that exited since it was listed.
Napi::Value ReadPhysFootprints(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 1 || !info[0].IsArray()) {
    Napi::TypeError::New(env, "pids (array) required").ThrowAsJavaScriptException();
    return env.Null();
  }

  Napi::Array pids = info[0].As<Napi::Array>();
  uint32_t length = pids.Length();
  Napi::Array result = Napi::Array::New(env, length);

  for (uint32_t i = 0; i < length; i++) {
    Napi::Value value = pids.Get(i);
    result.Set(i, env.Null());
    if (!value.IsNumber()) continue;

    double pidDouble = value.As<Napi::Number>().DoubleValue();
    if (!(pidDouble > 0) || pidDouble > INT_MAX || std::floor(pidDouble) != pidDouble) continue;

    rusage_info_v4 usage = {};
    int rc = proc_pid_rusage(
        static_cast<pid_t>(pidDouble), RUSAGE_INFO_V4, reinterpret_cast<rusage_info_t*>(&usage));
    if (rc != 0) continue;

    result.Set(i, Napi::Number::New(env, static_cast<double>(usage.ri_phys_footprint)));
  }

  return result;
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("readPhysFootprints", Napi::Function::New(env, ReadPhysFootprints));
  return exports;
}

}  // namespace

NODE_API_MODULE(mac_phys_footprint, Init)
