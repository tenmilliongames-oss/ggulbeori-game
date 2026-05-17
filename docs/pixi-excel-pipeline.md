# Pixi + Excel Resource Pipeline

This project keeps scene timing in Excel and keeps all replaceable assets in fixed folders.

## Fixed folders

All swappable files live under `public/projects/sample/resources/`.

- `images/puzzles/`
- `images/backgrounds/`
- `images/ui/`
- `images/effects/`
- `videos/backgrounds/`
- `audio/bgm/`
- `audio/sfx/`

`scripts/build-project-index.mjs` scans those folders and writes `project-index.json`.

## Puzzle step rule

Puzzle step count is detected from filenames, not typed manually into Excel.

- `1.png` = step 1 left image
- `1-1.png` = step 1 right image
- `2.png` = step 2 left image
- `2-1.png` = step 2 right image

The number of unique leading integers becomes the total step count.

## Workbook sheets

- `Project`: resolution, FPS, and authoring notes.
- `Scenes`: scene order, duration, step number, background image, background video, and optional foreground PNG.
- `Hud`: HUD text/color fallback plus `bannerImage`, `badgeImage`, and `panelFrameImage`.
- `Effects`: timeline effect rows and their `resourcePath`.
- `Audio`: BGM/SFX file paths and playback timing.
- `Markers`: saved answer positions and optional marker texture file.
- `Resources`: replacement checklist for the user.

## Sample replaceable filenames

If you want simple swap-in replacement, keep these filenames and overwrite the files:

- `resources/images/backgrounds/title-bg.png`
- `resources/images/backgrounds/puzzle-bg.png`
- `resources/images/ui/cards/title-card-frame.png`
- `resources/images/ui/cards/timeout-card-frame.png`
- `resources/images/ui/hud/step-1-hud.png`
- `resources/images/ui/hud/answer-1-hud.png`
- `resources/images/ui/hud/step-2-hud.png`
- `resources/images/ui/hud/timer-badge.png`
- `resources/images/ui/countdown/0.png` through `resources/images/ui/countdown/120.png`
- `resources/images/ui/panels/puzzle-panel-frame.png`
- `resources/images/ui/markers/answer-marker.png`
- `resources/images/effects/glow-strip-cyan.png`
- `resources/videos/backgrounds/ambient-pan.mp4`
- `resources/audio/bgm/sample-bgm.wav`
- `resources/audio/sfx/reveal-chime.wav`
- `resources/audio/sfx/countdown-hit.wav`

If you rename a file, update the workbook cell that points at it and rerun the index script.

The preview runtime now expects title cards, timeout cards, HUD text, and countdown numerals to come from PNG assets instead of Pixi text rendering.

## Regeneration flow

```bash
npm run generate:sample-assets
npm run build:sample-workbook
npm run build:index
```

`npm run dev` and `npm run build` already run those steps for the sample project.

## Index contents

`project-index.json` includes:

- `stepCount`
- `steps[]`
- `resources.backgroundImages`
- `resources.uiImages`
- `resources.effectImages`
- `resources.backgroundVideos`
- `resources.bgm`
- `resources.sfx`
- `replaceableFiles[]`

The runtime uses that index to validate workbook paths and to expose a plain list of swappable sample files.
