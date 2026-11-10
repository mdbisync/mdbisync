// Which scenario a free worker starts next. Admission decides what may run
// at the same time; this only keeps a worker from waiting in admission
// behind a scenario of its own batch. A worker takes the first pending
// scenario that conflicts neither with a running one nor with an earlier
// pending one: scenarios that cannot run together keep their order, none is
// overtaken for ever, and a worker that finds nothing waits until a running
// scenario ends instead of polling the shared admission state.

/** Whether the scenarios at two indices cannot hold admission at the same time. */
export type Conflicts = (a: number, b: number) => boolean;

/** The first pending index that may start now, or undefined when every one must wait. */
export function nextStartable(pending: readonly number[], running: ReadonlySet<number>, conflicts: Conflicts): number | undefined {
  for (const [position, index] of pending.entries()) {
    if ([...running].some((other) => conflicts(index, other))) continue;
    if (pending.slice(0, position).some((earlier) => conflicts(index, earlier))) continue;
    return index;
  }
  return undefined;
}

/**
 * Runs `run` for every index on `workers` workers. When nothing can start,
 * something is running: the first pending index has no earlier one, so only
 * a running index can hold it back.
 */
export async function runScheduled(indices: readonly number[], workers: number, conflicts: Conflicts, run: (index: number) => Promise<void>): Promise<void> {
  const pending = [...indices];
  const running = new Set<number>();
  let waiting: Array<() => void> = [];
  const worker = async () => {
    while (pending.length > 0) {
      const index = nextStartable(pending, running, conflicts);
      if (index === undefined) {
        await new Promise<void>((resolve) => waiting.push(resolve));
        continue;
      }
      pending.splice(pending.indexOf(index), 1);
      running.add(index);
      try {
        await run(index);
      } finally {
        running.delete(index);
        const wake = waiting;
        waiting = [];
        wake.forEach((resolve) => resolve());
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(workers, indices.length)) }, worker));
}
