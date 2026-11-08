// The setup check, run before any write in both workflows: both
// tokens work and have their rights, merge commits are allowed, the
// Linear-format hook is configured, every annotation is usable and its team
// and project exist. Missing security hooks are a warning. Nothing here
// writes, and the report holds names and states only.

import { type LinearClient } from '../linear/index.ts';
import { type RepositoryMapping, resolveZones } from '../mapping/index.ts';
import { type GitHubCheck } from './github.ts';
import { type HookConfig, checkLinearFormatHookPending, checkSecurityHooks, securityHooks } from './hooks.ts';
import { type ResolvedTargets, checkLinearScopes, linearCredentialFailure, resolveTargets } from './linear.ts';
import { type CheckResult, type SetupReport, buildReport, failed, notChecked, passed } from './report.ts';

export interface SetupInput {
  /** The tracked branch's mapping. */
  mapping: RepositoryMapping;
  /** The tracked branch's pre-commit configuration. */
  hooks: HookConfig;
  /** The run's Linear client and its token's scopes, or why no token could be had. */
  linear: { client: LinearClient; scope?: readonly string[] | undefined } | { error: string };
  github: GitHubCheck;
}

export interface SetupResult {
  report: SetupReport;
  /** The annotated teams and projects as Linear ids; present when they all resolved. */
  targets?: ResolvedTargets;
}

export async function runSetupCheck(input: SetupInput): Promise<SetupResult> {
  const annotations = checkAnnotations(input.mapping);
  let credentials: CheckResult;
  let targets: { result: CheckResult; targets?: ResolvedTargets } = { result: notChecked('annotation-targets', 'needs working Linear credentials') };

  if ('error' in input.linear) {
    credentials = linearCredentialFailure(input.linear.error);
  } else {
    credentials = checkLinearScopes(input.linear.scope);
    if (credentials.state === 'passed' && annotations.state === 'passed') {
      const resolved = await resolveTargets(input.linear.client, resolveZones(input.mapping.annotations).zones.values());
      if (resolved.credentials !== undefined) credentials = resolved.credentials;
      targets = resolved;
    } else if (annotations.state !== 'passed') {
      targets = { result: notChecked('annotation-targets', 'needs usable annotations') };
    }
  }

  const checks: CheckResult[] = [
    credentials,
    input.github.access,
    input.github.mergeCommits,
    checkLinearFormatHookPending(input.hooks),
    annotations,
    targets.result,
    checkSecurityHooks(input.hooks),
  ];
  const report = buildReport(checks, securityHooks(input.hooks));
  return report.ok && targets.targets !== undefined ? { report, targets: targets.targets } : { report };
}

function checkAnnotations(mapping: RepositoryMapping): CheckResult {
  if (mapping.problems.length > 0) {
    return failed('annotations', 'invalid-annotation', mapping.problems.map((problem) => problem.message).join('; '));
  }
  if (mapping.annotations.length === 0) {
    return failed('annotations', 'no-annotations', 'no folder has linear-team or linear-project in its README.md front matter');
  }
  return passed('annotations', `${mapping.annotations.length} annotated folders, ${mapping.documents.length} files to sync`);
}
