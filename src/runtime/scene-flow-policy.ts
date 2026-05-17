import type { ResolvedScene } from "./project-types";

export const BOOK_TRANSITION_TOTAL_SEC = 0.94;
export const BOOK_TRANSITION_COVER_SEC = 0.42;

export function shouldUseBookTransition(fromScene: ResolvedScene | null, toScene: ResolvedScene | null): boolean {
  if (!fromScene || !toScene || fromScene.sceneId === toScene.sceneId) {
    return false;
  }

  return (
    (fromScene.sceneType === "title_card" && toScene.sceneType === "puzzle_scene") ||
    (fromScene.sceneType === "answer_reveal" && toScene.sceneType === "puzzle_scene") ||
    (fromScene.sceneType === "answer_reveal" && toScene.sceneType === "timeout_card")
  );
}
