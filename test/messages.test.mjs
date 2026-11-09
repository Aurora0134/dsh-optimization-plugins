import assert from 'node:assert/strict';
import { test } from 'node:test';
import { userMessage } from '../host/messages.js';

test('userMessage carries the durable identity the session log requires', () => {
  const message = userMessage('继续');
  assert.equal(message.role, 'user');
  assert.equal(typeof message.id, 'string');
  assert.ok(message.id.length > 0);
  assert.deepEqual(message.content, [{ type: 'text', text: '继续' }]);
  assert.deepEqual(message.source, { kind: 'user' });
});

test('each message gets its own id', () => {
  assert.notEqual(userMessage('a').id, userMessage('b').id);
});
