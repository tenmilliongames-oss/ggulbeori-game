export type GameSide = "left" | "right";
export type GameStatus = "playing" | "clear" | "failed" | "paused";

export interface SpotPoint {
  id: string;
  cx: number;
  cy: number;
  radius: number;
}

export interface GameLevel {
  styleId: string;
  level: number;
  leftImage: string;
  rightImage: string;
  thumbnailImage: string;
  bgmTrack: string;
  spots: SpotPoint[];
  timeLimitSec: number;
}

export interface GameStyle {
  id: string;
  name: string;
  coverImage: string;
  levels: GameLevel[];
}

export interface GameBanner {
  id: string;
  title: string;
  subtitle?: string;
  disclosure?: string;
  image?: string;
  layout?: "text" | "image";
  url: string;
  background?: string;
  foreground?: string;
  accent?: string;
  enabled?: boolean;
}

export interface GameData {
  projectName: string;
  logoImage: string;
  beeImage: string;
  beeFrames: string[];
  hiveImage: string;
  markerImage: string;
  successSound: string;
  failSound: string;
  bgmTracks: string[];
  banners: GameBanner[];
  styles: GameStyle[];
}

export interface GuessResult {
  kind: "correct" | "duplicate" | "wrong" | "ignored";
  spotId?: string;
  remainingMistakes: number;
}
