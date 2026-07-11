export interface BubbleLayout {
  text: string;
  width: number;
  height: number;
  lines: number;
}

const MAX_DISPLAY_CHARS = 150;
const CHARS_PER_LINE = 26;
const MAX_LINES = 6;

export function layoutBubble(input: string): BubbleLayout {
  const normalized = input.replace(/\s+/g, ' ').trim();
  const text = normalized.length > MAX_DISPLAY_CHARS
    ? `${normalized.slice(0, MAX_DISPLAY_CHARS - 3).trimEnd()}...`
    : normalized;
  const lines = Math.min(MAX_LINES, Math.max(1, Math.ceil(text.length / CHARS_PER_LINE)));
  return {
    text,
    width: Math.min(220, Math.max(112, text.length * 7 + 24)),
    height: 28 + lines * 17,
    lines,
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
