'use strict';

const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const {
  uid, ensureDir, atomicWrite, readJson, debounce, clamp,
} = require('./util');

const CONFIG_VERSION = 3;

function jobDefaults() {
  return {
    id: '',
    name: '',
    createdAt: 0,
    updatedAt: 0,
    autoStart: false,
    note: '',
    source: {
      type: 'test',
      path: '',
      paths: [],
      url: '',
      loop: false,
      headers: '',
      userAgent: '',
      screen: {
        display: 0, x: 0, y: 0, width: 0, height: 0, fps: 30, cursor: true,
      },
      camera: {
        videoDevice: '', audioDevice: '', width: 1280, height: 720, fps: 30,
      },
      testPattern: 'testsrc2',
    },
    video: {
      mode: 'transcode',
      codec: 'h264',
      encoder: 'libx264',
      preset: 'veryfast',
      width: 1920,
      height: 1080,
      fps: 30,
      rateControl: 'cbr',
      bitrateKbps: 6000,
      maxBitrateKbps: 0,
      crf: 21,
      gopSeconds: 2,
      profile: 'high',
      scaling: 'fit', // fit(等比+黑边) | cover(裁剪填满) | stretch(拉伸)
    },
    audio: {
      mode: 'transcode', // transcode | copy | none
      codec: 'aac',
      bitrateKbps: 128,
      sampleRate: 44100,
      channels: 2,
    },
    target: {
      protocol: 'rtmp', // rtmp | rtmps | rtsp | srt | udp | hls | file | flv
      host: '',
      port: 0,
      app: 'live',
      streamKey: '',
      url: '', // 直填完整地址时优先使用
      srtLatency: 200,
      srtPassphrase: '',
      udpTTL: 1,
      hlsDir: '',
      hlsSegmentSeconds: 2,
      hlsListSize: 6,
      filePath: '',
      recordFormat: 'mp4',
      flvListenPort: 8380,
    },
    advanced: {
      reconnect: true,
      reconnectDelaySec: 3,
      maxReconnect: 0, // 0 = 无限
      inputReconnect: true,
      threadQueue: 512,
      logLevel: 'info',
      extraInputArgs: '',
      extraOutputArgs: '',
      copyTimestamps: false,
      realtime: true,
    },
  };
}

function defaultConfig() {
  return {
    version: CONFIG_VERSION,
    settings: {
      ffmpegPath: '',
      ffprobePath: '',
      dataDir: '',
      http: { port: 8377, host: '127.0.0.1', allowLan: false, lanToken: '' },
      player: {
        proxy: true,
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36',
        referer: '',
        lowLatency: true,
        volume: 0.85,
        favoriteOnly: false,
      },
      preview: { maxHeight: 1080, mode: 'auto', idleTimeoutSec: 40 },
      iptv: { autoRefreshHours: 12, concurrency: 10 },
      backup: { enabled: true, intervalMin: 30, keep: 40 },
      ui: { page: 'dashboard', theme: 'dark' },
      defaults: {
        video: jobDefaults().video,
        audio: jobDefaults().audio,
      },
    },
    jobs: [],
    player: {
      history: [],
      favorites: [],
      playlist: [],
      current: '',
    },
  };
}

/** 合并深层默认值（只补齐缺失字段，不覆盖用户值） */
function deepDefaults(base, override) {
  if (Array.isArray(base)) return Array.isArray(override) ? override : base;
  if (base && typeof base === 'object') {
    const out = {};
    const src = override && typeof override === 'object' ? override : {};
    for (const key of Object.keys(base)) out[key] = deepDefaults(base[key], src[key]);
    for (const key of Object.keys(src)) if (!(key in out)) out[key] = src[key];
    return out;
  }
  return override === undefined ? base : override;
}

const PROTOCOLS = ['rtmp', 'rtmps', 'rtsp', 'srt', 'udp', 'hls', 'file', 'flv'];
const SOURCE_TYPES = ['test', 'file', 'files', 'screen', 'camera', 'url'];

function normalizeJob(input = {}, prev = null) {
  const base = prev ? JSON.parse(JSON.stringify(prev)) : jobDefaults();
  const merged = deepDefaults(base, input);

  merged.id = prev?.id || merged.id || uid('job');
  merged.name = String(merged.name || '未命名任务').slice(0, 80);
  merged.createdAt = prev?.createdAt || merged.createdAt || Date.now();
  merged.updatedAt = Date.now();
  merged.note = String(merged.note || '').slice(0, 500);

  const s = merged.source;
  if (!SOURCE_TYPES.includes(s.type)) s.type = 'test';
  s.loop = Boolean(s.loop);
  s.screen.display = clamp(s.screen.display, 0, 8, 0);
  s.screen.x = clamp(s.screen.x, 0, 20000, 0);
  s.screen.y = clamp(s.screen.y, 0, 20000, 0);
  s.screen.width = clamp(s.screen.width, 0, 20000, 0);
  s.screen.height = clamp(s.screen.height, 0, 20000, 0);
  s.screen.fps = clamp(s.screen.fps, 1, 120, 30);
  s.camera.width = clamp(s.camera.width, 160, 7680, 1280);
  s.camera.height = clamp(s.camera.height, 120, 4320, 720);
  s.camera.fps = clamp(s.camera.fps, 1, 120, 30);

  const v = merged.video;
  if (!['transcode', 'copy'].includes(v.mode)) v.mode = 'transcode';
  if (!['h264', 'hevc'].includes(v.codec)) v.codec = 'h264';
  v.width = clamp(v.width, 128, 7680, 1920);
  v.height = clamp(v.height, 128, 4320, 1080);
  v.width -= v.width % 2;
  v.height -= v.height % 2;
  v.fps = clamp(v.fps, 1, 120, 30);
  v.bitrateKbps = clamp(v.bitrateKbps, 100, 200000, 6000);
  v.maxBitrateKbps = clamp(v.maxBitrateKbps, 0, 200000, 0);
  v.crf = clamp(v.crf, 0, 51, 21);
  v.gopSeconds = clamp(v.gopSeconds, 0.5, 10, 2);
  if (!['cbr', 'vbr', 'crf'].includes(v.rateControl)) v.rateControl = 'cbr';
  if (!['fit', 'cover', 'stretch'].includes(v.scaling)) v.scaling = 'fit';

  const a = merged.audio;
  if (!['transcode', 'copy', 'none'].includes(a.mode)) a.mode = 'transcode';
  if (!['aac', 'opus', 'mp3', 'ac3'].includes(a.codec)) a.codec = 'aac';
  a.bitrateKbps = clamp(a.bitrateKbps, 32, 512, 128);
  a.sampleRate = clamp(a.sampleRate, 8000, 192000, 44100);
  a.channels = clamp(a.channels, 1, 8, 2);

  const t = merged.target;
  if (!PROTOCOLS.includes(t.protocol)) t.protocol = 'rtmp';
  t.port = clamp(t.port, 0, 65535, 0);
  t.srtLatency = clamp(t.srtLatency, 20, 8000, 200);
  t.udpTTL = clamp(t.udpTTL, 0, 255, 1);
  t.hlsSegmentSeconds = clamp(t.hlsSegmentSeconds, 1, 15, 2);
  t.hlsListSize = clamp(t.hlsListSize, 2, 60, 6);
  t.flvListenPort = clamp(t.flvListenPort, 1024, 65535, 8380);
  t.app = String(t.app || 'live').replace(/^\/+|\/+$/g, '');
  t.streamKey = String(t.streamKey || '');

  const adv = merged.advanced;
  adv.reconnectDelaySec = clamp(adv.reconnectDelaySec, 1, 120, 3);
  adv.maxReconnect = clamp(adv.maxReconnect, 0, 9999, 0);
  adv.threadQueue = clamp(adv.threadQueue, 32, 8192, 512);
  return merged;
}

/**
 * 目标地址组装。返回 { url, muxer, extraArgs[] }
 */
function buildTargetUrl(t) {
  const port = t.port || 0;
  const custom = String(t.url || '').trim();
  const join = (host, p, app, key) => {
    const seg = [app, key].filter(Boolean).join('/');
    return `${host}${p ? ':' + p : ''}/${seg}`;
  };
  switch (t.protocol) {
    case 'rtmp':
    case 'rtmps': {
      const scheme = t.protocol;
      const defPort = scheme === 'rtmps' ? 443 : 1935;
      const url = custom || `${scheme}://${t.host || 'localhost'}:${port || defPort}/${[t.app, t.streamKey].filter(Boolean).join('/')}`;
      return { url, muxer: 'flv', extra: ['-flvflags', 'no_duration_filesize'] };
    }
    case 'rtsp': {
      const url = custom || `rtsp://${t.host || 'localhost'}:${port || 8554}/${[t.app, t.streamKey].filter(Boolean).join('/')}`;
      return { url, muxer: 'rtsp', extra: ['-rtsp_transport', 'tcp', '-muxdelay', '0.1'] };
    }
    case 'srt': {
      const params = new URLSearchParams();
      params.set('mode', 'caller');
      params.set('latency', String(t.srtLatency * 1000));
      if (t.srtPassphrase) { params.set('passphrase', t.srtPassphrase); params.set('pbkeylen', '16'); }
      const url = custom || `srt://${t.host || 'localhost'}:${port || 9000}?${params.toString()}`;
      return { url, muxer: 'mpegts', extra: [] };
    }
    case 'udp': {
      const url = custom || `udp://${t.host || '239.0.0.1'}:${port || 1234}?ttl=${t.udpTTL}&pkt_size=1316`;
      return { url, muxer: 'mpegts', extra: [] };
    }
    case 'hls': {
      return { url: custom || '', muxer: 'hls', extra: [] };
    }
    case 'file': {
      return { url: t.filePath || '', muxer: '', extra: [] };
    }
    case 'flv': {
      const u = custom || `http://0.0.0.0:${t.flvListenPort || 8380}/live.flv`;
      return { url: u, muxer: 'flv', extra: ['-listen', '1'], listen: true };
    }
    default:
      return { url: custom, muxer: 'flv', extra: [] };
  }
}

class Store extends EventEmitter {
  constructor(dataDir) {
    super();
    this.dataDir = dataDir;
    this.configPath = path.join(dataDir, 'config.json');
    this.backupDir = path.join(dataDir, 'backups');
    this.channelsPath = path.join(dataDir, 'channels.json');
    this.config = defaultConfig();
    this.channels = [];
    this.lastBackupAt = 0;
    this.persist = debounce(() => this.saveNow(), 700);
  }

  load() {
    ensureDir(this.dataDir);
    ensureDir(this.backupDir);
    const raw = readJson(this.configPath, null);
    if (raw) {
      const merged = deepDefaults(defaultConfig(), raw);
      merged.jobs = (merged.jobs || []).map((j) => normalizeJob(j, null));
      this.config = merged;
    } else {
      this.config = defaultConfig();
      this.config.settings.dataDir = this.dataDir;
      this.saveNow();
    }
    this.config.settings.dataDir = this.dataDir;
    this.channels = readJson(this.channelsPath, []) || [];
    return this.config;
  }

  saveNow() {
    try {
      ensureDir(this.dataDir);
      if (fs.existsSync(this.configPath)) {
        fs.copyFileSync(this.configPath, `${this.configPath}.bak`);
      }
      atomicWrite(this.configPath, JSON.stringify(this.config, null, 2));
      this.maybeSnapshot();
      this.emit('saved');
    } catch (err) {
      this.emit('error', err);
    }
  }

  touch(scope = 'config') {
    this.persist();
    this.emit('changed', scope);
  }

  saveChannels(list) {
    this.channels = list;
    try {
      atomicWrite(this.channelsPath, JSON.stringify(list));
    } catch (_) {}
  }

  maybeSnapshot(force = false) {
    const b = this.config.settings.backup;
    if (!b?.enabled && !force) return null;
    const now = Date.now();
    const interval = Math.max(1, Number(b?.intervalMin || 30)) * 60000;
    if (!force && now - this.lastBackupAt < interval) return null;
    this.lastBackupAt = now;
    ensureDir(this.backupDir);
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    const file = path.join(this.backupDir, `config-${stamp}.json`);
    try {
      fs.writeFileSync(file, JSON.stringify(this.config, null, 2));
      this.rotateSnapshots();
      return file;
    } catch (err) {
      this.emit('error', err);
      return null;
    }
  }

  rotateSnapshots() {
    const keep = Math.max(5, Number(this.config.settings.backup?.keep || 40));
    const files = fs.readdirSync(this.backupDir)
      .filter((f) => f.startsWith('config-') && f.endsWith('.json'))
      .map((f) => ({ f, t: fs.statSync(path.join(this.backupDir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    files.slice(keep).forEach(({ f }) => {
      try { fs.unlinkSync(path.join(this.backupDir, f)); } catch (_) {}
    });
  }

  listBackups() {
    if (!fs.existsSync(this.backupDir)) return [];
    return fs.readdirSync(this.backupDir)
      .filter((f) => f.startsWith('config-') && f.endsWith('.json'))
      .map((f) => {
        const p = path.join(this.backupDir, f);
        const st = fs.statSync(p);
        return { name: f, path: p, size: st.size, mtime: st.mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
  }

  restoreBackup(name) {
    const file = path.join(this.backupDir, path.basename(String(name || '')));
    if (!fs.existsSync(file)) throw new Error('备份文件不存在');
    const raw = readJson(file, null);
    if (!raw) throw new Error('备份文件内容无效');
    this.maybeSnapshot(true);
    const merged = deepDefaults(defaultConfig(), raw);
    merged.jobs = (merged.jobs || []).map((j) => normalizeJob(j, null));
    this.config = merged;
    this.config.settings.dataDir = this.dataDir;
    this.saveNow();
    this.emit('changed', 'restore');
    return this.config;
  }

  getJob(id) {
    return this.config.jobs.find((j) => j.id === id) || null;
  }

  upsertJob(input) {
    const prev = input.id ? this.getJob(input.id) : null;
    const job = normalizeJob(input, prev);
    if (prev) {
      const idx = this.config.jobs.findIndex((j) => j.id === prev.id);
      this.config.jobs[idx] = job;
    } else {
      this.config.jobs.push(job);
    }
    this.touch('job');
    return job;
  }

  removeJob(id) {
    const idx = this.config.jobs.findIndex((j) => j.id === id);
    if (idx < 0) return false;
    this.config.jobs.splice(idx, 1);
    this.touch('job');
    return true;
  }

  updateSettings(patch = {}) {
    this.config.settings = deepDefaults(this.config.settings, patch);
    this.touch('settings');
    return this.config.settings;
  }
}

module.exports = {
  Store, defaultConfig, jobDefaults, normalizeJob, buildTargetUrl, deepDefaults,
  PROTOCOLS, SOURCE_TYPES, CONFIG_VERSION,
};
