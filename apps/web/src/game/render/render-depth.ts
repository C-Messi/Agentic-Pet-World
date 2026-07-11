export function bottomDepthFromTopLeft(displayTopY: number, displayHeight: number): number {
  return displayTopY + displayHeight;
}

export function bottomDepthFromCenter(displayCenterY: number, displayHeight: number): number {
  return displayCenterY + displayHeight / 2;
}
