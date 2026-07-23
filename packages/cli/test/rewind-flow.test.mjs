import assert from 'node:assert/strict';
import test from 'node:test';

import { REWIND_CONFIRM_DEFAULT, queueRewindRefill } from '../dist/rewind-flow.js';

test('/rewind confirmation defaults to yes', () => {
  assert.equal(REWIND_CONFIRM_DEFAULT, 'yes');
});

test('refilled rewind input is queued ahead of existing messages', () => {
  const pendingInputs = ['later message'];
  assert.equal(queueRewindRefill(pendingInputs, '  edited message  '), true);
  assert.deepEqual(pendingInputs, ['edited message', 'later message']);
});

test('empty rewind refill is ignored', () => {
  const pendingInputs = ['later message'];
  assert.equal(queueRewindRefill(pendingInputs, '   '), false);
  assert.deepEqual(pendingInputs, ['later message']);
});
