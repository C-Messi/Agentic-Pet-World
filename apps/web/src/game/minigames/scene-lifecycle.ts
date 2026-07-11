export interface ReturnSceneController {
  stop(key: string): unknown;
  wake(key: string): unknown;
}

export function returnToWorld(
  controller: ReturnSceneController,
  returnSceneKey: string,
  currentSceneKey: string,
): void {
  controller.stop(currentSceneKey);
  controller.wake(returnSceneKey);
}
