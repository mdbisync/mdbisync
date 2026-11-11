import { LinearGraphQLError, LinearHttpError } from '../../../src/linear/index.ts';
import { GitError } from '../../../src/state/index.ts';

/** Only sandbox reads in cleanup: a missing repository may be a transient GitHub response. */
export async function retryGitHubCleanup<T>(
  action: () => Promise<T>,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await action();
    } catch (error) {
      const transient = error instanceof GitError
        && (error.args[0] === 'ls-remote' || error.args[0] === 'fetch')
        && (/\b(?:HTTP(?:\/\S+)?(?: error)?[: ]+|requested URL returned error: )5\d\d\b/i.test(error.stderr)
          || /\brepository not found\b|\brepository .+ not found\b/i.test(error.stderr)
          || /requested URL returned error: 404\b/i.test(error.stderr));
      if (!transient || attempt === 3) throw error;
      await sleep(attempt * 1000);
    }
  }
}

/** Cleanup only: three attempts for server failures, with a pause between them. */
export async function retryCleanup<T>(
  action: () => Promise<T>,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  canRetry: () => boolean = () => true,
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await action();
    } catch (error) {
      const transient = (error instanceof LinearHttpError && error.httpStatus >= 500)
        || (error instanceof LinearGraphQLError && (error.httpStatus >= 500
          || error.code === 'DEADLOCK_DETECTED' || error.code === 'INTERNAL_SERVER_ERROR'));
      if (!transient || attempt === 3 || !canRetry()) throw error;
      await sleep(1000);
      if (!canRetry()) throw error;
    }
  }
}
