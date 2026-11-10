// Fixed child entry point for process-isolation tests. Configuration is data
// in argv, never interpolated into executable JavaScript.
import { SharedAdmission, GitStateStore } from './shared-state.ts';
import { registerRun } from './locks.ts';
import type { Budget } from './governor.ts';

type Reservation = Omit<Parameters<SharedAdmission['reserve']>[0], 'readBudget'>;
const mode = process.argv[2];
const input = JSON.parse(process.argv[3] ?? '{}') as { root: string; remote: string; reservation: Reservation; budget: Budget };
if (mode === 'register') {
  registerRun(input.root, 'aaaaaa');
  process.stdout.write('ready');
  setInterval(() => {}, 1000);
} else if (mode === 'reserve' || mode === 'hold') {
  const { reservation, budget } = input;
  if (mode === 'hold') registerRun(input.root, reservation.runId);
  const store = new GitStateStore({ stateDir: input.root, url: input.remote });
  const shared = new SharedAdmission(store);
  const result = await shared.reserve({ ...reservation, readBudget: async () => budget });
  if (mode === 'reserve') {
    await store.close();
    process.stdout.write(JSON.stringify(result.admitted));
  } else {
    if (!result.admitted) throw new Error('child reservation was refused');
    await shared.claim(reservation.runId, reservation.owner, ['zone-a']);
    process.stdout.write('ready');
    setInterval(() => {}, 1000);
  }
} else {
  throw new Error('unknown admission child mode');
}
