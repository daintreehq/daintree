/*
 * daintree-pty-supervisor — crash-safe POSIX reaper for help-session PTY
 * trees (#8769). The macOS / Linux counterpart to the Windows Job Object
 * mechanism in win-job-object (#7526).
 *
 * The Daintree main process spawns this binary detached, holding the write end
 * of the supervisor's stdin pipe for the app's lifetime. The supervisor reads a
 * tiny line protocol from stdin:
 *
 *   ADD <pid>\n   register a help-session PTY root pid to reap
 *   DISARM\n      a clean shutdown is in progress — do not reap on EOF
 *
 * When stdin reaches EOF the supervisor SIGKILLs the full descendant tree of
 * every registered root pid, UNLESS it was disarmed first. EOF happens either
 * because the parent closed the write end on a clean quit (after DISARM, so we
 * stand down) or because the parent died — crash, OOM, SIGKILL — and the kernel
 * closed every fd it held (no DISARM, so we reap). This is the one cleanup tier
 * that survives a hard crash of main; cooperative teardown only runs while the
 * main process is still executing.
 *
 * A simple kill(-pgid) is insufficient: agent CLIs (Claude Code, Gemini, …)
 * call setsid()/setpgid() to escape the PTY shell's process group, so the
 * supervisor walks the live process table by PPID ancestry and kills the whole
 * subtree, leaves-first, to stop a parent's death from reparenting a child to
 * init before we reach it.
 */

#include <ctype.h>
#include <errno.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/types.h> /* pid_t — not transitively included by the Linux headers */
#include <unistd.h>

#if defined(__APPLE__)
#include <sys/sysctl.h>
#endif

#if defined(__linux__)
#include <dirent.h>
#endif

#define MAX_PIDS 8192

static pid_t g_roots[MAX_PIDS];
static unsigned long long g_root_starttimes[MAX_PIDS];
static int g_root_has_starttime[MAX_PIDS];
static int g_root_count = 0;
static int g_disarmed = 0;

/* Read a process's start time — a stable per-process identity anchor — so a
 * reused PID can't trick the supervisor into reaping an unrelated tree. Returns
 * 1 and sets *out on success, 0 if the process is gone or unreadable. */
static int get_starttime(pid_t pid, unsigned long long *out) {
#if defined(__linux__)
  char path[64];
  snprintf(path, sizeof(path), "/proc/%ld/stat", (long)pid);
  FILE *f = fopen(path, "r");
  if (!f) return 0;
  char buf[1024];
  size_t r = fread(buf, 1, sizeof(buf) - 1, f);
  fclose(f);
  if (r == 0) return 0;
  buf[r] = '\0';
  char *rparen = strrchr(buf, ')');
  if (!rparen) return 0;
  /* Tokens after comm: state(0) ppid(1) … starttime is /proc stat field 22,
   * i.e. index 19 counting from state. */
  const char *p = rparen + 1;
  int idx = 0;
  while (*p) {
    while (*p == ' ') p++;
    if (!*p) break;
    if (idx == 19) {
      *out = strtoull(p, NULL, 10);
      return 1;
    }
    while (*p && *p != ' ') p++;
    idx++;
  }
  return 0;
#elif defined(__APPLE__)
  int mib[4] = {CTL_KERN, KERN_PROC, KERN_PROC_PID, (int)pid};
  struct kinfo_proc kp;
  size_t len = sizeof(kp);
  if (sysctl(mib, 4, &kp, &len, NULL, 0) != 0 || len == 0) return 0;
  *out = (unsigned long long)kp.kp_proc.p_starttime.tv_sec * 1000000ULL +
         (unsigned long long)kp.kp_proc.p_starttime.tv_usec;
  return 1;
#else
  (void)pid;
  (void)out;
  return 0;
#endif
}

static void register_pid(long pid) {
  if (pid <= 1 || pid > 0x7fffffff) return;
  if (g_root_count >= MAX_PIDS) return;
  for (int i = 0; i < g_root_count; i++) {
    if (g_roots[i] == (pid_t)pid) return;
  }
  int idx = g_root_count++;
  g_roots[idx] = (pid_t)pid;
  /* Captured while the PTY is still alive (the ADD arrives right after spawn),
   * so this is the true start time of the process we mean to reap. */
  g_root_has_starttime[idx] = get_starttime((pid_t)pid, &g_root_starttimes[idx]);
}

typedef struct {
  pid_t pid;
  pid_t ppid;
} proc_t;

/* Snapshot every live (pid, ppid) pair into `out`. Returns the count. */
static int snapshot_procs(proc_t *out, int max) {
  int n = 0;
#if defined(__linux__)
  DIR *d = opendir("/proc");
  if (!d) return 0;
  struct dirent *ent;
  while ((ent = readdir(d)) != NULL && n < max) {
    const char *name = ent->d_name;
    if (name[0] == '\0') continue;
    int numeric = 1;
    for (const char *p = name; *p; p++) {
      if (!isdigit((unsigned char)*p)) {
        numeric = 0;
        break;
      }
    }
    if (!numeric) continue;

    char path[64];
    snprintf(path, sizeof(path), "/proc/%s/stat", name);
    FILE *f = fopen(path, "r");
    if (!f) continue;
    char buf[1024];
    size_t r = fread(buf, 1, sizeof(buf) - 1, f);
    fclose(f);
    if (r == 0) continue;
    buf[r] = '\0';

    /* /proc/<pid>/stat: "pid (comm) state ppid ...". comm may contain spaces
     * and parens, so scan from the LAST ')' to find state + ppid. */
    char *rparen = strrchr(buf, ')');
    if (!rparen) continue;
    char state;
    long ppid = 0;
    if (sscanf(rparen + 1, " %c %ld", &state, &ppid) != 2) continue;
    out[n].pid = (pid_t)atol(name);
    out[n].ppid = (pid_t)ppid;
    n++;
  }
  closedir(d);
#elif defined(__APPLE__)
  int mib[4] = {CTL_KERN, KERN_PROC, KERN_PROC_ALL, 0};
  size_t len = 0;
  if (sysctl(mib, 4, NULL, &len, NULL, 0) != 0 || len == 0) return 0;
  struct kinfo_proc *procs = (struct kinfo_proc *)malloc(len);
  if (!procs) return 0;
  if (sysctl(mib, 4, procs, &len, NULL, 0) != 0) {
    free(procs);
    return 0;
  }
  int count = (int)(len / sizeof(struct kinfo_proc));
  for (int i = 0; i < count && n < max; i++) {
    out[n].pid = procs[i].kp_proc.p_pid;
    out[n].ppid = procs[i].kp_eproc.e_ppid;
    n++;
  }
  free(procs);
#else
  (void)out;
  (void)max;
#endif
  return n;
}

/* Collect `root` plus its transitive descendants into `out` (BFS order). */
static int collect_tree(pid_t root, const proc_t *procs, int nprocs, pid_t *out, int max) {
  int n = 0;
  if (n < max) out[n++] = root;
  for (int i = 0; i < n; i++) {
    pid_t cur = out[i];
    for (int j = 0; j < nprocs; j++) {
      if (procs[j].ppid != cur || procs[j].pid == cur) continue;
      int seen = 0;
      for (int k = 0; k < n; k++) {
        if (out[k] == procs[j].pid) {
          seen = 1;
          break;
        }
      }
      if (!seen && n < max) out[n++] = procs[j].pid;
    }
  }
  return n;
}

static void reap_all(void) {
  static proc_t procs[MAX_PIDS];
  static pid_t tree[MAX_PIDS];
  int nprocs = snapshot_procs(procs, MAX_PIDS);
  for (int i = 0; i < g_root_count; i++) {
    /* Skip a root whose PID was reused (start time no longer matches) or that
     * is already gone — never SIGKILL a tree we can't confirm is ours. When no
     * anchor was captured at registration, fall back to best-effort reaping. */
    if (g_root_has_starttime[i]) {
      unsigned long long now;
      if (!get_starttime(g_roots[i], &now) || now != g_root_starttimes[i]) continue;
    }
    int n = collect_tree(g_roots[i], procs, nprocs, tree, MAX_PIDS);
    /* Kill leaves-first so killing a parent can't reparent a not-yet-killed
     * child onto init and let it escape. */
    for (int j = n - 1; j >= 0; j--) {
      if (tree[j] > 1) kill(tree[j], SIGKILL);
    }
  }
}

static void handle_line(const char *line) {
  while (*line && isspace((unsigned char)*line)) line++;
  if (strncmp(line, "ADD ", 4) == 0) {
    register_pid(atol(line + 4));
  } else if (strncmp(line, "DISARM", 6) == 0) {
    g_disarmed = 1;
  }
}

int main(void) {
  char buf[4096];
  char line[256];
  size_t linelen = 0;

  for (;;) {
    ssize_t r = read(STDIN_FILENO, buf, sizeof(buf));
    if (r < 0) {
      if (errno == EINTR) continue;
      break; /* read error — treat like EOF, fall through to reap decision. */
    }
    if (r == 0) break; /* EOF: parent closed the write end or died. */
    for (ssize_t i = 0; i < r; i++) {
      char c = buf[i];
      if (c == '\n') {
        line[linelen] = '\0';
        handle_line(line);
        linelen = 0;
      } else if (linelen < sizeof(line) - 1) {
        line[linelen++] = c;
      }
    }
  }

  if (!g_disarmed) reap_all();
  return 0;
}
