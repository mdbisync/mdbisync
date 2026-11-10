import { LinearGraphQLError, LinearHttpError } from '../../../src/linear/index.ts';

/** Cleanup only: three attempts for server failures, with a pause between them. */
export async function retryCleanup<T>(
  action: () => Promise<T>,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await action();
    } catch (error) {
      const transient = (error instanceof LinearHttpError && error.httpStatus >= 500)
        || (error instanceof LinearGraphQLError && (error.httpStatus >= 500
          || error.code === 'DEADLOCK_DETECTED' || error.code === 'INTERNAL_SERVER_ERROR'));
      if (!transient || attempt === 3) throw error;
      await sleep(1000);
    }
  }
}
