import 'dotenv/config';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Command } from 'commander';
import { runTest } from './agent.js';
import { createLlm, type LlmClient } from './llm.js';
import { printResult, saveResult } from './report.js';
import { firstLine, type RunResult } from './types.js';

type Expected = 'PASS' | 'FAIL';
type Case = { test: string; url?: string; expect: Expected };

function collect(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}

const program = new Command()
  .name('qa')
  .description('Run a plain-English test case in a real browser, driven by an AI model.')
  .option('--url <url>', 'page to open first')
  .option('--test <text>', 'the test case, in plain English')
  .option('--file <path>', 'file of test cases, one per line: [expect:FAIL] START_URL | test text ("#" starts a comment)')
  .option('--var <name=value>', 'value for a {{name}} placeholder (repeatable)', collect, [] as string[])
  .option('--repeat <n>', 'run every case n times and report how often the result was as expected', '1')
  .option('--headless', 'run without a visible browser window', false)
  .option('--max-steps <n>', 'maximum steps per test', '20')
  .option('--out <dir>', 'folder for results', 'results')
  .option('--verbose', 'also print the reasoning for each step', false);
program.parse();
const o = program.opts<{
  url?: string; test?: string; file?: string; var: string[]; repeat: string;
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
  if (o.test) return [{ test: o.test, url: o.url, expect: 'PASS' }];
  if (!o.file) {
    console.error('Give --test "..." or --file cases.txt');
    process.exit(2);
  }
  const lines = (await readFile(o.file, 'utf8'))
    .split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  return lines.map((line): Case => {
    const m = line.match(/^\[expect:(PASS|FAIL)\]\s*(.*)$/i);
    const expect = (m ? (m[1] as string).toUpperCase() : 'PASS') as Expected;
    const rest = m ? (m[2] ?? '') : line;
    const sep = rest.indexOf(' | ');
    return sep > 0
      ? { url: rest.slice(0, sep).trim(), test: rest.slice(sep + 3).trim(), expect }
      : { url: o.url, test: rest, expect };
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
const repeat = Math.max(1, Number(o.repeat) || 1);
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const results: { caseIndex: number; r: RunResult }[] = [];

for (let round = 1; round <= repeat; round++) {
  for (const [i, c] of cases.entries()) {
    const runInfo = repeat > 1 ? ` (run ${round}/${repeat})` : '';
    console.log(`\n=== Test ${i + 1}/${cases.length}${runInfo}: ${c.test}`);
    const outDir = path.join(o.out, `${stamp}-${String(i + 1).padStart(2, '0')}-r${round}`);
    const r = await runTest(llm, {
      test: c.test, startUrl: c.url, vars, headless: o.headless,
      maxSteps: Number(o.maxSteps) || 20, outDir, verbose: o.verbose,
    });
    await saveResult(r);
    printResult(r);
    results.push({ caseIndex: i, r });
  }
}

if (results.length > 1) {
  const lines = cases.map((c, i) => {
    const mine = results.filter((x) => x.caseIndex === i).map((x) => x.r);
    const asExpected = mine.filter((r) => r.verdict === c.expect).length;
    const errors = mine.filter((r) => r.verdict === 'ERROR').length;
    const avg = Math.round(mine.reduce((s, r) => s + r.seconds, 0) / mine.length);
    return `${i + 1}. as expected ${asExpected}/${mine.length} (expect ${c.expect}, errors ${errors}, avg ${avg}s)  ${c.test}`;
  });
  console.log('\n=== Summary');
  lines.forEach((l) => console.log(l));
  await mkdir(o.out, { recursive: true });
  await writeFile(path.join(o.out, `${stamp}-summary.txt`), `Model: ${llm.label}\n${lines.join('\n')}\n`, 'utf8');
}

const checked = results.map((x) => ({ r: x.r, expect: (cases[x.caseIndex] as Case).expect }));
process.exit(
  checked.some((x) => x.r.verdict === 'ERROR') ? 2 : checked.some((x) => x.r.verdict !== x.expect) ? 1 : 0,
);