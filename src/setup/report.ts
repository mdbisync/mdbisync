// The setup check's result: one entry per checked item, with a state and a
// short detail that names what failed (a credential, a permission, a team,
// a file path), never document content or tokens.

export const CHECK_NAMES = [
  'linear-credentials',
  'github-access',
  'merge-commits',
  'linear-format-hook',
  'annotations',
  'annotation-targets',
  'left-out-files',
  'security-hooks',
] as const;
export type CheckName = (typeof CHECK_NAMES)[number];

/** `warning` lets the run go on; `not-checked` means an earlier failure made the item impossible to check. */
export type CheckState = 'passed' | 'failed' | 'warning' | 'not-checked';

/** Why a run stopped before writing anything. */
export type FailureCode =
  | 'linear-credential-failed'
  | 'github-credential-failed'
  | 'missing-permission'
  | 'merge-commits-required'
  | 'linear-format-hook-required'
  | 'invalid-annotation'
  | 'no-annotations'
  | 'annotation-target-not-found'
  | 'annotation-target-ambiguous'
  | 'annotation-target-shared'
  | 'initial-sync-required'
  | 'initial-pull-request-pending';

export interface CheckResult {
  name: CheckName;
  state: CheckState;
  /** One line for the job summary: names and states only. */
  detail: string;
  /** Set when `state` is `failed`. */
  code?: FailureCode;
}

export interface SetupReport {
  ok: boolean;
  /** The first failure's code; absent when every check passed. */
  code?: FailureCode;
  checks: CheckResult[];
  /** Ids of the pre-commit hooks marked `alias: security`; empty means content is pushed unchecked. */
  securityHooks: string[];
}

export function passed(name: CheckName, detail: string): CheckResult {
  return { name, state: 'passed', detail };
}

export function failed(name: CheckName, code: FailureCode, detail: string): CheckResult {
  return { name, state: 'failed', detail, code };
}

export function notChecked(name: CheckName, detail: string): CheckResult {
  return { name, state: 'not-checked', detail };
}

export function buildReport(checks: CheckResult[], securityHooks: string[]): SetupReport {
  const failure = checks.find((check) => check.state === 'failed');
  return failure?.code === undefined
    ? { ok: true, checks, securityHooks }
    : { ok: false, code: failure.code, checks, securityHooks };
}
