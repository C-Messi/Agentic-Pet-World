import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8');

describe('responsive interface styles', () => {
  it('keeps touch controls stable and mobile text readable', () => {
    expect(css).toMatch(/\.icon-button\s*\{[^}]*inline-size:\s*44px/s);
    expect(css).toMatch(/@media\s*\(max-width:\s*600px\)[\s\S]*\.command-input\s*\{[^}]*font-size:\s*16px/s);
    expect(css).toContain('max-inline-size: min(100vw, 420px)');
    expect(css).toContain('letter-spacing: 0');
  });

  it('uses restrained corners and no gradients or decorative orbs', () => {
    expect(css).not.toMatch(/gradient\s*\(/i);
    expect(css).not.toMatch(/border-radius:\s*(?:[9-9]|[1-9][0-9])px/i);
    expect(css).not.toMatch(/\borb\b/i);
  });

  it('keeps the town canvas unobstructed and subtitles to one line', () => {
    expect(css).toMatch(/\.town-tool-strip\s*\{[^}]*position:\s*absolute/s);
    expect(css).toMatch(/\.town-subtitle\s*\{[^}]*white-space:\s*nowrap/s);
    expect(css).not.toContain('town-sidebar');
  });
});
