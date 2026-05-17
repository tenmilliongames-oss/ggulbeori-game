import type { GameData, GameLevel, GameSide, GameStatus, GameStyle, GuessResult } from "./types";

const MAX_MISTAKES = 10;
const MIN_HIT_RADIUS = 0.055;

export class SpotGameState {
  private styleIndex = 0;
  private levelIndex = 0;
  private foundSpotIds = new Set<string>();
  private mistakesLeft = MAX_MISTAKES;
  private timeLeftSec = 0;
  private status: GameStatus = "playing";

  constructor(private readonly data: GameData) {
    this.startLevel(0);
  }

  get currentLevel(): GameLevel {
    return this.currentStyle.levels[this.levelIndex];
  }

  get currentStyle(): GameStyle {
    return this.data.styles[this.styleIndex];
  }

  get currentStyleIndex(): number {
    return this.styleIndex;
  }

  get currentLevelIndex(): number {
    return this.levelIndex;
  }

  get levelCount(): number {
    return this.currentStyle.levels.length;
  }

  get remainingMistakes(): number {
    return this.mistakesLeft;
  }

  get remainingTimeSec(): number {
    return Math.max(0, this.timeLeftSec);
  }

  get foundCount(): number {
    return this.foundSpotIds.size;
  }

  get foundIds(): Set<string> {
    return new Set(this.foundSpotIds);
  }

  get gameStatus(): GameStatus {
    return this.status;
  }

  get isLastLevel(): boolean {
    return this.levelIndex >= this.currentStyle.levels.length - 1;
  }

  selectStyle(index: number): void {
    const clampedIndex = Math.max(0, Math.min(index, this.data.styles.length - 1));
    this.styleIndex = clampedIndex;
    this.startLevel(0);
  }

  startLevel(index: number): void {
    const clampedIndex = Math.max(0, Math.min(index, this.currentStyle.levels.length - 1));
    this.levelIndex = clampedIndex;
    this.foundSpotIds = new Set();
    this.mistakesLeft = MAX_MISTAKES;
    this.timeLeftSec = this.currentLevel.timeLimitSec;
    this.status = "playing";
  }

  restartLevel(): void {
    this.startLevel(this.levelIndex);
  }

  restartGame(): void {
    this.startLevel(0);
  }

  nextLevel(): void {
    if (this.isLastLevel) {
      this.restartGame();
      return;
    }

    this.startLevel(this.levelIndex + 1);
  }

  pause(): void {
    if (this.status === "playing") {
      this.status = "paused";
    }
  }

  resume(): void {
    if (this.status === "paused") {
      this.status = "playing";
    }
  }

  tick(deltaSec: number): void {
    if (this.status !== "playing") {
      return;
    }

    this.timeLeftSec = Math.max(0, this.timeLeftSec - Math.max(0, deltaSec));
    if (this.timeLeftSec <= 0) {
      this.status = "failed";
    }
  }

  guess(side: GameSide, cx: number, cy: number): GuessResult {
    void side;

    if (this.status !== "playing") {
      return { kind: "ignored", remainingMistakes: this.mistakesLeft };
    }

    const duplicate = this.findSpot(cx, cy, true);
    if (duplicate) {
      return {
        kind: "duplicate",
        spotId: duplicate.id,
        remainingMistakes: this.mistakesLeft,
      };
    }

    const spot = this.findSpot(cx, cy, false);
    if (spot) {
      this.foundSpotIds.add(spot.id);
      if (this.foundSpotIds.size >= this.currentLevel.spots.length) {
        this.status = "clear";
      }

      return {
        kind: "correct",
        spotId: spot.id,
        remainingMistakes: this.mistakesLeft,
      };
    }

    this.mistakesLeft = Math.max(0, this.mistakesLeft - 1);
    if (this.mistakesLeft <= 0) {
      this.status = "failed";
    }

    return {
      kind: "wrong",
      remainingMistakes: this.mistakesLeft,
    };
  }

  private findSpot(cx: number, cy: number, onlyFound: boolean): GameLevel["spots"][number] | null {
    for (const spot of this.currentLevel.spots) {
      const isFound = this.foundSpotIds.has(spot.id);
      if (onlyFound !== isFound) {
        continue;
      }

      const radius = Math.max(MIN_HIT_RADIUS, spot.radius);
      const dx = cx - spot.cx;
      const dy = cy - spot.cy;
      if (Math.hypot(dx, dy) <= radius) {
        return spot;
      }
    }

    return null;
  }
}
