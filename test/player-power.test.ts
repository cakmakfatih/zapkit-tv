import { tick } from './setup';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { h, render, flushSync, useSignalValue, FocusManager } from '../src/index';
import { Player, PlayerState, VideoPlayer } from '../src/player/index';

function mount(unmountHiddenControls: boolean, options: Record<string, unknown> = {}) {
  const root = document.createElement('div');
  document.body.appendChild(root);
  const manager = new FocusManager({ autoFocusFirst: false, pointer: false }).start(document.body);
  const player = new Player({ persistPrefs: false });
  player.state.value = PlayerState.PLAYING;
  player.duration.value = 120;
  player.currentTime.value = 30;
  player.video.currentTime = 30;
  let extraRenders = 0;
  function Extra() {
    const time = useSignalValue(player.currentTime);
    extraRenders++;
    return h('span', { id: 'app-time' }, String(time));
  }
  const { initialFocus, ...playerOptions } = options;
  if (initialFocus) manager.focus(initialFocus as Element);
  flushSync(() => render(h(VideoPlayer, {
    player, focusManager: manager, unmountHiddenControls, ...playerOptions,
    extraControls: h(Extra, {}),
  } as any), root));
  return {
    root, player, manager,
    renders: () => extraRenders,
    close: () => { flushSync(() => render(null, root)); manager.stop(); player.destroy(); root.remove(); },
  };
}

test('low-power OSD unsubscribes hidden controls and restores current values on reveal', async () => {
  const f = mount(true);
  try {
    await tick();
    const visibleSubscriptions = (f.player.currentTime as any).subs.size;
    flushSync(() => { f.manager.dispatchKey('info'); });
    const hiddenSubscriptions = (f.player.currentTime as any).subs.size;
    const before = f.renders();
    for (let time = 31; time < 51; time++) flushSync(() => { f.player.currentTime.value = time; });
    console.log(JSON.stringify({ visibleSubscriptions, hiddenSubscriptions, hiddenExtraRenders: f.renders() - before }));
    assert.equal(!!f.root.querySelector('.kb-progress'), false);
    assert.equal(f.renders(), before, 'app-provided controls must not render while hidden');
    assert.equal(hiddenSubscriptions, 0);
    flushSync(() => { f.player.cues.value = [{ id: 'cue', start: 0, end: 100, text: 'Subtitle', settings: {} }]; });
    assert.match(f.root.querySelector('.kb-captions')!.textContent!, /Subtitle/);
    flushSync(() => { f.manager.dispatchKey('info'); });
    assert.equal(f.root.querySelector('.kb-progress')?.getAttribute('aria-valuenow'), '50');
    assert.equal(f.root.querySelector('#app-time')?.textContent, '50');
    assert.equal((f.player.currentTime as any).subs.size, visibleSubscriptions);
  } finally { f.close(); }
});

test('modern OSD retains the existing mounted controls behavior', async () => {
  const f = mount(false);
  try {
    await tick();
    flushSync(() => { f.manager.dispatchKey('info'); });
    assert.ok(f.root.querySelector('.kb-osd--hidden .kb-progress'));
    flushSync(() => { f.player.currentTime.value = 70; });
    assert.equal(f.root.querySelector('#app-time')?.textContent, '70');
  } finally { f.close(); }
});

for (const lowPower of [false, true]) test(`app dialog keeps player focus and controls while open (lowPower=${lowPower})`, async () => {
  const f = mount(lowPower, { osdTimeout: 80 });
  const modal = document.createElement('div');
  modal.className = 'kb-overlay';
  modal.setAttribute('data-kb-group', JSON.stringify({ trap: true }));
  const dialog = document.createElement('button');
  dialog.setAttribute('data-kb-focusable', '');
  modal.appendChild(dialog);
  document.body.appendChild(modal);
  try {
    await new Promise(resolve => setTimeout(resolve, 30));
    f.manager.focus(dialog);
    await new Promise(resolve => setTimeout(resolve, 120));
    flushSync();
    assert.equal(!!f.root.querySelector('.kb-osd--hidden'), false);
    assert.equal(!!f.root.querySelector('.kb-progress'), true);
    for (const key of ['up', 'info', 'audio', 'subtitle'] as const) flushSync(() => { f.manager.dispatchKey(key); });
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(f.manager.current, dialog);
    assert.equal(!!f.root.querySelector('.kb-osd--hidden'), false);
    assert.equal(!!f.root.querySelector('.kb-settings'), false);
    f.manager.focusById('kb-player-play');
    await new Promise(resolve => setTimeout(resolve, 120));
    flushSync();
    assert.equal(!!f.root.querySelector('.kb-osd--hidden'), true);
  } finally { modal.remove(); f.close(); }
});

test('a retained non-dialog focus target does not prevent initial player focus', async () => {
  const previous = document.createElement('button');
  document.body.appendChild(previous);
  const f = mount(true, { initialFocus: previous });
  try {
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(f.manager.current?.getAttribute('data-focus-id'), 'kb-player-play');
  } finally { previous.remove(); f.close(); }
});

test('low-power OSD preserves the first seek key and restores progress focus', async () => {
  const f = mount(true);
  try {
    await new Promise(resolve => setTimeout(resolve, 30));
    flushSync(() => { f.manager.dispatchKey('info'); });
    assert.ok(f.root.querySelector('.kb-osd--hidden'));
    flushSync(() => { f.manager.dispatchKey('right'); });
    await new Promise(resolve => setTimeout(resolve, 30));
    flushSync();
    assert.equal(f.manager.current?.getAttribute('data-focus-id'), 'kb-player-progress');
    assert.equal(f.root.querySelector('.kb-progress')?.getAttribute('aria-valuenow'), '40');
    f.manager.dispatchKey('enter');
    assert.equal(f.player.video.currentTime, 40);
  } finally { f.close(); }
});

test('rapid seek taps use the configured jump from the third tap and reset on a direction change', async () => {
  const f = mount(false, { seekBurstStep: 30 });
  try {
    await new Promise(resolve => setTimeout(resolve, 30));
    f.manager.focusById('kb-player-progress');
    const preview = () => f.root.querySelector('.kb-progress')?.getAttribute('aria-valuenow');
    flushSync(() => { f.manager.dispatchKey('right'); });
    assert.equal(preview(), '40');
    flushSync(() => { f.manager.dispatchKey('right'); f.manager.dispatchKey('right'); });
    assert.equal(preview(), '80');
    flushSync(() => { f.manager.dispatchKey('left'); });
    assert.equal(preview(), '70');
    flushSync(() => { f.manager.dispatchKey('enter'); });
    assert.equal(f.player.video.currentTime, 70);
    flushSync(() => { f.manager.dispatchKey('left'); });
    assert.equal(preview(), '60');
  } finally { f.close(); }
});

test('a renewed media connection keeps the same video and visible controls', async () => {
  const f = mount(true, { osdTimeout: 1000 });
  try {
    await tick();
    const video = f.player.video;
    video.load = () => {};
    video.play = () => Promise.resolve();
    f.player.source.value = { url: 'https://media.example/video.mp4' };
    const controls = f.root.querySelector('.kb-osd__bottom');
    await f.player.reloadSource(30);
    video.dispatchEvent(new window.Event('pause'));
    flushSync();
    assert.equal(f.root.querySelector('video'), video);
    assert.equal(f.root.querySelector('.kb-osd__bottom'), controls);
    assert.equal(f.player.getState(), PlayerState.BUFFERING);
  } finally { f.close(); }
});
