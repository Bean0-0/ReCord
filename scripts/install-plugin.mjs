import { cp, lstat, mkdir, readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const checkout = process.argv[2] ?? join(projectRoot, ".dev", "vencord");
const root = resolve(checkout);
const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
if (manifest.name !== "vencord") throw new Error("The destination must be a Vencord source checkout");
const source = join(projectRoot, "plugin");
const target = join(root, "src", "userplugins", "reCord.discordDesktop");
let info;
try {
    info = await lstat(target);
} catch (error) {
    if (error.code !== "ENOENT") throw error;
}
if (info) {
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("Destination must be a regular plugin directory");
    // Refuse to silently replace an unrelated plugin.
    if ((await readdir(target)).length) {
        const entry = await readFile(join(target, "index.tsx"), "utf8");
        if (!entry.includes('name: "ReCord"')) throw new Error("Destination contains another plugin");
    }
}
await mkdir(target, { recursive: true });
await cp(source, target, { recursive: true });
console.log(`Copied ReCord to ${target}\nRebuild Vencord and fully restart Discord to load native changes.`);
