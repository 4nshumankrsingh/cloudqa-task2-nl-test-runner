export type Verdict = 'PASS' | 'FAIL' | 'ERROR';

export type StepLog = {
  n: number;
  thought: string;
  description: string;
  ok: boolean;
  note: string;
  url: string;
};

export type RunResult = {
  test: string;
  startUrl?: string;
  verdict: Verdict;
  reason: string;
  steps: StepLog[];
  seconds: number;
  outDir: string;
};

export function firstLine(e: unknown): string {
  const text = e instanceof Error ? e.message : String(e);
  return (text.split('\n')[0] ?? '').slice(0, 300);
}