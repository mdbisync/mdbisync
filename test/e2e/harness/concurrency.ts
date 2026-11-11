// Zone concurrency is opt-in. A scenario id alone is insufficient: each
// audited contract is pinned by the digest of its whole spec, so a change to
// its setup, steps or assertions returns it to exclusive mode until it is
// audited again. Its steps and subjects must also be ones whose reads and
// writes were audited to stay inside the run's leased team, owned projects,
// recorded ids and run refs.
import { createHash } from 'node:crypto';
import type { Scenario } from './spec.ts';

/**
 * Step actions whose reads and writes stay inside the run's scope: the run's
 * own engine commands, person commits to the run's tracked branch, deletion
 * of the run's own state refs, and editor writes to documents the run's ids
 * ref records or to the run's first project. Faults, kills, workflows,
 * trash, restore, uploads and helper projects are absent on purpose.
 */
export const AUDITED_STEPS: ReadonlySet<string> = new Set([
  'run.initial-sync', 'run.sync', 'run.resume-until-complete', 'run.settle',
  'git.edit', 'git.add', 'git.move', 'git.copy', 'git.front-matter', 'git.delete-refs',
  'linear.edit', 'linear.create', 'linear.rename',
]);

/**
 * Assertion subjects whose values come only from the run's scoped document
 * view (or a by-id read checked against that scope), the run's refs and
 * tracked branch, its pull requests by exact branch, its own engine reports
 * or its own request log. Workspace-wide counts, uploads, trash state and
 * cross-run evidence scans are absent on purpose. A `before.` subject reads
 * the same value from the start view, which setup takes through the same
 * scoped reads.
 */
export const AUDITED_SUBJECTS: ReadonlySet<string> = new Set([
  'documents.mapping', 'expected.annotationMapping', 'documents.unsyncedPaths',
  'writes.total', 'writes.linear', 'summary.code', 'summary.setupChecks', 'summary.securityHooksReported', 'setup.requiredChecks',
  'documents.bytes', 'refs.tips', 'refs.rebuilt', 'documents.duplicateCount',
  'documents.body', 'linear.body', 'record.kind', 'pullRequests.created', 'pullRequests.author', 'pullRequests.mergeKind',
  'documents.newLocation', 'expected.annotationLocation', 'ids.newPathRecorded',
  'documents.title', 'expected.pathTitle', 'documents.id', 'documents.comments', 'documents.newIdDiffers',
  'capture.ref', 'tracked.body', 'tracked.frontMatter', 'tracked.createdPath', 'tracked.movedPath', 'ids.documentId',
]);

/** The audited contracts: scenario id → digest of the spec that was audited. */
const AUDITED: Readonly<Record<string, string>> = {
  'L1-01': '3210bdd7373d36dcb833fad0957dc5d947487feb206a4c2ecf6eda42dcfa1fba',
  'L1-02': 'e3b36a02b45640218eb7141a217df1a55cc64ae5d5e9eb3f339348bf2fce0951',
  'L1-05': 'ddf1f4a66fa3fb6f102752fdc907a1a19366493d30911bebd6b27adab765ecee',
  'L1-18': 'b562a45b55bb599748d0ac7005be86bf92203daf826ad17787feb738223db875',
  'L1-19': '39e48c34ed833fee156c0cf4feed0c850701a3859c8981a1ea579e111c7e1051',
  'L2-01': '5199dcc56b0c8e8eaf55d6ac8f385d50ddde6bf110e0d53351a4d6f5c9660741',
  'L2-02': 'b80a946783a2d2f72ca485d2504af2326453d30aa80a77d17320c78eed8cada5',
  'L2-04': '790c771497a510bcf7f82e32d0c9e851a9086f6d64878b2f3a7fa0e6e2a8ba8c',
  'L2-07': 'e6e0fa7a0be3bb1ee5435f92ad90da780259c57e814488c975e843947c5cb4c4',
  'L2-11': '6dbd8af6607052a7914e1e8852d0f24e94e1209588329a441cd57749f71313ff',
  'L2-20': '09e7da95f02b08e2a0c6306a8dfd8a4f107f26a8bb95cf53141a7428a307fc23',
  'L2-21': 'e91c6dd8126f81f7c4597a073a6564daee0d4045fa2e3e98ef8ccb3014e62e15',
  'L2-23': 'c667e4d71b5ed51254d182524968b9d258e48f859b90d833e716c254a1ca8c47',
};

/** SHA-256 of the spec as canonical JSON (object keys sorted, array order kept). */
export function contractDigest(scenario: Scenario): string {
  return createHash('sha256').update(canonical(scenario)).digest('hex');
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Every subject a scenario's assertions name, the `same-as` targets included. */
export function assertionSubjects(scenario: Scenario): string[] {
  return scenario.checks.assertions.flatMap((item) => item.operator === 'same-as' ? [item.subject, String(item.expected)] : [item.subject]);
}

/** The ids of the audited contracts, for tests and reports. */
export const AUDITED_CONTRACTS: readonly string[] = Object.keys(AUDITED);

export function zoneConcurrent(scenario: Scenario): boolean {
  const digest = AUDITED[scenario.id];
  if (digest === undefined || scenario.slice !== 'mini' || scenario.mode !== 'local' || !scenario.setup.teamZoneLock) return false;
  if (!scenario.steps.every((step) => AUDITED_STEPS.has(`${step.kind}.${step.action}`))) return false;
  if (!assertionSubjects(scenario).every((subject) => AUDITED_SUBJECTS.has(subject.replace(/^before\./, '')))) return false;
  return contractDigest(scenario) === digest;
}
