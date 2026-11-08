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

it('maps every input to an MDBISYNC_ environment variable', () => {
  assert.equal(environmentName('linear-client-id'), 'MDBISYNC_LINEAR_CLIENT_ID');
  assert.equal(new Set(INPUT_NAMES.map(environmentName)).size, INPUT_NAMES.length);
});

it('declares every input in action.yml', async () => {
  const { readFile } = await import('node:fs/promises');
  const actionYml = await readFile('action.yml', 'utf8');
  for (const name of INPUT_NAMES) assert.match(actionYml, new RegExp(`^  ${name}:$`, 'm'), name);
});
