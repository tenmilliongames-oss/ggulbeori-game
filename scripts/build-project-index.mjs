import fs from "node:fs/promises";
import path from "node:path";

const projectName = process.argv[2] ?? "sample";
const projectRoot = path.resolve("public", "projects", projectName);
const resourceRoot = path.join(projectRoot, "resources");
const defaultStyleId = "default";

async function listFiles(relativeDir, extensions) {
  const dir = path.join(resourceRoot, relativeDir);

  async function visit(currentDir, relativePrefix) {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    const files = [];

    for (const entry of entries) {
      if (entry.isDirectory()) {
        files.push(...(await visit(path.join(currentDir, entry.name), path.join(relativePrefix, entry.name))));
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      if (!extensions.includes(path.extname(entry.name).toLowerCase())) {
        continue;
      }

      const normalized = path.join(relativeDir, relativePrefix, entry.name).replaceAll("\\", "/");
      files.push({
        fileName: entry.name,
        relativePath: `resources/${normalized}`,
        publicPath: `/projects/${projectName}/resources/${normalized}`,
      });
    }

    return files;
  }

  try {
    const files = await visit(dir, "");
    return files.sort((a, b) => a.relativePath.localeCompare(b.relativePath, "en"));
  } catch {
    return [];
  }
}

function publicResourcePath(relativePath) {
  return `/projects/${projectName}/resources/${relativePath.replaceAll("\\", "/")}`;
}

function buildStepEntries(puzzleFiles, thumbnailDir) {
  const stepMap = new Map();

  for (const file of puzzleFiles) {
    const baseName = path.basename(file.fileName, path.extname(file.fileName));
    const match = baseName.match(/^(\d+)(?:-(\d+))?$/);
    if (!match) {
      continue;
    }

    const step = Number(match[1]);
    const variant = Number(match[2] ?? "0");
    const entry = stepMap.get(step) ?? { step, variants: new Map() };
    entry.variants.set(variant, file.publicPath);
    stepMap.set(step, entry);
  }

  return [...stepMap.values()]
    .sort((a, b) => a.step - b.step)
    .map((entry) => {
      const variants = [...entry.variants.entries()].sort((a, b) => a[0] - b[0]);
      const leftImage = entry.variants.get(0) ?? variants[0]?.[1] ?? "";
      const rightImage = entry.variants.get(1) ?? variants[1]?.[1] ?? leftImage;

      return {
        step: entry.step,
        leftImage,
        rightImage,
        thumbnailImage: publicResourcePath(path.join(thumbnailDir, `level-${entry.step}.webp`)),
        variants: variants.map(([, assetPath]) => assetPath),
      };
    });
}

async function buildStepIndexFromDir(puzzleDir, thumbnailDir) {
  const puzzleFiles = await listFiles(puzzleDir, [".webp"]);
  return buildStepEntries(puzzleFiles, thumbnailDir);
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function readJsonIfExists(targetPath) {
  try {
    return JSON.parse(await fs.readFile(targetPath, "utf8"));
  } catch {
    return {};
  }
}

async function listStyleDirs() {
  const stylesRoot = path.join(resourceRoot, "styles");
  try {
    const entries = await fs.readdir(stylesRoot, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name, "en"));
  } catch {
    return [];
  }
}

function resolveStyleResource(styleId, resourcePath) {
  if (!resourcePath) {
    return "";
  }

  if (resourcePath.startsWith("/")) {
    return resourcePath;
  }

  return publicResourcePath(path.join("styles", styleId, resourcePath));
}

async function buildStyles(defaultSteps) {
  const styles = [];
  if (defaultSteps.length) {
    styles.push({
      id: defaultStyleId,
      name: "기본 스타일",
      order: 0,
      coverImage: defaultSteps[0]?.thumbnailImage ?? defaultSteps[0]?.leftImage ?? "",
      stepCount: defaultSteps.length,
      steps: defaultSteps,
    });
  }

  for (const entry of await listStyleDirs()) {
    const styleId = entry.name;
    const styleRoot = path.join(resourceRoot, "styles", styleId);
    const metadata = await readJsonIfExists(path.join(styleRoot, "style.json"));
    const steps = await buildStepIndexFromDir(
      path.join("styles", styleId, "puzzles"),
      path.join("styles", styleId, "level-thumbnails"),
    );

    if (!steps.length) {
      continue;
    }

    const hasCover = await pathExists(path.join(styleRoot, "cover.webp"));
    const coverImage =
      resolveStyleResource(styleId, metadata.coverImage ?? "") ||
      (hasCover ? publicResourcePath(path.join("styles", styleId, "cover.webp")) : "") ||
      steps[0]?.thumbnailImage ||
      steps[0]?.leftImage ||
      "";

    styles.push({
      id: styleId,
      name: typeof metadata.name === "string" ? metadata.name : styleId,
      order: Number.isFinite(metadata.order) ? metadata.order : 1000,
      coverImage,
      stepCount: steps.length,
      steps,
    });
  }

  return styles
    .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name, "ko"))
    .map(({ order, ...style }) => style);
}

function toPublicPaths(files) {
  return files.map((file) => file.publicPath);
}

function toReplaceableFiles(files, category) {
  return files.map((file) => ({
    category,
    fileName: file.fileName,
    relativePath: file.relativePath,
    publicPath: file.publicPath,
  }));
}

const backgroundImages = await listFiles(path.join("images", "backgrounds"), [".png", ".jpg", ".jpeg", ".webp"]);
const uiImages = await listFiles(path.join("images", "ui"), [".png", ".jpg", ".jpeg", ".webp"]);
const effectImages = await listFiles(path.join("images", "effects"), [".png", ".jpg", ".jpeg", ".webp"]);
const backgroundVideos = await listFiles(path.join("videos", "backgrounds"), [".mp4", ".webm", ".mov"]);
const bgmTracks = await listFiles(path.join("audio", "bgm"), [".mp3", ".wav", ".ogg"]);
const sfxTracks = await listFiles(path.join("audio", "sfx"), [".mp3", ".wav", ".ogg"]);
const steps = await buildStepIndexFromDir(path.join("images", "puzzles"), path.join("images", "level-thumbnails"));
const styles = await buildStyles(steps);

const resourceIndex = {
  projectName,
  generatedAt: new Date().toISOString(),
  stepCount: steps.length,
  steps,
  styles,
  resources: {
    backgroundImages: toPublicPaths(backgroundImages),
    uiImages: toPublicPaths(uiImages),
    effectImages: toPublicPaths(effectImages),
    backgroundVideos: toPublicPaths(backgroundVideos),
    bgm: toPublicPaths(bgmTracks),
    sfx: toPublicPaths(sfxTracks),
    ui: {
      hudBar: `/projects/${projectName}/resources/images/ui/hud/hud-bar.png`,
      timerBadge: `/projects/${projectName}/resources/images/ui/hud/timer-badge.png`,
      countdownDigitsDir: `/projects/${projectName}/resources/images/ui/countdown`,
      puzzlePanelFrame: `/projects/${projectName}/resources/images/ui/panels/puzzle-panel-frame.png`,
      titleCardFrame: `/projects/${projectName}/resources/images/ui/cards/title-card-frame.png`,
      timeoutCardFrame: `/projects/${projectName}/resources/images/ui/cards/timeout-card-frame.png`,
      answerMarker: `/projects/${projectName}/resources/images/ui/markers/answer-marker.png`,
    },
  },
  replaceableFiles: [
    ...toReplaceableFiles(backgroundImages, "backgroundImage"),
    ...toReplaceableFiles(uiImages, "uiImage"),
    ...toReplaceableFiles(effectImages, "effectImage"),
    ...toReplaceableFiles(backgroundVideos, "backgroundVideo"),
    ...toReplaceableFiles(bgmTracks, "bgm"),
    ...toReplaceableFiles(sfxTracks, "sfx"),
  ],
};

await fs.mkdir(projectRoot, { recursive: true });
await fs.writeFile(
  path.join(projectRoot, "project-index.json"),
  `${JSON.stringify(resourceIndex, null, 2)}\n`,
  "utf8",
);

console.log(`Generated resource index for ${projectName}: ${steps.length} detected steps.`);
