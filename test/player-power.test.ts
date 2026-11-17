import { tick } from './setup';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { h, render, flushSync, useSignalValue, FocusManager } from '../src/index';
import { Player, PlayerState, VideoPlayer } from '../src/player/index';

function mount(unmountHiddenControls: boolean) {
  const root = document.createElement('div');
  document.body.appendChild(root);
  const manager = new FocusManager({ autoFocusFirst: false, pointer: false }).start(root);
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
  flushSync(() => render(h(VideoPlayer, {
    player, focusManager: manager, unmountHiddenControls,
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
