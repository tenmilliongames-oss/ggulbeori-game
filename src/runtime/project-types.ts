export type SceneType = "title_card" | "puzzle_scene" | "answer_reveal" | "timeout_card";

export interface WorkbookProjectMetadata {
  projectName: string;
  width: number;
  height: number;
  fps: number;
  authoringMode: string;
}

export interface SceneRow {
  sceneId: string;
  sceneType: SceneType;
  step: number | null;
  durationSec: number;
  titleText: string;
  backgroundImage: string;
  backgroundVideo: string;
  foregroundImage: string;
  countdownFrom: number;
  theme: string;
  bannerText: string;
  bannerFill: string;
  textColor: string;
  badgeFill: string;
  bannerImage: string;
  badgeImage: string;
  panelFrameImage: string;
}

export interface HudRow {
  sceneId: string;
  theme: string;
  bannerText: string;
  bannerFill: string;
  textColor: string;
  badgeFill: string;
  bannerImage: string;
  badgeImage: string;
  panelFrameImage: string;
}

export interface EffectRow {
  sceneId: string;
  target: string;
  effectType: string;
  resourcePath: string;
  startSec: number;
  durationSec: number;
  magnitude: number;
  ease: string;
}

export interface AudioRow {
  sceneId: string;
  trackType: "bgm" | "sfx";
  resourcePath: string;
  startSec: number;
  volume: number;
  loop: boolean;
}

export interface MarkerRow {
  sceneId: string;
  step: number;
  side: "left" | "right";
  cx: number;
  cy: number;
  radius: number;
  revealAtSec: number;
  strokeColor: string;
  lineWidth: number;
  texturePath: string;
}

export interface ResolvedHud extends HudRow {
  bannerImageUrl: string | null;
  badgeImageUrl: string | null;
  panelFrameImageUrl: string | null;
}

export interface ResolvedMarker extends MarkerRow {
  textureUrl: string | null;
}

export interface ResourceSlotRow {
  category: string;
  resourcePath: string;
  replaceHint: string;
}

export interface WorkbookData {
  project: WorkbookProjectMetadata;
  scenes: SceneRow[];
  hud: HudRow[];
  effects: EffectRow[];
  audio: AudioRow[];
  markers: MarkerRow[];
  resources: ResourceSlotRow[];
}

export interface StepResource {
  step: number;
  leftImage: string;
  rightImage: string;
  thumbnailImage?: string;
  variants: string[];
}

export interface StyleResource {
  id: string;
  name: string;
  coverImage: string;
  stepCount: number;
  steps: StepResource[];
}

export interface ResourceIndex {
  projectName: string;
  generatedAt: string;
  stepCount: number;
  steps: StepResource[];
  styles?: StyleResource[];
  resources: {
    backgroundImages: string[];
    uiImages: string[];
    effectImages: string[];
    backgroundVideos: string[];
    bgm: string[];
    sfx: string[];
    ui?: Partial<UiResourceOverrides>;
  };
  replaceableFiles?: Array<{
    category: string;
    fileName: string;
    relativePath: string;
    publicPath: string;
  }>;
}

export interface UiResourceOverrides {
  hudBar: string;
  timerBadge: string;
  countdownDigitsDir: string;
  puzzlePanelFrame: string;
  titleCardFrame: string;
  timeoutCardFrame: string;
  answerMarker: string;
}

export interface UiResourceUrls {
  hudBar: string;
  timerBadge: string;
  countdownDigitsDir: string;
  puzzlePanelFrame: string;
  titleCardFrame: string;
  timeoutCardFrame: string;
  answerMarker: string;
}

export interface ResolvedScene extends SceneRow {
  stepImages: StepResource | null;
  effects: EffectRow[];
  audio: AudioRow[];
  markers: ResolvedMarker[];
  backgroundImageUrl: string | null;
  backgroundVideoUrl: string | null;
  foregroundImageUrl: string | null;
}

export interface ProjectModel {
  projectName: string;
  width: number;
  height: number;
  fps: number;
  detectedStepCount: number;
  scenes: ResolvedScene[];
  diagnostics: string[];
  resourceIndex: ResourceIndex;
  uiResources: UiResourceUrls;
}
