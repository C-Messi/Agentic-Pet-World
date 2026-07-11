import { describe, expect, it } from 'vitest';

import { layoutBubble, positionBubble } from './bubble-layout';

describe('bubble layout', () => {
  it.each([
    ['speech', 's'.repeat(280)],
    ['thought', 't'.repeat(240)],
  ])('contains protocol-maximum %s text in a bounded bubble', (_kind, text) => {
    const layout = layoutBubble(text);

    expect(layout.text.endsWith('...')).toBe(true);
    expect(layout.height).toBeLessThanOrEqual(132);
    expect(layout.width).toBeLessThanOrEqual(220);
    expect(layout.lines).toBeLessThanOrEqual(6);
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
