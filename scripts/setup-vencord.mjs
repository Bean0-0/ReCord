import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const checkout = join(root, ".dev", "vencord");
const revision = "383409e6a6ec9008ee8a7496500f1e75f17824d1";

function run(command, args, cwd) {
    const result = spawnSync(command, args, { cwd, stdio: "inherit", shell: false });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
}

if (!existsSync(checkout)) {
    run("git", ["clone", "--no-checkout", "--depth", "1", "https://github.com/Vendicated/Vencord.git", checkout], root);
    run("git", ["fetch", "--depth", "1", "origin", revision], checkout);
    run("git", ["checkout", "--detach", revision], checkout);
}
const manifest = JSON.parse(await readFile(join(checkout, "package.json"), "utf8"));
if (manifest.name !== "vencord" || !/^pnpm@\d+\.\d+\.\d+$/.test(manifest.packageManager)) throw new Error("Unexpected Vencord checkout or package manager");
// Invoke npm's JS entry point to avoid Windows shell quoting and broken pnpm shims.
const npm = process.env.npm_execpath;
if (!npm) throw new Error("Run this script using npm run setup:vencord");
run(process.execPath, [npm, "exec", "--yes", `--package=${manifest.packageManager}`, "--", "pnpm", "install", "--frozen-lockfile"], checkout);
run(process.execPath, [join(root, "scripts", "install-plugin.mjs"), checkout], root);
console.log("Development checkout ready. Run npm run build.");
