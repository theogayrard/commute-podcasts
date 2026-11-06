import { generateJson } from '../server/codex.ts';

const result = await generateJson('Write two short, natural lines for a podcast about curiosity. Maya asks a question and Leo replies. Do not use tools. Return the requested JSON only.', {
  type: 'object', additionalProperties: false,
  properties: { turns: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { speaker: { type: 'string' }, text: { type: 'string' } }, required: ['speaker', 'text'] } } }, required: ['turns'],
}, process.argv[2] || 'gpt-6.1-sol', false);
if (!Array.isArray(result.turns) || result.turns.length !== 2 || result.turns[0].speaker !== 'Maya' || result.turns[1].speaker !== 'Leo') throw new Error('Unexpected writer output.');
console.log(JSON.stringify({ ok: true, turns: result.turns.length, characters: result.turns.reduce((n: number, t: { text: string }) => n + t.text.length, 0) }));
