import { batch, signal, type ReadonlySignal, type Signal } from '../core/signal';
import { activeCues, parseVtt, type VttCue } from './captions/vtt';
import { Emitter } from './emitter';
import { DashEngine, type DashOptions } from './engines/dash/dash-engine';
import type { Engine, EngineCallbacks, EngineFactory } from './engines/engine';
import { HlsJsEngine, hasHlsJs } from './engines/hlsjs';
import { NativeEngine, canPlayNativeHls } from './engines/native';
import { loadPrefs, savePref, type PlayerPrefs } from './prefs';
import { spriteStoryboard, vttStoryboard, type Storyboard, type StoryboardFrame } from './storyboard';
import {
  PlayerState,
  type AudioTrack,
  type CaptionSettings,
  type CaptionTrack,
  type CueRange,
  type LiveMode,
  type PlayerErrorInfo,
  type PlayerEvents,
  type PlayerStats,
  type QualityLevel,
  type SqueezebackRect,
  type StreamType,
  type TimeRange,
  type VideoSource,
} from './types';

/*
 * Player: the playback API the UI talks to.
 *
 * Shaped after the IFrame-style player API (loadVideoById/cueVideoById,
 * playVideo/pauseVideo/seekTo, getPlayerState with -1/0/1/2/3/5, quality and
 * caption control, cue ranges, playlists with auto-advance, storyboards,
 * stats for nerds, squeezeback), with readable names. Every piece of state is
 * also a signal, so components re-render from `useSignalValue(player.state)`
 * without wiring event listeners by hand.
 */

export interface PlayerOptions {
  /** Existing <video> element; one is created otherwise. */
  video?: HTMLVideoElement;
  /** Engine factories tried before the built-in ones. */
  engines?: EngineFactory[];
  dash?: DashOptions;
  /** Persist volume, rate, captions and quality cap in localStorage. Default true. */
  persistPrefs?: boolean;
  /** Pause when the page is hidden (TV home button). Default true. */
  pauseWhenHidden?: boolean;
  /** Auto-advance the playlist when an item ends. Default true. */
  autoAdvance?: boolean;
  /** Seconds of countdown before auto-advancing (0 = immediately). Default 10. */
  autoAdvanceDelay?: number;
  /** Seconds before the end where `upNext` appears when the source has no `upNextAt`. Default 20. */
  upNextLead?: number;
  /** Jump small gaps in the buffer and recover from stalls. Default true. */
  gapJumping?: boolean;
  /** Skip duplicate progress polling while the media element is sending regular time updates. Default false. */
  preferNativeTimeUpdates?: boolean;
  /** Distance (s) from the live edge still counted as "at live head". Default 10. */
  liveHeadTolerance?: number;
}

export interface UpNextInfo {
  index: number;
  source: VideoSource;
  /** Seconds left before auto-advance, or null while only suggesting. */
  countdown: number | null;
}

const RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
const PROGRESS_POLL_MS = 250;
const NATIVE_TIME_UPDATE_GRACE_MS = 300;

function detectType(source: { url: string; type?: StreamType }): StreamType {
  if (source.type && source.type !== 'auto') return source.type;
  const path = source.url.split(/[?#]/)[0].toLowerCase();
  if (path.endsWith('.mpd')) return 'dash';
  if (path.endsWith('.m3u8') || path.endsWith('.m3u')) return 'hls';
  return 'progressive';
}

export class Player {
  readonly video: HTMLVideoElement;
  readonly events = new Emitter<PlayerEvents>();

  // ---- reactive state (read in components with useSignalValue) ---------
  readonly state: Signal<PlayerState> = signal(PlayerState.UNSTARTED);
  readonly currentTime: Signal<number> = signal(0);
  readonly duration: Signal<number> = signal(0);
  /** End of the buffered range containing the playhead. */
  readonly bufferedEnd: Signal<number> = signal(0);
  readonly volume: Signal<number> = signal(100);
  readonly muted: Signal<boolean> = signal(false);
  /** The browser blocked autoplay with sound and we muted the video ourselves: not the viewer's choice, so not saved. */
  private autoplayMuted = false;
  readonly playbackRate: Signal<number> = signal(1);
  readonly qualities: Signal<QualityLevel[]> = signal([]);
  readonly quality: Signal<QualityLevel | null> = signal(null);
  /** True while adaptive switching is on. */
  readonly autoQuality: Signal<boolean> = signal(true);
  readonly audioTracks: Signal<AudioTrack[]> = signal([]);
  readonly audioTrack: Signal<AudioTrack | null> = signal(null);
  readonly captionTracks: Signal<CaptionTrack[]> = signal([]);
  readonly captionTrack: Signal<CaptionTrack | null> = signal(null);
  readonly captionSettings: Signal<CaptionSettings>;
  /** Caption cues visible right now. */
  readonly cues: Signal<VttCue[]> = signal([]);
  readonly liveMode: Signal<LiveMode> = signal('none');
  readonly seekable: Signal<TimeRange | null> = signal(null);
  readonly error: Signal<PlayerErrorInfo | null> = signal(null);
  readonly source: Signal<VideoSource | null> = signal(null);
  readonly playlist: Signal<VideoSource[]> = signal([]);
  readonly playlistIndex: Signal<number> = signal(-1);
  readonly upNext: Signal<UpNextInfo | null> = signal(null);
  readonly squeezeback: Signal<SqueezebackRect | null> = signal(null);
  readonly engineName: Signal<string> = signal('');

  private engine: Engine | null = null;
  private opts: Required<Omit<PlayerOptions, 'video' | 'engines' | 'dash'>> & PlayerOptions;
  private prefs: PlayerPrefs;
  private captionCues: VttCue[] = [];
  private captionLoad = 0;
  private cueRanges: CueRange[] = [];
  private activeRanges = new Set<string>();
  private loopRange: TimeRange | null = null;
  private storyboard: Storyboard | null = null;
  private loadToken = 0;
  private fallbackIndex = 0;
  private startedPlayback = false;
  private reloadingSource = false;
  private retryReloadPlay = false;
  private playRequested = false;
  private retryNativePlay = false;
  private shuffle = false;
  private shuffleOrder: number[] = [];
  private loop = false;
  private upNextDismissed = false;
  private countdownTimer: ReturnType<typeof setInterval> | null = null;
  private gapTimer: ReturnType<typeof setInterval> | null = null;
  private lastProgress = { time: -1, at: 0 };
  private cleanups: Array<() => void> = [];
  private destroyed = false;

  constructor(options: PlayerOptions = {}) {
    this.opts = {
      persistPrefs: true,
      pauseWhenHidden: true,
      autoAdvance: true,
      autoAdvanceDelay: 10,
      upNextLead: 20,
      gapJumping: true,
      preferNativeTimeUpdates: false,
      liveHeadTolerance: 10,
      ...options,
    };
    const video = options.video || document.createElement('video');
    video.setAttribute('playsinline', '');
    video.setAttribute('webkit-playsinline', '');
    video.preload = 'auto';
    this.video = video;
    this.prefs = loadPrefs();
    this.captionSettings = signal({ ...this.prefs.captionSettings });
    this.volume.value = this.prefs.volume;
    this.muted.value = this.prefs.muted;
    video.volume = this.prefs.volume / 100;
    video.muted = this.prefs.muted;
    this.bindVideo();
  }

  // ---- loading ---------------------------------------------------------

  /** Loads and plays a source (loadVideoById). */
  load(source: VideoSource, startTime?: number): Promise<void> {
    return this.open(source, startTime ?? source.startTime, true);
  }

  /** Loads a source without playing it; state becomes CUED (cueVideoById). */
  cue(source: VideoSource, startTime?: number): Promise<void> {
    return this.open(source, startTime ?? source.startTime, false);
  }

  /** Replaces the playlist and plays item `index`. */
  loadPlaylist(sources: VideoSource[], index = 0, startTime?: number): Promise<void> {
    this.playlist.value = sources.slice();
    this.shuffleOrder = sources.map((_, i) => i);
    if (this.shuffle) this.reshuffle(index);
    return this.playVideoAt(index, startTime);
  }

  private prepareEngineLoad(autoplay: boolean): number {
    const token = ++this.loadToken;
    this.playRequested = false;
    this.retryNativePlay = false;
    this.retryReloadPlay = false;
    this.teardownEngine();
    this.playRequested = autoplay;
    this.fallbackIndex = 0;
    this.startedPlayback = false;
    return token;
  }

  /** Reopen the current media at a position without replacing the title or controls state. */
  reloadSource(position = this.currentTime.peek(), autoplay = true): Promise<void> {
    const source = this.source.peek();
    if (!source) return Promise.resolve();
    this.reloadingSource = true;
    const token = this.prepareEngineLoad(autoplay);
    this.captionLoad++;
    batch(() => {
      this.error.value = null;
      this.currentTime.value = position;
      this.bufferedEnd.value = position;
      this.updateCues(position);
      this.setState(PlayerState.BUFFERING);
    });
    return this.startEngine(source, source, position, autoplay, token);
  }

  private async open(source: VideoSource, startTime: number | undefined, autoplay: boolean): Promise<void> {
    this.reloadingSource = false;
    const token = this.prepareEngineLoad(autoplay);
    this.upNextDismissed = false;
    this.stopCountdown();
    batch(() => {
      this.source.value = source;
      this.error.value = null;
      this.qualities.value = [];
      this.quality.value = null;
      this.audioTracks.value = [];
      this.audioTrack.value = null;
      this.captionTrack.value = null;
      this.cues.value = [];
      this.currentTime.value = startTime || 0;
      this.duration.value = 0;
      this.bufferedEnd.value = 0;
      this.liveMode.value = source.live ? 'live' : 'none';
      this.seekable.value = null;
      this.upNext.value = null;
      this.setState(PlayerState.UNSTARTED);
    });
    this.captionCues = [];
    this.activeRanges.clear();
    this.storyboard = null;
    this.events.emit('onVideoDataChange', source);
    const sidecar: CaptionTrack[] = (source.captions || []).map((c, i) => ({
      id: c.id || 'sidecar:' + i,
      lang: c.lang,
      label: c.label || c.lang,
      kind: c.kind || 'subtitles',
      origin: 'sidecar',
      url: c.url,
    }));
    this.captionTracks.value = sidecar;
    this.events.emit('onCaptionsTrackListChanged', sidecar);
    this.loadStoryboard(source);
    await this.startEngine(source, source, startTime, autoplay, token);
  }

  private async startEngine(source: VideoSource, variant: { url: string; type?: StreamType }, startTime: number | undefined, autoplay: boolean, token: number) {
    const effective: VideoSource = { ...source, url: variant.url, type: variant.type || (variant === source ? source.type : undefined) };
    let engine: Engine | null = null;
    try {
      engine = this.createEngine(effective);
      if (!engine) {
        this.fail({ code: 'unsupported', message: 'No engine can play ' + effective.url, fatal: true }, token, autoplay, startTime);
        return;
      }
      this.engine = engine;
      this.engineName.value = engine.name;
      if (this.video.playbackRate !== this.playbackRate.value) this.video.playbackRate = this.playbackRate.value;
      await engine.load(this.video, effective, startTime, this.engineCallbacks(engine, token, autoplay, startTime));
    } catch (e) {
      if (token !== this.loadToken || (engine && engine !== this.engine)) return;
      const err = e as Error & { code?: PlayerErrorInfo['code'] };
      this.fail({ code: err.code || 'manifest', message: err.message, fatal: true, cause: e }, token, autoplay, startTime);
      return;
    }
    if (token !== this.loadToken || engine !== this.engine) return;
    if (autoplay && this.playRequested) {
      this.retryReloadPlay = this.reloadingSource;
      void this.play();
    } else if (!autoplay && !this.reloadingSource) {
      this.setState(PlayerState.CUED);
    }
  }

  private createEngine(source: VideoSource): Engine | null {
    for (const f of this.opts.engines || []) {
      const e = f(source, this.video);
      if (e) return e;
    }
    const type = detectType(source);
    if (type === 'dash') return new DashEngine({ defaultBandwidth: this.prefs.bandwidth || undefined, preferredAudioLanguage: this.prefs.audioLang || undefined, ...this.opts.dash });
    if (type === 'hls') {
      if (canPlayNativeHls(this.video)) return new NativeEngine();
      if (hasHlsJs()) return new HlsJsEngine();
      return null;
    }
    return new NativeEngine();
  }

  private engineCallbacks(engine: Engine, token: number, autoplay: boolean, startTime: number | undefined): EngineCallbacks {
    const live = () => token === this.loadToken && this.engine === engine;
    let qualityReady = false;
    let audioReady = false;
    return {
      qualities: (levels) => {
        if (!live()) return;
        this.qualities.value = levels;
        if (levels.length && !qualityReady) {
          qualityReady = true;
          const cap = this.prefs.quality;
          const level = cap && levels.filter(q => q.height <= cap).sort((a, b) => b.height - a.height)[0];
          if (level) {
            engine.setQuality(level.id);
            this.autoQuality.value = false;
          }
        }
        this.events.emit('onAvailableQualityLevelsChange', levels);
      },
      quality: (level) => {
        if (!live()) return;
        this.quality.value = level;
        this.events.emit('onPlaybackQualityChange', level);
      },
      audioTracks: (tracks) => {
        if (!live()) return;
        this.audioTracks.value = tracks;
        if (tracks.length && !audioReady) {
          audioReady = true;
          const track = this.prefs.audioLang && tracks.find(a => a.lang === this.prefs.audioLang);
          if (track && this.audioTrack.peek()?.id !== track.id) engine.setAudioTrack(track.id);
        }
        this.events.emit('onAudioTracksChange', tracks);
      },
      audioTrack: (track) => {
        if (!live()) return;
        this.audioTrack.value = track;
        this.events.emit('onAudioTrackChange', track);
      },
      captionTracks: (tracks) => {
        if (!live()) return;
        const sidecar = this.captionTracks.peek().filter((t) => t.origin === 'sidecar');
        const all = sidecar.concat(tracks.filter((t) => !sidecar.some((s) => s.id === t.id)));
        this.captionTracks.value = all;
        this.events.emit('onCaptionsTrackListChanged', all);
        this.restoreCaptions();
      },
      error: (info) => live() && this.fail(info, token, autoplay, startTime),
      liveEnded: () => {
        if (!live()) return;
        this.liveMode.value = 'none';
        this.events.emit('onLiveMediaEnded');
      },
      emsg: (e) => live() && this.events.emit('onEmsg', e),
    };
  }

  /** Fatal error: try the next fallback URL if playback never started. */
  private fail(info: PlayerErrorInfo, token: number, autoplay: boolean, startTime: number | undefined) {
    if (token !== this.loadToken) return;
    const source = this.source.peek();
    if (info.fatal && source && !this.startedPlayback && source.fallbacks && this.fallbackIndex < source.fallbacks.length) {
      const next = source.fallbacks[this.fallbackIndex++];
      this.teardownEngine();
      this.startEngine(source, next, startTime, autoplay, token);
      return;
    }
    this.error.value = info;
    this.events.emit('onError', info);
    if (info.fatal) {
      this.reloadingSource = false;
      this.setState(PlayerState.UNSTARTED);
    }
  }

  private teardownEngine() {
    const engine = this.engine;
    this.engine = null;
    if (engine) {
      try {
        engine.destroy();
      } catch {
        // ignore
      }
    }
  }

  private async loadStoryboard(source: VideoSource) {
    const sb = source.storyboard;
    if (!sb) return;
    try {
      this.storyboard = typeof sb === 'string' ? await vttStoryboard(sb) : spriteStoryboard(sb);
    } catch {
      this.storyboard = null;
    }
  }

  // ---- transport -------------------------------------------------------

  async play(): Promise<void> {
    this.playRequested = true;
    this.retryNativePlay = this.engine?.name === 'native' && this.video.readyState < 3;
    const token = this.loadToken;
    const engine = this.engine;
    const current = () => !this.destroyed && token === this.loadToken && engine === this.engine;
    const fail = (error: unknown) => {
      if (!current()) return;
      const e = error as Error;
      if (e.name === 'AbortError') {
        this.resumeReloadPlayback();
        return;
      }
      this.playRequested = false;
      this.retryNativePlay = false;
      if (e.name === 'NotAllowedError') {
        this.reloadingSource = false;
        this.setState(PlayerState.PAUSED);
        return;
      }
      this.fail({ code: e.name === 'NotSupportedError' ? 'unsupported' : 'decode', message: e.message || 'Playback could not start', fatal: true, cause: e }, token, true, this.video.currentTime || undefined);
    };
    try {
      await this.video.play();
    } catch (error) {
      if (!current()) return;
      if ((error as Error).name === 'NotAllowedError' && !this.video.muted) {
        this.autoplayMuted = true;
        this.video.muted = true;
        try { await this.video.play(); } catch (retryError) { fail(retryError); }
      } else fail(error);
    }
  }

  pause(): void {
    const reloading = this.reloadingSource;
    this.reloadingSource = false;
    this.playRequested = false;
    this.retryNativePlay = false;
    this.video.pause();
    if (reloading) this.setState(PlayerState.PAUSED);
  }

  togglePlay(): void {
    if (this.video.paused || this.video.ended) this.play();
    else this.pause();
  }

  /** Stops playback and unloads the source (stopVideo). */
  stop(): void {
    this.reloadingSource = false;
    this.playRequested = false;
    this.retryNativePlay = false;
    this.loadToken++;
    this.teardownEngine();
    this.stopCountdown();
    batch(() => {
      this.source.value = null;
      this.upNext.value = null;
      this.setState(PlayerState.UNSTARTED);
    });
  }

  seekTo(time: number): void {
    const r = this.getSeekableRange();
    let t = time;
    if (r) t = Math.max(r.start, Math.min(r.end - 0.1, t));
    else if (this.duration.peek()) t = Math.max(0, Math.min(this.duration.peek() - 0.1, t));
    const from = this.video.currentTime;
    if (this.engine && this.engine.onSeek) this.engine.onSeek(t);
    this.video.currentTime = t;
    this.currentTime.value = t;
    this.events.emit('onSeek', { from, to: t });
    if (this.upNext.peek() && this.upNext.peek()!.countdown == null && !this.inUpNextWindow(t)) this.upNext.value = null;
  }

  seekBy(delta: number): void {
    this.seekTo(this.video.currentTime + delta);
  }

  seekToLiveHead(): void {
    const edge = this.engine && this.engine.liveEdge();
    if (edge != null) this.seekTo(edge);
  }

  isAtLiveHead(): boolean {
    if (this.liveMode.peek() === 'none') return false;
    const edge = this.engine && this.engine.liveEdge();
    return edge == null || edge - this.video.currentTime <= this.opts.liveHeadTolerance;
  }

  getSeekableRange(): TimeRange | null {
    return this.engine ? this.engine.seekableRange() : null;
  }

  // ---- volume / rate ---------------------------------------------------

  setVolume(volume: number): void {
    const v = Math.max(0, Math.min(100, Math.round(volume)));
    this.video.volume = v / 100;
    if (v > 0 && this.video.muted) this.video.muted = false;
  }

  mute(): void {
    this.video.muted = true;
  }

  unMute(): void {
    this.video.muted = false;
  }

  toggleMute(): void {
    this.video.muted = !this.video.muted;
  }

  setPlaybackRate(rate: number): void {
    this.video.playbackRate = rate;
  }

  getAvailablePlaybackRates(): number[] {
    return this.liveMode.peek() === 'live' ? [1] : RATES.slice();
  }

  // ---- quality / audio / captions ----------------------------------------

  /** 'auto' re-enables ABR; otherwise a QualityLevel id. */
  setPlaybackQuality(id: string | 'auto'): void {
    if (!this.engine) return;
    this.engine.setQuality(id);
    this.autoQuality.value = id === 'auto';
    const level = this.qualities.peek().find((q) => q.id === id);
    if (this.opts.persistPrefs) {
      this.prefs.quality = id === 'auto' || !level ? 0 : level.height;
      savePref('quality', this.prefs.quality);
    }
  }

  /** Limits ABR to a height range, e.g. (0, 720) on slow devices. */
  setPlaybackQualityRange(minHeight: number, maxHeight: number): void {
    if (this.engine) this.engine.setQualityRange(minHeight, maxHeight);
  }

  setAudioTrack(id: string): void {
    if (!this.engine) return;
    this.engine.setAudioTrack(id);
    const track = this.audioTracks.peek().find((t) => t.id === id) || null;
    if (track) {
      this.audioTrack.value = track;
      this.events.emit('onAudioTrackChange', track);
      if (this.opts.persistPrefs) {
        this.prefs.audioLang = track.lang;
        savePref('audioLang', track.lang);
      }
    }
  }

  /** Shows a caption track by id, or hides captions with null. */
  async setCaptionTrack(id: string | null): Promise<void> {
    const load = ++this.captionLoad;
    if (id == null) {
      this.captionTrack.value = null;
      this.captionCues = [];
      this.cues.value = [];
      this.events.emit('onCaptionsChange', null);
      this.persistCaptions(false, '');
      return;
    }
    const track = this.captionTracks.peek().find((t) => t.id === id);
    if (!track) return;
    try {
      let text: string;
      if (track.origin === 'sidecar' && track.url) {
        const res = await fetch(track.url);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        text = await res.text();
      } else if (this.engine && this.engine.loadCaptionTrack) {
        text = await this.engine.loadCaptionTrack(track.id);
      } else throw new Error('Caption track cannot be loaded');
      if (load !== this.captionLoad) return;
      this.captionCues = parseVtt(text);
      this.captionTrack.value = track;
      this.updateCues(this.video.currentTime);
      this.events.emit('onCaptionsChange', track);
      this.persistCaptions(true, track.lang);
    } catch (e) {
      if (load !== this.captionLoad) return;
      this.events.emit('onError', { code: 'network', message: 'Captions: ' + (e as Error).message, fatal: false, cause: e });
    }
  }

  private persistCaptions(on: boolean, lang: string) {
    if (!this.opts.persistPrefs) return;
    this.prefs.captionsOn = on;
    savePref('captionsOn', on);
    if (lang) {
      this.prefs.captionLang = lang;
      savePref('captionLang', lang);
    }
  }

  private restoreCaptions() {
    if (!this.prefs.captionsOn || this.captionTrack.peek()) return;
    const t = this.captionTracks.peek().find((c) => c.lang === this.prefs.captionLang) || null;
    if (t) this.setCaptionTrack(t.id);
  }

  setCaptionSettings(patch: Partial<CaptionSettings>): void {
    const next = { ...this.captionSettings.peek(), ...patch };
    this.captionSettings.value = next;
    if (this.opts.persistPrefs) savePref('captionSettings', next);
  }

  // ---- cue ranges / loop -------------------------------------------------

  addCueRange(range: CueRange): void {
    this.cueRanges = this.cueRanges.filter((r) => r.id !== range.id).concat(range);
  }

  removeCueRange(id: string): void {
    this.cueRanges = this.cueRanges.filter((r) => r.id !== id);
    this.activeRanges.delete(id);
  }

  clearCueRanges(namespace?: string): void {
    this.cueRanges = namespace ? this.cueRanges.filter((r) => r.namespace !== namespace) : [];
    if (!namespace) this.activeRanges.clear();
  }

  /** Repeats [start, end) until cleared with null. */
  setLoopRange(range: TimeRange | null): void {
    this.loopRange = range;
  }

  // ---- playlist ----------------------------------------------------------

  playVideoAt(index: number, startTime?: number): Promise<void> {
    const list = this.playlist.peek();
    if (index < 0 || index >= list.length) return Promise.resolve();
    this.playlistIndex.value = index;
    this.events.emit('onPlaylistChange', { index, length: list.length });
    return this.load(list[index], startTime);
  }

  private nextIndex(): number {
    const list = this.playlist.peek();
    const i = this.playlistIndex.peek();
    if (!list.length) return -1;
    if (this.shuffle) {
      const pos = this.shuffleOrder.indexOf(i);
      const n = pos + 1 < this.shuffleOrder.length ? this.shuffleOrder[pos + 1] : this.loop ? this.shuffleOrder[0] : -1;
      return n;
    }
    if (i + 1 < list.length) return i + 1;
    return this.loop ? 0 : -1;
  }

  private previousIndex(): number {
    const list = this.playlist.peek();
    const i = this.playlistIndex.peek();
    if (this.shuffle) {
      const pos = this.shuffleOrder.indexOf(i);
      return pos > 0 ? this.shuffleOrder[pos - 1] : this.loop ? this.shuffleOrder[this.shuffleOrder.length - 1] : -1;
    }
    if (i > 0) return i - 1;
    return this.loop && list.length ? list.length - 1 : -1;
  }

  hasNext(): boolean {
    return this.nextIndex() >= 0;
  }

  hasPrevious(): boolean {
    return this.previousIndex() >= 0;
  }

  nextVideo(): Promise<void> {
    const n = this.nextIndex();
    return n >= 0 ? this.playVideoAt(n) : Promise.resolve();
  }

  /** Restarts the current item if more than 3 s in, otherwise goes back one. */
  previousVideo(): Promise<void> {
    if (this.video.currentTime > 3 && this.liveMode.peek() === 'none') {
      this.seekTo(0);
      return Promise.resolve();
    }
    const p = this.previousIndex();
    return p >= 0 ? this.playVideoAt(p) : Promise.resolve();
  }

  setShuffle(on: boolean): void {
    this.shuffle = on;
    if (on) this.reshuffle(this.playlistIndex.peek());
  }

  setLoop(on: boolean): void {
    this.loop = on;
  }

  private reshuffle(current: number) {
    const rest = this.playlist.peek().map((_, i) => i).filter((i) => i !== current);
    for (let i = rest.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [rest[i], rest[j]] = [rest[j], rest[i]];
    }
    this.shuffleOrder = current >= 0 ? [current, ...rest] : rest;
  }

  /** Hides "Up next" for the current item. */
  dismissUpNext(): void {
    this.upNextDismissed = true;
    this.stopCountdown();
    this.upNext.value = null;
  }

  /** Skips the countdown and plays the next item now. */
  playUpNext(): Promise<void> {
    this.stopCountdown();
    this.upNext.value = null;
    return this.nextVideo();
  }

  private inUpNextWindow(time: number): boolean {
    const src = this.source.peek();
    const d = this.duration.peek();
    if (!src || !d || !isFinite(d) || this.liveMode.peek() !== 'none') return false;
    const at = src.upNextAt != null ? src.upNextAt : d - this.opts.upNextLead;
    return time >= at && time < d;
  }

  private updateUpNext(time: number) {
    if (this.upNextDismissed || this.countdownTimer) return;
    const n = this.nextIndex();
    if (n < 0) return;
    const show = this.inUpNextWindow(time);
    const cur = this.upNext.peek();
    if (show && !cur) this.upNext.value = { index: n, source: this.playlist.peek()[n], countdown: null };
    else if (!show && cur && cur.countdown == null) this.upNext.value = null;
  }

  private onEnded() {
    const n = this.nextIndex();
    if (!this.opts.autoAdvance || n < 0 || this.upNextDismissed) return;
    if (this.opts.autoAdvanceDelay <= 0) {
      this.playVideoAt(n);
      return;
    }
    let left = this.opts.autoAdvanceDelay;
    this.upNext.value = { index: n, source: this.playlist.peek()[n], countdown: left };
    this.countdownTimer = setInterval(() => {
      left--;
      if (left <= 0) {
        this.playUpNext();
        return;
      }
      this.upNext.value = { index: n, source: this.playlist.peek()[n], countdown: left };
    }, 1000);
  }

  private stopCountdown() {
    if (this.countdownTimer) clearInterval(this.countdownTimer);
    this.countdownTimer = null;
  }

  // ---- storyboard / stats / layout ---------------------------------------

  getStoryboardFrame(time: number): StoryboardFrame | null {
    return this.storyboard ? this.storyboard.frameAt(time) : null;
  }

  hasStoryboard(): boolean {
    return !!this.storyboard;
  }

  getStatsForNerds(): PlayerStats {
    const v = this.video;
    const q = (v as HTMLVideoElement & { getVideoPlaybackQuality?: () => VideoPlaybackQuality }).getVideoPlaybackQuality;
    const pq = q ? q.call(v) : null;
    const s = this.engine ? this.engine.stats() : { bandwidth: 0, bitrate: 0, codecs: '', liveLatency: null };
    const level = this.quality.peek();
    const src = this.source.peek();
    return {
      engine: this.engine ? this.engine.name : '-',
      videoId: (src && src.id) || '-',
      url: src ? src.url : '-',
      resolution: v.videoWidth ? `${v.videoWidth}x${v.videoHeight}` : '-',
      viewport: `${v.clientWidth}x${v.clientHeight}`,
      quality: level ? level.label + (this.autoQuality.peek() ? ' (auto)' : '') : '-',
      bitrateKbps: Math.round((s.bitrate || (level ? level.bitrate : 0)) / 1000),
      bandwidthKbps: Math.round(s.bandwidth / 1000),
      bufferHealth: Math.max(0, this.bufferedEnd.peek() - v.currentTime),
      droppedFrames: pq ? pq.droppedVideoFrames : 0,
      totalFrames: pq ? pq.totalVideoFrames : 0,
      codecs: s.codecs || (level && level.codecs) || '-',
      liveLatency: s.liveLatency,
      volume: `${Math.round(v.volume * 100)}%${v.muted ? ' (muted)' : ''}`,
      playbackRate: v.playbackRate,
      state: PlayerState[this.state.peek()],
    };
  }

  /** Shrinks the video into `rect` (fractions of the player) or restores it. */
  setSqueezeback(rect: SqueezebackRect | null): void {
    this.squeezeback.value = rect;
    this.events.emit('onSqueezebackChange', rect);
  }

  getState(): PlayerState {
    return this.state.peek();
  }

  on<K extends keyof PlayerEvents>(event: K, fn: (payload: PlayerEvents[K]) => void): () => void {
    return this.events.on(event, fn);
  }

  // ---- video element wiring ----------------------------------------------

  private setState(s: PlayerState) {
    if (this.state.peek() === s) return;
    this.state.value = s;
    this.events.emit('onStateChange', s);
  }

  private markPlaying() {
    this.reloadingSource = false;
    this.startedPlayback = true;
    this.retryNativePlay = false;
    this.setState(PlayerState.PLAYING);
  }

  private resumeReloadPlayback() {
    const v = this.video;
    if (!this.reloadingSource || !this.retryReloadPlay || !this.playRequested
        || !v.paused || v.ended || v.seeking || v.readyState < 2 || v.error) return;
    this.retryReloadPlay = false;
    void this.play();
  }

  private bindVideo() {
    const v = this.video;
    const on = (type: string, fn: () => void) => {
      v.addEventListener(type, fn);
      this.cleanups.push(() => v.removeEventListener(type, fn));
    };
    on('playing', () => {
      if (!this.reloadingSource) this.markPlaying();
    });
    on('canplay', () => {
      if (this.reloadingSource) {
        this.resumeReloadPlayback();
        return;
      }
      // Some TV engines ignore an early play() call and return no promise.
      if (this.retryNativePlay && this.playRequested && !this.startedPlayback && v.paused && this.source.peek()) {
        this.retryNativePlay = false;
        void this.play();
      }
    });
    on('play', () => this.state.peek() !== PlayerState.PLAYING && v.readyState < 3 && this.setState(PlayerState.BUFFERING));
    on('pause', () => {
      if (this.reloadingSource) this.resumeReloadPlayback();
      else if (v.paused && !v.ended) this.setState(PlayerState.PAUSED);
    });
    on('waiting', () => !v.paused && this.setState(PlayerState.BUFFERING));
    on('seeking', () => !v.paused && this.setState(PlayerState.BUFFERING));
    const readyAfterReload = () => {
      if (!this.reloadingSource || this.playRequested || v.seeking || v.readyState < 2) return false;
      this.reloadingSource = false;
      this.setState(PlayerState.CUED);
      return true;
    };
    on('loadeddata', readyAfterReload);
    on('seeked', () => {
      this.resumeReloadPlayback();
      if (readyAfterReload() || this.reloadingSource) return;
      this.setState(v.paused ? PlayerState.PAUSED : v.readyState >= 3 ? PlayerState.PLAYING : PlayerState.BUFFERING);
    });
    on('canplay', () => {
      if (readyAfterReload() || this.reloadingSource) return;
      if (this.state.peek() === PlayerState.BUFFERING && !v.paused) this.setState(PlayerState.PLAYING);
    });
    on('ended', () => {
      this.setState(PlayerState.ENDED);
      this.onEnded();
    });
    on('loadedmetadata', () => {
      this.updateDuration();
      this.events.emit('onReady');
    });
    on('durationchange', () => this.updateDuration());
    let lastNativeTimeUpdate = -Infinity;
    on('timeupdate', () => {
      if (this.opts.preferNativeTimeUpdates) lastNativeTimeUpdate = Date.now();
      this.onTime();
    });
    on('progress', () => this.updateBuffered());
    on('volumechange', () => {
      const volume = Math.round(v.volume * 100);
      batch(() => {
        this.volume.value = volume;
        this.muted.value = v.muted;
      });
      this.events.emit('onVolumeChange', { volume, muted: v.muted });
      if (!v.muted) this.autoplayMuted = false;
      if (this.opts.persistPrefs) {
        savePref('volume', volume);
        // The fallback mute after a blocked autoplay must not become the saved setting.
        if (!this.autoplayMuted) savePref('muted', v.muted);
      }
    });
    on('ratechange', () => {
      this.playbackRate.value = v.playbackRate;
      this.events.emit('onPlaybackRateChange', v.playbackRate);
      if (this.opts.persistPrefs) savePref('playbackRate', v.playbackRate);
    });
    on('error', () => {
      const me = v.error;
      if (!me || !this.source.peek()) return;
      const code: PlayerErrorInfo['code'] = me.code === 2 ? 'network' : me.code === 3 ? 'decode' : me.code === 4 ? 'unsupported' : me.code === 1 ? 'aborted' : 'unknown';
      this.fail({ code, message: me.message || 'Media error ' + me.code, fatal: true }, this.loadToken, true, this.video.currentTime || undefined);
    });

    if (this.opts.pauseWhenHidden && typeof document !== 'undefined') {
      const onVis = () => {
        if (document.hidden && (this.playRequested || !v.paused)) this.pause();
      };
      document.addEventListener('visibilitychange', onVis);
      this.cleanups.push(() => document.removeEventListener('visibilitychange', onVis));
    }
    // Some TV engines either repeat or stop sending timeupdate; keep polling as a fallback.
    this.gapTimer = setInterval(() => {
      if (!v.paused && (!this.opts.preferNativeTimeUpdates || Date.now() - lastNativeTimeUpdate >= NATIVE_TIME_UPDATE_GRACE_MS)) {
        this.onTime();
      }
      if (this.opts.gapJumping && !this.reloadingSource) this.checkStall();
    }, PROGRESS_POLL_MS);
  }

  private updateDuration() {
    if (this.reloadingSource && this.video.readyState === 0) return;
    const engine = this.engine;
    const live = (engine && engine.isLive()) || this.video.duration === Infinity || !!(this.source.peek() && this.source.peek()!.live);
    const range = engine ? engine.seekableRange() : null;
    batch(() => {
      this.duration.value = live ? (range ? range.end : 0) : isFinite(this.video.duration) ? this.video.duration : 0;
      this.seekable.value = range;
      this.liveMode.value = live ? (range && range.end - range.start > 60 ? 'dvr' : 'live') : 'none';
    });
    this.events.emit('onLoadProgress', this.bufferedEnd.peek());
  }

  private updateBuffered(time = this.video.currentTime) {
    const b = this.video.buffered;
    let end = 0;
    for (let i = 0; i < b.length; i++) {
      const rangeEnd = b.end(i);
      if (time >= b.start(i) - 0.2 && time <= rangeEnd) end = rangeEnd;
    }
    this.bufferedEnd.value = end;
    this.events.emit('onLoadProgress', end);
  }

  private onTime() {
    const t = this.video.currentTime;
    if (this.reloadingSource) {
      // A decoder can emit playing for the first frame before the resume seek settles.
      if (!this.playRequested || this.video.paused || this.video.seeking || this.video.readyState < 2
          || t <= this.currentTime.peek() + 0.25) return;
      this.markPlaying();
    }
    if (this.loopRange && t >= this.loopRange.end) {
      this.seekTo(this.loopRange.start);
      return;
    }
    batch(() => {
      this.currentTime.value = t;
      if (this.liveMode.peek() !== 'none' && this.engine) {
        const r = this.engine.seekableRange();
        this.seekable.value = r;
        if (r) this.duration.value = r.end;
      }
      this.updateBuffered(t);
      this.updateCues(t);
      this.updateUpNext(t);
    });
    this.updateCueRanges(t);
    this.events.emit('onVideoProgress', t);
  }

  private updateCues(t: number) {
    if (!this.captionCues.length) {
      if (this.cues.peek().length) this.cues.value = [];
      return;
    }
    const next = activeCues(this.captionCues, t);
    const prev = this.cues.peek();
    if (next.length !== prev.length || next.some((c, i) => c !== prev[i])) this.cues.value = next;
  }

  private updateCueRanges(t: number) {
    for (const r of this.cueRanges) {
      const inside = t >= r.start && t < r.end;
      const was = this.activeRanges.has(r.id);
      if (inside && !was) {
        this.activeRanges.add(r.id);
        this.events.emit('onCueRangeEnter', r);
      } else if (!inside && was) {
        this.activeRanges.delete(r.id);
        this.events.emit('onCueRangeExit', r);
      }
    }
  }

  /**
   * Gap jumper: when playback should be running but the clock has not moved
   * for a second and the next buffered range starts within 2 s, jump into it.
   */
  private checkStall() {
    const v = this.video;
    if (v.paused || v.ended || v.seeking || !this.source.peek()) {
      this.lastProgress = { time: v.currentTime, at: Date.now() };
      return;
    }
    if (v.currentTime !== this.lastProgress.time) {
      this.lastProgress = { time: v.currentTime, at: Date.now() };
      return;
    }
    if (Date.now() - this.lastProgress.at < 1000) return;
    const b = v.buffered;
    for (let i = 0; i < b.length; i++) {
      const gap = b.start(i) - v.currentTime;
      if (gap > 0 && gap < 2) {
        v.currentTime = b.start(i) + 0.05;
        this.lastProgress = { time: v.currentTime, at: Date.now() };
        return;
      }
    }
    // Live at the edge with nothing ahead: nudge back into the window.
    if (this.liveMode.peek() !== 'none' && this.engine && Date.now() - this.lastProgress.at > 4000) {
      const edge = this.engine.liveEdge();
      if (edge != null && Math.abs(edge - v.currentTime) > 2) {
        this.seekTo(edge);
        this.lastProgress = { time: v.currentTime, at: Date.now() };
      }
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.loadToken++;
    this.teardownEngine();
    this.stopCountdown();
    if (this.gapTimer) clearInterval(this.gapTimer);
    for (const c of this.cleanups) c();
    this.cleanups = [];
    this.events.removeAll();
  }
}

export type { ReadonlySignal };
