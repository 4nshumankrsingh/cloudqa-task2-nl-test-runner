import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: false });
const page = await browser.newPage();
await page.goto('https://phptravels.com/demo', { waitUntil: 'domcontentloaded' });
console.log('Title:', await page.title());
console.log('Links on page:', await page.locator('a').count());
await browser.close();