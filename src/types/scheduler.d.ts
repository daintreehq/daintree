type SchedulerPriority = "user-blocking" | "user-visible" | "background";

interface SchedulerPostTaskOptions {
  priority?: SchedulerPriority;
  signal?: AbortSignal;
  delay?: number;
}

interface Scheduler {
  postTask<T>(callback: () => T | PromiseLike<T>, options?: SchedulerPostTaskOptions): Promise<T>;
}

declare const scheduler: Scheduler;
