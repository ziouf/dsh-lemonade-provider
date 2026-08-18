/**
 * Structural validation of the browser half (lib/client.js factory):
 * module-loader id, exports apply/inject, and that apply registers the
 * conversation.view "Lemonade" tab. Served bundle = verbatim copy of
 * src/client/index.js, so both are equivalent.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const file = process.argv[2] ?? 'lib/client.js';
const code = readFileSync(file, 'utf8');

const captured = {};
const sandbox = {
  window: {},
  __ModuleLoader__: { load: (spec) => { captured.id = spec.id; captured.factory = spec.factory; } },
  console,
};
sandbox.window.__ModuleLoader__ = sandbox.__ModuleLoader__;
vm.runInNewContext(code, sandbox, { filename: 'client-bundle.js' });

let passed = 0;
const eq = (a, b, label) => { assert.deepEqual(a, b, label); passed += 1; };
const ok = (c, label) => { assert.ok(c, label); passed += 1; };

eq(captured.id, 'dsh-lemonade-provider', 'loader id');
ok(typeof captured.factory === 'function', 'factory function');

const exp = captured.factory((name) => {
  if (name === 'react') return { createElement(){ return {}; }, useState(){ return [undefined, () => {}]; }, useEffect(){}, useCallback(f){ return f; } };
  throw new Error('unexpected factory require: ' + name);
});
eq(typeof exp.apply, 'function', 'apply exported');
ok(JSON.stringify(exp.inject) === JSON.stringify(['slots', 'connection']), 'inject list');

// absent services → no-op
exp.apply({ get: () => undefined });

// present services → registers conversation.view tab (with locale i18n)
let registered = null;
const registeredLocales = [];
const ctx = {
  get: (name) => {
    if (name === 'slots') {
      return {
        inject: (slot, cb) => { registered = { slot, cb }; },
        register: (opts, Component) => ({ ...opts, Component }),
      };
    }
    if (name === 'connection') {
      return { api: { settings: {}, credentials: {}, llm: {} } };
    }
    if (name === 'locale') {
      return {
        register: (ns, dict) => { registeredLocales.push({ ns, en: !!dict.en, zh: !!dict.zh }); },
        bind: (ns) => {
          const dict = { tabLabel: 'Lemonade', title: 'Lemonade Server' };
          return (key) => dict[key] || key;
        },
      };
    }
    return undefined;
  },
};
exp.apply(ctx);
ok(registered !== null, 'slots.inject called');
eq(registered.slot, 'conversation.view', 'registers conversation.view');
const options = registered.cb();
eq(options.name, 'conversation.view', 'slot name');
eq(options.id, 'lemonade', 'tab id');
eq(options.label(), 'Lemonade', 'tab label');
ok(typeof options.order === 'number', 'order numeric');
ok(typeof options.inject === 'function', 'inject face');
ok(registeredLocales.length === 1 && registeredLocales[0].ns === 'lemonade' && registeredLocales[0].en && registeredLocales[0].zh, 'locale dict registered (en + zh)');
const injected = options.inject();
ok(injected.api && typeof injected.t === 'function', 'inject face provides api + translator');

console.log('\n✓ ' + passed + ' assertions OK (client-bundle)');
