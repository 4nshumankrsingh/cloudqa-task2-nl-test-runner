import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium, type BrowserContext, type Page } from 'playwright';
import { ActionSchema, NEXT_ACTION_TOOL, execute, type Vars } from './actions.js';
import type { LlmClient } from './llm.js';
import { observe, type Observation } from './observe.js';
import { SYSTEM_PROMPT, buildUserPrompt, describeAction } from './prompts.js';
import { firstLine, type RunResult, type StepLog, type Verdict } from './types.js';

export type AgentOptions = {
  test: string;
  startUrl?: string;
  vars: Vars;
  headless: boolean;
  maxSteps: number;
  outDir: string;
  verbose: boolean;
};

export async function runTest(llm: LlmClient, opts: AgentOptions): Promise<RunResult> {
  const started = Date.now();
  const steps: StepLog[] = [];
  const done = (verdict: Verdict, reason: string): RunResult => ({
    test: opts.test,
    startUrl: opts.startUrl,
    verdict,
    reason,
    steps,
    seconds: Math.round((Date.now() - started) / 100) / 10,
    outDir: opts.outDir,
  });

  // Missing placeholder values are caught before any browser or model call.
  const needed = [...opts.test.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1] as string);
  const missing = [...new Set(needed)].filter((n) => !(n in opts.vars));
  if (missing.length) {
    return done('ERROR', `missing data: no value for ${missing.map((m) => `{{${m}}}`).join(', ')}. Pass --var name=value.`);
  }

  await mkdir(opts.outDir, { recursive: true });
  const browser = await chromium.launch({ headless: opts.headless, slowMo: opts.headless ? 0 : 250 });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await context.addInitScript('window.__name = window.__name || ((f) => f);');
    const watch = (p: Page): void => { p.on('dialog', (d) => { void d.accept(); }); };
    context.on('page', watch);
    let page = await context.newPage();

    if (opts.startUrl) {
      try {
        await page.goto(opts.startUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      } catch (e) {
        return done('ERROR', `could not open ${opts.startUrl}: ${firstLine(e)}`);
      }
    }

    let invalid = 0;
    let lastAssertOk: boolean | null = null;
    let lastSig = '';
    let repeat = 0;
    let hint = '';

    for (let n = 1; n <= opts.maxSteps; n++) {
      page = await latestPage(context, page);
      await settle(page);

      let obs: Observation;
      try {
        obs = await observeWithRetry(page);
      } catch (e) {
        return done('ERROR', `could not read the page: ${firstLine(e)}`);
      }

      let raw: unknown;
      try {
        const prompt = buildUserPrompt({
          test: opts.test, startUrl: opts.startUrl, step: n, maxSteps: opts.maxSteps, history: steps, obs, hint,
        });
        raw = await llm.callTool(SYSTEM_PROMPT, [{ role: 'user', content: prompt }], NEXT_ACTION_TOOL);
      } catch (e) {
        return done('ERROR', `AI model unavailable: ${firstLine(e)}`);
      }
      hint = '';

      const parsed = ActionSchema.safeParse(raw);
      if (!parsed.success) {
        invalid++;
        const msg = parsed.error.issues.slice(0, 2).map((i) => `${i.path.join('.') || 'action'}: ${i.message}`).join('; ');
        steps.push({ n, thought: '', description: '(invalid response from the model)', ok: false, note: msg, url: obs.url });
        console.log(`  step ${n}: invalid model response (${msg})`);
        if (invalid >= 3) return done('ERROR', 'the model repeatedly returned invalid actions');
        continue;
      }
      const a = parsed.data;
      if (a.action === 'type') a.text = unwrapInventedBraces(a.text, opts);
      if (opts.verbose && a.thought) console.log(`    why: ${a.thought}`);

      if (a.action === 'finish') {
        if (a.verdict === 'PASS' && lastAssertOk !== true) {
          steps.push({ n, thought: a.thought ?? '', description: 'finish PASS (rejected)', ok: false, note: 'PASS needs a passing assertion as the last action', url: obs.url });
          console.log(`  step ${n}: PASS rejected, no passing assertion yet`);
          hint = 'You tried to finish with PASS, but your latest action was not a passing assertion. Run assert_text, assert_no_text or assert_url that proves the expected outcome, or finish FAIL.';
          continue;
        }
        steps.push({ n, thought: a.thought ?? '', description: `finish ${a.verdict}`, ok: a.verdict === 'PASS', note: a.reason, url: obs.url });
        console.log(`  step ${n}: finish ${a.verdict}`);
        await shot(page, opts.outDir, n);
        return done(/^missing data/i.test(a.reason) ? 'ERROR' : a.verdict, a.reason);
      }

      const label = 'id' in a ? (obs.elements.find((e) => e.id === a.id)?.name ?? '') : '';
      const res = await execute(page, a, opts.vars);
      const description = describeAction(a, label);
      steps.push({ n, thought: a.thought ?? '', description, ok: res.ok, note: res.note, url: obs.url });
      console.log(`  step ${n}: ${description} -> ${res.ok ? 'ok' : 'FAILED'} (${res.note})`);
      lastAssertOk = a.action.startsWith('assert') ? res.ok : null;

      const sig = JSON.stringify([a.action, 'id' in a ? a.id : '', 'text' in a ? a.text : '']);
      repeat = sig === lastSig ? repeat + 1 : 1;
      lastSig = sig;
      if (repeat >= 3) hint = 'You have repeated the same action 3 times. Try something different, or finish FAIL if you are stuck.';

      await shot(page, opts.outDir, n);
    }
    return done('FAIL', `step limit (${opts.maxSteps}) reached before the test finished`);
  } catch (e) {
    return done('ERROR', `unexpected error: ${firstLine(e)}`);
  } finally {
    await browser.close();
  }
}

// Follow a link that opened in a new tab.
async function latestPage(context: BrowserContext, current: Page): Promise<Page> {
  const pages = context.pages().filter((p) => !p.isClosed());
  const last = pages[pages.length - 1];
  if (last && last !== current) {
    await last.bringToFront().catch(() => {});
    return last;
  }
  return current;
}

async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 2000 }).catch(() => {});
  await page.waitForTimeout(300);
}

async function observeWithRetry(page: Page): Promise<Observation> {
  let last: unknown;
  for (let i = 0; i < 3; i++) {
    try {
      return await observe(page);
    } catch (e) {
      last = e; // usually a navigation in progress
      await page.waitForTimeout(700);
    }
  }
  throw last;
}

async function shot(page: Page, dir: string, n: number): Promise<void> {
  await page.screenshot({ path: path.join(dir, `step-${String(n).padStart(2, '0')}.png`) }).catch(() => {});
}
// The model sometimes wraps a literal value from the test case in {{ }} as if it were a placeholder.
function unwrapInventedBraces(text: string, opts: AgentOptions): string {
  const m = text.match(/^\{\{\s*(.+?)\s*\}\}$/);
  if (!m) return text;
  const inner = m[1] as string;
  if (inner in opts.vars) return text; // a real placeholder: leave it for substitution
  return opts.test.includes(inner) ? inner : text; // a literal from the test case: drop the braces
}