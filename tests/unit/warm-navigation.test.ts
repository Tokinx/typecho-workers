import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const shell = readFileSync(join(process.cwd(), 'src/themes/typecho-theme-warm/components/WarmShell.astro'), 'utf8');
const navigationScript = shell.match(/<script is:inline>([\s\S]*?)<\/script>/)![1];
const delegatedScript = shell.match(/<script is:inline data-no-instant>([\s\S]*?)<\/script>/)![1];

type Target = { inside?: boolean; closest?: (selector: string) => Target | null };
type Event = { key?: string; detail?: number; preventDefault?: () => void; target?: Target; relatedTarget?: Target | null };

function setup(hoverCapable: boolean) {
  const listeners = new Map<string, (event: Event) => void>();
  const documentListeners = new Map<string, Array<(event: Event) => void>>();
  const summary: Target = { inside: true };
  const dropdown = {
    open: false,
    contains: (target: Target | null | undefined) => target?.inside === true,
    querySelector: () => ({ focus: vi.fn(() => { document.activeElement = summary; }) }),
    addEventListener: (name: string, handler: (event: Event) => void) => listeners.set(name, handler),
  };
  const document = {
    activeElement: null as Target | null,
    querySelectorAll: (selector: string) => selector.endsWith('[open]') && !dropdown.open ? [] : [dropdown],
    addEventListener: (name: string, handler: (event: Event) => void) => {
      documentListeners.set(name, [...(documentListeners.get(name) || []), handler]);
    },
  };
  const context = {
    document,
    window: { matchMedia: () => ({ matches: hoverCapable }), addEventListener: vi.fn() },
    CSS: { supports: () => false },
  };
  runInNewContext(navigationScript, context);
  runInNewContext(delegatedScript, context);
  return { dropdown, document, summary, emit: (name: string, event: Event = {}) => listeners.get(name)?.(event),
    click: (target: Target) => documentListeners.get('click')?.forEach(handler => handler({ target: { ...target, closest: () => null } })) };
}

describe('Warm navigation', () => {
  it('enhances pointer hover without overriding touch-only details behavior', () => {
    const mouse = setup(true);
    mouse.emit('mouseenter');
    expect(mouse.dropdown.open).toBe(true);
    mouse.emit('mouseleave');
    expect(mouse.dropdown.open).toBe(false);
    const touch = setup(false);
    touch.emit('mouseenter');
    expect(touch.dropdown.open).toBe(false);
    touch.dropdown.open = true; // Native summary tap.
    touch.emit('mouseleave');
    expect(touch.dropdown.open).toBe(true);
  });


  it('does not immediately close a hover-opened menu on the first pointer click', () => {
    const menu = setup(true);
    menu.emit('mouseenter');
    const preventDefault = vi.fn();
    const click = { target: { closest: () => menu.summary }, detail: 1, preventDefault };
    menu.emit('click', click);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(menu.dropdown.open).toBe(true);
    preventDefault.mockClear();
    menu.emit('click', click);
    expect(preventDefault).not.toHaveBeenCalled(); // A second click toggles natively.
    menu.emit('mouseleave');
    menu.emit('mouseenter');
    menu.emit('click', { ...click, detail: 0 });
    expect(preventDefault).not.toHaveBeenCalled(); // Enter/Space still toggle natively.
  });

  it('keeps keyboard focus inside the menu until Escape or focus leaves', () => {
    const menu = setup(true);
    menu.dropdown.open = true;
    menu.document.activeElement = menu.summary;
    menu.emit('mouseleave');
    expect(menu.dropdown.open).toBe(true);
    menu.emit('keydown', { key: 'ArrowDown' });
    expect(menu.dropdown.open).toBe(true);
    menu.emit('keydown', { key: 'Escape' });
    expect(menu.dropdown.open).toBe(false);
    expect(menu.document.activeElement).toBe(menu.summary);
    menu.dropdown.open = true;
    menu.emit('focusout', { relatedTarget: { inside: true } });
    expect(menu.dropdown.open).toBe(true);
    // Mobile Safari reports null while a touch tap moves from <summary>
    // to a nested link. Do not remove that link before its synthetic click.
    menu.emit('focusout', { relatedTarget: null });
    expect(menu.dropdown.open).toBe(true);
    menu.emit('focusout', { relatedTarget: { inside: false } });
    expect(menu.dropdown.open).toBe(false);
  });

  it('delegates outside-click dismissal while leaving menu links usable', () => {
    const menu = setup(false);
    menu.dropdown.open = true;
    menu.click({ inside: true });
    expect(menu.dropdown.open).toBe(true);
    menu.click({ inside: false });
    expect(menu.dropdown.open).toBe(false);
    // A newly opened menu is found by the same document listener after a page swap.
    menu.dropdown.open = true;
    menu.click({ inside: false });
    expect(menu.dropdown.open).toBe(false);
  });
});
