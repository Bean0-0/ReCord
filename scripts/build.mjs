import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const checkout = resolve(process.argv[2] ?? join(root, ".dev", "vencord"));
for (const [args, cwd] of [
    [[join(root, "scripts", "install-plugin.mjs"), checkout], root],
    [["node_modules/typescript/bin/tsc", "--noEmit"], checkout],
    [["node_modules/eslint/bin/eslint.js", "src/userplugins/reCord.discordDesktop"], checkout],
    [["node_modules/stylelint/bin/stylelint.mjs", "src/userplugins/reCord.discordDesktop/styles.css"], checkout],
    [["--require=./scripts/suppressExperimentalWarnings.js", "scripts/build/build.mjs", "--dev"], checkout]
]) {
    const result = spawnSync(process.execPath, args, { cwd, stdio: "inherit", shell: false });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
}
console.log(`Built and checked ReCord in ${join(checkout, "dist")}.`);
