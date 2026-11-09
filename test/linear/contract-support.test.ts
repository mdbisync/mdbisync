import assert from 'node:assert/strict';
import { it } from 'node:test';

import type { LogEntry } from '../../src/linear/index.ts';
import { lastCalls } from './contract-support.ts';

const entry = (operation: string, attempt: number, requestId: string) => ({ operation, attempt, requestId }) as LogEntry;

it('takes every attempt of the last calls of an operation, a retried one included', () => {
  const log = [
    entry('CreateDocument', 1, 'old'),
    entry('CreateDocument', 1, 'first'),
    entry('GetDocuments', 1, 'read'),
    entry('CreateDocument', 1, 'second-429'),
    entry('CreateDocument', 2, 'second'),
  ];
  assert.deepEqual(lastCalls(log, 'CreateDocument', 2).map((e) => e.requestId), ['first', 'second-429', 'second']);
  assert.deepEqual(lastCalls(log, 'CreateDocument', 9).map((e) => e.requestId), ['old', 'first', 'second-429', 'second']);
  assert.deepEqual(lastCalls(log, 'TrashDocument', 1), []);
});
