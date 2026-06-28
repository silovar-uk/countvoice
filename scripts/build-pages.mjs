import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(projectRoot, "dist");
const sourcePublic = join(projectRoot, "public");

const exclude = new Set([
  ".git", ".github", "dist", "node_modules", "public", "scripts",
  ".DS_Store", "countvoice-public-icons-v41.zip"
]);

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

for (const entry of await readdir(projectRoot, { withFileTypes: true })) {
  if (exclude.has(entry.name)) continue;
  await cp(join(projectRoot, entry.name), join(dist, entry.name), { recursive: true });
}

// Like Vite's public/ behavior: copy static assets into the deployed site root.
await cp(sourcePublic, dist, { recursive: true });

const transformFiles = ["index.html", "voice-pack-maker.html", "manifest.webmanifest", "sw.js"];
for (const name of transformFiles) {
  const path = join(dist, name);
  let text = await readFile(path, "utf8");
  // Source files use ./public/ for local clarity. The deployment artifact exposes public/ at its root.
  text = text.replaceAll("./public/", "./");
  await writeFile(path, text, "utf8");
}

// Avoid Jekyll processing of files and names used by the app.
await writeFile(join(dist, ".nojekyll"), "", "utf8");
console.log("Built GitHub Pages artifact:", dist);
