// Turns off dataless-file materialization on Main's libuv worker threads (#16361).
//
// Reading an online-only File Provider placeholder (Dropbox, iCloud Drive,
// OneDrive under ~/Library/CloudStorage) blocks the reading thread until the
// provider has downloaded it, which can take minutes or never happen. Main's
// async fs calls all run on libuv's small threadpool, so a few such reads stall
// every other one: the app:// handler, the CLI availability check, project
// switching. With IOPOL_MATERIALIZE_DATALESS_FILES_OFF the read fails at once
// with EDEADLK instead (Apple TN3150). Metadata calls never materialize.
//
// Thread scope, never process scope: the process-wide policy is inherited by
// every child (pty-host, shells, agents, git), which must keep downloading the
// files they read. A thread's own setting overrides the process policy and no
// child inherits it, and children are spawned from the loop thread or
// Chromium's launcher, never from a pool thread.
//
// libuv has no way to run something on each pool thread, so `requested` async
// works are queued and each holds its thread at a barrier until all have
// arrived: while one is held, the next can only land on another thread. The
// barrier is timed so a busy or missing thread can't hold the rest for long.

#include "dataless_policy.h"

#include <pthread.h>
#include <sys/resource.h>

#include <cerrno>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <cstdint>
#include <memory>
#include <mutex>
#include <set>
#include <vector>

namespace {

constexpr double kMaxThreads = 1024;  // libuv's MAX_THREADPOOL_SIZE
constexpr double kMaxTimeoutMs = 60000;

struct Rendezvous {
  Rendezvous(Napi::Env env, uint32_t requested, std::chrono::milliseconds timeout)
      : requested(requested),
        deadline(std::chrono::steady_clock::now() + timeout),
        deferred(Napi::Promise::Deferred::New(env)) {}

  const uint32_t requested;
  const std::chrono::steady_clock::time_point deadline;
  Napi::Promise::Deferred deferred;

  std::mutex mutex;
  std::condition_variable arrivals;
  uint32_t arrived = 0;          // guarded by mutex
  std::set<uint64_t> applied;    // guarded by mutex: threads now OFF
  std::vector<int> errors;       // guarded by mutex: errno per failed thread

  uint32_t completed = 0;        // main thread only
};

class PolicyWork : public Napi::AsyncWorker {
 public:
  PolicyWork(Napi::Env env, std::shared_ptr<Rendezvous> rendezvous)
      : Napi::AsyncWorker(env), rendezvous_(std::move(rendezvous)) {}

  void Execute() override {
    int error = 0;
    if (setiopolicy_np(IOPOL_TYPE_VFS_MATERIALIZE_DATALESS_FILES, IOPOL_SCOPE_THREAD,
                       IOPOL_MATERIALIZE_DATALESS_FILES_OFF) != 0) {
      error = errno;
    } else if (getiopolicy_np(IOPOL_TYPE_VFS_MATERIALIZE_DATALESS_FILES, IOPOL_SCOPE_THREAD) !=
               IOPOL_MATERIALIZE_DATALESS_FILES_OFF) {
      error = errno != 0 ? errno : EINVAL;
    }

    uint64_t thread_id = 0;
    pthread_threadid_np(nullptr, &thread_id);

    Rendezvous& r = *rendezvous_;
    std::unique_lock<std::mutex> lock(r.mutex);
    if (error == 0) {
      r.applied.insert(thread_id);
    } else {
      r.errors.push_back(error);
    }
    r.arrived++;
    r.arrivals.notify_all();
    r.arrivals.wait_until(lock, r.deadline, [&r] { return r.arrived >= r.requested; });
  }

  void OnOK() override { Finish(); }

  // Execute never sets an error; kept so a failed work still counts as done.
  void OnError(const Napi::Error&) override { Finish(); }

 private:
  void Finish() {
    Rendezvous& r = *rendezvous_;
    if (++r.completed < r.requested) return;

    Napi::Env env = Env();
    Napi::Object result = Napi::Object::New(env);
    std::lock_guard<std::mutex> lock(r.mutex);
    result.Set("requested", Napi::Number::New(env, r.requested));
    result.Set("applied", Napi::Number::New(env, static_cast<double>(r.applied.size())));
    Napi::Array errors = Napi::Array::New(env, r.errors.size());
    for (uint32_t i = 0; i < r.errors.size(); i++) {
      errors.Set(i, Napi::Number::New(env, r.errors[i]));
    }
    result.Set("errors", errors);
    r.deferred.Resolve(result);
  }

  std::shared_ptr<Rendezvous> rendezvous_;
};

// disableThreadPoolDatalessMaterialization(threads: number, timeoutMs: number):
//   Promise<{ requested: number; applied: number; errors: number[] }>
//
// `applied` counts distinct threads confirmed OFF, so it falls short of
// `requested` when the pool is smaller, a thread was busy past the barrier, or
// the kernel refused the policy (its errno is in `errors`).
Napi::Value DisableThreadPoolDatalessMaterialization(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsNumber()) {
    Napi::TypeError::New(env, "threads and timeoutMs (numbers) required")
        .ThrowAsJavaScriptException();
    return env.Null();
  }

  double threads = info[0].As<Napi::Number>().DoubleValue();
  double timeout_ms = info[1].As<Napi::Number>().DoubleValue();
  if (!(threads >= 1) || threads > kMaxThreads || std::floor(threads) != threads) {
    Napi::RangeError::New(env, "threads must be an integer from 1 to 1024")
        .ThrowAsJavaScriptException();
    return env.Null();
  }
  if (!(timeout_ms >= 0) || timeout_ms > kMaxTimeoutMs) {
    Napi::RangeError::New(env, "timeoutMs must be from 0 to 60000").ThrowAsJavaScriptException();
    return env.Null();
  }

  auto rendezvous = std::make_shared<Rendezvous>(
      env, static_cast<uint32_t>(threads),
      std::chrono::milliseconds(static_cast<int64_t>(timeout_ms)));
  Napi::Promise promise = rendezvous->deferred.Promise();
  for (uint32_t i = 0; i < rendezvous->requested; i++) {
    (new PolicyWork(env, rendezvous))->Queue();
  }
  return promise;
}

}  // namespace

void RegisterDatalessPolicy(Napi::Env env, Napi::Object exports) {
  exports.Set("disableThreadPoolDatalessMaterialization",
              Napi::Function::New(env, DisableThreadPoolDatalessMaterialization));
}
