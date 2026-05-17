import fs from "node:fs/promises";
import path from "node:path";
import * as XLSX from "xlsx";

const projectName = process.argv[2] ?? "sample";
const forceOverwrite = process.argv.includes("--force");
const projectRoot = path.resolve("public", "projects", projectName);
const outputPath = path.join(projectRoot, "scene-flow.xlsx");

const workbook = XLSX.utils.book_new();

function withHud(row, overrides = {}) {
  return {
    theme: "default",
    bannerText: "",
    bannerFill: "#1d4ed8",
    textColor: "#ffffff",
    badgeFill: "#fb923c",
    bannerImage: "resources/images/ui/hud/hud-bar.png",
    badgeImage: "resources/images/ui/timer-badge.png",
    panelFrameImage: "resources/images/ui/puzzle-frame.png",
    ...row,
    ...overrides,
  };
}

const projectRows = [
  { key: "projectName", value: projectName },
  { key: "width", value: 1280 },
  { key: "height", value: 720 },
  { key: "fps", value: 30 },
  { key: "authoringMode", value: "excel-driven" },
  { key: "stepCountSource", value: "images/puzzles folder scan" },
  { key: "puzzlePairRule", value: "{step}.png = left image, {step}-1.png = right image" },
];

const scenesRows = [
  withHud({
    sceneId: "intro",
    sceneType: "title_card",
    step: "",
    durationSec: 5,
    titleText: "Intro",
    backgroundImage: "resources/images/backgrounds/title-bg.png",
    backgroundVideo: "resources/videos/backgrounds/ambient-pan.mp4",
    foregroundImage: "resources/images/ui/intro-card.png",
    countdownFrom: 0,
  }),
  withHud({
    sceneId: "step-1",
    sceneType: "puzzle_scene",
    step: 1,
    durationSec: 90,
    titleText: "STEP 1",
    backgroundImage: "resources/images/backgrounds/puzzle-bg.png",
    backgroundVideo: "resources/videos/backgrounds/ambient-pan.mp4",
    foregroundImage: "",
    countdownFrom: 90,
  }, {
    theme: "blue",
    bannerText: "Find the three differences.",
    bannerFill: "#2563eb",
    textColor: "#ffffff",
    badgeFill: "#fb923c",
  }),
  withHud({
    sceneId: "answer-1",
    sceneType: "answer_reveal",
    step: 1,
    durationSec: 5,
    titleText: "STEP 1",
    backgroundImage: "resources/images/backgrounds/puzzle-bg.png",
    backgroundVideo: "resources/videos/backgrounds/ambient-pan.mp4",
    foregroundImage: "",
    countdownFrom: 0,
  }, {
    theme: "blue",
    bannerText: "Answer reveal scene",
    bannerFill: "#2563eb",
    textColor: "#fef08a",
    badgeFill: "#fb923c",
  }),
  withHud({
    sceneId: "step-2",
    sceneType: "puzzle_scene",
    step: 2,
    durationSec: 90,
    titleText: "STEP 2",
    backgroundImage: "resources/images/backgrounds/puzzle-bg.png",
    backgroundVideo: "",
    foregroundImage: "",
    countdownFrom: 90,
  }, {
    theme: "teal",
    bannerText: "Folder scan detects total steps automatically.",
    bannerFill: "#0f766e",
    textColor: "#ffffff",
    badgeFill: "#22c55e",
  }),
  withHud({
    sceneId: "timeout",
    sceneType: "timeout_card",
    step: "",
    durationSec: 4,
    titleText: "Timeout",
    backgroundImage: "resources/images/backgrounds/title-bg.png",
    backgroundVideo: "",
    foregroundImage: "resources/images/ui/timeout-card.png",
    countdownFrom: 0,
  }),
];

const effectsRows = [
  { sceneId: "step-1", target: "countdown", effectType: "pulse", resourcePath: "", startSec: 0, durationSec: 12, magnitude: 1.06, ease: "sine.inOut" },
  { sceneId: "answer-1", target: "marker", effectType: "pulse", resourcePath: "resources/images/effects/answer-marker-ring.png", startSec: 0, durationSec: 5, magnitude: 1.08, ease: "sine.inOut" },
];

const audioRows = [
  { sceneId: "step-1", trackType: "bgm", resourcePath: "resources/audio/bgm/sample-bgm.wav", startSec: 0, volume: 0.8, loop: true },
  { sceneId: "timeout", trackType: "sfx", resourcePath: "resources/audio/sfx/countdown-hit.wav", startSec: 0, volume: 1, loop: false },
];

const markerRows = [
  { sceneId: "answer-1", step: 1, side: "right", cx: 0.22, cy: 0.24, radius: 0.1, revealAtSec: 0.4, strokeColor: "#ff4fd8", lineWidth: 8, texturePath: "resources/images/effects/answer-marker-ring.png" },
  { sceneId: "answer-1", step: 1, side: "right", cx: 0.47, cy: 0.58, radius: 0.1, revealAtSec: 1.1, strokeColor: "#ff4fd8", lineWidth: 8, texturePath: "resources/images/effects/answer-marker-ring.png" },
  { sceneId: "answer-1", step: 1, side: "right", cx: 0.84, cy: 0.24, radius: 0.08, revealAtSec: 1.8, strokeColor: "#ff4fd8", lineWidth: 8, texturePath: "resources/images/effects/answer-marker-ring.png" },
];

const resourcesRows = [
  { category: "backgroundImage", resourcePath: "resources/images/backgrounds/title-bg.png", replaceHint: "Replace this PNG to change intro and timeout background art." },
  { category: "backgroundImage", resourcePath: "resources/images/backgrounds/puzzle-bg.png", replaceHint: "Replace this PNG to change the puzzle scene backdrop." },
  { category: "uiImage", resourcePath: "resources/images/ui/intro-card.png", replaceHint: "Full intro card PNG." },
  { category: "uiImage", resourcePath: "resources/images/ui/timeout-card.png", replaceHint: "Full timeout card PNG." },
  { category: "uiImage", resourcePath: "resources/images/ui/hud/hud-bar.png", replaceHint: "Shared HUD bar image used by every puzzle and answer scene." },
  { category: "uiImage", resourcePath: "resources/images/ui/timer-badge.png", replaceHint: "Countdown badge." },
  { category: "uiImage", resourcePath: "resources/images/ui/countdown/0.png", replaceHint: "Countdown digit set lives in resources/images/ui/countdown/." },
  { category: "uiImage", resourcePath: "resources/images/ui/puzzle-frame.png", replaceHint: "Panel frame for both puzzle images." },
  { category: "effectImage", resourcePath: "resources/images/effects/answer-marker-ring.png", replaceHint: "Answer reveal ring." },
  { category: "backgroundVideo", resourcePath: "resources/videos/backgrounds/ambient-pan.mp4", replaceHint: "Optional short looping background clip." },
  { category: "bgm", resourcePath: "resources/audio/bgm/sample-bgm.wav", replaceHint: "Sample looping BGM." },
  { category: "sfx", resourcePath: "resources/audio/sfx/ok.mp3", replaceHint: "Answer reveal SFX used when markers pop in." },
  { category: "sfx", resourcePath: "resources/audio/sfx/countdown-hit.wav", replaceHint: "Sample timeout SFX." },
];

XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(projectRows), "Project");
XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(scenesRows), "Scenes");
XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(effectsRows), "Effects");
XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(audioRows), "Audio");
XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(markerRows), "Markers");
XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(resourcesRows), "Resources");

await fs.mkdir(projectRoot, { recursive: true });
if (!forceOverwrite) {
  try {
    await fs.access(outputPath);
    console.log(`Skipped workbook creation because ${outputPath} already exists. Pass --force to overwrite it.`);
    process.exit(0);
  } catch {
    // File does not exist yet, continue and create it.
  }
}
XLSX.writeFile(workbook, outputPath);

console.log(`Created sample workbook at ${outputPath}`);
