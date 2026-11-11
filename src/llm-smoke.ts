import 'dotenv/config';
import { createLlm } from './llm.js';

const llm = createLlm();
console.log('Using', llm.label);

const result = await llm.callTool(
  'You are a helpful assistant.',
  [{ role: 'user', content: 'Put the word "ready" in the answer field.' }],
  {
    name: 'reply',
    description: 'Return your answer.',
    schema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] },
  },
);
console.log('Model returned:', result);