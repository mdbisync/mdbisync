import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { GITHUB_API, fakeFetch, fakeWorld } from '../setup/test-helpers.ts';
import { PullRequestError } from './github.ts';
import { readChecks, readCommitChecks } from './merge.ts';

const SHA = 'a'.repeat(40);

function target(rewrite: (path: string, body: any) => any) {
  const world = fakeWorld();
  world.github.checks = new Map([[SHA, [{ name: 'tests', status: 'completed', conclusion: 'success' }]]]);
  const transport = fakeFetch(world);
  return { repository: 'owner/repo', token: 'gh-token', apiUrl: GITHUB_API,
    fetch: async (input: string | URL | Request, init?: RequestInit) => {
      const response = await transport(input, init);
      return Response.json(rewrite(String(input), await response.json()), { status: response.status });
    } };
}

describe('Actions job provenance', () => {
  it('requires suite, job, head and check identity from the Actions APIs', async () => {
    const mutations = [
      (body: any) => { body.workflow_runs[0].check_suite_id = 999; },
      (body: any) => { body.workflow_runs[0].path = '.github/workflows/ci.yml@untrusted'; },
    ];
    for (const mutate of mutations) {
      const repo = target((path, body) => { if (path.includes('/actions/runs?')) mutate(body); return body; });
      assert.equal((await readChecks(repo, SHA)).state, 'pending');
    }
    for (const change of [{ run_id: 999 }, { head_sha: 'c'.repeat(40) }, { name: 'other' },
      { check_run_url: `${GITHUB_API}/repos/other/repo/check-runs/1` },
      { check_run_url: `${GITHUB_API}/repos/owner/repo/check-runs/2` }, { status: 'in_progress' }]) {
      const repo = target((path, body) => { if (path.includes('/jobs?')) Object.assign(body.jobs[0], change); return body; });
      assert.equal((await readChecks(repo, SHA)).state, 'pending', JSON.stringify(change));
    }
    const failed = target((path, body) => { if (path.includes('/jobs?')) body.jobs[0].conclusion = 'failure'; return body; });
    assert.equal((await readChecks(failed, SHA)).state, 'failed', 'a successful check payload overrode the job failure');
  });

  it('accepts GitHub-managed CodeQL with genuine jobs, but no arbitrary dynamic workflow', async () => {
    const repo = target((path, body) => {
      if (path.includes('/actions/runs?')) Object.assign(body.workflow_runs[0], {
        event: 'dynamic', path: 'dynamic/github-code-scanning/codeql', workflow_id: 42,
      });
      return body;
    });
    assert.equal((await readChecks(repo, SHA)).state, 'passed');
    const quality = target((path, body) => {
      if (path.includes('/actions/runs?')) Object.assign(body.workflow_runs[0], {
        event: 'dynamic', path: 'dynamic/github-code-quality/codeql', workflow_id: 43,
      });
      return body;
    });
    assert.equal((await readChecks(quality, SHA)).state, 'passed');
    const unknown = target((path, body) => {
      if (path.includes('/actions/runs?')) Object.assign(body.workflow_runs[0], {
        event: 'dynamic', path: 'dynamic/other/workflow', workflow_id: 42,
      });
      return body;
    });
    assert.equal((await readChecks(unknown, SHA)).state, 'pending');
  });

  it('accepts canonical repository casing, encoded workflow filenames and normal CI after dispatch', async () => {
    const workflow = { path: '.github/workflows/CI + checks.yml', revision: 'b'.repeat(40), event: 'workflow_dispatch' as const };
    const repo = target((path, body) => {
      if (path.includes('/actions/runs?')) body.workflow_runs[0].path = workflow.path;
      if (path.includes('/jobs?')) body.jobs[0].check_run_url = body.jobs[0].check_run_url.replace('/owner/repo/', '/Owner/Repo/');
      return body;
    });
    assert.equal((await readChecks(repo, SHA, { checks: [{ name: 'tests', workflow }] })).state, 'passed');
  });

  it('rejects inconsistent inferred PR blobs without treating the association as execution proof', async () => {
    const base = 'd'.repeat(40);
    const common = 'e'.repeat(40);
    const repo = target((path, body) => {
      if (path.includes('/actions/runs?')) body.workflow_runs[0].pull_requests[0].base.sha = base;
      if (path.includes('/contents/') && new URL(path).searchParams.get('ref') === base) body.sha = 'c'.repeat(40);
      return body;
    });
    const transport = repo.fetch;
    repo.fetch = async (input, init) => String(input).includes('/compare/')
      ? Response.json({ merge_base_commit: { sha: common } }) : transport(input, init);
    const check = (await readCommitChecks(repo, SHA, { creators: false })).checks[0]!;
    assert.equal(check.workflow?.revision, 'c'.repeat(40), 'used the head blob instead of the inferred association blob');
    const dispatch = target((path, body) => {
      if (path.includes('/actions/runs?')) body.workflow_runs[0].event = 'workflow_dispatch';
      return body;
    });
    const expectation = { checks: [{ name: check.name, publisher: check.publisher, workflow: check.workflow! }] };
    assert.equal((await readChecks(dispatch, SHA, expectation)).state, 'pending', 'a dispatch bypassed the additional blob consistency guard');

    const both = repo.fetch;
    repo.fetch = async (input, init) => {
      const response = await both(input, init);
      if (!String(input).includes('/contents/') || new URL(String(input)).searchParams.get('ref') !== common) return response;
      return Response.json({ type: 'file', sha: 'f'.repeat(40) });
    };
    assert.equal((await readChecks(repo, SHA)).state, 'pending', 'invented a workflow blob when both sides changed');
    const retargeted = target((path, body) => {
      if (path.includes('/actions/runs?')) body.workflow_runs[0].pull_requests[0].base.ref = 'other';
      return body;
    });
    assert.equal((await readChecks(retargeted, SHA)).state, 'pending', 'used a workflow from an untrusted base');
  });

  it('keeps per-head job identities distinct when a fixture reuses a check and its display link', async () => {
    const world = fakeWorld();
    const check = { name: 'tests', status: 'completed' as const, conclusion: 'success', url: 'https://github.test/owner/repo/runs/tests' };
    const other = 'b'.repeat(40);
    world.github.checks = new Map([[SHA, [check]], [other, [check]]]);
    const repo = { repository: 'owner/repo', token: 'gh-token', apiUrl: GITHUB_API, fetch: fakeFetch(world) };
    for (const head of [SHA, other, SHA]) assert.equal((await readChecks(repo, head)).state, 'passed');
    const runs: Array<{ id: number; html_url: string }> = [];
    for (const head of [SHA, other]) {
      const response = await repo.fetch(`${GITHUB_API}/repos/owner/repo/commits/${head}/check-runs`);
      const body = await response.json() as { check_runs: Array<{ id: number; html_url: string }> };
      runs.push(body.check_runs[0]!);
    }
    assert.notEqual(runs[0]!.id, runs[1]!.id);
    assert.equal(runs[0]!.html_url, runs[1]!.html_url);
  });

  it('never passes a job whose pull request moved on from its head, and stands in its blob only where the base agrees', async () => {
    const path = '.github/workflows/ci.yml';
    const base = 'd'.repeat(40);
    // GitHub names the pull request's current head, and its base's current tip, in the run's association.
    const movedOn = (baseBlob: string) => target((url, body) => {
      if (url.includes('/actions/runs?')) Object.assign(body.workflow_runs[0].pull_requests[0], { head: { sha: 'b'.repeat(40) } }, { base: { ...body.workflow_runs[0].pull_requests[0].base, sha: base } });
      if (url.includes('/contents/') && new URL(url).searchParams.get('ref') === base) body.sha = baseBlob;
      return body;
    });
    const [same] = (await readCommitChecks(movedOn('b'.repeat(40)), SHA, { creators: false })).checks;
    assert.equal(same?.outcome, 'pending', 'a job of an unknown revision passed');
    assert.equal(same?.workflow, null);
    assert.deepEqual(same?.moved, { path, event: 'pull_request', standIn: 'b'.repeat(40) });
    const [changed] = (await readCommitChecks(movedOn('c'.repeat(40)), SHA, { creators: false })).checks;
    assert.deepEqual(changed?.moved, { path, event: 'pull_request' }, 'stood in a blob the base no longer agrees with');
    // A closed pull request leaves no association: moved, with nothing to compare a stand-in with.
    const closed = target((url, body) => {
      if (url.includes('/actions/runs?')) body.workflow_runs[0].pull_requests = [];
      if (url.includes('/jobs?')) body.jobs[0].conclusion = 'failure';
      return body;
    });
    const [gone] = (await readCommitChecks(closed, SHA, { creators: false })).checks;
    assert.deepEqual(gone?.moved, { path, event: 'pull_request' });
    assert.equal((await readChecks(closed, SHA)).state, 'pending', 'a job of an unknown revision decided the outcome');
    // Any other unknown revision stays unverifiable, with no source at all.
    for (const rewrite of [
      (body: any) => { body.workflow_runs[0].pull_requests.push(body.workflow_runs[0].pull_requests[0]); },
      (body: any) => { Object.assign(body.workflow_runs[0].pull_requests[0], { head: { sha: 'b'.repeat(40) }, base: { ...body.workflow_runs[0].pull_requests[0].base, ref: 'other' } }); },
    ]) {
      const [check] = (await readCommitChecks(target((url, body) => { if (url.includes('/actions/runs?')) rewrite(body); return body; }), SHA, { creators: false })).checks;
      assert.equal(check?.workflow, null);
      assert.equal(check?.moved, undefined);
    }
    const known = (await readCommitChecks(target((_url, body) => body), SHA, { creators: false })).checks[0];
    assert.equal(known?.moved, undefined, 'a known identity also carried a moved source');
  });

  it('does not trust missing or malformed provenance, and fails on denied Actions reads', async () => {
    for (const endpoint of ['/actions/runs?', '/jobs?', '/contents/']) {
      const repo = target((path, body) => path.includes(endpoint) ? {} : body);
      if (endpoint === '/contents/') assert.equal((await readChecks(repo, SHA)).state, 'pending');
      else await assert.rejects(readChecks(repo, SHA), PullRequestError);
    }
    const repo = target((_path, body) => body);
    const transport = repo.fetch;
    repo.fetch = async (input, init) => String(input).includes('/actions/') ? Response.json({}, { status: 403 }) : transport(input, init);
    await assert.rejects(readChecks(repo, SHA), (error: unknown) => error instanceof PullRequestError && error.status === 403);
  });

  it('reads later job pages and never follows a check URL with the token', async () => {
    let jobReads = 0;
    const repo = target((path, body) => {
      if (!path.includes('/jobs?')) return body;
      jobReads += 1;
      return new URL(path).searchParams.get('page') === '1' ? { total_count: 101, jobs: Array.from({ length: 100 }, () => ({})) } : body;
    });
    assert.equal((await readChecks(repo, SHA)).state, 'passed');
    assert.equal(jobReads, 2);
  });
});
