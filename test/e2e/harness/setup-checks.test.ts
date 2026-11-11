import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CHECK_NAMES } from '../../../src/setup/index.ts';
import { REQUIRED_SETUP_CHECKS } from './subjects.ts';

describe('required setup checks', () => {
  // L1-02 asserts that the engine's report lists exactly these checks, in this order.
  it("match the engine's setup check list, in its order", () => {
    assert.deepEqual([...REQUIRED_SETUP_CHECKS], [...CHECK_NAMES]);
  });
});
