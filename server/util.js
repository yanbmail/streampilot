'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');

/** 生成短 ID */
function uid(prefix = '') {
  const s = crypto.randomBytes(6).toString('hex');
  return prefix ? `${prefix}_${s}` : s;
}

function clamp(n, min, max, fallback) {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, v));
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 原子写：先写临时文件再 rename，避免断电/崩溃造成配置损坏 */
function atomicWrite(file, content) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, content);
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    throw err;
  }
}

function readJson(file, fallback) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch (err) {
    return fallback;
  }
}

function debounce(fn, wait) {
  let timer = null;
  const wrapped = (...args) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, wait);
  };
  wrapped.flush = (...args) => {
    if (timer) { clearTimeout(timer); timer = null; }
    fn(...args);
  };
  wrapped.cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };
  return wrapped;
}

function execFileP(file, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: opts.timeout || 15000, maxBuffer: 8 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: stdout || '', stderr: stderr || '', error: err });
    });
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 字节数转可读 */
function humanBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/** 解析 ffmpeg 的 time=00:00:12.34 */
function parseTime(str) {
  if (!str) return 0;
  const p = String(str).trim().split(':').map(Number);
  if (p.some((v) => !Number.isFinite(v))) return 0;
  if (p.length === 3) return p[0] * 3600 + p[1] * 60 + p[2];
  if (p.length === 2) return p[0] * 60 + p[1];
  return p[0] || 0;
}

function formatDuration(sec) {
  const s = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(r)}` : `${pad(m)}:${pad(r)}`;
}

/** 该平台默认数据目录 */
function defaultDataDir() {
  if (process.env.STREAMPILOT_DATA) return process.env.STREAMPILOT_DATA;
  return path.join(os.homedir(), '.streampilot');
}

/** 解析分辨率字符串 "1920x1080" → {width,height} */
function parseSize(str) {
  const m = /^(\d{2,5})\s*[xX×*]\s*(\d{2,5})$/.exec(String(str || '').trim());
  if (!m) return null;
  return { width: Number(m[1]), height: Number(m[2]) };
}

/** 从任意 URL 推断协议族 */
function urlKind(url) {
  const u = String(url || '').trim();
  const low = u.toLowerCase().split('?')[0];
  if (!u) return 'empty';
  if (low.startsWith('rtsp://')) return 'rtsp';
  if (low.startsWith('rtmps://')) return 'rtmps';
  if (low.startsWith('rtmp://')) return 'rtmp';
  if (low.startsWith('srt://')) return 'srt';
  if (low.startsWith('udp://') || low.startsWith('rtp://')) return 'udp';
  if (low.startsWith('mms://')) return 'mms';
  if (low.endsWith('.m3u8')) return 'hls';
  if (low.endsWith('.flv')) return 'flv';
  if (low.endsWith('.mpd')) return 'dash';
  if (low.startsWith('http://') || low.startsWith('https://')) return 'http';
  return 'file';
}

/** 把 m3u8 内相对地址解析为绝对地址 */
function resolveUrl(base, rel) {
  try {
    return new URL(rel, base).toString();
  } catch (_) {
    return rel;
  }
}

function safeJsonParse(str, fallback) {
  try { return JSON.parse(str); } catch (_) { return fallback; }
}

function slug(str, fallback = 'item') {
  const s = String(str || '')
    .normalize('NFKD')
    .replace(/[^\w\u4e00-\u9fa5.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return s || fallback;
}

module.exports = {
  uid, clamp, ensureDir, atomicWrite, readJson, debounce, execFileP, sleep,
  humanBytes, parseTime, formatDuration, defaultDataDir, parseSize, urlKind,
  resolveUrl, safeJsonParse, slug,
};
