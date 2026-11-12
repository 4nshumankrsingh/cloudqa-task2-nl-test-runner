import type { Page } from 'playwright';

export type ObservedElement = {
  id: number;
  role: string;
  name: string;
  type: string;
  value: string;
  placeholder: string;
  href: string;
  checked: boolean;
  disabled: boolean;
  options: string[];
};

export type Observation = {
  url: string;
  title: string;
  elements: ObservedElement[];
  notShown: number;
  text: string;
};

const MAX_ELEMENTS = 120;
const MAX_TEXT = 3000;

// Describes the page to the model: every visible interactive element gets a number,
// which is stamped on the element as data-qa-id so actions can find it again.
export async function observe(page: Page): Promise<Observation> {
  // tsx adds a __name helper to compiled code; the browser doesn't have it, so define a stand-in.
  await page.evaluate('window.__name = window.__name || ((f) => f);');
  const snapshot = await page.evaluate(
    ({ maxElements, maxText }) => {
      const norm = (s: string | null | undefined): string => (s ?? '').replace(/\s+/g, ' ').trim();
      const visible = (el: Element): boolean => {
        if (el.getClientRects().length === 0) return false;
        const s = getComputedStyle(el);
        return s.visibility !== 'hidden' && s.display !== 'none';
      };
      const inView = (el: Element): boolean => {
        const r = el.getBoundingClientRect();
        return r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
      };
      const textOf = (n: Element | null): string =>
        norm(n ? (n as HTMLElement).innerText ?? n.textContent : '');
      const near = (node: Element): string => {
        for (let n: Element | null = node, d = 0; n && d < 4; n = n.parentElement, d++) {
          let p = n.previousElementSibling;
          while (p && !textOf(p)) p = p.previousElementSibling;
          if (p && textOf(p).length <= 40) return textOf(p);
        }
        return '';
      };
      const nameOf = (el: Element): string => {
        const aria = el.getAttribute('aria-label');
        if (aria) return norm(aria);
        const by = el.getAttribute('aria-labelledby');
        if (by) {
          const t = by.split(/\s+/).map((i) => textOf(document.getElementById(i))).join(' ').trim();
          if (t) return t;
        }
        const labels = (el as HTMLInputElement).labels;
        if (labels && labels.length) return norm(Array.from(labels).map((l) => l.textContent).join(' '));
        if (el.tagName === 'INPUT') {
          const t = (el as HTMLInputElement).type;
          if (t === 'submit' || t === 'button' || t === 'reset') return norm((el as HTMLInputElement).value);
        }
        const own = el.tagName === 'SELECT' || el.tagName === 'TEXTAREA' ? '' : textOf(el).slice(0, 80);
        if (own) return own;
        const alt = norm(el.getAttribute('alt') || el.getAttribute('title'));
        if (alt) return alt;
        if (['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName)) return near(el);
        return '';
      };
      const roleOf = (el: Element): string => {
        const r = el.getAttribute('role');
        if (r) return r;
        const tag = el.tagName.toLowerCase();
        if (tag === 'a') return 'link';
        if (tag === 'button' || tag === 'summary') return 'button';
        if (tag === 'select') return 'select';
        if (tag === 'textarea') return 'textbox';
        if (tag === 'input') {
          const t = (el as HTMLInputElement).type;
          if (t === 'checkbox' || t === 'radio') return t;
          if (['submit', 'button', 'reset', 'image'].includes(t)) return 'button';
          if (t === 'file') return 'file';
          return 'textbox';
        }
        return tag === 'li' ? 'option' : 'clickable';
      };

      const SELECTOR = [
        'a[href]', 'button', 'input:not([type=hidden])', 'select', 'textarea', 'summary',
        '[role=button]', '[role=link]', '[role=checkbox]', '[role=radio]', '[role=combobox]',
        '[role=option]', '[role=tab]', '[role=menuitem]', '[role=switch]', '[role=textbox]',
        '[onclick]', '[contenteditable=true]', '[tabindex]:not([tabindex="-1"])',
        'li[class*=option i]', 'div[class*=option i]',
      ].join(',');

      document.querySelectorAll('[data-qa-id]').forEach((e) => e.removeAttribute('data-qa-id'));
      const found = Array.from(new Set(Array.from(document.querySelectorAll(SELECTOR)))).filter(visible);
      found.sort((a, b) => Number(inView(b)) - Number(inView(a))); // on-screen first, DOM order kept
      const shown = found.slice(0, maxElements);

      const elements = shown.map((el, i) => {
        const id = i + 1;
        el.setAttribute('data-qa-id', String(id));
        const input = el as HTMLInputElement;
        const isSelect = el.tagName === 'SELECT';
        const select = el as HTMLSelectElement;
        const options: string[] = isSelect
          ? Array.from(select.options).slice(0, 25).map((o) => norm(o.text))
          : [];
        const raw = typeof input.value === 'string' ? input.value : '';
        const value = isSelect
          ? norm(select.selectedOptions[0]?.text)
          : input.type === 'password'
            ? (raw ? '(hidden)' : '')
            : norm(raw).slice(0, 60);
        return {
          id,
          role: roleOf(el),
          name: nameOf(el),
          type: typeof input.type === 'string' ? input.type : '',
          value,
          placeholder: el.getAttribute('placeholder') ?? '',
          href: (el.getAttribute('href') ?? '').slice(0, 80),
          checked: input.checked === true || el.getAttribute('aria-checked') === 'true',
          disabled: (el as HTMLButtonElement).disabled === true || el.getAttribute('aria-disabled') === 'true',
          options,
        };
      });

      const text = (document.body?.innerText ?? '')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n\s*\n+/g, '\n')
        .trim()
        .slice(0, maxText);
      return { elements, notShown: found.length - shown.length, text };
    },
    { maxElements: MAX_ELEMENTS, maxText: MAX_TEXT },
  );
  const title = await page.title().catch(() => '');
  return { url: page.url(), title, ...snapshot };
}