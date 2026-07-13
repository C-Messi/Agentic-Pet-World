export class TownSceneState {
  followedResidentId = 'player-cat';
  bubble: { ownerId: string; text: string } | undefined;
  follow(residentId: string): void { this.followedResidentId = residentId; }
  showBubble(ownerId: string, text: string): void { this.bubble = { ownerId, text }; }
  clearBubble(ownerId?: string): void {
    if (ownerId === undefined || this.bubble?.ownerId === ownerId) this.bubble = undefined;
  }
}
