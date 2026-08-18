/**
 * Patch the vendored dsh Models UI ProviderEditor so the llm-lemonade card
 * renders a second optional "Admin API key" field (stored under the profile's
 * adminApiKeyEnv, default LEMONADE_ADMIN_API_KEY, via credentials.set).
 * Idempotent; backup on first run.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const FILE = process.argv[2] ?? '/home/cyril/.npm/_npx/1e7f6d9597241db0/node_modules/@deepseek-ai/dsh-client-ui-settings-models/lib/client.js';
const MARKER = '/* dsh-lemonade-provider: admin api key field */';
const T = '\t';
const n = (depth, s) => T.repeat(depth) + s;

const pairs = [
  [
    n(3, 'const [keyDraft, setKeyDraft] = (0, react.useState)("");') + '\n' + n(3, 'const [keyState, setKeyState] = (0, react.useState)(void 0);'),
    n(3, 'const [keyDraft, setKeyDraft] = (0, react.useState)("");') + '\n' + n(3, 'const [keyState, setKeyState] = (0, react.useState)(void 0);') + '\n' + n(3, 'const [adminKeyDraft, setAdminKeyDraft] = (0, react.useState)("");') + '\n' + n(3, 'const [adminKeyState, setAdminKeyState] = (0, react.useState)(void 0);'),
  ],
  [
    n(3, 'const keyRef = refFor(namespace, settingsPath, props.provider);'),
    n(3, 'const keyRef = refFor(namespace, settingsPath, props.provider);') + '\n' + n(3, 'const adminRef = namespace.ns === "llm-lemonade" ? (() => {') + '\n' + n(4, 'const named = (0, _deepseek_ai_dsh_client_schema_form.getPath)(namespace.value, ["adminApiKeyEnv"]);') + '\n' + n(4, 'return typeof named === "string" && named.trim().length > 0 ? named : "LEMONADE_ADMIN_API_KEY";') + '\n' + n(3, '})() : void 0;'),
  ],
  [
    n(3, '}, [api.credentials, keyRef]);'),
    n(3, '}, [api.credentials, keyRef]);') + '\n' + n(3, '/* dsh-lemonade-provider: admin api key field */') + '\n' + n(3, 'adminRef === void 0 ? void 0 : (0, react.useEffect)(() => {') + '\n' + n(4, 'let staleAdmin = false;') + '\n' + n(4, 'setAdminKeyState(void 0);') + '\n' + n(4, 'api.credentials.describe({ refs: [adminRef] }).then((response) => {') + '\n' + n(5, 'if (staleAdmin || !response.result.ok) return;') + '\n' + n(5, 'setAdminKeyState(response.result.value.credentials[adminRef]);') + '\n' + n(4, '}, () => void 0);') + '\n' + n(4, 'return () => { staleAdmin = true; };') + '\n' + n(3, '}, [api.credentials, adminRef]);'),
  ],
  [
    n(3, 'const shownKeyFailure = (props.credentialRequired === true && keyDraft.length > 0 && keyValue.length === 0 ? "keyRequired" : void 0) ?? keyFailure;'),
    n(3, 'const shownKeyFailure = (props.credentialRequired === true && keyDraft.length > 0 && keyValue.length === 0 ? "keyRequired" : void 0) ?? keyFailure;') + '\n' + n(3, 'const adminKeyValue = adminKeyDraft.trim();') + '\n' + n(3, 'const adminKeyFailure = adminRef === void 0 ? void 0 : apiKeyFailure(adminKeyDraft);'),
  ],
  [
    n(4, 'const next = layout === "pi-ai" && stringAt(draft, "apiKeyEnv") === void 0 && stringAt(fallback, "apiKeyEnv") === void 0 && keyValue.length > 0 ? (0, _deepseek_ai_dsh_client_schema_form.setPath)(draft, ["apiKeyEnv"], keyRef) : draft;'),
    n(4, 'const baseDraft = layout === "pi-ai" && stringAt(draft, "apiKeyEnv") === void 0 && stringAt(fallback, "apiKeyEnv") === void 0 && keyValue.length > 0 ? (0, _deepseek_ai_dsh_client_schema_form.setPath)(draft, ["apiKeyEnv"], keyRef) : draft;') + '\n' + n(4, 'const next = adminRef !== void 0 && adminKeyValue.length > 0 && stringAt(baseDraft, "adminApiKeyEnv") === void 0 ? (0, _deepseek_ai_dsh_client_schema_form.setPath)(baseDraft, ["adminApiKeyEnv"], adminRef) : baseDraft;'),
  ],
  [
    n(4, 'if (keyValue.length > 0) {') + '\n' + n(5, 'const stored = await api.credentials.set({') + '\n' + n(6, 'ref: keyRef,') + '\n' + n(6, 'value: keyValue') + '\n' + n(5, '});') + '\n' + n(5, 'if (!stored.result.ok) return stored.result.error.message;') + '\n' + n(4, '}') + '\n' + n(4, 'setKeyDraft("");'),
    n(4, 'if (keyValue.length > 0) {') + '\n' + n(5, 'const stored = await api.credentials.set({') + '\n' + n(6, 'ref: keyRef,') + '\n' + n(6, 'value: keyValue') + '\n' + n(5, '});') + '\n' + n(5, 'if (!stored.result.ok) return stored.result.error.message;') + '\n' + n(4, '}') + '\n' + n(4, 'if (adminRef !== void 0 && adminKeyValue.length > 0) {') + '\n' + n(5, 'const storedAdmin = await api.credentials.set({ ref: adminRef, value: adminKeyValue });') + '\n' + n(5, 'if (!storedAdmin.result.ok) return storedAdmin.result.error.message;') + '\n' + n(4, '}') + '\n' + n(4, 'setKeyDraft("");') + '\n' + n(4, 'setAdminKeyDraft("");'),
  ],
  [
    n(7, 'children: t(shownKeyFailure)') + '\n' + n(6, '})') + '\n' + n(5, ']') + '\n' + n(4, '}), props.credentialOnly === true ? null : (0, react_jsx_runtime.jsxs)("details", {'),
    n(7, 'children: t(shownKeyFailure)') + '\n' + n(6, '})') + '\n' + n(5, ']') + '\n' + n(4, '}), adminRef === void 0 ? null : (0, react_jsx_runtime.jsxs)("div", {') + '\n' + n(5, 'className: ModelsSection_module_css_default["field"],') + '\n' + n(5, 'children: [') + '\n' + n(6, '(0, react_jsx_runtime.jsx)("span", {') + '\n' + n(7, 'className: ModelsSection_module_css_default["fieldLabel"],') + '\n' + n(7, 'children: "Admin API key (optional)"') + '\n' + n(6, '}),') + '\n' + n(6, '(0, react_jsx_runtime.jsx)("input", {') + '\n' + n(7, 'className: ModelsSection_module_css_default["input"],') + '\n' + n(7, 'type: "password",') + '\n' + n(7, 'autoComplete: "off",') + '\n' + n(7, 'value: adminKeyDraft,') + '\n' + n(7, 'placeholder: adminKeyState?.configured === true ? "Admin API key stored — type to replace" : "LEMONADE_ADMIN_API_KEY",') + '\n' + n(7, '"aria-label": "Admin API key",') + '\n' + n(7, '"aria-invalid": adminKeyFailure !== void 0,') + '\n' + n(7, 'disabled,') + '\n' + n(7, 'onChange: (event) => {') + '\n' + n(8, 'setAdminKeyDraft(event.target.value);') + '\n' + n(7, '}') + '\n' + n(6, '}),') + '\n' + n(6, 'adminKeyFailure === void 0 ? null : (0, react_jsx_runtime.jsx)("p", {') + '\n' + n(7, 'className: ModelsSection_module_css_default["error"],') + '\n' + n(7, 'children: "Invalid API key format."') + '\n' + n(6, '}),') + '\n' + n(6, 'adminKeyState?.configured === true ? (0, react_jsx_runtime.jsx)("p", {') + '\n' + n(7, 'className: ModelsSection_module_css_default["hint"],') + '\n' + n(7, 'children: "Admin API key stored."') + '\n' + n(6, '}) : null') + '\n' + n(5, ']') + '\n' + n(4, '}), props.credentialOnly === true ? null : (0, react_jsx_runtime.jsxs)("details", {'),
  ],
  [
    'submitDisabled: disabled || layout === "unknown" || props.credentialOnly !== true && modelFailure !== void 0 || shownKeyFailure !== void 0 || props.credentialRequired === true && keyValue.length === 0,',
    'submitDisabled: disabled || layout === "unknown" || props.credentialOnly !== true && modelFailure !== void 0 || shownKeyFailure !== void 0 || adminKeyFailure !== void 0 || props.credentialRequired === true && keyValue.length === 0,',
  ],
];

let src = readFileSync(FILE, 'utf8');
if (src.includes(MARKER)) { console.log('already patched (admin key field) — nothing to do'); process.exit(0); }
const missing = [];
for (const [needle] of pairs) if (!src.includes(needle)) missing.push(needle.slice(0, 70).replace(/\n/g, '⏎'));
if (missing.length > 0) {
  console.error('ANCHOR MISSING (' + missing.length + '):');
  for (const m of missing) console.error('  - ' + m);
  process.exit(1);
}
const backup = FILE + '.orig-before-admin';
if (!existsSync(backup)) writeFileSync(backup, src);
let out = src;
for (const [needle, replacement] of pairs) out = out.split(needle).join(replacement);
writeFileSync(FILE, out);
console.log('patched ProviderEditor (admin API key field); backup = ' + backup);

