// An ordinary plugin worker. Detection and extraction must never start it, so
// loading it is the fixture's tripwire.
(globalThis as { __litPickerWorkerStarted?: boolean }).__litPickerWorkerStarted = true;
export {};
