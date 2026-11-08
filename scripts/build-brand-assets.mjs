#!/usr/bin/env node
/**
 * Rasterize Bifrost Beacon SVG masters → PNG / ICO / brand sheet.
 * Uses sharp from apps/hub (already a Next.js dependency).
 * No network; no secrets. Fails closed if SVG contains embedded raster or scripts.
 */
import { createRequire } from "node:module";
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const BRAND = join(ROOT, "assets", "brand");
const PNG_DIR = join(BRAND, "png");
const DERIVED = join(BRAND, "derived");

const require = createRequire(join(ROOT, "apps/hub/package.json"));
const sharp = require("sharp");

function assertSvgSafe(path) {
  const raw = readFileSync(path, "utf8");
  if (/<script/i.test(raw)) throw new Error(`unsafe SVG script: ${path}`);
  if (/xlink:href\s*=\s*["']data:image/i.test(raw) || /href\s*=\s*["']data:image/i.test(raw)) {
    throw new Error(`unsafe embedded raster in SVG: ${path}`);
  }
  if (/<image[\s>]/i.test(raw)) throw new Error(`unsafe <image> in SVG: ${path}`);
  if (/javascript:/i.test(raw)) throw new Error(`unsafe javascript URI: ${path}`);
  return raw;
}

async function raster(svgPath, outPath, size) {
  assertSvgSafe(svgPath);
  const pipeline = sharp(svgPath, { density: 300 });
  if (size) pipeline.resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } });
  await pipeline.png().toFile(outPath);
}

async function rasterExact(svgPath, outPath, width, height) {
  assertSvgSafe(svgPath);
  await sharp(svgPath, { density: 300 })
    .resize(width, height, { fit: "fill" })
    .png()
    .toFile(outPath);
}

function buildIco(pngPaths, outPath) {
  // Pillow multi-size ICO via system python
  const py = `/usr/bin/python3`;
  const script = `
from PIL import Image
imgs = []
sizes = []
for p in ${JSON.stringify(pngPaths)}:
    im = Image.open(p).convert("RGBA")
    imgs.append(im)
    sizes.append(im.size)
imgs[0].save(${JSON.stringify(outPath)}, format="ICO", sizes=sizes, append_images=imgs[1:])
print("ico", ${JSON.stringify(outPath)}, sizes)
`;
  const r = spawnSync(py, ["-c", script], { encoding: "utf8" });
  if (r.status !== 0) {
    console.error(r.stdout, r.stderr);
    throw new Error("ICO build failed");
  }
  console.log(r.stdout.trim());
}

async function brandSheet() {
  // Compose a review sheet: app icon + wordmarks + favicon sizes
  const W = 1280;
  const H = 720;
  const navy = { r: 10, g: 22, b: 40, alpha: 1 };
  const cream = { r: 243, g: 237, b: 224, alpha: 1 };
  const base = sharp({
    create: { width: W, height: H, channels: 4, background: navy },
  });
  const icon = await sharp(join(PNG_DIR, "icon-512.png")).resize(280, 280).png().toBuffer();
  const wmLight = await sharp(join(BRAND, "heimdall-wordmark-light.svg"), { density: 200 })
    .resize(520, 128)
    .png()
    .toBuffer();
  const wmDark = await sharp(join(BRAND, "heimdall-wordmark-dark.svg"), { density: 200 })
    .resize(520, 128)
    .png()
    .toBuffer();
  const fav32 = await sharp(join(PNG_DIR, "favicon-32.png")).resize(64, 64, { kernel: "nearest" }).png().toBuffer();
  const creamBar = await sharp({
    create: { width: 560, height: 160, channels: 4, background: cream },
  })
    .png()
    .toBuffer();

  await base
    .composite([
      { input: icon, left: 80, top: 120 },
      { input: creamBar, left: 420, top: 100 },
      { input: wmLight, left: 440, top: 116 },
      { input: wmDark, left: 420, top: 300 },
      { input: fav32, left: 420, top: 480 },
    ])
    .png()
    .toFile(join(DERIVED, "brand-sheet.png"));
}

async function main() {
  mkdirSync(PNG_DIR, { recursive: true });
  mkdirSync(DERIVED, { recursive: true });

  // SVG safety pass
  for (const f of readdirSync(BRAND)) {
    if (f.endsWith(".svg")) assertSvgSafe(join(BRAND, f));
  }
  console.log("svg safety: ok");

  const favSrc = join(BRAND, "heimdall-mark-favicon.svg");
  const appSrc = join(BRAND, "heimdall-icon-app.svg");
  const sizes = [16, 32, 48, 180, 192, 512];
  for (const s of sizes) {
    const src = s <= 48 ? favSrc : appSrc;
    const name = s <= 48 ? `favicon-${s}.png` : `icon-${s}.png`;
    await raster(src, join(PNG_DIR, name), s);
    // also emit generic size name
    await raster(src, join(PNG_DIR, `${s}.png`), s);
  }
  // App icon variants at all listed sizes for completeness
  for (const s of [180, 192, 512]) {
    await raster(appSrc, join(PNG_DIR, `icon-${s}.png`), s);
  }
  await raster(appSrc, join(PNG_DIR, "icon-32.png"), 32);

  await rasterExact(
    join(BRAND, "heimdall-social-1280x640.svg"),
    join(BRAND, "heimdall-social-1280x640.png"),
    1280,
    640,
  );

  buildIco(
    [join(PNG_DIR, "favicon-16.png"), join(PNG_DIR, "favicon-32.png"), join(PNG_DIR, "favicon-48.png")],
    join(BRAND, "favicon.ico"),
  );

  await brandSheet();

  // Copy into hub app paths
  const hubApp = join(ROOT, "apps/hub/src/app");
  const hubPublic = join(ROOT, "apps/hub/public/brand");
  mkdirSync(hubPublic, { recursive: true });
  writeFileSync(join(hubApp, "favicon.ico"), readFileSync(join(BRAND, "favicon.ico")));
  writeFileSync(join(hubApp, "icon.png"), readFileSync(join(PNG_DIR, "icon-512.png")));
  writeFileSync(join(hubApp, "apple-icon.png"), readFileSync(join(PNG_DIR, "icon-180.png")));
  writeFileSync(join(hubPublic, "mark-dark.svg"), readFileSync(join(BRAND, "heimdall-mark-dark.svg")));
  writeFileSync(join(hubPublic, "mark-light.svg"), readFileSync(join(BRAND, "heimdall-mark-light.svg")));
  writeFileSync(join(hubPublic, "wordmark-light.svg"), readFileSync(join(BRAND, "heimdall-wordmark-light.svg")));
  writeFileSync(join(hubPublic, "wordmark-dark.svg"), readFileSync(join(BRAND, "heimdall-wordmark-dark.svg")));
  writeFileSync(join(hubPublic, "icon.svg"), readFileSync(join(BRAND, "heimdall-icon-app.svg")));
  writeFileSync(join(hubPublic, "og.png"), readFileSync(join(BRAND, "heimdall-social-1280x640.png")));

  // README / docs screenshot copies (synthetic brand sheet)
  mkdirSync(join(ROOT, "docs/screenshots"), { recursive: true });
  writeFileSync(
    join(ROOT, "docs/screenshots/brand-sheet.png"),
    readFileSync(join(DERIVED, "brand-sheet.png")),
  );
  writeFileSync(
    join(ROOT, ".publish/screenshots/fleet-placeholder.svg"),
    readFileSync(join(BRAND, "heimdall-social-1280x640.svg")),
  );

  console.log("brand assets built");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
