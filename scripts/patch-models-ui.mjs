/**
 * Patch the vendored dsh Models UI so the `llm-lemonade` namespace renders
 * with the pi-ai provider card (API key, base URL, model editor with
 * "Fetch available models" via llm.discoverModels).
 *
 * The built-in Settings/Models editor only knows the `llm-deepseek` and
 * `llm-pi-ai` namespaces (anything else shows a disabled hint); there is no
 * third-party seam. This single-line idempotent edit in the vendored bundle
 * maps `llm-lemonade` onto the pi-ai card. Re-run it after a `npm exec` cache
 * refresh (a backup `.orig-before-lemonade` is kept on first run).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const FILE = process.argv[2] ??
  "/home/cyril/.npm/_npx/1e7f6d9597241db0/node_modules/@deepseek-ai/dsh-client-ui-settings-models/lib/client.js";
const MARKER = "/* dsh-lemonade-provider: llm-lemonade renders with the pi-ai card */";
const NEED = 'if (ns === "llm-pi-ai") return "pi-ai";';
const ADD = NEED + `\n\t\t\tif (ns === "llm-lemonade") return "pi-ai"; ${MARKER}`;

let src = readFileSync(FILE, "utf8");
if (src.includes(MARKER)) {
  console.log("already patched — nothing to do");
  process.exit(0);
}
if (!src.includes("function layoutOf")) {
  console.error("layoutOf not found in " + FILE);
  process.exit(1);
}
if (!src.includes(NEED)) {
  console.error("anchor not found in " + FILE);
  process.exit(1);
}
const backup = FILE + ".orig-before-lemonade";
if (!existsSync(backup)) writeFileSync(backup, src);
writeFileSync(FILE, src.replace(NEED, ADD));
console.log("patched layoutOf in " + FILE);
console.log("backup written to " + backup);
