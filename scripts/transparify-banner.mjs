#!/usr/bin/env node
/**
 * Strip a near-white background from a PNG and write the result with a
 * proper alpha channel.
 *
 *   node scripts/transparify-banner.mjs <input.png> <output.png>
 *
 * Algorithm: flood-fill from the four image edges, only visiting pixels
 * whose RGB is near-white (>= BG_THRESHOLD). Anything reachable from an
 * edge through a continuous path of near-white pixels is the background;
 * everything else is the subject. This is the same logic Photoshop's
 * "Magic Wand → contiguous" uses, and it's what you want when the
 * subject contains its OWN white highlights (chrome reflections, etc.)
 * that should NOT become transparent.
 *
 * After the binary alpha mask is built, we apply a 1-pixel Gaussian blur
 * to the alpha channel only. That feathers the boundary 1 pixel so the
 * subject doesn't have a hard aliased edge. RGB stays intact.
 *
 * After background removal, we ALSO tight-crop to the subject's bounding
 * box and re-pad to a square canvas with a configurable safe-area
 * margin. Without this step the subject ends up tiny inside the icon
 * (lots of transparent padding around it carries through resize).
 *
 * Tunables via env:
 *   PAAT_BG_THRESHOLD   default 235. Higher = more aggressive (more
 *                       pixels treated as background).
 *   PAAT_FEATHER        default 1.0. Gaussian sigma for the alpha edge
 *                       feather. 0 disables feathering.
 *   PAAT_PADDING_PCT    default 5. Percent of the longer subject side to
 *                       add as transparent padding on each side of the
 *                       final square. 0 = subject touches the canvas
 *                       edges (sharpest at small icon sizes but riskier
 *                       at the corners).
 *   PAAT_NO_TRIM        set to "1" to skip the auto-crop step and keep
 *                       the original canvas dimensions.
 */

import sharp from "sharp";
import process from "node:process";

const inputPath = process.argv[2];
const outputPath = process.argv[3];
if (!inputPath || !outputPath) {
  console.error("usage: transparify-banner.mjs <input.png> <output.png>");
  process.exit(2);
}

const BG_THRESHOLD = Number(process.env.PAAT_BG_THRESHOLD ?? 235);
const FEATHER = Number(process.env.PAAT_FEATHER ?? 1.0);

const { data, info } = await sharp(inputPath)
  .removeAlpha()
  .raw()
  .toBuffer({ resolveWithObject: true });
const W = info.width;
const H = info.height;
const N = W * H;
console.log(`source ${W}x${H}, threshold=${BG_THRESHOLD}, feather=${FEATHER}`);

const isLight = (i) =>
  data[i * 3] >= BG_THRESHOLD &&
  data[i * 3 + 1] >= BG_THRESHOLD &&
  data[i * 3 + 2] >= BG_THRESHOLD;

// BFS/DFS from all four edges; only visit pixels that are themselves light.
const visited = new Uint8Array(N);
const stack = [];
const enqueue = (x, y) => {
  if (x < 0 || x >= W || y < 0 || y >= H) return;
  const i = y * W + x;
  if (visited[i]) return;
  if (!isLight(i)) return;
  visited[i] = 1;
  stack.push(i);
};
for (let x = 0; x < W; x++) {
  enqueue(x, 0);
  enqueue(x, H - 1);
}
for (let y = 0; y < H; y++) {
  enqueue(0, y);
  enqueue(W - 1, y);
}
while (stack.length) {
  const i = stack.pop();
  const x = i % W;
  const y = (i / W) | 0;
  enqueue(x - 1, y);
  enqueue(x + 1, y);
  enqueue(x, y - 1);
  enqueue(x, y + 1);
}

let bgCount = 0;
for (let i = 0; i < N; i++) if (visited[i]) bgCount++;
console.log(
  `background pixels: ${bgCount} / ${N} (${((bgCount / N) * 100).toFixed(1)}%)`,
);

// Build initial RGBA with hard alpha (255 if subject, 0 if background).
const rgba = Buffer.alloc(N * 4);
for (let i = 0; i < N; i++) {
  rgba[i * 4] = data[i * 3];
  rgba[i * 4 + 1] = data[i * 3 + 1];
  rgba[i * 4 + 2] = data[i * 3 + 2];
  rgba[i * 4 + 3] = visited[i] ? 0 : 255;
}

// Feather: blur the alpha channel only to soften the subject edge.
if (FEATHER > 0) {
  const featheredAlpha = await sharp(rgba, {
    raw: { width: W, height: H, channels: 4 },
  })
    .extractChannel(3)
    .blur(FEATHER)
    .raw()
    .toBuffer();
  for (let i = 0; i < N; i++) {
    rgba[i * 4 + 3] = featheredAlpha[i];
  }
}

// Save the bg-removed image to a buffer first; we'll tight-crop next.
const transparentBuf = await sharp(rgba, {
  raw: { width: W, height: H, channels: 4 },
})
  .png({ compressionLevel: 9 })
  .toBuffer();

if (process.env.PAAT_NO_TRIM === "1") {
  await sharp(transparentBuf).toFile(outputPath);
  console.log(`wrote ${outputPath} (no-trim mode)`);
  process.exit(0);
}

// Compute the subject's bounding box from the alpha channel directly
// (sharp's .trim() also works but our manual scan lets us tune the
// threshold for partial-alpha edge pixels feathered above).
let minX = W;
let minY = H;
let maxX = -1;
let maxY = -1;
const ALPHA_BBOX_THRESHOLD = 16; // any alpha >= this counts as subject
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const a = rgba[(y * W + x) * 4 + 3];
    if (a >= ALPHA_BBOX_THRESHOLD) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
}
if (maxX < 0) {
  console.error("transparify: no subject detected after bg removal");
  process.exit(3);
}
const subjectW = maxX - minX + 1;
const subjectH = maxY - minY + 1;
console.log(
  `subject bbox: ${subjectW}x${subjectH} at (${minX},${minY})`,
);

// Tight-crop to the bbox.
const cropped = await sharp(transparentBuf)
  .extract({ left: minX, top: minY, width: subjectW, height: subjectH })
  .toBuffer();

// Re-pad to a square canvas, longer side + padding on each side.
const PADDING_PCT = Math.max(0, Number(process.env.PAAT_PADDING_PCT ?? 5));
const longSide = Math.max(subjectW, subjectH);
const padPx = Math.round((longSide * PADDING_PCT) / 100);
const finalSize = longSide + 2 * padPx;

await sharp(cropped)
  .resize(finalSize, finalSize, {
    fit: "contain",
    background: { r: 0, g: 0, b: 0, alpha: 0 },
    kernel: "lanczos3",
  })
  .png({ compressionLevel: 9 })
  .toFile(outputPath);

const fillPct = ((subjectW * subjectH) / (finalSize * finalSize)) * 100;
console.log(
  `wrote ${outputPath} ${finalSize}x${finalSize} (subject fills ~${fillPct.toFixed(1)}% of canvas, ${PADDING_PCT}% padding)`,
);
