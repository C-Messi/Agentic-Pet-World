import { describe, expect, it } from 'vitest';

import { layoutBubble, positionBubble } from './bubble-layout';

describe('bubble layout', () => {
  it.each([
    ['unbroken ASCII', 'W'.repeat(280)],
    ['wide CJK', '界'.repeat(280)],
    ['emoji', '😀'.repeat(280)],
  ])('contains protocol-maximum %s text in a bounded bubble', (_kind, text) => {
    const layout = layoutBubble(text);

    expect(layout.text.endsWith('…')).toBe(true);
    expect(layout.height).toBeLessThanOrEqual(132);
    expect(layout.width).toBeLessThanOrEqual(220);
    expect(layout.lines).toBeLessThanOrEqual(6);
    expect(layout.wrappedLines).toHaveLength(layout.lines);
    expect(layout.wrappedLines.every((line) => [...line].length <= 24)).toBe(true);
  });

  it('pre-wraps short text deterministically at fixed Unicode columns', () => {
    const layout = layoutBubble('123456789012345678901234ABCDE');

    expect(layout.wrappedLines).toEqual(['123456789012345678901234', 'ABCDE']);
    expect(layout.text).toBe('123456789012345678901234\nABCDE');
  });

  it('keeps the complete bubble inside every world edge', () => {
    const layout = layoutBubble('A long message '.repeat(30));

    for (const cat of [{ x: 0, y: 0 }, { x: 768, y: 0 }, { x: 0, y: 512 }, { x: 768, y: 512 }]) {
      const position = positionBubble(cat, layout, { width: 768, height: 512 });
      expect(position.x - layout.width / 2).toBeGreaterThanOrEqual(4);
      expect(position.x + layout.width / 2).toBeLessThanOrEqual(764);
      expect(position.y - layout.height - 14).toBeGreaterThanOrEqual(4);
      expect(position.y).toBeLessThanOrEqual(508);
    }
  });
});
