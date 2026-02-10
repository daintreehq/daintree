import crypto from "crypto";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  id: string;
  timestamp: number;
  level: LogLevel;
  message: string;
  context?: Record<string, unknown>;
  source?: string;
}

export interface FilterOptions {
  levels?: LogLevel[];
  sources?: string[];
  search?: string;
  startTime?: number;
  endTime?: number;
}

let instance: LogBuffer | null = null;

export class LogBuffer {
  private buffer: LogEntry[] = [];
  private maxSize: number;

  constructor(maxSize = 500) {
    this.maxSize = this.normalizeMaxSize(maxSize);
  }

  private normalizeMaxSize(maxSize: number): number {
    if (typeof maxSize !== "number" || !Number.isFinite(maxSize)) {
      return 500;
    }

    if (maxSize < 1) {
      return 1;
    }

    return Math.floor(maxSize);
  }

  static getInstance(): LogBuffer {
    if (!instance) {
      instance = new LogBuffer();
    }
    return instance;
  }

  push(entry: Omit<LogEntry, "id">): LogEntry {
    const fullEntry: LogEntry = {
      ...entry,
      id: crypto.randomUUID(),
    };

    this.buffer.push(fullEntry);

    if (this.buffer.length > this.maxSize) {
      this.buffer = this.buffer.slice(-this.maxSize);
    }

    return fullEntry;
  }

  getAll(): LogEntry[] {
    return [...this.buffer];
  }

  getFiltered(options: FilterOptions): LogEntry[] {
    let entries = this.buffer;

    if (options.levels && options.levels.length > 0) {
      entries = entries.filter((e) => options.levels!.includes(e.level));
    }

    if (options.sources && options.sources.length > 0) {
      entries = entries.filter((e) => e.source && options.sources!.includes(e.source));
    }

    if (options.search) {
      const searchLower = options.search.toLowerCase();
      entries = entries.filter((e) => {
        if (e.message.toLowerCase().includes(searchLower)) return true;
        if (e.source && e.source.toLowerCase().includes(searchLower)) return true;

        if (e.context) {
          try {
            return JSON.stringify(e.context).toLowerCase().includes(searchLower);
          } catch {
            return false;
          }
        }

        return false;
      });
    }

    if (options.startTime !== undefined) {
      entries = entries.filter((e) => e.timestamp >= options.startTime!);
    }
    if (options.endTime !== undefined) {
      entries = entries.filter((e) => e.timestamp <= options.endTime!);
    }

    return entries;
  }

  getSources(): string[] {
    const sources = new Set<string>();
    for (const entry of this.buffer) {
      if (entry.source) {
        sources.add(entry.source);
      }
    }
    return Array.from(sources).sort();
  }

  clear(): void {
    this.buffer = [];
  }

  onProjectSwitch(): void {
    console.log("Handling project switch in LogBuffer - clearing logs");
    this.clear();
  }

  get length(): number {
    return this.buffer.length;
  }
}

export const logBuffer = LogBuffer.getInstance();
