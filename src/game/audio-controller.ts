import type { GameLevel } from "./types";

const BGM_VOLUME = 0.34;
const SUCCESS_VOLUME = 0.82;
const FAIL_VOLUME = 0.72;
const FANFARE_VOLUME = 0.24;

export class GameAudioController {
  private readonly bgm = new Audio();
  private audioContext: AudioContext | null = null;
  private currentBgmSrc = "";
  private readonly availableBgmSet: Set<string>;

  constructor(
    private readonly successSound: string,
    private readonly failSound: string,
    private readonly bgmTracks: string[],
  ) {
    this.availableBgmSet = new Set(bgmTracks);
    this.bgm.loop = true;
    this.bgm.preload = "auto";
    this.bgm.volume = BGM_VOLUME;
  }

  async startLevel(level: GameLevel): Promise<void> {
    await this.playBgm(this.resolveLevelBgm(level.bgmTrack));
  }

  stopBgm(): void {
    this.bgm.pause();
  }

  playSuccess(): void {
    this.playOneShot(this.successSound, SUCCESS_VOLUME);
  }

  playFail(): void {
    this.playOneShot(this.failSound, FAIL_VOLUME);
  }

  playFanfare(): void {
    const context = this.getAudioContext();
    if (!context) {
      return;
    }

    const startAt = context.currentTime + 0.02;
    const notes = [
      { delay: 0, frequency: 523.25, duration: 0.18 },
      { delay: 0.12, frequency: 659.25, duration: 0.18 },
      { delay: 0.24, frequency: 783.99, duration: 0.22 },
      { delay: 0.42, frequency: 1046.5, duration: 0.34 },
      { delay: 0.42, frequency: 1318.51, duration: 0.34 },
      { delay: 0.72, frequency: 987.77, duration: 0.22 },
      { delay: 0.86, frequency: 1318.51, duration: 0.48 },
      { delay: 0.86, frequency: 1567.98, duration: 0.48 },
    ];

    for (const note of notes) {
      this.playTone(context, startAt + note.delay, note.frequency, note.duration);
    }
  }

  private async playBgm(src: string): Promise<void> {
    if (!src) {
      return;
    }

    if (this.currentBgmSrc !== src) {
      this.currentBgmSrc = src;
      this.bgm.src = src;
      this.bgm.currentTime = 0;
    }

    this.bgm.volume = BGM_VOLUME;
    try {
      await this.bgm.play();
    } catch {
      // Keep gameplay flowing if a browser blocks audio.
    }
  }

  private resolveLevelBgm(levelBgmTrack: string): string {
    if (!this.bgmTracks.length) {
      return levelBgmTrack;
    }

    if (levelBgmTrack && this.availableBgmSet.has(levelBgmTrack)) {
      return levelBgmTrack;
    }

    return this.randomBgmTrack();
  }

  private randomBgmTrack(): string {
    const nextCandidates = this.bgmTracks.filter((track) => track !== this.currentBgmSrc);
    const candidates = nextCandidates.length ? nextCandidates : this.bgmTracks;
    const index = Math.floor(Math.random() * candidates.length);
    return candidates[index] ?? "";
  }

  private playOneShot(src: string, volume: number): void {
    if (!src) {
      return;
    }

    const sound = new Audio(src);
    sound.preload = "auto";
    sound.volume = volume;
    void sound.play().catch(() => {
      // Sound effects are optional; blocked playback should not interrupt the game.
    });
  }

  private getAudioContext(): AudioContext | null {
    const AudioContextConstructor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextConstructor) {
      return null;
    }

    this.audioContext ??= new AudioContextConstructor();
    if (this.audioContext.state === "suspended") {
      void this.audioContext.resume().catch(() => undefined);
    }

    return this.audioContext;
  }

  private playTone(context: AudioContext, startAt: number, frequency: number, duration: number): void {
    const oscillator = context.createOscillator();
    const gain = context.createGain();

    oscillator.type = "triangle";
    oscillator.frequency.setValueAtTime(frequency, startAt);
    oscillator.frequency.exponentialRampToValueAtTime(frequency * 1.02, startAt + duration);

    gain.gain.setValueAtTime(0.001, startAt);
    gain.gain.exponentialRampToValueAtTime(FANFARE_VOLUME, startAt + 0.025);
    gain.gain.exponentialRampToValueAtTime(0.001, startAt + duration);

    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start(startAt);
    oscillator.stop(startAt + duration + 0.03);
  }
}
