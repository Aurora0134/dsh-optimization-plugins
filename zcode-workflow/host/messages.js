import { randomUUID } from 'node:crypto';

/**
 * Build a user message that `agent.followup` can append to a session.
 *
 * The session log needs the message identity (`id`) and `role`; a bare
 * `{ content, source }` object is accepted in memory but cannot be read back
 * when the session is resumed.
 *
 * @param {string} text
 * @returns {{ id: string, role: 'user', content: { type: 'text', text: string }[], source: { kind: 'user' } }}
 */
export function userMessage(text) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  };
}
