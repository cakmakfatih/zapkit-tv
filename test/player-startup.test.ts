import { tick } from './setup';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Player, PlayerState } from '../src/player/index';
import { NativeEngine } from '../src/player/engines/native';
import type { Engine, EngineCallbacks } from '../src/player/engines/engine';

function fixture() {
  const video = document.createElement('video');
  video.load = () => {};
  video.pause = () => {};
  video.play = () => Promise.resolve();
  const engine: Engine = {
    name: 'native', load: async () => {}, destroy: () => {}, setQuality: () => {}, setQualityRange: () => {},
    setAudioTrack: () => {}, isLive: () => false, seekableRange: () => null, liveEdge: () => null,
    stats: () => ({ bandwidth: 0, bitrate: 0, codecs: '', liveLatency: null }),
  };
  const player = new Player({ video, engines: [() => engine], persistPrefs: false });
  return { video, player };
}

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
