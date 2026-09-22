/*
 * Process sampler for the idle harness (#12521). macOS only.
 *
 * Prints one line per process this user can read: its own CPU time, the CPU
 * time of the children it has reaped, and its wakeup counters, all cumulative
 * since the process started. Two samples bracket a measurement window and
 * `electron/services/idleHarnessMeasurement.ts` does the arithmetic.
 *
 * Why native: `ps -S` is documented to fold exited children into their parent,
 * but on current macOS it does not (measured; Apple's `ps` source has the
 * addition under `#if FIXME`), so the `ps` forks the pty-host makes every few
 * milliseconds would be invisible. `proc_pid_rusage` exposes the reaped-child
 * counters directly and needs no privileges for the caller's own processes.
 * `top` reads the same wakeup counters but only for live processes, and costs
 * far more per sample.
 *
 * `ri_*_time` is in Mach absolute-time units, which are nanoseconds on Intel
 * and 125/3 ns on Apple silicon; everything printed here is converted to ns.
 *
 * Zombies are listed: an exited child's counters reach its parent only when it
 * is reaped, so dropping it until then would lose its CPU from both rows.
 *
 * The scan is not atomic. A process that exits and is reaped between its own
 * row and its parent's can be counted twice or not at all; the error is
 * bounded by that one process's lifetime CPU — milliseconds for the `ps` forks
 * that make up nearly all churn in the tree.
 *
 * Output, tab separated:
 *   v1  <wall clock, epoch microseconds>
 *   pid ppid startUs selfNs childNs idleWakeups interruptWakeups
 *       childIdleWakeups childInterruptWakeups name
 */

#include <libproc.h>
#include <mach/mach_time.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/proc_info.h>
#include <sys/resource.h>
#include <sys/time.h>

static mach_timebase_info_data_t timebase;

static uint64_t to_ns(uint64_t ticks) {
  return (ticks / timebase.denom) * timebase.numer +
         (ticks % timebase.denom) * timebase.numer / timebase.denom;
}

static void copy_name(char *out, size_t size, const struct proc_bsdinfo *bsd) {
  const char *source = bsd->pbi_name[0] != '\0' ? bsd->pbi_name : bsd->pbi_comm;
  snprintf(out, size, "%s", source);
  for (char *c = out; *c != '\0'; c++) {
    if (*c == '\t' || *c == '\n' || *c == '\r') *c = ' ';
  }
}

int main(void) {
  if (mach_timebase_info(&timebase) != KERN_SUCCESS || timebase.denom == 0) return 2;

  int estimate = proc_listallpids(NULL, 0);
  if (estimate <= 0) return 3;
  pid_t *pids = NULL;
  int count = 0;
  // A full buffer may have been truncated; grow until the list fits.
  for (int capacity = estimate + 256;; capacity *= 2) {
    free(pids);
    pids = calloc((size_t)capacity, sizeof(pid_t));
    if (pids == NULL) return 4;
    count = proc_listallpids(pids, capacity * (int)sizeof(pid_t));
    if (count <= 0) return 5;
    if (count < capacity) break;
  }

  struct timeval now;
  gettimeofday(&now, NULL);
  printf("v1\t%lld\n", (long long)now.tv_sec * 1000000LL + (long long)now.tv_usec);

  for (int i = 0; i < count; i++) {
    pid_t pid = pids[i];
    if (pid <= 0) continue;

    // arg 1: include zombies, which arg 0 skips.
    struct proc_bsdinfo bsd;
    if (proc_pidinfo(pid, PROC_PIDTBSDINFO, 1, &bsd, sizeof bsd) != (int)sizeof bsd) continue;

    struct rusage_info_v4 usage;
    if (proc_pid_rusage(pid, RUSAGE_INFO_V4, (rusage_info_t *)&usage) != 0) continue;

    char name[2 * MAXCOMLEN + 1];
    copy_name(name, sizeof name, &bsd);

    printf("%d\t%u\t%llu\t%llu\t%llu\t%llu\t%llu\t%llu\t%llu\t%s\n", pid, bsd.pbi_ppid,
           (unsigned long long)bsd.pbi_start_tvsec * 1000000ULL + bsd.pbi_start_tvusec,
           (unsigned long long)to_ns(usage.ri_user_time + usage.ri_system_time),
           (unsigned long long)to_ns(usage.ri_child_user_time + usage.ri_child_system_time),
           (unsigned long long)usage.ri_pkg_idle_wkups, (unsigned long long)usage.ri_interrupt_wkups,
           (unsigned long long)usage.ri_child_pkg_idle_wkups,
           (unsigned long long)usage.ri_child_interrupt_wkups, name);
  }

  free(pids);
  return 0;
}
