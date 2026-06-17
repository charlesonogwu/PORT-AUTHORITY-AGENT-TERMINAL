#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Generates the README demo animation (assets/demo.gif + assets/demo.mp4).
 *
 * Pipeline: a scripted timeline -> per-frame SVG -> PNG (via sharp) ->
 * GIF + MP4 (via ffmpeg). No screen capture, no browser — the dashboard is
 * drawn, but the layout (table columns, grouped rows, Show/Hide/Kill
 * actions, live/conflicts counters) faithfully mirrors the real Port Pilot
 * window. All data is fake + generic: no real paths, usernames, or URLs.
 *
 * Run: node scripts/make-demo.cjs
 * Requires: sharp (devDep) + ffmpeg on PATH.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");
const sharp = require("sharp");

const W = 1280;
const H = 720;
const FPS = 12;

const REPO = path.resolve(__dirname, "..");
const FRAMES_DIR = path.join(os.tmpdir(), "paat-demo-frames");
const ASSETS = path.join(REPO, "assets");

// ── palette (matches the real dark dashboard) ──────────────────────────────
const C = {
  bg: "#0a0a0a",
  titlebar: "#161616",
  line: "#262626",
  rowline: "#1c1c1c",
  white: "#ededed",
  dim: "#8a8a8a",
  faint: "#5a5a5a",
  cyan: "#5cc8ff",
  green: "#3fb950",
  red: "#f06f6f",
  badgeBorder: "#2f6f8f",
  badgeText: "#7fd0f0",
  cap: "#ededed",
  capbg: "#1f6feb",
  claude: "#d2785a",
  codex: "#10a37f",
  cursor: "#8b5cf6",
  gemini: "#4f8cf0",
  btnBorder: "#363636",
};

const MONO = "ui-monospace, 'JetBrains Mono', 'Cascadia Code', Consolas, monospace";

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function trunc(s, n) {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

// ── timeline state ─────────────────────────────────────────────────────────
const state = {
  groups: [], // {project, cwd, sessions:[{agent, agentColor, page, url, port, pid}]}
  caption: "",
};
const frames = [];
const snapshot = () => frames.push(JSON.stringify(state));
const hold = (n) => { for (let i = 0; i < n; i++) snapshot(); };
const caption = (t) => { state.caption = t; };
const liveCount = () => state.groups.reduce((a, g) => a + g.sessions.length, 0);

function addGroup(g, h = 30) {
  state.groups.push(g);
  hold(h);
}

// ── the script ─────────────────────────────────────────────────────────────
caption("One machine. Several AI agents — each on its own real task.");
hold(20);

caption("claude sets up a Cloudflare API token.");
addGroup({
  project: "cloudflare-keys",
  cwd: "C:\\dev\\cloudflare-keys",
  sessions: [{ agent: "claude", agentColor: C.claude, page: "API Tokens", url: "https://dash.cloudflare.com/profile/api-tokens", port: 9322, pid: 8120 }],
}, 28);

caption("codex grabs AWS keys — different site, different lane.");
addGroup({
  project: "aws-keys",
  cwd: "C:\\dev\\aws-keys",
  sessions: [{ agent: "codex", agentColor: C.codex, page: "IAM · Security credentials", url: "https://console.aws.amazon.com/iam/home", port: 9323, pid: 8455 }],
}, 28);

caption("cursor hunts monitors on eBay. Still zero collisions.");
addGroup({
  project: "monitor-research",
  cwd: "C:\\dev\\monitor-research",
  sessions: [{ agent: "cursor", agentColor: C.cursor, page: "monitor for sale | eBay", url: "https://www.ebay.com/sch/i.html?_nkw=monitor", port: 9324, pid: 8702 }],
}, 28);

caption("gemini compares prices on another store entirely.");
addGroup({
  project: "deal-hunt",
  cwd: "C:\\dev\\deal-hunt",
  sessions: [{ agent: "gemini", agentColor: C.gemini, page: "27\" Monitors — Newegg", url: "https://www.newegg.com/p/pl?d=monitor", port: 9325, pid: 8930 }],
}, 32);

caption("Four agents, four sites, four logins — fully isolated.");
hold(34);

caption("Port Pilot — give every agent its own lane.");
hold(42);

// ── renderer ───────────────────────────────────────────────────────────────
// column x-anchors (content runs 40..1240)
const COL = { chev: 28, agent: 48, project: 210, page: 392, port: 772, source: 904, action: 1044 };

function btn(x, y, label, w, color) {
  const c = color || C.dim;
  return (
    `<rect x="${x}" y="${y}" width="${w}" height="26" rx="6" fill="none" stroke="${C.btnBorder}"/>` +
    `<text x="${x + w / 2}" y="${y + 17}" text-anchor="middle" fill="${c}" font-family="${MONO}" font-size="12">${esc(label)}</text>`
  );
}

function render(st) {
  const p = [];
  p.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`);
  p.push(`<rect width="${W}" height="${H}" fill="${C.bg}"/>`);

  // title bar
  p.push(`<rect x="0" y="0" width="${W}" height="34" fill="${C.titlebar}"/>`);
  // little paat mark
  p.push(`<rect x="12" y="10" width="14" height="14" rx="3" fill="#2b3a55"/><circle cx="19" cy="17" r="3.2" fill="#7fb0ff"/>`);
  p.push(`<text x="34" y="22" fill="${C.dim}" font-family="${MONO}" font-size="13">Port Authority Agent Terminal</text>`);
  p.push(`<text x="${W - 78}" y="22" fill="${C.faint}" font-family="${MONO}" font-size="14">—  ▢  ✕</text>`);

  // header: Port Pilot + live/conflicts
  const live = liveCount();
  p.push(`<text x="40" y="76" fill="${C.white}" font-family="${MONO}" font-size="20" font-weight="700">Port Pilot</text>`);
  p.push(
    `<text x="${W - 40}" y="76" text-anchor="end" font-family="${MONO}" font-size="15" fill="${C.dim}">` +
      `<tspan fill="${C.white}" font-weight="700">${live}</tspan> live` +
      `<tspan dx="18" fill="${C.white}" font-weight="700">0</tspan> conflicts</text>`,
  );

  // section row: label + Hide all / Kill all
  p.push(`<text x="40" y="118" fill="${C.dim}" font-family="${MONO}" font-size="12" letter-spacing="1.5">LIVE CHROME SESSIONS</text>`);
  p.push(btn(W - 268, 102, `Hide all (${live})`, 116, C.dim));
  p.push(btn(W - 144, 102, `Kill all (${live})`, 104, C.dim));

  // table header
  const hy = 158;
  const hdr = (x, t, anchor) =>
    `<text x="${x}" y="${hy}" ${anchor ? `text-anchor="${anchor}"` : ""} fill="${C.faint}" font-family="${MONO}" font-size="12" letter-spacing="0.5">${t}</text>`;
  p.push(hdr(COL.agent, "Agent"));
  p.push(hdr(COL.project, "Project"));
  p.push(hdr(COL.page, "Current page"));
  p.push(hdr(COL.port, "Port / pid"));
  p.push(hdr(COL.source, "Source"));
  p.push(hdr(COL.action, "Action"));
  p.push(`<line x1="40" y1="${hy + 12}" x2="${W - 40}" y2="${hy + 12}" stroke="${C.line}"/>`);

  // rows
  let y = hy + 12;
  for (const g of st.groups) {
    // group header
    const gh = 38;
    p.push(`<text x="${COL.agent}" y="${y + 25}" fill="${C.white}" font-family="${MONO}" font-size="14" font-weight="700">${esc(g.project)}</text>`);
    const projW = g.project.length * 8.4 + 16;
    p.push(`<text x="${COL.agent + projW}" y="${y + 25}" fill="${C.faint}" font-family="${MONO}" font-size="12">${esc(g.cwd)}</text>`);
    const n = g.sessions.length;
    const badgeX = COL.agent + projW + g.cwd.length * 7.2 + 18;
    p.push(`<rect x="${badgeX}" y="${y + 12}" width="${(`${n} agent`).length * 7.4 + 14}" height="20" rx="10" fill="#1c1c1c" stroke="${C.line}"/>`);
    p.push(`<text x="${badgeX + 8}" y="${y + 26}" fill="${C.dim}" font-family="${MONO}" font-size="11">${n} agent</text>`);
    p.push(btn(W - 268, y + 8, `Hide all (${n})`, 116, C.dim));
    p.push(btn(W - 144, y + 8, `Kill all (${n})`, 104, C.dim));
    y += gh;

    // session rows
    for (const s of g.sessions) {
      const rh = 58;
      p.push(`<line x1="40" y1="${y}" x2="${W - 40}" y2="${y}" stroke="${C.rowline}"/>`);
      p.push(`<text x="${COL.chev}" y="${y + 34}" fill="${C.faint}" font-family="${MONO}" font-size="14">›</text>`);
      // agent (colored)
      p.push(`<text x="${COL.agent}" y="${y + 34}" fill="${s.agentColor}" font-family="${MONO}" font-size="14" font-weight="700">${esc(s.agent)}</text>`);
      // project
      p.push(`<text x="${COL.project}" y="${y + 34}" fill="${C.dim}" font-family="${MONO}" font-size="13">${esc(g.project)}</text>`);
      // current page (title + url)
      p.push(`<text x="${COL.page}" y="${y + 27}" fill="${C.white}" font-family="${MONO}" font-size="13">${esc(trunc(s.page, 34))}</text>`);
      p.push(`<text x="${COL.page}" y="${y + 45}" fill="${C.faint}" font-family="${MONO}" font-size="11.5">${esc(trunc(s.url, 48))}</text>`);
      // port / pid
      p.push(`<text x="${COL.port}" y="${y + 27}" fill="${C.cyan}" font-family="${MONO}" font-size="13">:${s.port}</text>`);
      p.push(`<text x="${COL.port}" y="${y + 45}" fill="${C.faint}" font-family="${MONO}" font-size="11.5">pid ${s.pid}</text>`);
      // source badge
      p.push(`<rect x="${COL.source}" y="${y + 17}" width="86" height="22" rx="5" fill="none" stroke="${C.badgeBorder}"/>`);
      p.push(`<text x="${COL.source + 43}" y="${y + 32}" text-anchor="middle" fill="${C.badgeText}" font-family="${MONO}" font-size="11.5">Port Pilot</text>`);
      // actions
      p.push(`<text x="${COL.action}" y="${y + 33}" fill="${C.dim}" font-family="${MONO}" font-size="12.5">Show</text>`);
      p.push(`<text x="${COL.action + 56}" y="${y + 33}" fill="${C.dim}" font-family="${MONO}" font-size="12.5">Hide</text>`);
      p.push(`<text x="${COL.action + 112}" y="${y + 33}" fill="${C.red}" font-family="${MONO}" font-size="12.5">🗑 Kill</text>`);
      y += rh;
    }
  }
  if (st.groups.length === 0) {
    p.push(`<text x="${W / 2}" y="300" text-anchor="middle" fill="${C.faint}" font-family="${MONO}" font-size="14">No live Chrome sessions. Agents will appear here as they open browsers.</text>`);
  }

  // caption strip
  const cyc = 648, ch = 50;
  p.push(`<rect x="40" y="${cyc}" width="${W - 80}" height="${ch}" rx="10" fill="${C.capbg}" opacity="0.14"/>`);
  p.push(`<rect x="40" y="${cyc}" width="6" height="${ch}" rx="3" fill="${C.capbg}"/>`);
  p.push(`<text x="64" y="${cyc + 32}" fill="${C.cap}" font-family="${MONO}" font-size="16">${esc(st.caption)}</text>`);

  p.push(`</svg>`);
  return p.join("");
}

// ── main ───────────────────────────────────────────────────────────────────
async function main() {
  console.log(`[demo] timeline = ${frames.length} frames @ ${FPS}fps (~${(frames.length / FPS).toFixed(1)}s)`);
  fs.rmSync(FRAMES_DIR, { recursive: true, force: true });
  fs.mkdirSync(FRAMES_DIR, { recursive: true });
  fs.mkdirSync(ASSETS, { recursive: true });

  for (let i = 0; i < frames.length; i++) {
    const svg = render(JSON.parse(frames[i]));
    const file = path.join(FRAMES_DIR, `f_${String(i).padStart(4, "0")}.png`);
    await sharp(Buffer.from(svg)).png().toFile(file);
    if (i % 40 === 0) console.log(`[demo] rendered frame ${i}/${frames.length}`);
  }
  console.log("[demo] all frames rendered");

  const pattern = path.join(FRAMES_DIR, "f_%04d.png");
  const palette = path.join(FRAMES_DIR, "palette.png");
  const gif = path.join(ASSETS, "demo.gif");
  const mp4 = path.join(ASSETS, "demo.mp4");

  const run = (args) => {
    const r = spawnSync("ffmpeg", args, { stdio: ["ignore", "ignore", "inherit"] });
    if (r.status !== 0) throw new Error("ffmpeg failed: " + args.join(" "));
  };

  console.log("[demo] building GIF…");
  run(["-y", "-framerate", String(FPS), "-i", pattern, "-vf", "scale=1000:-1:flags=lanczos,palettegen=stats_mode=diff", "-update", "1", palette]);
  run(["-y", "-framerate", String(FPS), "-i", pattern, "-i", palette, "-filter_complex", "scale=1000:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=3", "-loop", "0", gif]);

  console.log("[demo] building MP4…");
  run(["-y", "-framerate", String(FPS), "-i", pattern, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-vf", "scale=1280:-2", mp4]);

  const mb = (p2) => (fs.statSync(p2).size / 1024 / 1024).toFixed(2);
  console.log(`[demo] done.\n  ${gif}  (${mb(gif)} MB)\n  ${mp4}  (${mb(mp4)} MB)`);
  const previewSrc = path.join(FRAMES_DIR, `f_${String(frames.length - 1).padStart(4, "0")}.png`);
  fs.copyFileSync(previewSrc, path.join(ASSETS, "demo-preview.png"));
  console.log(`  ${path.join(ASSETS, "demo-preview.png")}  (still for review)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
