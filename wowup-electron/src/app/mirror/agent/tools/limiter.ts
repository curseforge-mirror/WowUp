/** Runs at most `max` of the given tasks at a time, in the order they were queued */
export function createLimiter(max: number): <T>(task: () => Promise<T>) => Promise<T> {
  let running = 0;
  const waiting: Array<() => void> = [];
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (running >= max) {
      await new Promise<void>((go) => waiting.push(go));
    } else {
      running += 1;
    }
    try {
      return await task();
    } finally {
      const next = waiting.shift();
      if (next) {
        // The slot passes straight to the next task
        next();
      } else {
        running -= 1;
      }
    }
  };
}
