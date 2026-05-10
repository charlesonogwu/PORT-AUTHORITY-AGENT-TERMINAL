#!/usr/bin/env node
/**
 * Generate the program icon set from `assets/paat-banner.png`.
 *
 * Outputs:
 *   assets/paat.ico             — multi-resolution Windows icon (16/32/48/64/128/256)
 *   assets/paat-256.png         — square PNG at 256x256 (used by README, OS shells)
 *   assets/paat-favicon-32.png  — 32x32 PNG for the dashboard <link rel="icon">
 *   dashboard-ui/portpilot-dashboard/public/favicon.ico  — same .ico for the in-app window
 *
 * The source banner is wide (≈1672×941), so we square-crop it before scaling.
 * The default crop is centered on the front-robot silhouette, which is the
 * most recognisable element down to 16×16. Override with env vars when
 * iterating: PAAT_CROP_LEFT, PAAT_CROP_TOP, PAAT_CROP_SIZE.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import pngToIco from "png-to-ico";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BANNER = join(REPO_ROOT, "assets", "paat-banner.png");

const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
const PNG_OUT_256 = join(REPO_ROOT, "assets", "paat-256.png");
const PNG_OUT_FAV = join(REPO_ROOT, "assets", "paat-favicon-32.png");
const ICO_OUT = join(REPO_ROOT, "assets", "paat.ico");
const DASHBOARD_PUBLIC = join(
  REPO_ROOT,
  "dashboard-ui",
  "portpilot-dashboard",
  "public",
);
const DASHBOARD_FAVICON = join(DASHBOARD_PUBLIC, "favicon.ico");
const DASHBOARD_FAVICON_PNG = join(DASHBOARD_PUBLIC, "paat-icon.png");

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
 */
async function squareLetterbox(size, bg) {
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
    ICO_SIZES.map((s) => squareLetterbox(s, bg)),
  );

  // 2. Pack into a multi-resolution .ico.
  const icoBuffer = await pngToIco(pngBuffers);
  await mkdir(dirname(ICO_OUT), { recursive: true });
  await writeFile(ICO_OUT, icoBuffer);
  console.log(`[build-icons] wrote ${ICO_OUT} (${icoBuffer.length} bytes)`);

  // 3. Standalone PNGs (README + dashboard).
  const png256 = await squareLetterbox(256, bg);
  await writeFile(PNG_OUT_256, png256);
  console.log(`[build-icons] wrote ${PNG_OUT_256}`);

  const png32 = await squareLetterbox(32, bg);
  await writeFile(PNG_OUT_FAV, png32);
  console.log(`[build-icons] wrote ${PNG_OUT_FAV}`);

  // 5. Mirror into dashboard-ui/public so Vite copies it into the inlined HTML.
  await mkdir(DASHBOARD_PUBLIC, { recursive: true });
  await writeFile(DASHBOARD_FAVICON, icoBuffer);
  await writeFile(DASHBOARD_FAVICON_PNG, png256);
  console.log(`[build-icons] wrote ${DASHBOARD_FAVICON}`);
  console.log(`[build-icons] wrote ${DASHBOARD_FAVICON_PNG}`);

  // 6. Inject the favicon as a base64 data URI directly into index.html.
  //    The dashboard ships as a single inlined HTML file (vite-plugin-singlefile),
  //    so external <link rel="icon" href="/favicon.ico"> would be a 404 at runtime.
  //    We swap the data: URI in place to keep everything self-contained.
  const indexHtmlPath = join(REPO_ROOT, "dashboard-ui", "portpilot-dashboard", "index.html");
  const html = await readFile(indexHtmlPath, "utf8");
  const dataUri = `data:image/png;base64,${png32.toString("base64")}`;
  const linkRegex = /<link\s+rel="icon"[^>]*\/?>/i;
  const newLink = `<link rel="icon" type="image/png" href="${dataUri}" />`;
  const updated = linkRegex.test(html)
    ? html.replace(linkRegex, newLink)
    : html.replace(/<head>/i, `<head>\n    ${newLink}`);
  if (updated !== html) {
    await writeFile(indexHtmlPath, updated, "utf8");
    console.log(`[build-icons] updated favicon data URI in ${indexHtmlPath}`);
  } else {
    console.log(`[build-icons] favicon data URI in index.html already up to date`);
  }
}

main().catch((err) => {
  console.error("[build-icons] failed:", err);
  process.exit(1);
});

void readFile; // satisfy lint: keep readFile import for future use
