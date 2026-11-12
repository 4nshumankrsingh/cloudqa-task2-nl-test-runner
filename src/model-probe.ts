import 'dotenv/config';
import { createLlm } from './llm.js';
import { firstLine } from './types.js';

const models = process.argv.slice(2);
if (models.length === 0) {
  console.error('Usage: npm run probe -- model-name [model-name ...]');
  process.exit(2);
}

process.env.LLM_MAX_ATTEMPTS = '1'; // one quick try per model
process.env.LLM_TIMEOUT_SECONDS = '20';

for (const model of models) {
  const started = Date.now();
  try {
    const llm = createLlm({ ...process.env, LLM_MODEL: model, LLM_FALLBACK_MODEL: '' });
    await llm.callTool(
      'You are a helpful assistant.',
      [{ role: 'user', content: 'Put the word ready in the answer field.' }],
      {
        name: 'reply',
        description: 'Return your answer.',
        schema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] },
      },
    );
    console.log(`OK    ${model}   ${((Date.now() - started) / 1000).toFixed(1)}s`);
  } catch (e) {
    console.log(`FAIL  ${model}   ${firstLine(e).slice(0, 110)}`);
  }
}