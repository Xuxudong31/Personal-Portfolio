import { cp, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

const projectRoot = resolve(import.meta.dirname, "..");
const outputRoot = resolve(projectRoot, ".edgeone-dist");

// 国内静态托管只发布浏览器需要的文件，服务端源码、测试和密钥不会进入产物。
await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });
await cp(resolve(projectRoot, "index.html"), resolve(outputRoot, "index.html"));
await cp(resolve(projectRoot, "assets"), resolve(outputRoot, "assets"), { recursive: true });

console.log(`EdgeOne static bundle ready: ${outputRoot}`);
