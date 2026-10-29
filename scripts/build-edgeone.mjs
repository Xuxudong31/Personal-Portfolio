import { copyFile, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const projectRoot = resolve(import.meta.dirname, "..");
const outputRoot = resolve(projectRoot, ".edgeone-dist");

// 国内静态托管只发布浏览器需要的文件，服务端源码、测试和密钥不会进入产物。
await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });
await cp(resolve(projectRoot, "assets"), resolve(outputRoot, "assets"), { recursive: true });

// EdgeOne currently serves `.mjs` as application/octet-stream. Publish the
// same ESM runtime as `.js`, which EdgeOne serves with a browser-safe MIME type.
const sourceHtml = await readFile(resolve(projectRoot, "index.html"), "utf8");
await writeFile(
  resolve(outputRoot, "index.html"),
  sourceHtml.replace("canvas_advanced.mjs", "canvas_advanced.js"),
  "utf8",
);
await copyFile(
  resolve(projectRoot, "assets", "rive-runtime", "canvas_advanced.mjs"),
  resolve(outputRoot, "assets", "rive-runtime", "canvas_advanced.js"),
);
await rm(resolve(outputRoot, "assets", "rive-runtime", "canvas_advanced.mjs"));

console.log(`EdgeOne static bundle ready: ${outputRoot}`);
