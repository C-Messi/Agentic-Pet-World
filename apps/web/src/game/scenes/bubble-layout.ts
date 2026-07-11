export interface BubbleLayout {
  text: string;
  width: number;
  height: number;
  lines: number;
  wrappedLines: readonly string[];
}

const CHARS_PER_LINE = 24;
const MAX_LINES = 6;
const CELL_WIDTH = 8;
const HORIZONTAL_PADDING = 24;
const LINE_HEIGHT = 18;
const VERTICAL_PADDING = 20;

export function layoutBubble(input: string): BubbleLayout {
  const normalized = input.replace(/\s+/g, ' ').trim();
  const graphemes = segmentGraphemes(normalized);
  const capacity = CHARS_PER_LINE * MAX_LINES;
  const truncated = graphemes.reduce((total, grapheme) => total + graphemeWidth(grapheme), 0) > capacity;
  const contentBudget = truncated ? capacity - 1 : capacity;
  const wrappedLines: string[] = [];
  let currentLine = '';
  let currentWidth = 0;
  let consumedWidth = 0;
  for (const grapheme of graphemes) {
    const width = graphemeWidth(grapheme);
    if (consumedWidth + width > contentBudget) break;
    if (currentWidth + width > CHARS_PER_LINE) {
      wrappedLines.push(currentLine);
      currentLine = '';
      currentWidth = 0;
    }
    currentLine += grapheme;
    currentWidth += width;
    consumedWidth += width;
  }
  if (currentLine || wrappedLines.length === 0) wrappedLines.push(currentLine);
  if (truncated) wrappedLines[wrappedLines.length - 1] += '…';
  const longestLine = Math.max(...wrappedLines.map(displayWidth));
  return {
    text: wrappedLines.join('\n'),
    width: Math.min(220, Math.max(112, longestLine * CELL_WIDTH + HORIZONTAL_PADDING)),
    height: VERTICAL_PADDING + wrappedLines.length * LINE_HEIGHT,
    lines: wrappedLines.length,
    wrappedLines,
  };
}

export function segmentGraphemes(input: string): string[] {
  try {
    if (typeof Intl.Segmenter === 'function') {
      const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
      return Array.from(segmenter.segment(input), ({ segment }) => segment);
    }
  } catch {
    // Fall through to the deterministic grouping below.
  }
  return fallbackGraphemes(input);
}

export function displayWidth(input: string): number {
  return segmentGraphemes(input).reduce(
    (total, grapheme) => total + graphemeWidth(grapheme),
    0,
  );
}

function graphemeWidth(grapheme: string): number {
  const codePoints = [...grapheme];
  if (codePoints.some((value) => isRegionalIndicator(value.codePointAt(0) ?? 0))) return 2;
  if (/\p{Extended_Pictographic}/u.test(grapheme)) return 2;
  return codePoints.some((value) => isWideCodePoint(value.codePointAt(0) ?? 0)) ? 2 : 1;
}

function fallbackGraphemes(input: string): string[] {
  const clusters: string[] = [];
  let current = '';
  let currentRegionalCount = 0;
  for (const value of input) {
    const codePoint = value.codePointAt(0) ?? 0;
    const append = current !== '' && (
      isCombining(codePoint)
      || isVariationSelector(codePoint)
      || isEmojiModifier(codePoint)
      || codePoint === 0x200d
      || current.endsWith('\u200d')
      || (isRegionalIndicator(codePoint) && currentRegionalCount === 1)
    );
    if (!append && current) {
      clusters.push(current);
      current = '';
      currentRegionalCount = 0;
    }
    current += value;
    currentRegionalCount = isRegionalIndicator(codePoint) ? currentRegionalCount + 1 : 0;
  }
  if (current) clusters.push(current);
  return clusters;
}

function isCombining(codePoint: number): boolean {
  return /\p{Mark}/u.test(String.fromCodePoint(codePoint));
}

function isVariationSelector(codePoint: number): boolean {
  return (codePoint >= 0xfe00 && codePoint <= 0xfe0f)
    || (codePoint >= 0xe0100 && codePoint <= 0xe01ef);
}

function isEmojiModifier(codePoint: number): boolean {
  return codePoint >= 0x1f3fb && codePoint <= 0x1f3ff;
}

function isRegionalIndicator(codePoint: number): boolean {
  return codePoint >= 0x1f1e6 && codePoint <= 0x1f1ff;
}

function isWideCodePoint(codePoint: number): boolean {
  return codePoint >= 0x1100 && (
    codePoint <= 0x115f
    || codePoint === 0x2329
    || codePoint === 0x232a
    || (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f)
    || (codePoint >= 0xac00 && codePoint <= 0xd7a3)
    || (codePoint >= 0xf900 && codePoint <= 0xfaff)
    || (codePoint >= 0xfe10 && codePoint <= 0xfe19)
    || (codePoint >= 0xfe30 && codePoint <= 0xfe6f)
    || (codePoint >= 0xff00 && codePoint <= 0xff60)
    || (codePoint >= 0xffe0 && codePoint <= 0xffe6)
    || (codePoint >= 0x1f300 && codePoint <= 0x1faff)
    || (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  );
}

export function positionBubble(
  cat: { x: number; y: number },
  bubble: Pick<BubbleLayout, 'width' | 'height'>,
  world: { width: number; height: number },
): { x: number; y: number } {
  const margin = 4;
  const halfWidth = bubble.width / 2;
  return {
    x: clamp(cat.x, halfWidth + margin, world.width - halfWidth - margin),
    y: clamp(cat.y - 42, bubble.height + 14 + margin, world.height - margin),
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
