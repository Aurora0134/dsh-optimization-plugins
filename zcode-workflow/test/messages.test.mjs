import assert from 'node:assert/strict';
import { test } from 'node:test';
import { userMessage } from '../host/messages.js';
import { SKILL_NAME as CONTRACT_SKILL, DESCRIPTIONS } from '../host/tool-contract.js';
import { SKILL_NAME, TOOL_DESCRIPTIONS } from '../host/prompt.js';

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

test('the skill the tools tell the model to load is named dynamic-workflows', () => {
  assert.equal(SKILL_NAME, 'dynamic-workflows');
  assert.equal(CONTRACT_SKILL, SKILL_NAME);
});

test('the prompt keeps the tool descriptions English and verbatim', () => {
  assert.deepEqual(Object.values(TOOL_DESCRIPTIONS), Object.values(DESCRIPTIONS));
  for (const [key, text] of Object.entries(TOOL_DESCRIPTIONS)) {
    // CreateWorkflow quotes the user's own trigger phrases ("使用 workflow", "用工作流"),
    // which are data in the description, not translated prose.
    if (key !== 'createWorkflow') {
      assert.ok(!/[\u3400-\u9fff]/u.test(text), `${key} must stay English`);
    }
    assert.ok(!text.includes('WorkflowReport'), key);
    assert.ok(!text.includes('parallel('), key);
    assert.ok(!text.includes('pipeline('), key);
  }
});
