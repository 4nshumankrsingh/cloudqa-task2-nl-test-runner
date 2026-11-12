import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Command } from 'commander';
import { runTest } from './agent.js';
import { createLlm, type LlmClient } from './llm.js';
import { printResult, saveResult } from './report.js';
import { firstLine, type RunResult } from './types.js';

type Case = { test: string; url?: string };

function collect(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}

const program = new Command()
  .name('qa')
  .description('Run a plain-English test case in a real browser, driven by an AI model.')
  .option('--url <url>', 'page to open first')
  .option('--test <text>', 'the test case, in plain English')
  .option('--file <path>', 'file of test cases, one per line, optionally "START_URL | test text"; # starts a comment')
  .option('--var <name=value>', 'value for a {{name}} placeholder (repeatable)', collect, [] as string[])
  .option('--headless', 'run without a visible browser window', false)
  .option('--max-steps <n>', 'maximum steps per test', '20')
  .option('--out <dir>', 'folder for results', 'results')
  .option('--verbose', 'also print the reasoning for each step', false);
program.parse();
const o = program.opts<{
  url?: string; test?: string; file?: string; var: string[];
  headless: boolean; maxSteps: string; out: string; verbose: boolean;
}>();

// Variables: TEST_VAR_name in .env or the environment, then --var name=value (wins).
const vars: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) {
  if (k.startsWith('TEST_VAR_') && v) vars[k.slice('TEST_VAR_'.length)] = v;
}
for (const pair of o.var) {
  const i = pair.indexOf('=');
  if (i < 1) {
    console.error(`--var expects name=value, got '${pair}'`);
    process.exit(2);
  }
  vars[pair.slice(0, i)] = pair.slice(i + 1);
}

async function loadCases(): Promise<Case[]> {
  if (o.test) return [{ test: o.test, url: o.url }];
  if (!o.file) {
    console.error('Give --test "..." or --file cases.txt');
    process.exit(2);
  }
  const lines = (await readFile(o.file, 'utf8'))
    .split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  return lines.map((l) => {
    const sep = l.indexOf(' | ');
    return sep > 0 ? { url: l.slice(0, sep).trim(), test: l.slice(sep + 3).trim() } : { url: o.url, test: l };
  });
}

let llm: LlmClient;
try {
  llm = createLlm();
} catch (e) {
  console.error(firstLine(e));
  process.exit(2);
}
console.log(`Model: ${llm.label}`);

const cases = await loadCases();
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const results: RunResult[] = [];

for (const [i, c] of cases.entries()) {
  console.log(`\n=== Test ${i + 1}/${cases.length}: ${c.test}`);
  const outDir = path.join(o.out, `${stamp}-${String(i + 1).padStart(2, '0')}`);
  const r = await runTest(llm, {
    test: c.test, startUrl: c.url, vars, headless: o.headless,
    maxSteps: Number(o.maxSteps) || 20, outDir, verbose: o.verbose,
  });
  await saveResult(r);
  printResult(r);
  results.push(r);
}

if (results.length > 1) {
  console.log('\n=== Summary');
  results.forEach((r, i) => console.log(`${i + 1}. ${r.verdict}  ${r.test}`));
}
process.exit(results.some((r) => r.verdict === 'ERROR') ? 2 : results.some((r) => r.verdict === 'FAIL') ? 1 : 0);