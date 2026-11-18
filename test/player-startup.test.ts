import { tick } from './setup';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Player, PlayerState, type PlayerOptions } from '../src/player/index';
import { NativeEngine } from '../src/player/engines/native';
import type { Engine, EngineCallbacks } from '../src/player/engines/engine';

function fixture(options: PlayerOptions = {}) {
  const video = document.createElement('video');
  video.load = () => {};
  video.pause = () => {};
  video.play = () => Promise.resolve();
  const engine: Engine = {
    name: 'native', load: async () => {}, destroy: () => {}, setQuality: () => {}, setQualityRange: () => {},
    setAudioTrack: () => {}, isLive: () => false, seekableRange: () => null, liveEdge: () => null,
    stats: () => ({ bandwidth: 0, bitrate: 0, codecs: '', liveLatency: null }),
  };
  const player = new Player({ video, engines: [() => engine], persistPrefs: false, ...options });
  return { video, player };
}

test('reloading the media keeps the title, seeking range and controls data', async () => {
  const opens: Array<number | undefined> = [];
  const { player, video } = fixture({ engines: [() => ({
    name: 'fixture', async load(_video, _source, position) { opens.push(position); },
    destroy() {}, setQuality() {}, setQualityRange() {}, setAudioTrack() {}, isLive: () => false,
    seekableRange: () => null, liveEdge: () => null, stats: () => ({ bandwidth: 0, bitrate: 0, codecs: '', liveLatency: null }),
  })] });
  try {
    const source = { url: 'https://media.example/video.m3u8' };
    let titleChanges = 0;
    player.on('onVideoDataChange', () => { titleChanges++; });
    await player.load(source, 20);
    player.duration.value = 100;
    player.seekable.value = { start: 0, end: 100 };
    const captions = [{ id: 'sidecar', lang: 'tr', label: 'Türkçe', origin: 'sidecar' as const, kind: 'subtitles' as const }];
    player.captionTracks.value = captions;
    player.captionTrack.value = captions[0];
    await player.reloadSource(42);
    assert.deepEqual(opens, [20, 42]);
    assert.equal(player.source.peek(), source);
    assert.equal(player.video, video);
    assert.equal(titleChanges, 1);
    assert.equal(player.duration.peek(), 100);
    assert.deepEqual(player.seekable.peek(), { start: 0, end: 100 });
    assert.equal(player.currentTime.peek(), 42);
    assert.equal(player.captionTrack.peek(), captions[0]);
    video.dispatchEvent(new window.Event('pause'));
    assert.equal(player.getState(), PlayerState.BUFFERING);
  } finally { player.destroy(); }
});

test('only the active engine applies the saved quality, even after several reconnects', async () => {
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => key === 'kb-player-quality' ? '720' : null,
  } });
  const callbacks: EngineCallbacks[] = [];
  const applied: Array<[number, string]> = [];
  const { player } = fixture({ engines: [() => {
    const instance = callbacks.length;
    return {
      name: 'fixture', async load(_v, _s, _t, cb) { callbacks.push(cb); },
      destroy() {}, setQuality(id) { applied.push([instance, id]); }, setQualityRange() {}, setAudioTrack() {},
      isLive: () => false, seekableRange: () => null, liveEdge: () => null,
      stats: () => ({ bandwidth: 0, bitrate: 0, codecs: '', liveLatency: null }),
    };
  }] });
  try {
    await player.load({ url: 'https://media.example/video.m3u8' });
    for (let i = 1; i <= 3; i++) await player.load({ url: 'https://media.example/video.m3u8' }, i);
    const levels = [{ id: 'hd', height: 720, width: 1280, bitrate: 400000, label: '720p', codecs: '' }];
    callbacks[0].qualities(levels);
    callbacks.at(-1)!.qualities(levels);
    callbacks.at(-1)!.qualities(levels);
    assert.deepEqual(applied, [[3, 'hd']]);
  } finally {
    player.destroy();
    if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});

test('low-power playback skips redundant polling and keeps a fallback when native events stop', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: 0 });
  const normal = fixture({ gapJumping: false });
  const lowPower = fixture({ gapJumping: false, preferNativeTimeUpdates: true });
  const progress = [0, 0];
  const buffers = [0, 0];
  try {
    [normal, lowPower].forEach(({ player, video }, i) => {
      Object.defineProperty(video, 'paused', { value: false });
      Object.defineProperty(video, 'buffered', { get: () => { buffers[i]++; return { length: 0 }; } });
      player.on('onVideoProgress', () => { progress[i]++; });
    });
    for (let i = 1; i <= 4; i++) {
      t.mock.timers.tick(125);
      for (const { video } of [normal, lowPower]) {
        video.currentTime = i * 0.25;
        video.dispatchEvent(new window.Event('timeupdate'));
      }
      t.mock.timers.tick(125);
    }
    assert.deepEqual(progress, [8, 4]);
    assert.deepEqual(buffers, [8, 4]);
    lowPower.video.currentTime = 1.25;
    t.mock.timers.tick(250);
    assert.equal(progress[1], 5);
    assert.equal(lowPower.player.currentTime.peek(), 1.25);
    lowPower.player.seekTo(40);
    assert.equal(lowPower.player.currentTime.peek(), 40);
  } finally {
    normal.player.destroy();
    lowPower.player.destroy();
  }
});

test('startup: legacy native playback is retried when media becomes ready', async () => {
  const { video, player } = fixture();
  let ready = false, calls = 0;
  video.play = (() => {
    calls++;
    if (ready) video.dispatchEvent(new window.Event('playing'));
  }) as typeof video.play;
  try {
    await player.load({ url: 'https://media.example/video.mkv', type: 'progressive' });
    assert.equal(calls, 1);
    ready = true;
    video.dispatchEvent(new window.Event('canplay'));
    await tick();
    assert.equal(calls, 2);
    assert.equal(player.getState(), PlayerState.PLAYING);
  } finally { player.destroy(); }
});

test('startup: readiness never resumes a source the viewer paused', async () => {
  const { video, player } = fixture();
  let calls = 0;
  video.play = (() => { calls++; }) as typeof video.play;
  try {
    await player.load({ url: 'https://media.example/video.mp4' });
    player.pause();
    video.dispatchEvent(new window.Event('canplay'));
    assert.equal(calls, 1);
  } finally { player.destroy(); }
});

test('startup: a legacy void return is valid on the muted autoplay retry', async () => {
  const { video, player } = fixture();
  let calls = 0;
  video.play = (() => ++calls === 1 ? Promise.reject(Object.assign(new Error('blocked'), { name: 'NotAllowedError' })) : undefined) as typeof video.play;
  try {
    await assert.doesNotReject(player.play());
    assert.equal(calls, 2);
    assert.equal(video.muted, true);
  } finally { player.destroy(); }
});

test('startup: unsupported playback errors are not silently swallowed', async () => {
  const { video, player } = fixture();
  video.play = () => Promise.reject(Object.assign(new Error('Unsupported media'), { name: 'NotSupportedError' }));
  try {
    await player.load({ url: 'https://media.example/video.mp4' });
    await tick();
    assert.equal(player.error.peek()?.code, 'unsupported');
  } finally { player.destroy(); }
});

test('startup: an old play rejection cannot pause the next source', async () => {
  const { video, player } = fixture();
  let rejectOld!: (error: Error) => void;
  video.play = () => new Promise<void>((_resolve, reject) => { rejectOld = reject; });
  try {
    await player.load({ url: 'https://media.example/first.mp4' });
    video.play = () => Promise.resolve();
    await player.load({ url: 'https://media.example/second.mp4' });
    video.dispatchEvent(new window.Event('playing'));
    rejectOld(Object.assign(new Error('old source'), { name: 'NotSupportedError' }));
    await tick();
    assert.equal(player.getState(), PlayerState.PLAYING);
    assert.equal(player.error.peek(), null);
  } finally { player.destroy(); }
});

test('startup: engine construction failures reach the error state', async () => {
  const video = document.createElement('video');
  video.load = () => {};
  const player = new Player({ video, persistPrefs: false, engines: [() => { throw new Error('Engine unavailable'); }] });
  try {
    await assert.doesNotReject(player.load({ url: 'https://media.example/video.mp4' }));
    assert.equal(player.error.peek()?.code, 'manifest');
  } finally { player.destroy(); }
});

test('startup: the native default playback rate is left unchanged', async () => {
  const { video, player } = fixture();
  Object.defineProperty(video, 'playbackRate', { get: () => 1, set: () => { throw new Error('Rate changes unavailable'); } });
  try {
    await assert.doesNotReject(player.load({ url: 'https://media.example/video.mp4' }));
    assert.equal(player.error.peek(), null);
  } finally { player.destroy(); }
});

function callbacks(): EngineCallbacks {
  return { qualities: () => {}, quality: () => {}, audioTracks: () => {}, audioTrack: () => {}, captionTracks: () => {}, error: () => {}, liveEnded: () => {}, emsg: () => {} };
}

test('native startup: metadata listeners exist before assigning the source', async () => {
  const { video, player } = fixture();
  const native = new NativeEngine();
  let metadata = false;
  Object.defineProperty(video, 'videoHeight', { value: 720 });
  Object.defineProperty(video, 'src', { set: () => video.dispatchEvent(new window.Event('loadedmetadata')) });
  try {
    await native.load(video, { url: 'https://media.example/video.mp4' }, undefined, {
      ...callbacks(), qualities: () => { metadata = true; },
    });
    assert.equal(metadata, true);
  } finally { native.destroy(); player.destroy(); }
});

test('native startup: destroying a source removes its pending resume seek', async () => {
  const { video, player } = fixture();
  const native = new NativeEngine();
  Object.defineProperty(video, 'duration', { value: 120 });
  try {
    await native.load(video, { url: 'https://media.example/first.mp4' }, 30, callbacks());
    native.destroy();
    video.dispatchEvent(new window.Event('loadedmetadata'));
    assert.equal(video.currentTime, 0);
  } finally { player.destroy(); }
});
