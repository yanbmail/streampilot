'use strict';

const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const {
  uid, ensureDir, atomicWrite, readJson, debounce, clamp,
} = require('./util');

const CONFIG_VERSION = 4;

/** 单个推流目标的默认字段 */
function targetDefaults() {
  return {
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
  };
}

/** 阶梯转码默认结构：一次解码出多档，分别推不同平台 */
function ladderDefaults() {
  return { enabled: false, rungs: [] };
}

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
    target: targetDefaults(),
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
    // 一份编码同时分发到多个目标（除主目标外）
    targets: [],
    // 推流同时录制一份到本地磁盘
    record: {
      enabled: false,
      filePath: '',
      recordFormat: 'mp4', // mp4 | ts | mkv
    },
    // 多码率阶梯转码：一次解码出多档，每档推各自的平台
    ladder: ladderDefaults(),
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
      // 内置 RTMP 收流服务端：不装 nginx 也能接收 OBS / 手机 / 其他设备推上来的流
      rtmpServer: {
        enabled: false,
        port: 1935,
        httpPort: 8399,
        chunkSize: 60000,
        gopCache: true,
        autoStart: false,
      },
      ui: { page: 'dashboard', theme: 'dark' },
      defaults: {
        video: jobDefaults().video,
        audio: jobDefaults().audio,
      },
    },
    jobs: [],
    // 一周排播表：按天 + 时段自动开播 / 自动停播
    schedule: {
      enabled: true,
      tasks: [],
    },
    // 推流模板：一套码率/分辨率/目标存起来，新任务一键套用
    templates: [],
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

/** 规范化一个推流目标（主目标 / 附加目标 / 阶梯某档共用） */
function normalizeTarget(input = {}) {
  const t = { ...targetDefaults(), ...(input || {}) };
  if (!PROTOCOLS.includes(t.protocol)) t.protocol = 'rtmp';
  t.port = clamp(t.port, 0, 65535, 0);
  t.srtLatency = clamp(t.srtLatency, 20, 8000, 200);
  t.udpTTL = clamp(t.udpTTL, 0, 255, 1);
  t.hlsSegmentSeconds = clamp(t.hlsSegmentSeconds, 1, 15, 2);
  t.hlsListSize = clamp(t.hlsListSize, 2, 60, 6);
  t.flvListenPort = clamp(t.flvListenPort, 1024, 65535, 8380);
  t.app = String(t.app || 'live').replace(/^\/+|\/+$/g, '');
  t.streamKey = String(t.streamKey || '');
  t.host = String(t.host || '');
  t.url = String(t.url || '').trim();
  t.filePath = String(t.filePath || '');
  return t;
}

/**
 * 按目标高度推荐三档阶梯（1080 / 720 / 480）。
 * 前端「一键生成阶梯」与后端兜底都用它，避免两边算得不一样。
 */
function suggestRungs(video = {}) {
  const baseH = clamp(video.height, 240, 2160, 1080);
  const baseFps = clamp(video.fps, 1, 120, 30);
  const tiers = [
    { h: 1080, kbps: 6000 },
    { h: 720, kbps: 3000 },
    { h: 480, kbps: 1200 },
  ].filter((x) => x.h <= Math.max(480, baseH));
  const list = tiers.length ? tiers : [{ h: baseH, kbps: Math.round(baseH * 5.5) }];
  return list.map((t, i) => ({
    id: `r${i + 1}`,
    name: `${t.h}P`,
    width: Math.round((t.h * 16) / 9 / 2) * 2,
    height: t.h,
    fps: Math.min(baseFps, t.h >= 720 ? baseFps : 30),
    bitrateKbps: t.kbps,
    maxBitrateKbps: 0,
    preset: video.preset || 'veryfast',
    profile: t.h >= 720 ? 'high' : 'main',
    target: targetDefaults(),
  }));
}

function normalizeRung(r = {}, i = 0, job = {}) {
  const v = job.video || {};
  let width = clamp(r.width, 128, 7680, 1280);
  let height = clamp(r.height, 128, 4320, 720);
  width -= width % 2;
  height -= height % 2;
  return {
    id: String(r.id || `r${i + 1}`).slice(0, 12),
    name: String(r.name || `${height}P`).slice(0, 24),
    width,
    height,
    fps: clamp(r.fps || v.fps, 1, 120, 30),
    bitrateKbps: clamp(r.bitrateKbps, 100, 200000, Math.round(height * 5.5)),
    maxBitrateKbps: clamp(r.maxBitrateKbps, 0, 200000, 0),
    preset: String(r.preset || v.preset || 'veryfast'),
    profile: ['baseline', 'main', 'high'].includes(r.profile) ? r.profile : (height >= 720 ? 'high' : 'main'),
    target: normalizeTarget(r.target || {}),
  };
}

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

  merged.target = normalizeTarget(merged.target);

  const adv = merged.advanced;
  adv.reconnectDelaySec = clamp(adv.reconnectDelaySec, 1, 120, 3);
  adv.maxReconnect = clamp(adv.maxReconnect, 0, 9999, 0);
  adv.threadQueue = clamp(adv.threadQueue, 32, 8192, 512);

  // 附加分发目标（一份编码推多路）
  const rawTargets = Array.isArray(merged.targets) ? merged.targets : [];
  merged.targets = rawTargets.slice(0, 8).map((x) => {
    const o = normalizeTarget(x);
    o.name = String(x.name || '').slice(0, 60);
    // 空行（没填任何地址）直接丢弃，避免生成无效 slave
    const empty = !o.url && !o.host && !o.streamKey;
    return empty ? null : o;
  }).filter(Boolean);

  const rec = merged.record || {};
  rec.enabled = Boolean(rec.enabled);
  rec.filePath = String(rec.filePath || '');
  rec.recordFormat = ['mp4', 'ts', 'mkv'].includes(rec.recordFormat) ? rec.recordFormat : 'mp4';
  merged.record = rec;

  // 录制文件扩展名与容器保持一致
  if (rec.enabled && rec.filePath) {
    const ext = path.extname(rec.filePath).toLowerCase().replace('.', '');
    if (['mp4', 'ts', 'mkv', 'flv', 'mov'].includes(ext)) rec.recordFormat = ext === 'mov' ? 'mp4' : ext;
  }

  // 多码率阶梯转码（一次解码出多档，每档推各自的平台）
  const ladder = merged.ladder || ladderDefaults();
  ladder.enabled = Boolean(ladder.enabled);
  const rawRungs = Array.isArray(ladder.rungs) ? ladder.rungs : [];
  ladder.rungs = rawRungs.slice(0, 4).map((r, i) => normalizeRung(r, i, merged));
  if (ladder.enabled && ladder.rungs.length < 2) ladder.rungs = suggestRungs(merged.video);
  if (ladder.rungs.length < 2) ladder.enabled = false;
  merged.ladder = ladder;

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

/** 把 "HH:MM" / "H:M" / "HHMM" 统一成 "HH:MM"，非法值退回 fallback */
function normalizeClock(value, fallback = '20:00') {
  const m = /^(\d{1,2})[:：]?(\d{2})$/.exec(String(value || '').trim());
  if (!m) return fallback;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (hh > 23 || mm > 59) return fallback;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

/** 一条排播计划：每周哪几天、几点开、几点停 */
function normalizeScheduleTask(input = {}, prev = null) {
  const base = { ...(prev || {}), ...(input || {}) };
  const days = Array.isArray(base.days)
    ? [...new Set(base.days.map((d) => Number(d)).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort()
    : [];
  const endMode = base.endMode === 'duration' ? 'duration' : 'time';
  return {
    id: prev?.id || String(base.id || '').trim() || uid('sch'),
    name: String(base.name || '未命名排播').slice(0, 60),
    jobId: String(base.jobId || ''),
    enabled: base.enabled === undefined ? true : Boolean(base.enabled),
    days,
    start: normalizeClock(base.start, '20:00'),
    end: normalizeClock(base.end, '22:00'),
    endMode,
    durationMin: clamp(base.durationMin, 1, 1440, 60),
    note: String(base.note || '').slice(0, 300),
    createdAt: prev?.createdAt || Number(base.createdAt) || Date.now(),
    updatedAt: Date.now(),
  };
}

/** 推流模板：保存一套画面/音频/目标配置，新任务一键套用 */
function normalizeTemplate(input = {}, prev = null) {
  const base = { ...(prev || {}), ...(input || {}) };
  const job = normalizeJob({
    ...(prev ? JSON.parse(JSON.stringify(prev)) : {}),
    ...base,
    name: base.name || '未命名模板',
    id: prev?.id || base.id || uid('tpl'),
  }, null);
  return {
    id: job.id,
    name: String(base.name || '未命名模板').slice(0, 60),
    desc: String(base.desc || '').slice(0, 300),
    icon: String(base.icon || '').slice(0, 8),
    video: job.video,
    audio: job.audio,
    target: job.target,
    targets: job.targets,
    record: job.record,
    ladder: job.ladder,
    advanced: job.advanced,
    createdAt: prev?.createdAt || Number(base.createdAt) || Date.now(),
    updatedAt: Date.now(),
  };
}

/** 把模板内容套到任务上（只覆盖模板包含的字段） */
function applyTemplate(job, template) {
  if (!template) return job;
  const patch = { ...job };
  for (const key of ['video', 'audio', 'target', 'targets', 'record', 'ladder', 'advanced']) {
    if (template[key] === undefined || template[key] === null) continue;
    patch[key] = JSON.parse(JSON.stringify(template[key]));
  }
  return normalizeJob(patch, job);
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
      merged.version = CONFIG_VERSION;
      merged.jobs = (merged.jobs || []).map((j) => normalizeJob(j, null));
      merged.schedule = merged.schedule || { enabled: true, tasks: [] };
      merged.schedule.tasks = (merged.schedule.tasks || []).map((t) => normalizeScheduleTask(t, null));
      merged.templates = (merged.templates || []).map((t) => normalizeTemplate(t, null));
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
    merged.version = CONFIG_VERSION;
    merged.jobs = (merged.jobs || []).map((j) => normalizeJob(j, null));
    merged.schedule = merged.schedule || { enabled: true, tasks: [] };
    merged.schedule.tasks = (merged.schedule.tasks || []).map((t) => normalizeScheduleTask(t, null));
    merged.templates = (merged.templates || []).map((t) => normalizeTemplate(t, null));
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

  /* ---------------- 排播表 ---------------- */
  get schedule() {
    if (!this.config.schedule) this.config.schedule = { enabled: true, tasks: [] };
    if (!Array.isArray(this.config.schedule.tasks)) this.config.schedule.tasks = [];
    return this.config.schedule;
  }

  listScheduleTasks() {
    return this.schedule.tasks;
  }

  getScheduleTask(id) {
    return this.schedule.tasks.find((t) => t.id === id) || null;
  }

  upsertScheduleTask(input = {}) {
    const prev = input.id ? this.getScheduleTask(input.id) : null;
    const task = normalizeScheduleTask(input, prev);
    if (prev) {
      const idx = this.schedule.tasks.findIndex((t) => t.id === prev.id);
      this.schedule.tasks[idx] = task;
    } else {
      this.schedule.tasks.push(task);
    }
    this.touch('schedule');
    return task;
  }

  removeScheduleTask(id) {
    const idx = this.schedule.tasks.findIndex((t) => t.id === id);
    if (idx < 0) return false;
    this.schedule.tasks.splice(idx, 1);
    this.touch('schedule');
    return true;
  }

  setScheduleEnabled(enabled) {
    this.schedule.enabled = Boolean(enabled);
    this.touch('schedule');
    return this.schedule.enabled;
  }

  /* ---------------- 模板 ---------------- */
  listTemplates() {
    if (!Array.isArray(this.config.templates)) this.config.templates = [];
    return this.config.templates;
  }

  getTemplate(id) {
    return this.listTemplates().find((t) => t.id === id) || null;
  }

  upsertTemplate(input = {}) {
    const prev = input.id ? this.getTemplate(input.id) : null;
    const tpl = normalizeTemplate(input, prev);
    const list = this.listTemplates();
    if (prev) list[list.findIndex((t) => t.id === prev.id)] = tpl;
    else list.push(tpl);
    this.touch('template');
    return tpl;
  }

  removeTemplate(id) {
    const list = this.listTemplates();
    const idx = list.findIndex((t) => t.id === id);
    if (idx < 0) return false;
    list.splice(idx, 1);
    this.touch('template');
    return true;
  }
}

module.exports = {
  Store, defaultConfig, jobDefaults, normalizeJob, buildTargetUrl, deepDefaults,
  normalizeTarget, targetDefaults, ladderDefaults, normalizeRung, suggestRungs,
  normalizeScheduleTask, normalizeClock, normalizeTemplate, applyTemplate,
  PROTOCOLS, SOURCE_TYPES, CONFIG_VERSION,
};
