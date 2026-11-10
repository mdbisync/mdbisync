// The setup check's result: one entry per checked item, with a state and a
// short detail that names what failed (a credential, a permission, a team,
// a file path), never document content or tokens.

import { type CheckName, type FailureCode } from '../codes.ts';

export { CHECK_NAMES, type CheckName, type FailureCode } from '../codes.ts';

/** `warning` lets the run go on; `not-checked` means an earlier failure made the item impossible to check. */
export type CheckState = 'passed' | 'failed' | 'warning' | 'not-checked';

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
  /** The first failure's detail, with its code. */
  detail?: string;
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
    : { ok: false, code: failure.code, detail: failure.detail, checks, securityHooks };
}
