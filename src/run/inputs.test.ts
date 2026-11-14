import assert from 'node:assert/strict';
import { it } from 'node:test';
import { INPUT_NAMES, type InputName, InputError, environmentName, readInputs } from './inputs.ts';

const given = (values: Partial<Record<InputName, string>>) => (name: InputName) => values[name] ?? '';
const REQUIRED = { 'linear-client-id': 'id', 'linear-client-secret': 'secret', 'github-token': 'token' };

it('reads the inputs with defaults from the runner and the state config', () => {
  const inputs = readInputs(given(REQUIRED), { GITHUB_REPOSITORY: 'owner/repo', GITHUB_API_URL: 'https://api.example.test' });
  assert.deepEqual(inputs, {
    linear: { clientId: 'id', clientSecret: 'secret' },
    github: { token: 'token', repository: 'owner/repo', apiUrl: 'https://api.example.test' },
    state: { remote: 'origin', trackedBranch: 'main', syncBranch: 'mdbisync/linear', refPrefix: 'refs/mdbisync' },
  });
});

it('takes the optional inputs when given', () => {
  const inputs = readInputs(
    given({ ...REQUIRED, repository: 'o/r', 'linear-api-url': 'http://proxy.test', 'tracked-branch': 't/1/main', 'sync-branch': 't/1/sync', 'state-ref-prefix': 'refs/t/1', 'report-file': 'r.json' }),
    {},
  );
  assert.equal(inputs.linear.apiUrl, 'http://proxy.test');
  assert.equal(inputs.reportFile, 'r.json');
  assert.deepEqual(inputs.state, { remote: 'origin', trackedBranch: 't/1/main', syncBranch: 't/1/sync', refPrefix: 'refs/t/1' });
});

it('names a missing input or a bad repository', () => {
  assert.throws(() => readInputs(given({}), {}), new InputError('the input linear-client-id is required'));
  assert.throws(() => readInputs(given(REQUIRED), {}), /the input repository must be "owner\/name"/);
  assert.throws(() => readInputs(given({ ...REQUIRED, repository: 'o/r', 'sync-branch': 'main' }), {}), (error) => error instanceof InputError && /must differ/.test(error.message));
});

it('takes the App slug, which the action requires and the command line may leave out', () => {
  const env = { GITHUB_REPOSITORY: 'owner/repo' };
  assert.equal(readInputs(given({ ...REQUIRED, 'app-slug': ' sync-app ' }), env).github.appSlug, 'sync-app');
  assert.equal(readInputs(given(REQUIRED), env).github.appSlug, undefined);
  assert.throws(() => readInputs(given(REQUIRED), env, { appSlugRequired: true }), new InputError("the input app-slug is required: give it the App token step's output app-slug"));
  assert.equal(readInputs(given({ ...REQUIRED, 'app-slug': 'sync-app' }), env, { appSlugRequired: true }).github.appSlug, 'sync-app');
  assert.equal(readInputs(given({ ...REQUIRED, 'app-slug': 'docs--sync' }), env).github.appSlug, 'docs--sync');
  for (const slug of ['sync-app[bot]', 'sync app', 'a/b', 'sync.app', '%2e%2e']) {
    assert.throws(() => readInputs(given({ ...REQUIRED, 'app-slug': slug }), env), /the input app-slug must be a GitHub App slug/, slug);
  }
});

it('maps every input to an MDBISYNC_ environment variable', () => {
  assert.equal(environmentName('linear-client-id'), 'MDBISYNC_LINEAR_CLIENT_ID');
  assert.equal(new Set(INPUT_NAMES.map(environmentName)).size, INPUT_NAMES.length);
});

it('declares every input in action.yml', async () => {
  const { readFile } = await import('node:fs/promises');
  const actionYml = await readFile('action.yml', 'utf8');
  for (const name of INPUT_NAMES) assert.match(actionYml, new RegExp(`^  ${name}:$`, 'm'), name);
});

it('validates a configurable document cap before contacting services', () => {
  for (const cap of ['0', '-1', '1.5', 'NaN', 'Infinity', '100x', '9007199254740992']) {
    assert.throws(() => readInputs(given({ ...REQUIRED, repository: 'o/r', 'document-cap': cap }), {}), InputError);
  }
  assert.equal(readInputs(given({ ...REQUIRED, repository: 'o/r', 'document-cap': '42' }), {}).documentCap, 42);
});

it('validates the bounded merge grace, including zero for deferred merging', () => {
  for (const grace of ['-1', '1.5', 'NaN', 'Infinity', '121', '999999999999999999']) {
    assert.throws(() => readInputs(given({ ...REQUIRED, repository: 'o/r', 'merge-grace-seconds': grace }), {}), InputError);
  }
  for (const grace of ['0', '60', '120']) {
    assert.equal(readInputs(given({ ...REQUIRED, repository: 'o/r', 'merge-grace-seconds': grace }), {}).mergeGraceSeconds, Number(grace));
  }
});

it('validates the check deadline from 10 to 1440 minutes, and leaves it to the default when not given', () => {
  for (const minutes of ['0', '9', '-10', '10.5', '1441', 'NaN', '060']) {
    assert.throws(() => readInputs(given({ ...REQUIRED, repository: 'o/r', 'check-deadline-minutes': minutes }), {}), /check-deadline-minutes must be an integer from 10 to 1440/);
  }
  for (const minutes of ['10', '60', '1440']) {
    assert.equal(readInputs(given({ ...REQUIRED, repository: 'o/r', 'check-deadline-minutes': minutes }), {}).checkDeadlineMinutes, Number(minutes));
  }
  assert.equal(readInputs(given({ ...REQUIRED, repository: 'o/r' }), {}).checkDeadlineMinutes, undefined);
});

it('reads required checks one per line, commas kept in a name, and merging without checks as true or false', () => {
  const read = (extra: Record<string, string>) => readInputs(given({ ...REQUIRED, repository: 'o/r', ...extra }), {});
  assert.deepEqual(read({ 'required-checks': 'tests\r\ntest (ubuntu-latest, 24)\nlint\n\ntests' }).requiredChecks, ['tests', 'test (ubuntu-latest, 24)', 'lint']);
  assert.equal(read({}).requiredChecks, undefined);
  for (const bad of ['tests\u0007', 'x'.repeat(256)]) assert.throws(() => read({ 'required-checks': bad }), /required-checks must list check names/);
  assert.equal(read({ 'merge-without-checks': 'true' }).mergeWithoutChecks, true);
  assert.equal(read({ 'merge-without-checks': 'false' }).mergeWithoutChecks, false);
  assert.equal(read({}).mergeWithoutChecks, undefined);
  for (const bad of ['yes', 'True', '1']) assert.throws(() => read({ 'merge-without-checks': bad }), /merge-without-checks must be true or false/);
});
