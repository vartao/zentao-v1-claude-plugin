import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pluginRoot = resolve(root, "plugin");
const releaseRoot = resolve(root, "release", "zentao-v1-plugin-marketplace");
const releasePlugin = resolve(releaseRoot, "plugins", "zentao-v1");

await mkdir(resolve(root, ".claude-plugin"), { recursive: true });
await mkdir(resolve(pluginRoot, "scripts"), { recursive: true });
await cp(resolve(root, "scripts", "configure.mjs"), resolve(pluginRoot, "scripts", "configure.mjs"));
await build({
  entryPoints: [resolve(root, "src", "server.ts")],
  outfile: resolve(pluginRoot, "server.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18",
  sourcemap: false,
  minify: false,
  legalComments: "none",
});

const marketplace = {
  $schema: "https://anthropic.com/claude-code/marketplace.schema.json",
  name: "zentao-v1-marketplace",
  description: "Open-source ZenTao REST API v1 integration for Claude Code",
  owner: { name: "vartao" },
  plugins: [{
    name: "zentao-v1",
    description: "Fast and safe ZenTao REST API v1 tools with workflow guidance.",
    version: "0.8.6",
    source: "./plugin",
    category: "productivity",
  }],
};
await writeFile(resolve(root, ".claude-plugin", "marketplace.json"), `${JSON.stringify(marketplace, null, 2)}\n`);

await rm(releaseRoot, { recursive: true, force: true });
await mkdir(resolve(releaseRoot, ".claude-plugin"), { recursive: true });
await mkdir(resolve(releaseRoot, "plugins"), { recursive: true });
await cp(pluginRoot, releasePlugin, { recursive: true });
const releaseMarketplace = structuredClone(marketplace);
releaseMarketplace.plugins[0].source = "./plugins/zentao-v1";
await writeFile(resolve(releaseRoot, ".claude-plugin", "marketplace.json"), `${JSON.stringify(releaseMarketplace, null, 2)}\n`);
await cp(resolve(root, "README.md"), resolve(releaseRoot, "README.md"));
await cp(resolve(root, "README.zh-CN.md"), resolve(releaseRoot, "README.zh-CN.md"));
await cp(resolve(root, "LICENSE"), resolve(releaseRoot, "LICENSE"));

console.log(releaseRoot);
