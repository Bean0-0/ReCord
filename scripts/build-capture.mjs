import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, rmdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const checkout = resolve(process.argv[2] ?? join(root, ".dev", "vencord"));
if (process.platform !== "win32") throw new Error("ReCord's audio capture helper currently requires Windows");
const vswhere = join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Microsoft Visual Studio", "Installer", "vswhere.exe");
if (!existsSync(vswhere)) throw new Error("Install Visual Studio Build Tools with the Desktop development with C++ workload");
const found = spawnSync(vswhere, ["-latest", "-products", "*", "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64", "-property", "installationPath"], { encoding: "utf8" });
if (found.error) throw found.error;
if (found.status !== 0 || !found.stdout.trim()) throw new Error("Visual Studio C++ build tools were not found");
const vcvars = join(found.stdout.trim(), "VC", "Auxiliary", "Build", "vcvars64.bat");
if (!existsSync(vcvars)) throw new Error("The Visual Studio x64 compiler environment was not found");
const temporary = await mkdtemp(join(tmpdir(), "record-capture-build-"));
const exe = join(temporary, "ReCordCapture.exe");
const object = join(temporary, "capture.obj");
try {
    const result = spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/c", join(root, "scripts", "build-capture.cmd"), vcvars, exe, object, join(root, "native", "capture.cpp")], { cwd: root, stdio: "inherit", shell: false, env: { ...process.env, PATH: `${dirname(vswhere)};${process.env.PATH ?? ""}` } });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Audio capture helper build failed (${result.status})`);
    await mkdir(join(checkout, "dist"), { recursive: true });
    await copyFile(exe, join(checkout, "dist", "ReCordCapture.exe"));
    console.log("Built the Windows audio capture helper.");
} finally {
    for (const file of [exe, object]) await unlink(file).catch(error => { if (error.code !== "ENOENT") throw error; });
    await rmdir(temporary);
}
