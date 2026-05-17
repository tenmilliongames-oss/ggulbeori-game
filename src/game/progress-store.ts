import type { GameStyle } from "./types";

const PROGRESS_STORAGE_KEY = "honey-spot-progress:v1";
const PROGRESS_VERSION = 1;

interface StyleProgress {
  clearedLevels: number[];
}

interface StoredProgress {
  version: number;
  styles: Record<string, StyleProgress>;
}

function createEmptyProgress(): StoredProgress {
  return {
    version: PROGRESS_VERSION,
    styles: {},
  };
}

function getDefaultStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function isStoredProgress(value: unknown): value is StoredProgress {
  if (!value || typeof value !== "object") {
    return false;
  }

  const record = value as Record<string, unknown>;
  return record.version === PROGRESS_VERSION && !!record.styles && typeof record.styles === "object";
}

function normalizeLevelList(value: unknown): number[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return Array.from(
    new Set(
      value.filter((level): level is number => Number.isInteger(level) && level > 0),
    ),
  ).sort((a, b) => a - b);
}

export class LocalProgressStore {
  private progress: StoredProgress;

  constructor(private readonly storage: Storage | null = getDefaultStorage()) {
    this.progress = this.load();
  }

  isLevelCleared(styleId: string, level: number): boolean {
    return this.getClearedLevels(styleId).has(level);
  }

  isLevelUnlocked(style: GameStyle, levelIndex: number): boolean {
    if (levelIndex <= 0) {
      return true;
    }

    const previousLevel = style.levels[levelIndex - 1];
    return previousLevel ? this.isLevelCleared(style.id, previousLevel.level) : false;
  }

  markLevelCleared(styleId: string, level: number): void {
    if (!Number.isInteger(level) || level <= 0) {
      return;
    }

    const styleProgress = this.getOrCreateStyle(styleId);
    if (!styleProgress.clearedLevels.includes(level)) {
      styleProgress.clearedLevels.push(level);
      styleProgress.clearedLevels.sort((a, b) => a - b);
      this.save();
    }
  }

  private getClearedLevels(styleId: string): Set<number> {
    const styleProgress = this.progress.styles[styleId];
    return new Set(normalizeLevelList(styleProgress?.clearedLevels));
  }

  private getOrCreateStyle(styleId: string): StyleProgress {
    this.progress.styles[styleId] ??= { clearedLevels: [] };
    return this.progress.styles[styleId];
  }

  private load(): StoredProgress {
    if (!this.storage) {
      return createEmptyProgress();
    }

    try {
      const raw = this.storage.getItem(PROGRESS_STORAGE_KEY);
      if (!raw) {
        return createEmptyProgress();
      }

      const parsed = JSON.parse(raw) as unknown;
      if (!isStoredProgress(parsed)) {
        return createEmptyProgress();
      }

      const normalized = createEmptyProgress();
      for (const [styleId, styleProgress] of Object.entries(parsed.styles)) {
        normalized.styles[styleId] = {
          clearedLevels: normalizeLevelList(styleProgress.clearedLevels),
        };
      }

      return normalized;
    } catch {
      return createEmptyProgress();
    }
  }

  private save(): void {
    if (!this.storage) {
      return;
    }

    try {
      this.storage.setItem(PROGRESS_STORAGE_KEY, JSON.stringify(this.progress));
    } catch {
      // Progress is a convenience feature; storage failures should not block play.
    }
  }
}
