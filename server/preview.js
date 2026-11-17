'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { ensureDir, urlKind } = require('./util');

const MIME = {
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.ts': 'video/mp2t',
  '.m4s': 'video/iso.segment',
  '.mp4': 'video/mp4',
  '.flv': 'video/x-flv',
  '.key': 'application/octet-stream',
};

const DIRECT_KINDS = new Set(['hls', 'flv', 'mp4', 'http']);

/**
 * 播放服务：
 * - 对 HLS/FLV 走本地反代（解决 CORS / Referer 防盗链）
 * - 对 RTSP/RTMP/UDP/SRT/本地文件 走 ffmpeg 转 HLS 桥接
 */
class PreviewService extends EventEmitterLite {
  constructor({ ffmpeg, dataDir, store }) {
    super();
    this.ffmpeg = ffmpeg;
    this.store = store;
    this.root = ensureDir(path.join(dataDir, 'preview'));
    this.sessions = new Map();
    this.timer = setInterval(() => this.sweep(), 10000);
    this.timer.unref?.();
  }

  keyOf(url, ua = '', ref = '') {
    return crypto.createHash('sha1').update(`${url}|${ua}|${ref}`).digest('hex').slice(0, 16);
  }

  /** 可以直接交给浏览器播放的地址 → 走反代 */
  directPlay(source) {
    const kind = urlKind(source.url);
    if (kind === 'hls' || kind === 'flv' || kind === 'http' || kind === 'mp4') {
      return `/api/proxy?u=${encodeURIComponent(source.url)}${source.userAgent ? `&ua=${encodeURIComponent(source.userAgent)}` : ''}${source.headers ? `&ref=${encodeURIComponent(extractReferer(source.headers))}` : ''}`;
    }
    return '';
  }

  async play(source, opts = {}) {
    const url = String(source.url || '').trim();
    if (!url) throw new Error('缺少播放地址');
    const ua = source.userAgent || this.store.config.settings.player.userAgent || '';
    const ref = source.referer || extractReferer(source.headers) || this.store.config.settings.player.referer || '';
    const direct = this.directPlay({ ...source, userAgent: ua, headers: source.headers || (ref ? `Referer: ${ref}` : '') });
    const mode = opts.mode || this.store.config.settings.preview.mode || 'auto';
    if (direct && mode !== 'transcode') {
      // 先确认源站真的给了流：否则把反代地址塞给 <video> 只会静默失败
      const info = await sniffKind(url, { userAgent: ua, referer: ref });
      if (!info.ok) throw new Error(friendlySniffError(info));
      const kind = info.kind && info.kind !== 'unknown' ? info.kind : urlKind(url);
      // 认不出类型时不硬塞给浏览器，改走 ffmpeg 桥接，至少能播
      if (['hls', 'flv', 'mp4', 'file'].includes(kind)) {
        return { ok: true, mode: 'proxy', playUrl: direct, kind, contentType: info.contentType || '' };
      }
    }

    const key = this.keyOf(url, ua, ref);
    const existing = this.sessions.get(key);
    if (existing && existing.alive) {
      existing.lastAccess = Date.now();
      return { ok: true, mode: 'bridge', playUrl: `/preview/${key}/index.m3u8`, reused: true };
    }

    const dir = ensureDir(path.join(this.root, key));
    for (const f of fs.readdirSync(dir)) {
      try { fs.unlinkSync(path.join(dir, f)); } catch (_) {}
    }

    // auto 模式下先探测：h264+aac 可直接转封装，省 CPU
    let copy = false;
    let videoHeight = 0;
    if (mode !== 'transcode') {
      const probe = await this.ffmpeg.probeMedia(url, { userAgent: ua, headers: source.headers, timeout: 12000 });
      if (probe.ok && probe.video) {
        videoHeight = probe.video.height || 0;
        copy = ['h264'].includes(probe.video.codec) && (!probe.audio || ['aac', 'mp3'].includes(probe.audio.codec));
      }
    }

    const maxHeight = this.store.config.settings.preview.maxHeight || 1080;
    const args = this.ffmpeg.buildPreviewArgs(
      { url },
      dir,
      { userAgent: ua, headers: source.headers, copy, videoHeight, maxHeight, bitrateKbps: opts.bitrateKbps || 3000 },
    );
    const proc = spawn(this.ffmpeg.bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const session = {
      key, dir, proc, alive: true, createdAt: Date.now(), lastAccess: Date.now(),
      url, copy, stderr: [], playUrl: `/preview/${key}/index.m3u8`,
    };
    this.sessions.set(key, session);
    const pushErr = (b) => {
      for (const line of b.toString().split(/\r?\n/)) {
        if (!line.trim()) continue;
        session.stderr.push(line.trim());
        if (session.stderr.length > 60) session.stderr.shift();
      }
    };
    proc.stderr.on('data', pushErr);
    proc.stdout.on('data', pushErr);
    proc.on('exit', () => {
      session.alive = false;
      this.emit('exit', { key });
    });

    const playlist = path.join(dir, 'index.m3u8');
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (!session.alive) break;
      if (fs.existsSync(playlist)) {
        const st = fs.statSync(playlist);
        if (st.size > 0) {
          return { ok: true, mode: 'bridge', playUrl: `/preview/${key}/index.m3u8`, copy, videoHeight };
        }
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    const tail = session.stderr.slice(-6).join('\n');
    this.stop(key);
    throw new Error(`无法拉取该流${tail ? `：${tail}` : '（超时）'}`);
  }

  touch(key) {
    const s = this.sessions.get(key);
    if (s) s.lastAccess = Date.now();
  }

  stop(key) {
    const s = this.sessions.get(key);
    if (!s) return false;
    try { s.proc.kill('SIGTERM'); } catch (_) {}
    setTimeout(() => { try { s.proc.kill('SIGKILL'); } catch (_) {} }, 2500).unref?.();
    s.alive = false;
    this.sessions.delete(key);
    return true;
  }

  sweep() {
    const idle = (this.store.config.settings.preview.idleTimeoutSec || 40) * 1000;
    const now = Date.now();
    for (const [key, s] of this.sessions) {
      if (now - s.lastAccess > idle || !s.alive) {
        this.stop(key);
        // 延迟清理目录，避免正在播放的客户端 404
        setTimeout(() => {
          try {
            for (const f of fs.readdirSync(s.dir)) {
              if (f.endsWith('.ts') || f.endsWith('.m3u8')) fs.unlinkSync(path.join(s.dir, f));
            }
          } catch (_) {}
        }, 5000).unref?.();
      }
    }
  }

  stopAll() {
    for (const k of [...this.sessions.keys()]) this.stop(k);
  }

  info() {
    return [...this.sessions.values()].map((s) => ({
      key: s.key, url: s.url, copy: s.copy, createdAt: s.createdAt, lastAccess: s.lastAccess,
    }));
  }
}

// 轻量事件基类，避免额外依赖
function EventEmitterLite() {
  this._handlers = {};
}
EventEmitterLite.prototype.on = function on(evt, fn) {
  (this._handlers[evt] = this._handlers[evt] || []).push(fn);
  return this;
};
EventEmitterLite.prototype.emit = function emit(evt, payload) {
  for (const fn of this._handlers[evt] || []) {
    try { fn(payload); } catch (_) {}
  }
};

function extractReferer(headers) {
  if (!headers) return '';
  const m = /referer:\s*(.+)/i.exec(String(headers));
  return m ? m[1].trim() : '';
}

/* ============================================================
   源站类型探测
   IPTV 里大量地址没有扩展名（/live/xx、/douyu/123456），
   只看 URL 后缀会把 HLS 当普通文件塞给 <video>，浏览器必然播不了。
   这里抓响应头 + 首块字节来判定真实类型。
   ============================================================ */
const sniffCache = new Map(); // url -> { at, info }

async function sniffKind(url, { userAgent, referer, timeout = 7000 } = {}) {
  const hit = sniffCache.get(url);
  if (hit && Date.now() - hit.at < 60000) return hit.info;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  let info;
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': userAgent || 'Mozilla/5.0 StreamPilot/1.0',
        ...(referer ? { Referer: referer } : {}),
        Accept: '*/*',
      },
    });
    const status = res.status;
    const contentType = (res.headers.get('content-type') || '').toLowerCase();
    if (!res.ok) {
      info = { ok: false, status, contentType };
    } else if (/mpegurl/.test(contentType)) {
      info = { ok: true, kind: 'hls', contentType };
    } else if (/flv/.test(contentType)) {
      info = { ok: true, kind: 'flv', contentType };
    } else if (/^video\//.test(contentType) || /^audio\//.test(contentType)) {
      info = { ok: true, kind: /mp4/.test(contentType) ? 'mp4' : 'file', contentType };
    } else {
      // content-type 不可信时看首块字节
      const head = res.body ? await readHead(res.body, 2048) : Buffer.alloc(0);
      const text = head.toString('utf8').trim();
      if (/^\uFEFF?#EXTM3U/i.test(text)) info = { ok: true, kind: 'hls', contentType };
      else if (text.slice(0, 3) === 'FLV') info = { ok: true, kind: 'flv', contentType };
      else if (head.slice(4, 8).toString() === 'ftyp') info = { ok: true, kind: 'mp4', contentType };
      else if (/^<(!doctype|html|\?xml)/i.test(text)) info = { ok: false, status, contentType, html: true };
      else info = { ok: true, kind: 'unknown', contentType };
      try { await res.body?.cancel(); } catch (_) {}
    }
  } catch (err) {
    info = { ok: false, status: 0, error: err.name === 'AbortError' ? '连接超时' : String(err.message || err) };
  } finally {
    clearTimeout(timer);
  }
  if (info.ok) sniffCache.set(url, { at: Date.now(), info });
  if (sniffCache.size > 400) sniffCache.clear();
  return info;
}

/** 只读前 n 个字节，不把直播流整个吃下去 */
async function readHead(body, n) {
  const reader = body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (total < n) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) { chunks.push(Buffer.from(value)); total += value.length; }
    }
  } catch (_) {}
  try { await reader.cancel(); } catch (_) {}
  return Buffer.concat(chunks).slice(0, n);
}

function friendlySniffError(info) {
  if (info.html) return '这个地址返回的是网页，不是视频流（可能需要登录或已失效）';
  if (info.status === 404) return '源站返回 404，该频道链接已失效';
  if (info.status === 403) return '源站返回 403，拒绝访问（可能有防盗链或地区限制）';
  if (info.status) return `源站返回 HTTP ${info.status}，暂时拉不到流`;
  return `连不上源站：${info.error || '网络错误'}`;
}

/** 把 m3u8 里的分片地址改成走本地反代 */
function rewritePlaylist(text, base) {
  const lines = String(text).split(/\r?\n/);
  return lines.map((line) => {
    const l = line.trim();
    if (!l) return line;
    if (l.startsWith('#')) {
      return l.replace(/URI="([^"]+)"/g, (_m, u) => {
        try {
          return `URI="/api/proxy?u=${encodeURIComponent(new URL(u, base).toString())}"`;
        } catch (_) {
          return `URI="${u}"`;
        }
      });
    }
    try {
      return `/api/proxy?u=${encodeURIComponent(new URL(l, base).toString())}`;
    } catch (_) {
      return line;
    }
  }).join('\n');
}

/** 反代 HLS 并重写分片地址 */
async function proxyHls(url, { userAgent, referer } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': userAgent || 'Mozilla/5.0 StreamPilot/1.0',
        ...(referer ? { Referer: referer } : {}),
        Accept: '*/*',
      },
    });
    if (!res.ok) throw new Error(`源站返回 HTTP ${res.status}`);
    const base = res.url || url;
    const ctype = (res.headers.get('content-type') || '').toLowerCase();
    // 播放列表要当文本改写分片地址：注意 HLS 常以 audio/mpegurl 返回，
    // 不能因为前缀是 audio/ 就当音视频二进制直接透传
    if (/mpegurl/.test(ctype)) {
      const text = await res.text();
      if (/^\uFEFF?#EXTM3U/i.test(text.trim())) {
        return { playlist: true, body: rewritePlaylist(text, base), base };
      }
      return { playlist: false, raw: Buffer.from(text), contentType: ctype };
    }
    // 明显是音视频流的内容不要当播放列表去读，直接原样转发，避免把二进制当文本吞掉
    if (/^(video|audio)\//.test(ctype) || ctype.includes('flv')) {
      return { playlist: false, res, contentType: ctype };
    }
    // 一次性读成 Buffer：判定不是播放列表时可以把原始字节原样交回去，
    // 否则 body 被 text() 消费完后再去 pipe 只会得到空响应
    const raw = Buffer.from(await res.arrayBuffer());
    const text = raw.toString('utf8').replace(/^\uFEFF/, '');
    if (!/^#EXTM3U/i.test(text.trim())) {
      return { playlist: false, res, raw, contentType: ctype || 'application/octet-stream' };
    }
    const lines = text.split(/\r?\n/);
    return { playlist: true, body: rewritePlaylist(lines.join('\n'), base), base };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { PreviewService, proxyHls, MIME, extractReferer, sniffKind, rewritePlaylist, friendlySniffError };
