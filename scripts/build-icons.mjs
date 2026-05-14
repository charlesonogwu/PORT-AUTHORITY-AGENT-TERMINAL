#!/usr/bin/env node
/**
 * Generate the program icon set from `assets/paat-banner.png`.
 *
 * Outputs (all committed to git):
 *   assets/paat.ico                  — multi-resolution Windows icon (16/32/48/64/128/256)
 *   assets/paat-256.png              — square PNG at 256x256 (README, OS shells)
 *   assets/paat-favicon-32.png       — 32x32 PNG (legacy alias)
 *   gui/src-tauri/icons/icon.ico     — Windows .ico baked into the Tauri shell
 *   gui/src-tauri/icons/icon.png     — 1024x1024 PNG (cross-platform Tauri icon)
 *   gui/src-tauri/icons/32x32.png    — small Tauri icon (taskbar / dock)
 *   gui/src-tauri/icons/128x128.png  — medium Tauri icon
 *   gui/src-tauri/icons/128x128@2x.png — retina Tauri icon
 *
 * The source banner is wide (≈1672×941), so we square-crop it before scaling.
 * The default crop is centered on the front-robot silhouette, which is the
 * most recognisable element down to 16×16. Override with env vars when
 * iterating: PAAT_CROP_LEFT, PAAT_CROP_TOP, PAAT_CROP_SIZE.
 *
 * IMPORTANT: All output files are checked into git. End users running
 * `npm install -g github:...` do NOT need to regenerate them — sharp +
 * png-to-ico are dev-only conveniences for iterating on the source PNG.
 * If every output file is already present we exit before importing sharp,
 * so a missing/broken sharp install never crashes the build.
 *
 * To force a rebuild: set PAAT_FORCE_ICONS=1 in the env, or delete one of
 * the output files before running `npm run build:icons`.
 */
import { existsSync } from "node:fs";
import { writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BANNER = join(REPO_ROOT, "assets", "paat-banner.png");

const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
const PNG_OUT_256 = join(REPO_ROOT, "assets", "paat-256.png");
const PNG_OUT_FAV = join(REPO_ROOT, "assets", "paat-favicon-32.png");
const ICO_OUT = join(REPO_ROOT, "assets", "paat.ico");

// Tauri-shell icon outputs. Tauri reads these from `gui/src-tauri/icons/`
// at build time and bakes them into the .exe / .app / .deb. The set of
// filenames mirrors `tauri.conf.json`'s bundle.icon array.
const TAURI_ICONS_DIR = join(REPO_ROOT, "gui", "src-tauri", "icons");
const TAURI_ICO = join(TAURI_ICONS_DIR, "icon.ico");
const TAURI_PNG_LARGE = join(TAURI_ICONS_DIR, "icon.png");
const TAURI_PNG_32 = join(TAURI_ICONS_DIR, "32x32.png");
const TAURI_PNG_128 = join(TAURI_ICONS_DIR, "128x128.png");
const TAURI_PNG_128_2X = join(TAURI_ICONS_DIR, "128x128@2x.png");

/** Background colour used to letterbox non-square banners onto a square
 *  canvas. Default is fully transparent so a source PNG with alpha keeps
 *  it through the entire pipeline. Set PAAT_BG_HEX="#000000" (or any
 *  hex colour) to flatten alpha onto a solid background instead — useful
 *  if you want the icon to display with a known backdrop everywhere. */
function letterboxBg() {
  const raw = process.env.PAAT_BG_HEX;
  if (!raw) return { r: 0, g: 0, b: 0, alpha: 0 }; // transparent
  const hex = raw.replace(/^#/, "");
  if (!/^[0-9a-f]{6}$/i.test(hex)) {
    return { r: 0, g: 0, b: 0, alpha: 0 };
  }
  return {
    r: parseInt(hex.slice(0, 2), 16),
    g: parseInt(hex.slice(2, 4), 16),
    b: parseInt(hex.slice(4, 6), 16),
    alpha: 1,
  };
}

/**
 * Resize the banner into a square (size×size) while preserving aspect ratio,
 * padding the empty top/bottom or left/right with the brand background
 * (transparent by default — see letterboxBg). `fit: "contain"` is sharp's
 * letterbox mode. We do NOT call .flatten() — that would force-fill alpha
 * with a solid colour and destroy any transparency in the source.
 *
 * `sharp` is passed in (rather than imported at module scope) because we
 * lazy-load it inside main() — see header comment for the rationale.
 */
async function squareLetterbox(sharp, size, bg) {
  return sharp(BANNER)
    .resize(size, size, {
      fit: "contain",
      background: bg,
      kernel: "lanczos3",
    })
    .png({ compressionLevel: 9 })
    .toBuffer();
}

async function main() {
  // End users get all icon outputs from git — no need to invoke sharp
  // unless someone is iterating on the source PNG. This skip is what makes
  // `npm install -g github:...` work on machines where sharp's native
  // binary fails to install (corp networks, unsupported arches, --ignore-
  // scripts, etc.). Forcing a rebuild: PAAT_FORCE_ICONS=1.
  const allOutputsExist =
    existsSync(ICO_OUT) &&
    existsSync(PNG_OUT_256) &&
    existsSync(PNG_OUT_FAV) &&
    existsSync(TAURI_ICO) &&
    existsSync(TAURI_PNG_LARGE) &&
    existsSync(TAURI_PNG_32) &&
    existsSync(TAURI_PNG_128) &&
    existsSync(TAURI_PNG_128_2X);
  if (allOutputsExist && process.env.PAAT_FORCE_ICONS !== "1") {
    console.log(
      "[build-icons] all icon outputs already exist — skipping (set PAAT_FORCE_ICONS=1 to rebuild)",
    );
    return;
  }

  // Lazy-import sharp + png-to-ico so the file doesn't crash with
  // ERR_MODULE_NOT_FOUND when those devDeps aren't present (the
  // common case during a `npm install -g github:...` build).
  const { default: sharp } = await import("sharp");
  const { default: pngToIco } = await import("png-to-ico");

  const meta = await sharp(BANNER).metadata();
  const bg = letterboxBg();
  const bgDesc = bg.alpha === 0 ? "transparent" : `rgb(${bg.r},${bg.g},${bg.b})`;
  console.log(
    `[build-icons] source ${meta.width}x${meta.height} hasAlpha=${meta.hasAlpha}, letterboxing onto square canvases (bg ${bgDesc})`,
  );

  // 1. Render every .ico size in parallel by letterboxing the banner.
  //    Each size is rendered from the original (not from a smaller buffer)
  //    so we get the best lanczos3 result at each resolution.
  const pngBuffers = await Promise.all(
    ICO_SIZES.map((s) => squareLetterbox(sharp, s, bg)),
  );

  // 2. Pack into a multi-resolution .ico.
  const icoBuffer = await pngToIco(pngBuffers);
  await mkdir(dirname(ICO_OUT), { recursive: true });
  await writeFile(ICO_OUT, icoBuffer);
  console.log(`[build-icons] wrote ${ICO_OUT} (${icoBuffer.length} bytes)`);

  // 3. Standalone PNGs (README + dashboard).
  const png256 = await squareLetterbox(sharp, 256, bg);
  await writeFile(PNG_OUT_256, png256);
  console.log(`[build-icons] wrote ${PNG_OUT_256}`);

  const png32 = await squareLetterbox(sharp, 32, bg);
  await writeFile(PNG_OUT_FAV, png32);
  console.log(`[build-icons] wrote ${PNG_OUT_FAV}`);

  // 4. Tauri-shell icons. Tauri picks these up from gui/src-tauri/icons/
  //    via tauri.conf.json's bundle.icon array and bakes them into the
  //    .exe (Windows resources) and .app (macOS Resources/AppIcon.icns).
  await mkdir(TAURI_ICONS_DIR, { recursive: true });
  await writeFile(TAURI_ICO, icoBuffer);
  console.log(`[build-icons] wrote ${TAURI_ICO}`);

  const png1024 = await squareLetterbox(sharp, 1024, bg);
  await writeFile(TAURI_PNG_LARGE, png1024);
  console.log(`[build-icons] wrote ${TAURI_PNG_LARGE}`);

  const png128 = await squareLetterbox(sharp, 128, bg);
  await writeFile(TAURI_PNG_128, png128);
  console.log(`[build-icons] wrote ${TAURI_PNG_128}`);

  const png256Tauri = await squareLetterbox(sharp, 256, bg);
  await writeFile(TAURI_PNG_128_2X, png256Tauri);
  console.log(`[build-icons] wrote ${TAURI_PNG_128_2X}`);

  await writeFile(TAURI_PNG_32, png32);
  console.log(`[build-icons] wrote ${TAURI_PNG_32}`);
}

main().catch((err) => {
  console.error("[build-icons] failed:", err);
  process.exit(1);
});
