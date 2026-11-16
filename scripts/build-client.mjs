/**
 * Inline src/normalize.js into the Client factory.
 *
 * The Client module loader only reaches the frozen baseline module table, so a
 * relative import from client.js is not available. Generating client.js keeps
 * one parser source while still shipping a self-contained browser module.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const normalize = readFileSync(new URL('src/normalize.js', root), 'utf8').replace(/^export\s+/gm, '');
const template = readFileSync(new URL('src/client-template.js', root), 'utf8');
const marker = '    /*__NORMALIZE__*/';
if (!template.includes(marker)) throw new Error('client template is missing the normalize marker');
if (/^\s*(?:import|export)\s/m.test(normalize)) throw new Error('normalize source still contains module syntax');
const client = template.replace(marker, normalize.split('\n').map((line) => (line === '' ? '' : '    ' + line)).join('\n'));
writeFileSync(new URL('client.js', root), client);
console.log('client.js written:', client.length, 'bytes');
