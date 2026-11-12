import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { RunResult } from './types.js';

export function printResult(r: RunResult): void {
  console.log('');
  console.log(`RESULT: ${r.verdict}`);
  console.log(`Reason: ${r.reason}`);
  console.log(`Steps: ${r.steps.length}   Time: ${r.seconds}s`);
  console.log(`Evidence: ${r.outDir}`);
}

export async function saveResult(r: RunResult): Promise<void> {
  await writeFile(path.join(r.outDir, 'result.json'), JSON.stringify(r, null, 2), 'utf8');
}