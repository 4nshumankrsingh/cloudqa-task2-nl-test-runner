import { chromium } from 'playwright';
import { observe } from './observe.js';
import { buildUserPrompt } from './prompts.js';

const url = process.argv[2] ?? 'https://example.com';
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
await context.addInitScript('window.__name = window.__name || ((f) => f);');
const page = await context.newPage();
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForTimeout(1000);

const obs = await observe(page);
console.log(buildUserPrompt({ test: '(observer check)', startUrl: url, step: 1, maxSteps: 20, history: [], obs, hint: '' }));
await browser.close();