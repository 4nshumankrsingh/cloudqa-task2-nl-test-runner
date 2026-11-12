import { z } from 'zod';
import type { Page } from 'playwright';
import type { ToolSpec } from './llm.js';
import { firstLine } from './types.js';

export type Vars = Record<string, string>;

const thought = z.string().optional();
const id = z.coerce.number().int();

// What the model may ask for. Each action is validated before anything runs.
export const ActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('goto'), url: z.string().min(1), thought }),
  z.object({ action: z.literal('click'), id, thought }),
  z.object({ action: z.literal('type'), id, text: z.string(), submit: z.boolean().optional(), thought }),
  z.object({ action: z.literal('select'), id, text: z.string().min(1), thought }),
  z.object({ action: z.literal('press'), key: z.string().min(1), thought }),
  z.object({ action: z.literal('scroll'), text: z.enum(['up', 'down']).optional(), thought }),
  z.object({ action: z.literal('wait'), ms: z.coerce.number().int().min(0).max(10000).optional(), thought }),
  z.object({ action: z.literal('assert_text'), text: z.string().min(1), thought }),
  z.object({ action: z.literal('assert_no_text'), text: z.string().min(1), thought }),
  z.object({ action: z.literal('assert_url'), text: z.string().min(1), thought }),
  z.object({ action: z.literal('finish'), verdict: z.enum(['PASS', 'FAIL']), reason: z.string().min(1), thought }),
]);
export type Action = z.infer<typeof ActionSchema>;

// The same thing as a flat JSON schema for the model (providers cope best with flat schemas).
export const NEXT_ACTION_TOOL: ToolSpec = {
  name: 'next_action',
  description: 'Choose the single next browser action, or finish the test.',
  schema: {
    type: 'object',
    properties: {
      thought: { type: 'string', description: 'One short sentence on why you chose this action.' },
      action: {
        type: 'string',
        enum: ['goto', 'click', 'type', 'select', 'press', 'scroll', 'wait',
               'assert_text', 'assert_no_text', 'assert_url', 'finish'],
        description: 'The action to perform.',
      },
      id: { type: 'integer', description: 'Element id from the current list (click, type, select).' },
      text: {
        type: 'string',
        description: 'type: the text to enter. select: the option to choose. assert_*: the text or URL fragment to check. scroll: up or down.',
      },
      url: { type: 'string', description: 'Address to open (goto).' },
      key: { type: 'string', description: 'Key to press, for example Enter, Tab or Escape (press).' },
      submit: { type: 'boolean', description: 'type: press Enter after typing.' },
      ms: { type: 'integer', description: 'Milliseconds to wait, at most 10000 (wait).' },
      verdict: { type: 'string', enum: ['PASS', 'FAIL'], description: 'finish: the test result.' },
      reason: { type: 'string', description: 'finish: what you observed and why this is the verdict.' },
    },
    required: ['thought', 'action'],
  },
};

export type ExecResult = { ok: boolean; note: string };

const normalize = (s: string): string => s.replace(/\s+/g, ' ').trim().toLowerCase();

// Replaces {{name}} placeholders with real values. Only happens here, so the model never sees secrets.
export function substitute(text: string, vars: Vars): string {
  return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, name: string) => {
    if (!(name in vars)) throw new Error(`variable '${name}' was not provided`);
    return vars[name] as string;
  });
}

export async function execute(page: Page, a: Action, vars: Vars): Promise<ExecResult> {
  const target = (n: number) => page.locator(`[data-qa-id="${n}"]`);
  try {
    switch (a.action) {
      case 'goto':
        await page.goto(substitute(a.url, vars), { waitUntil: 'domcontentloaded', timeout: 30000 });
        return { ok: true, note: 'opened' };

      case 'click':
        await target(a.id).click({ timeout: 8000 });
        return { ok: true, note: 'clicked' };

      case 'type': {
        const loc = target(a.id);
        const value = substitute(a.text, vars);
        try {
          await loc.fill(value, { timeout: 8000 });
        } catch {
          await loc.click({ timeout: 5000 }); // not a normal input: click it and type like a user
          await page.keyboard.type(value);
        }
        if (a.submit) await page.keyboard.press('Enter');
        return { ok: true, note: 'typed' };
      }

      case 'select': {
        const loc = target(a.id);
        const wanted = substitute(a.text, vars);
        const index = await loc.evaluate((el, w) => {
          const norm = (t: string) => t.replace(/\s+/g, ' ').trim().toLowerCase();
          const opts = Array.from((el as HTMLSelectElement).options);
          let i = opts.findIndex((o) => norm(o.text) === norm(w) || norm(o.value) === norm(w));
          if (i < 0) i = opts.findIndex((o) => norm(o.text).includes(norm(w)));
          return i;
        }, wanted);
        if (index < 0) return { ok: false, note: `no option matching '${wanted}'` };
        await loc.selectOption({ index }, { timeout: 8000 });
        return { ok: true, note: `selected '${wanted}'` };
      }

      case 'press':
        await page.keyboard.press(a.key);
        return { ok: true, note: `pressed ${a.key}` };

      case 'scroll':
        await page.evaluate((d) => window.scrollBy(0, d), a.text === 'up' ? -600 : 600);
        return { ok: true, note: 'scrolled' };

      case 'wait':
        await page.waitForTimeout(a.ms ?? 1000);
        return { ok: true, note: 'waited' };

      case 'assert_text': {
        const body = normalize(await page.evaluate(() => document.body.innerText));
        const ok = body.includes(normalize(substitute(a.text, vars)));
        return { ok, note: ok ? `page contains '${a.text}'` : `page does NOT contain '${a.text}'` };
      }

      case 'assert_no_text': {
        const body = normalize(await page.evaluate(() => document.body.innerText));
        const ok = !body.includes(normalize(substitute(a.text, vars)));
        return { ok, note: ok ? `page does not contain '${a.text}'` : `page DOES contain '${a.text}'` };
      }

      case 'assert_url': {
        const ok = normalize(page.url()).includes(normalize(substitute(a.text, vars)));
        return { ok, note: ok ? `URL contains '${a.text}'` : `URL does NOT contain '${a.text}' (it is ${page.url()})` };
      }

      case 'finish':
        return { ok: true, note: 'finished' };
    }
  } catch (e) {
    return { ok: false, note: firstLine(e) };
  }
}