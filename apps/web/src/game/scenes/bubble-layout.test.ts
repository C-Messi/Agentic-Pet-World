import { describe, expect, it } from 'vitest';

import {
  fitBubbleText,
  positionBubble,
  segmentGraphemes,
  type RenderedTextMeasurement,
} from './bubble-layout';

const measure = (text: string): RenderedTextMeasurement => {
  const lines = text.split('\n');
  return {
    width: Math.max(...lines.map((line) => segmentGraphemes(line).reduce(
      (width, grapheme) => width + fakeGlyphWidth(grapheme),
      0,
    ))),
    height: lines.length * 18,
    lines: lines.length,
  };
};

describe('measured bubble layout', () => {
  it.each([
    ['reviewer mixed widths', 'WWW界😀e\u03011️⃣'.repeat(45)],
    ['wide CJK', '界'.repeat(280)],
    ['emoji ZWJ and flags', '👨‍👩‍👧‍👦🇨🇳'.repeat(100)],
    ['combining accents', 'e\u0301'.repeat(280)],
    ['unbroken ASCII', 'W'.repeat(280)],
  ])('fits %s using actual renderer measurements', (_label, input) => {
    const layout = fitBubbleText(input, measure);
    const measured = measure(layout.text);

    expect(layout.truncated).toBe(true);
    expect(layout.text.endsWith('…')).toBe(true);
    expect(layout.lines).toBeLessThanOrEqual(6);
    expect(measured.lines).toBeLessThanOrEqual(6);
    expect(measured.width).toBeLessThanOrEqual(196);
    expect(measured.height).toBeLessThanOrEqual(108);
    expect(layout.width).toBeLessThanOrEqual(220);
    expect(layout.height).toBeLessThanOrEqual(132);
  });

  it('never splits keycap, ZWJ, flag, or combining graphemes', () => {
    const clusters = ['1️⃣', '👨‍👩‍👧‍👦', '🇨🇳', 'e\u0301'];
    const layout = fitBubbleText(clusters.join('').repeat(20), measure);
    const rendered = segmentGraphemes(layout.text.replace(/\n|…/g, ''));

    expect(rendered.every((cluster) => clusters.includes(cluster))).toBe(true);
  });

  it('uses measured fallback widths rather than character counts', () => {
    const layout = fitBubbleText(`${'i'.repeat(28)}${'W'.repeat(20)}`, measure);

    expect(layout.wrappedLines[0]).toBe('i'.repeat(28));
    expect(layout.wrappedLines[1]).toBe('W'.repeat(17));
    expect(measure(layout.wrappedLines[1] ?? '').width).toBeLessThanOrEqual(196);
  });

  it('remeasures ellipsis candidates when the renderer wraps a seventh line', () => {
    const ellipsisWrapMeasure = (text: string): RenderedTextMeasurement => {
      const measured = measure(text);
      const lastLine = text.split('\n').at(-1) ?? '';
      if (text.endsWith('…') && segmentGraphemes(lastLine).length > 5) {
        return { width: Math.min(196, measured.width), height: 126, lines: 7 };
      }
      return measured;
    };

    const layout = fitBubbleText('W'.repeat(280), ellipsisWrapMeasure);
    const measured = ellipsisWrapMeasure(layout.text);

    expect(layout.text.endsWith('…')).toBe(true);
    expect(measured.lines).toBeLessThanOrEqual(6);
    expect(measured.height).toBeLessThanOrEqual(108);
    expect(measured.width).toBeLessThanOrEqual(196);
  });

  it('keeps the measured bubble inside every world edge', () => {
    const layout = fitBubbleText('WWW界😀'.repeat(40), measure);

    for (const cat of [{ x: 0, y: 0 }, { x: 768, y: 0 }, { x: 0, y: 512 }, { x: 768, y: 512 }]) {
      const position = positionBubble(cat, layout, { width: 768, height: 512 });
      expect(position.x - layout.width / 2).toBeGreaterThanOrEqual(4);
      expect(position.x + layout.width / 2).toBeLessThanOrEqual(764);
      expect(position.y - layout.height - 14).toBeGreaterThanOrEqual(4);
      expect(position.y).toBeLessThanOrEqual(508);
    }
  });
});

function fakeGlyphWidth(grapheme: string): number {
  if (grapheme === 'W') return 11;
  if (grapheme === 'i') return 7;
  if (grapheme === '1️⃣') return 15;
  if (grapheme === 'e\u0301') return 8;
  if (/\p{Extended_Pictographic}/u.test(grapheme) || grapheme === '🇨🇳') return 18;
  if (grapheme === '界') return 16;
  return 8;
}
