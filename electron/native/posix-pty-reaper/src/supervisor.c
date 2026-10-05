/*
 * daintree-pty-supervisor — crash-safe POSIX reaper for terminal PTY trees
 * (#8769, #13176). The macOS / Linux counterpart to the Windows Job Object
 * mechanism in win-job-object (#7526).
 *
 * The Daintree main process spawns this binary detached, holding the write end
 * of the supervisor's stdin pipe for the app's lifetime. The supervisor reads a
 * tiny line protocol from stdin:
 *
 *   ADD <pid>\n     register a terminal PTY root pid to reap
 *   REMOVE <pid>\n  the terminal exited — retire the root registration
 *   DISARM\n        a clean shutdown is in progress — do not reap on EOF
 *
 * When stdin reaches EOF the supervisor SIGKILLs every tracked process, UNLESS
 * it was disarmed first. EOF happens either because the parent closed the
 * write end on a clean quit (after DISARM, so we stand down) or because the
 * parent died — crash, OOM, SIGKILL — and the kernel closed every fd it held
 * (no DISARM, so we reap). This is the one cleanup tier that survives a hard
 * crash of main; cooperative teardown only runs while main is still executing.
 *
 * A simple kill(-pgid) is insufficient: agent CLIs call setsid()/setpgid() to
 * escape the PTY shell's process group, and background work double-forks so it
 * reparents to init long before any crash. So while armed the supervisor walks
 * the process table every tick and records each root's descendants as
 * (pid, start time) pairs. A descendant stays tracked after it reparents away,
 * and its own children are discovered through it on later ticks. REMOVE only
 * retires the root: whatever the terminal left running stays tracked until it
 * dies, so a crash during (or after) that terminal's cleanup still reaps it.
 *
 * Known limits: sampling cannot see a child that forks, detaches and is
 * reparented entirely between two ticks. A start-time check and the kill()
 * that follows it are two syscalls, and ADD reads the start time when it
 * arrives rather than at spawn — both would need a PID to be recycled within
 * that window to go wrong.
 *
 * PID reuse: every tracked process is identified by its start time, captured
 * while it was provably ours (a registered root, or a live child of a tracked
 * process). Nothing is signalled unless its start time still matches at the
 * moment of the signal, and a root whose start time can't be read at ADD is
 * never registered.
 *
 * Usage: daintree_pty_supervisor [tick-ms]   (default 1000; tests pass less)
 */

#define _POSIX_C_SOURCE 200809L
#if defined(__APPLE__)
#define _DARWIN_C_SOURCE
#endif

#include <ctype.h>
#include <errno.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/types.h> /* pid_t — not transitively included by the Linux headers */
#include <time.h>
#include <unistd.h>

#if defined(__APPLE__)
#include <sys/sysctl.h>
#endif

#if defined(__linux__)
#include <dirent.h>
#endif

/* Bounds the tracked set so a fork bomb in a terminal can't grow the
 * supervisor without limit. Far beyond any real terminal fleet. */
#define MAX_TRACKED 65536
#define DEFAULT_TICK_MS 1000
#define REAP_STOP_ROUNDS 5

typedef unsigned long long starttime_t;

typedef struct {
  pid_t pid;
  pid_t ppid;
  starttime_t start;
} proc_t;

/* A tracked process. Roots are kept until REMOVE even while dead; every other
 * entry lives only as long as the process it identifies. */
typedef struct {
  pid_t pid;
  starttime_t start;
  int is_root;
} entry_t;

static entry_t *g_entries = NULL;
static int g_nentries = 0;
static int g_cap = 0;
static int g_disarmed = 0;

/* Members of the most recent refresh, as indices into the caller's snapshot. */
static int *g_member_idx = NULL;
static int g_nmembers = 0;

#if defined(__linux__)
/* Parse "pid (comm) state ppid ... starttime ..." from /proc/<pid>/stat. comm
 * may contain spaces and parens, so scan from the LAST ')'. starttime is field
 * 22, i.e. index 19 counting from state. */
static int parse_stat(const char *buf, pid_t *ppid, starttime_t *start) {
  const char *rparen = strrchr(buf, ')');
  if (!rparen) return 0;
  const char *p = rparen + 1;
  int idx = 0;
  int have_ppid = 0;
  while (*p) {
    while (*p == ' ') p++;
    if (!*p) break;
    if (idx == 1) {
      *ppid = (pid_t)strtol(p, NULL, 10);
      have_ppid = 1;
    } else if (idx == 19) {
      *start = strtoull(p, NULL, 10);
      return have_ppid;
    }
    while (*p && *p != ' ') p++;
    idx++;
  }
  return 0;
}

static int read_stat(const char *pidstr, pid_t *ppid, starttime_t *start) {
  char path[64];
  snprintf(path, sizeof(path), "/proc/%s/stat", pidstr);
  FILE *f = fopen(path, "r");
  if (!f) return 0;
  char buf[1024];
  size_t r = fread(buf, 1, sizeof(buf) - 1, f);
  fclose(f);
  if (r == 0) return 0;
  buf[r] = '\0';
  return parse_stat(buf, ppid, start);
}
#endif

#if defined(__APPLE__)
static starttime_t kp_start(const struct kinfo_proc *kp) {
  return (starttime_t)kp->kp_proc.p_starttime.tv_sec * 1000000ULL +
         (starttime_t)kp->kp_proc.p_starttime.tv_usec;
}
#endif

/* Read a process's start time — a stable per-process identity anchor — so a
 * reused PID can't trick the supervisor into reaping an unrelated process.
 * Returns 1 and sets *out on success, 0 if the process is gone or unreadable. */
static int get_starttime(pid_t pid, starttime_t *out) {
#if defined(__linux__)
  char pidstr[32];
  snprintf(pidstr, sizeof(pidstr), "%ld", (long)pid);
  pid_t ppid;
  return read_stat(pidstr, &ppid, out);
#elif defined(__APPLE__)
  int mib[4] = {CTL_KERN, KERN_PROC, KERN_PROC_PID, (int)pid};
  struct kinfo_proc kp;
  size_t len = sizeof(kp);
  if (sysctl(mib, 4, &kp, &len, NULL, 0) != 0 || len == 0) return 0;
  *out = kp_start(&kp);
  return 1;
#else
  (void)pid;
  (void)out;
  return 0;
#endif
}

/* Signal `pid` only if it is still the process we recorded. */
static void signal_verified(pid_t pid, starttime_t start, int sig) {
  if (pid <= 1 || pid == getpid()) return;
  starttime_t now;
  if (!get_starttime(pid, &now) || now != start) return;
  kill(pid, sig);
}

static int push_entry(pid_t pid, starttime_t start, int is_root) {
  if (g_nentries >= MAX_TRACKED) return 0;
  if (g_nentries == g_cap) {
    int cap = g_cap ? g_cap * 2 : 64;
    entry_t *grown = (entry_t *)realloc(g_entries, (size_t)cap * sizeof(entry_t));
    if (!grown) return 0;
    g_entries = grown;
    g_cap = cap;
  }
  entry_t *e = &g_entries[g_nentries++];
  e->pid = pid;
  e->start = start;
  e->is_root = is_root;
  return 1;
}

static void add_root(long pid) {
  if (pid <= 1 || pid > 0x7fffffff || (pid_t)pid == getpid()) return;
  starttime_t start;
  /* Captured while the PTY is still alive (the ADD arrives right after spawn),
   * so this is the true start time of the process we mean to reap. No start
   * time means no identity proof, so the pid is never registered. */
  if (!get_starttime((pid_t)pid, &start)) return;
  for (int i = 0; i < g_nentries; i++) {
    if (g_entries[i].pid == (pid_t)pid && g_entries[i].start == start) {
      g_entries[i].is_root = 1;
      return;
    }
  }
  push_entry((pid_t)pid, start, 1);
}

/* Retire a root: it stops being pinned, so the next refresh keeps it only if
 * it is still alive — and its descendants stay tracked on their own identity. */
static void retire_root(long pid) {
  if (pid <= 1 || pid > 0x7fffffff) return;
  for (int i = 0; i < g_nentries; i++) {
    if (g_entries[i].pid == (pid_t)pid) g_entries[i].is_root = 0;
  }
}

static int cmp_proc(const void *a, const void *b) {
  pid_t pa = ((const proc_t *)a)->pid;
  pid_t pb = ((const proc_t *)b)->pid;
  return (pa > pb) - (pa < pb);
}

static int find_proc(const proc_t *procs, int n, pid_t pid) {
  int lo = 0, hi = n - 1;
  while (lo <= hi) {
    int mid = lo + (hi - lo) / 2;
    if (procs[mid].pid == pid) return mid;
    if (procs[mid].pid < pid) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

/* Snapshot every live (pid, ppid, start) triple, sorted by pid. Returns the
 * count and a malloc'd array the caller frees, or -1 on failure. */
static int snapshot_procs(proc_t **out) {
  *out = NULL;
  int n = 0;
#if defined(__linux__)
  int cap = 1024;
  proc_t *procs = (proc_t *)malloc((size_t)cap * sizeof(proc_t));
  if (!procs) return -1;
  DIR *d = opendir("/proc");
  if (!d) {
    free(procs);
    return -1;
  }
  struct dirent *ent;
  int failed = 0;
  for (;;) {
    /* read_stat() sets errno for processes that vanish mid-walk, so reset it
     * before each readdir() to tell end-of-directory from a read error. */
    errno = 0;
    ent = readdir(d);
    if (!ent) {
      if (errno != 0) failed = 1;
      break;
    }
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
    pid_t ppid;
    starttime_t start;
    if (!read_stat(name, &ppid, &start)) continue;
    if (n == cap) {
      int ncap = cap * 2;
      proc_t *grown = (proc_t *)realloc(procs, (size_t)ncap * sizeof(proc_t));
      if (!grown) {
        failed = 1;
        break;
      }
      procs = grown;
      cap = ncap;
    }
    procs[n].pid = (pid_t)atol(name);
    procs[n].ppid = ppid;
    procs[n].start = start;
    n++;
  }
  closedir(d);
  /* A partial table would read as "those processes died" and drop identities
   * we can never recover, so it counts as no table at all. */
  if (failed) {
    free(procs);
    return -1;
  }
#elif defined(__APPLE__)
  int mib[4] = {CTL_KERN, KERN_PROC, KERN_PROC_ALL, 0};
  struct kinfo_proc *kps = NULL;
  size_t len = 0;
  /* The table can grow between the size probe and the read; retry with
   * headroom on ENOMEM. */
  for (int attempt = 0; attempt < 4; attempt++) {
    if (sysctl(mib, 4, NULL, &len, NULL, 0) != 0 || len == 0) return -1;
    len += len / 8;
    kps = (struct kinfo_proc *)malloc(len);
    if (!kps) return -1;
    if (sysctl(mib, 4, kps, &len, NULL, 0) == 0) break;
    free(kps);
    kps = NULL;
    if (errno != ENOMEM) return -1;
  }
  if (!kps) return -1;
  int count = (int)(len / sizeof(struct kinfo_proc));
  proc_t *procs = (proc_t *)malloc((size_t)(count > 0 ? count : 1) * sizeof(proc_t));
  if (!procs) {
    free(kps);
    return -1;
  }
  for (int i = 0; i < count; i++) {
    procs[n].pid = kps[i].kp_proc.p_pid;
    procs[n].ppid = kps[i].kp_eproc.e_ppid;
    procs[n].start = kp_start(&kps[i]);
    n++;
  }
  free(kps);
#else
  return -1;
#endif
  qsort(procs, (size_t)n, sizeof(proc_t), cmp_proc);
  *out = procs;
  return n;
}

/* A child adopted through its parent link must still have that parent: on
 * Linux the /proc walk is not atomic, so a tracked parent could have died and
 * had its pid reused between reading the parent and reading the child. macOS
 * reads the whole table in one sysctl, which is already consistent. */
static int adoption_holds(const proc_t *child, const proc_t *parent) {
#if defined(__linux__)
  char pidstr[32];
  snprintf(pidstr, sizeof(pidstr), "%ld", (long)child->pid);
  pid_t ppid;
  starttime_t start;
  if (!read_stat(pidstr, &ppid, &start)) return 0;
  if (start != child->start || ppid != parent->pid) return 0;
  starttime_t parent_start;
  return get_starttime(parent->pid, &parent_start) && parent_start == parent->start;
#else
  (void)child;
  (void)parent;
  return 1;
#endif
}

/* Recompute the tracked set against a sorted snapshot. A snapshot process is a
 * member if it matches a tracked (pid, start) pair, or if its parent is a
 * member — the parent link is live in this same snapshot, which is the proof
 * the child is ours. Tracked processes that died (or whose pid was reused)
 * drop out; roots persist until REMOVE. Fills g_member_idx and returns 1, or
 * returns 0 on allocation failure with the tracked set left untouched. */
static int refresh(const proc_t *procs, int n) {
  size_t slots = (size_t)(n > 0 ? n : 1);
  int *member = (int *)calloc(slots, sizeof(int));
  int *idx = (int *)realloc(g_member_idx, slots * sizeof(int));
  if (idx) g_member_idx = idx;
  g_nmembers = 0;
  if (!member || !idx) {
    free(member);
    return 0;
  }

  pid_t self = getpid();
  int nroots = 0;
  for (int i = 0; i < g_nentries; i++) {
    if (g_entries[i].is_root) nroots++;
    int j = find_proc(procs, n, g_entries[i].pid);
    if (j < 0 || procs[j].start != g_entries[i].start) continue;
    member[j] = 1;
  }

  /* Propagate to children until stable; each pass extends at least one level. */
  int changed = 1;
  while (changed) {
    changed = 0;
    for (int i = 0; i < n; i++) {
      if (member[i] || procs[i].pid <= 1 || procs[i].pid == self) continue;
      int j = find_proc(procs, n, procs[i].ppid);
      if (j < 0 || !member[j] || j == i) continue;
      if (!adoption_holds(&procs[i], &procs[j])) continue;
      member[i] = 1;
      changed = 1;
    }
  }

  /* Build the replacement set before committing it, so an allocation failure
   * leaves every previously recorded identity in place. Roots come first and
   * are kept even when dead; then every live member. */
  int nmembers = 0;
  for (int i = 0; i < n; i++) nmembers += member[i];
  int cap = nroots + nmembers > 0 ? nroots + nmembers : 1;
  entry_t *next = (entry_t *)malloc((size_t)cap * sizeof(entry_t));
  if (!next) {
    free(member);
    return 0;
  }
  int w = 0;
  for (int i = 0; i < g_nentries; i++) {
    if (g_entries[i].is_root) next[w++] = g_entries[i];
  }
  for (int i = 0; i < n; i++) {
    if (!member[i]) continue;
    g_member_idx[g_nmembers++] = i;
    int is_root = 0;
    for (int r = 0; r < nroots; r++) {
      if (next[r].pid == procs[i].pid && next[r].start == procs[i].start) {
        is_root = 1;
        break;
      }
    }
    if (is_root) continue;
    next[w].pid = procs[i].pid;
    next[w].start = procs[i].start;
    next[w].is_root = 0;
    w++;
  }
  free(g_entries);
  g_entries = next;
  g_cap = cap;
  g_nentries = w;

  free(member);
  return 1;
}

static void tick(void) {
  if (g_nentries == 0) return;
  proc_t *procs;
  int n = snapshot_procs(&procs);
  if (n < 0) return;
  refresh(procs, n);
  free(procs);
}

typedef struct {
  proc_t *items;
  int n;
  int cap;
} target_list_t;

/* SIGSTOP a target once, remembering it for the final SIGKILL pass. Returns 1
 * if it was new. */
static int freeze_target(target_list_t *t, pid_t pid, starttime_t start) {
  for (int s = 0; s < t->n; s++) {
    if (t->items[s].pid == pid && t->items[s].start == start) return 0;
  }
  if (t->n == t->cap) {
    int ncap = t->cap ? t->cap * 2 : 64;
    proc_t *grown = (proc_t *)realloc(t->items, (size_t)ncap * sizeof(proc_t));
    if (!grown) {
      /* No room to remember it: kill it now rather than leave it running. */
      signal_verified(pid, start, SIGKILL);
      return 0;
    }
    t->items = grown;
    t->cap = ncap;
  }
  t->items[t->n].pid = pid;
  t->items[t->n].ppid = 0;
  t->items[t->n].start = start;
  t->n++;
  signal_verified(pid, start, SIGSTOP);
  return 1;
}

/* Freeze every tracked process first so none can fork past the sweep, picking
 * up children forked while we were stopping their parents, then SIGKILL the
 * frozen set. Every signal re-verifies the target's start time. If the process
 * table can't be read, fall back to the identities already recorded. */
static void reap_all(void) {
  target_list_t targets = {NULL, 0, 0};
  for (int round = 0; round < REAP_STOP_ROUNDS; round++) {
    proc_t *procs;
    int n = snapshot_procs(&procs);
    if (n < 0 || !refresh(procs, n)) {
      if (n >= 0) free(procs);
      for (int i = 0; i < g_nentries; i++) {
        freeze_target(&targets, g_entries[i].pid, g_entries[i].start);
      }
      break;
    }
    int fresh = 0;
    for (int m = 0; m < g_nmembers; m++) {
      const proc_t *p = &procs[g_member_idx[m]];
      fresh += freeze_target(&targets, p->pid, p->start);
    }
    free(procs);
    if (fresh == 0) break;
    /* SIGSTOP lands asynchronously; give it a moment so a fork already in
     * flight shows up in the next round's table. */
    struct timespec settle = {0, 20 * 1000000L};
    nanosleep(&settle, NULL);
  }
  for (int s = targets.n - 1; s >= 0; s--) {
    signal_verified(targets.items[s].pid, targets.items[s].start, SIGKILL);
  }
  free(targets.items);
}

static void handle_line(const char *line) {
  while (*line && isspace((unsigned char)*line)) line++;
  if (strncmp(line, "ADD ", 4) == 0) {
    add_root(atol(line + 4));
  } else if (strncmp(line, "REMOVE ", 7) == 0) {
    retire_root(atol(line + 7));
  } else if (strncmp(line, "DISARM", 6) == 0) {
    g_disarmed = 1;
  }
}

static long long now_ms(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (long long)ts.tv_sec * 1000LL + ts.tv_nsec / 1000000LL;
}

int main(int argc, char **argv) {
  long tick_ms = DEFAULT_TICK_MS;
  if (argc > 1) {
    long parsed = strtol(argv[1], NULL, 10);
    if (parsed >= 10) tick_ms = parsed;
  }

  char buf[4096];
  char line[256];
  size_t linelen = 0;
  long long next_tick = now_ms() + tick_ms;

  for (;;) {
    long long wait = next_tick - now_ms();
    if (wait <= 0) {
      if (!g_disarmed) tick();
      next_tick = now_ms() + tick_ms;
      continue;
    }
    struct pollfd pfd = {STDIN_FILENO, POLLIN, 0};
    int pr = poll(&pfd, 1, (int)wait);
    if (pr < 0) {
      if (errno == EINTR) continue;
      break; /* poll error — treat like EOF, fall through to reap decision. */
    }
    if (pr == 0) continue;

    ssize_t r = read(STDIN_FILENO, buf, sizeof(buf));
    if (r < 0) {
      if (errno == EINTR || errno == EAGAIN) continue;
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
