export interface BubbleLayout {
  text: string;
  width: number;
  height: number;
  lines: number;
  wrappedLines: readonly string[];
  truncated: boolean;
}

export interface RenderedTextMeasurement {
  width: number;
  height: number;
  lines: number;
}

export type TextMeasurer = (text: string) => RenderedTextMeasurement;

const WRAP_WIDTH = 196;
const MAX_LINES = 6;
const MAX_TEXT_HEIGHT = 108;
const HORIZONTAL_PADDING = 24;
const VERTICAL_PADDING = 24;

export function fitBubbleText(input: string, measure: TextMeasurer): BubbleLayout {
  const normalized = input.replace(/\s+/g, ' ').trim();
  const graphemes = segmentGraphemes(normalized);
  const allLines: string[] = [];
  let currentLine = '';
  for (const grapheme of graphemes) {
    const candidate = currentLine + grapheme;
    const candidateMeasurement = measure(candidate);
    if (currentLine && (candidateMeasurement.width > WRAP_WIDTH || candidateMeasurement.lines > 1)) {
      allLines.push(currentLine);
      currentLine = grapheme;
    } else {
      currentLine = candidate;
    }
  }
  if (currentLine || allLines.length === 0) allLines.push(currentLine);

  let truncated = allLines.length > MAX_LINES;
  let wrappedLines = allLines.slice(0, MAX_LINES);
  let measurement = measure(wrappedLines.join('\n'));
  if (!fitsBubble(measurement)) {
    truncated = true;
  }
  if (truncated) {
    const fitted = fitTruncatedLines(wrappedLines, measure);
    wrappedLines = fitted.lines;
    measurement = fitted.measurement;
  }
  return {
    text: wrappedLines.join('\n'),
    width: Math.max(112, Math.ceil(measurement.width) + HORIZONTAL_PADDING),
    height: Math.ceil(measurement.height) + VERTICAL_PADDING,
    lines: measurement.lines,
    wrappedLines,
    truncated,
  };
}

function fitTruncatedLines(
  inputLines: readonly string[],
  measure: TextMeasurer,
): { lines: string[]; measurement: RenderedTextMeasurement } {
  const lines = [...inputLines];
  while (lines.length > 0) {
    const prefix = lines.slice(0, -1);
    const graphemes = segmentGraphemes(lines.at(-1) ?? '');
    for (let length = graphemes.length; length >= 0; length -= 1) {
      const candidateLines = [...prefix, `${graphemes.slice(0, length).join('')}…`];
      const measurement = measure(candidateLines.join('\n'));
      if (fitsBubble(measurement)) return { lines: candidateLines, measurement };
    }
    lines.pop();
  }
  for (const fallback of ['…', '']) {
    const measurement = measure(fallback);
    if (fitsBubble(measurement)) return { lines: [fallback], measurement };
  }
  throw new Error('Renderer cannot fit an empty bubble');
}

function fitsBubble(measurement: RenderedTextMeasurement): boolean {
  return measurement.lines <= MAX_LINES
    && measurement.height <= MAX_TEXT_HEIGHT
    && measurement.width <= WRAP_WIDTH;
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
