/**
 * Copy the hand-written web client factory (module-loader format) into lib.
 */
import { mkdirSync, copyFileSync, existsSync } from "node:fs";
mkdirSync("lib", { recursive: true });
if (!existsSync("src/client/index.js")) {
  console.error("src/client/index.js missing — client half not built");
  process.exit(1);
}
copyFileSync("src/client/index.js", "lib/client.js");
console.log("copied client factory -> lib/client.js");
