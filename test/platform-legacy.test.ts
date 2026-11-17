import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const { buildSync } = createRequire(import.meta.url)('esbuild') as typeof import('esbuild');

const script = buildSync({
  entryPoints: [fileURLToPath(new URL('../src/focus/keys.ts', import.meta.url))],
  bundle: true,
  format: 'iife',
  globalName: 'PlatformKeys',
  target: 'chrome67',
  write: false,
}).outputFiles[0].text;

test('platform keys: older TV browsers without globalThis ignore unavailable Tizen APIs', () => {
  assert.doesNotThrow(() => runInNewContext(script + '; PlatformKeys.registerPlatformKeys();', {
    globalThis: undefined,
    window: {},
  }));
});

test('platform keys: older Tizen browsers register keys and exit through window APIs', () => {
  const calls: string[] = [];
  runInNewContext(script + '; PlatformKeys.registerPlatformKeys(["MediaPlay"]); PlatformKeys.exitApp();', {
    globalThis: undefined,
    window: {
      tizen: {
        tvinputdevice: { registerKey: (key: string) => calls.push(key) },
        application: { getCurrentApplication: () => ({ exit: () => calls.push('exit') }) },
      },
    },
  });
  assert.deepEqual(calls, ['MediaPlay', 'exit']);
});

test('platform exit: older plain browsers fall back to window.close', () => {
  let closed = false;
  runInNewContext(script + '; PlatformKeys.exitApp();', {
    globalThis: undefined,
    window: { close: () => { closed = true; } },
  });
  assert.equal(closed, true);
});
