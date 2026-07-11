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
  const codePoints = [...normalized];
  const capacity = CHARS_PER_LINE * MAX_LINES;
  const visible = codePoints.slice(0, capacity);
  if (codePoints.length > capacity) visible[visible.length - 1] = '…';
  const wrappedLines: string[] = [];
  for (let index = 0; index < visible.length; index += CHARS_PER_LINE) {
    wrappedLines.push(visible.slice(index, index + CHARS_PER_LINE).join(''));
  }
  if (wrappedLines.length === 0) wrappedLines.push('');
  const longestLine = Math.max(...wrappedLines.map((line) => [...line].length));
  return {
    text: wrappedLines.join('\n'),
    width: Math.min(220, Math.max(112, longestLine * CELL_WIDTH + HORIZONTAL_PADDING)),
    height: VERTICAL_PADDING + wrappedLines.length * LINE_HEIGHT,
    lines: wrappedLines.length,
    wrappedLines,
  };
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
