'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const { Store } = require('./config');
const { jobDefaults, normalizeJob, buildTargetUrl } = require('./config');
const { FFmpegService } = require('./ffmpeg');
const { JobManager } = require('./jobs');
const { IPTVService } = require('./iptv');
const { PreviewService, proxyHls, MIME } = require('./preview');
const {
  ensureDir, defaultDataDir, uid, humanBytes, formatDuration, clamp, urlKind,
} = require('./util');

const WEB_ROOT = path.join(__dirname, '..', 'web');
const VENDOR_MAP = {
  '/vendor/hls.min.js': path.join(__dirname, '..', 'node_modules', 'hls.js', 'dist', 'hls.min.js'),
  '/vendor/mpegts.js': path.join(__dirname, '..', 'node_modules', 'mpegts.js', 'dist', 'mpegts.js'),
};

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.ts': 'video/mp2t',
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req, limit = 32 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (err) { reject(new Error('JSON 格式错误')); }
    });
    req.on('error', reject);
  });
}

async function createApp(options = {}) {
  const dataDir = options.dataDir || defaultDataDir();
  ensureDir(dataDir);
  const store = new Store(dataDir);
  store.load();

  const ffmpeg = new FFmpegService();
  const resolved = await ffmpeg.resolve(store.config.settings);
  if (resolved.ok) {
    store.config.settings.ffmpegPath = store.config.settings.ffmpegPath || resolved.path;
    await ffmpeg.probeCapabilities();
  }

  const hlsRoot = ensureDir(path.join(dataDir, 'hls'));
  const jobs = new JobManager({ store, ffmpeg, dataDir, hlsRoot });
  const iptv = new IPTVService({ store, dataDir });
  iptv.load();
  const preview = new PreviewService({ ffmpeg, dataDir, store });

  const sseClients = new Set();
  const globalLogs = [];
  const pendingStats = new Map();

  function broadcast(event, data) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of sseClients) {
      try { res.write(payload); } catch (_) { sseClients.delete(res); }
    }
  }

  jobs.on('log', (entry) => {
    globalLogs.push(entry);
    if (globalLogs.length > 1500) globalLogs.shift();
    broadcast('log', entry);
  });
  jobs.on('state', (s) => broadcast('job-state', { ...s, runtime: jobs.runtime(s.jobId) }));
  jobs.on('stats', ({ jobId, stats }) => {
    pendingStats.set(jobId, stats);
  });
  const statsTimer = setInterval(() => {
    if (!pendingStats.size) return;
    const payload = {};
    for (const [jobId, stats] of pendingStats) payload[jobId] = stats;
    pendingStats.clear();
    broadcast('stats', payload);
  }, 1000);
  statsTimer.unref?.();

  store.on('changed', () => broadcast('config', { scope: 'changed' }));
  iptv.on('refresh', (p) => broadcast('iptv-refresh', p));
  iptv.on('changed', () => broadcast('iptv', iptv.stats()));

  // 系统信息
  const systemInfo = () => ({
    platform: process.platform,
    arch: process.arch,
    node: process.versions.node,
    appVersion: require('../package.json').version,
    dataDir,
    ffmpeg: {
      ok: Boolean(resolved.ok),
      path: ffmpeg.bin,
      ffprobe: ffmpeg.probeBin,
      version: ffmpeg.caps?.version || '',
      versionLine: ffmpeg.caps?.versionLine || '',
      protocols: ffmpeg.caps?.protocols || [],
      encoders: ffmpeg.caps?.encoders || [],
      filters: ffmpeg.caps?.filters || [],
      hardware: (ffmpeg.caps?.encoders || []).filter((e) => /videotoolbox|nvenc|qsv|amf|vaapi/.test(e)),
    },
    addresses: ffmpeg.localAddresses(),
    hlsRoot,
    uptime: process.uptime(),
    memory: process.memoryUsage().rss,
  });

  const statePayload = () => ({
    ok: true,
    config: store.config,
    runtime: jobs.snapshot(),
    system: systemInfo(),
    template: jobDefaults(),
    iptv: { ...iptv.stats(), catalogs: iptv.listCatalogs() },    backups: store.listBackups().slice(0, 20).map((b) => ({
      ...b, human: humanBytes(b.size),
    })),
    preview: preview.info(),
    serverTime: Date.now(),
  });

  const handler = async (req, res) => {
    const parsed = url.parse(req.url, true);
    const pathname = decodeURIComponent(parsed.pathname || '/');
    const query = parsed.query || {};

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Streampilot-Token');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    // 局域网访问令牌校验（本机请求免校验）
    const needToken = Boolean(store.config.settings.http?.lanToken) && !isLocal(req);
    if (needToken) {
      const token = query.token || req.headers['x-streampilot-token'];
      if (token !== store.config.settings.http.lanToken) {
        return sendJson(res, 401, { ok: false, error: '访问令牌无效' });
      }
    }

    try {
      // ---------- 事件流 ----------
      if (pathname === '/api/events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        res.write('retry: 3000\n\n');
        res.write(`event: hello\ndata: ${JSON.stringify({ ok: true })}\n\n`);
        sseClients.add(res);
        const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch (_) {} }, 20000);
        req.on('close', () => { clearInterval(ping); sseClients.delete(res); });
        return;
      }

      // ---------- 状态 ----------
      if (pathname === '/api/state') return sendJson(res, 200, statePayload());

      if (pathname === '/api/system') return sendJson(res, 200, { ok: true, system: systemInfo() });

      if (pathname === '/api/system/redetect' && req.method === 'POST') {
        const r = await ffmpeg.resolve(store.config.settings);
        if (r.ok) {
          store.config.settings.ffmpegPath = r.path;
          await ffmpeg.probeCapabilities(true);
          store.touch('settings');
        }
        return sendJson(res, 200, { ok: r.ok, system: systemInfo() });
      }

      if (pathname === '/api/devices') {
        const devices = await ffmpeg.listDevices();
        return sendJson(res, 200, { ok: true, devices });
      }

      if (pathname === '/api/screen-size') {
        const size = await ffmpeg.screenSize(Number(query.index || 0));
        return sendJson(res, 200, size);
      }

      // 系统原生文件选择（仅桌面模式）
      if (pathname === '/api/pick-files' && req.method === 'POST') {
        if (typeof options.pickFiles !== 'function') {
          return sendJson(res, 200, { ok: false, error: '浏览器模式请手动输入路径或使用 URL 源' });
        }
        const body = await readBody(req).catch(() => ({}));
        const files = await options.pickFiles({
          multiple: Boolean(body.multiple),
          kind: body.kind || 'media',
        });
        return sendJson(res, 200, { ok: true, files: files || [] });
      }
      if (pathname === '/api/pick-folder' && req.method === 'POST') {
        if (typeof options.pickFolder !== 'function') {
          return sendJson(res, 200, { ok: false, error: '浏览器模式请手动输入路径' });
        }
        const dir = await options.pickFolder();
        return sendJson(res, 200, { ok: true, dir: dir || '' });
      }
      if (pathname === '/api/pick-save' && req.method === 'POST') {
        if (typeof options.pickSave !== 'function') {
          return sendJson(res, 200, { ok: false, error: '浏览器模式请手动输入保存路径' });
        }
        const body = await readBody(req).catch(() => ({}));
        const file = await options.pickSave({ defaultName: body.defaultName || 'record.mp4' });
        return sendJson(res, 200, { ok: true, file: file || '' });
      }

      if (pathname === '/api/caps') {
        const caps = await ffmpeg.probeCapabilities();
        const encoders = ['libx264', 'h264_videotoolbox', 'libx265', 'hevc_videotoolbox', 'libsvtav1', 'h264_nvenc']
          .filter((e) => caps.encoders.includes(e))
          .map((e) => ({ id: e, label: ffmpeg.describeEncoder(e) }));
        return sendJson(res, 200, { ok: true, caps, encoders });
      }

      if (pathname === '/api/probe' && req.method === 'POST') {
        const body = await readBody(req);
        const info = await ffmpeg.probeMedia(body.target, { userAgent: body.userAgent, headers: body.headers });
        return sendJson(res, 200, info);
      }

      // ---------- 任务 ----------
      if (pathname === '/api/jobs' && req.method === 'GET') {
        return sendJson(res, 200, { ok: true, jobs: store.config.jobs, runtime: jobs.snapshot() });
      }

      if (pathname === '/api/jobs/preview' && req.method === 'POST') {
        const body = await readBody(req);
        const job = normalizeJob(body, null);
        const prep = jobs.prepare(job);
        const args = ffmpeg.buildStreamArgs(job, {
          target: prep.target, concatFile: prep.concatFile, hlsRoot, warn: () => {},
        });
        const quote = (a) => (/[\s'"$`]/.test(a) ? `'${a.replace(/'/g, `'\\''`)}'` : a);
        return sendJson(res, 200, {
          ok: true,
          command: `${ffmpeg.bin} ${args.map(quote).join(' ')}`,
          targetUrl: prep.target.url,
          warnings: prep.warnings,
        });
      }

      if (pathname === '/api/jobs' && req.method === 'POST') {
        const body = await readBody(req);
        const job = store.upsertJob(body);
        jobs.log(job.id, `任务已创建：${job.name}`, 'ok');
        if (job.autoStart) {
          setTimeout(() => { jobs.start(job.id).catch((e) => jobs.log(job.id, e.message, 'error')); }, 300);
        }
        return sendJson(res, 200, { ok: true, job, runtime: jobs.runtime(job.id) });
      }

      const jobMatch = /^\/api\/jobs\/([\w-]+)(\/[a-z-]+)?$/.exec(pathname);
      if (jobMatch) {
        const id = jobMatch[1];
        const action = jobMatch[2] || '';
        const job = store.getJob(id);
        if (!job) return sendJson(res, 404, { ok: false, error: '任务不存在' });

        if (req.method === 'GET' && !action) {
          return sendJson(res, 200, { ok: true, job, runtime: jobs.runtime(id), logs: jobs.getLogs(id) });
        }
        if (req.method === 'PATCH' && !action) {
          const body = await readBody(req);
          const updated = store.upsertJob({ ...body, id });
          if (jobs.runtime(id).status === 'running') {
            jobs.log(id, '配置已更新，重启任务后生效', 'warn');
          }
          return sendJson(res, 200, { ok: true, job: updated, runtime: jobs.runtime(id) });
        }
        if (req.method === 'DELETE' && !action) {
          await jobs.stop(id);
          store.removeJob(id);
          return sendJson(res, 200, { ok: true });
        }
        if (req.method === 'POST' && action === '/start') {
          await jobs.start(id);
          return sendJson(res, 200, { ok: true, runtime: jobs.runtime(id) });
        }
        if (req.method === 'POST' && action === '/stop') {
          await jobs.stop(id);
          return sendJson(res, 200, { ok: true, runtime: jobs.runtime(id) });
        }
        if (req.method === 'POST' && action === '/restart') {
          await jobs.restart(id);
          return sendJson(res, 200, { ok: true, runtime: jobs.runtime(id) });
        }
        if (req.method === 'POST' && action === '/clone') {
          const copy = { ...JSON.parse(JSON.stringify(job)), id: '', name: `${job.name} 副本`, autoStart: false };
          const created = store.upsertJob(copy);
          return sendJson(res, 200, { ok: true, job: created });
        }
        if (req.method === 'GET' && action === '/logs') {
          return sendJson(res, 200, { ok: true, logs: jobs.getLogs(id, 500) });
        }
        if (req.method === 'GET' && action === '/command') {
          const prep = jobs.prepare(job);
          const args = ffmpeg.buildStreamArgs(job, {
            target: prep.target, concatFile: prep.concatFile, hlsRoot, warn: () => {},
          });
          return sendJson(res, 200, {
            ok: true,
            command: `${ffmpeg.bin} ${args.map((a) => (/\s/.test(a) ? `'${a}'` : a)).join(' ')}`,
            args,
          });
        }
      }

      // ---------- 电视源 ----------
      if (pathname === '/api/catalogs' && req.method === 'GET') {
        return sendJson(res, 200, { ok: true, catalogs: iptv.listCatalogs(), recommended: iptv.stats().recommended });
      }
      if (pathname === '/api/catalogs' && req.method === 'POST') {
        const body = await readBody(req);
        const cat = iptv.addCatalog(body);
        return sendJson(res, 200, { ok: true, catalog: cat });
      }
      const catMatch = /^\/api\/catalogs\/([\w-]+)(\/[a-z-]+)?$/.exec(pathname);
      if (catMatch) {
        const id = catMatch[1];
        const action = catMatch[2] || '';
        if (req.method === 'PATCH' && !action) {
          return sendJson(res, 200, { ok: true, catalog: iptv.updateCatalog(id, await readBody(req)) });
        }
        if (req.method === 'DELETE' && !action) {
          return sendJson(res, 200, { ok: iptv.removeCatalog(id) });
        }
        if (req.method === 'POST' && action === '/refresh') {
          return sendJson(res, 200, await iptv.refreshCatalog(id));
        }
      }
      if (pathname === '/api/catalogs/refresh-all' && req.method === 'POST') {
        const body = await readBody(req).catch(() => ({}));
        return sendJson(res, 200, await iptv.refreshAll(body));
      }
      if (pathname === '/api/iptv/import' && req.method === 'POST') {
        const body = await readBody(req);
        return sendJson(res, 200, { ok: true, ...iptv.importText(body.text, body.name || '手动导入') });
      }
      if (pathname === '/api/channels') {
        const data = iptv.query({
          q: query.q, group: query.group, catalog: query.catalog, quality: query.quality,
          fav: query.fav, limit: query.limit || 100, offset: query.offset || 0, sort: query.sort || 'name',
        });
        return sendJson(res, 200, { ok: true, ...data });
      }
      if (pathname === '/api/channels/check' && req.method === 'POST') {
        const body = await readBody(req);
        const results = await iptv.checkChannels(body.ids || [], { concurrency: body.concurrency || 10 });
        return sendJson(res, 200, { ok: true, results });
      }
      if (pathname === '/api/channels/stats') {
        return sendJson(res, 200, { ok: true, ...iptv.stats() });
      }

      // 一键把频道转成推流任务
      if (pathname === '/api/channels/push' && req.method === 'POST') {
        const body = await readBody(req);
        const ch = iptv.findChannel(body.id);
        if (!ch) return sendJson(res, 404, { ok: false, error: '频道不存在' });
        const job = store.upsertJob({
          name: body.name || `${ch.name} 转推`,
          source: { type: 'url', url: ch.url, headers: ch.headers || '', loop: false },
          target: body.target || {},
          video: body.video || {},
          audio: body.audio || {},
          autoStart: Boolean(body.autoStart),
        });
        if (job.autoStart) setTimeout(() => jobs.start(job.id).catch((e) => jobs.log(job.id, e.message, 'error')), 300);
        return sendJson(res, 200, { ok: true, job });
      }

      // ---------- 播放 ----------
      if (pathname === '/api/play' && req.method === 'POST') {
        const body = await readBody(req);
        // 允许只传 channelId，由服务端补齐地址与请求头
        const ch = body.channelId ? iptv.findChannel(body.channelId) : null;
        const src = {
          url: body.url || ch?.url,
          userAgent: body.userAgent || store.config.settings.player.userAgent,
          headers: body.headers || (body.referer ? `Referer: ${body.referer}` : '') || ch?.headers || '',
        };
        const result = await preview.play(src, { mode: body.mode, bitrateKbps: body.bitrateKbps });
        if (ch) {
          const p = store.config.player;
          p.history = [{ ...ch, playedAt: Date.now() }, ...(p.history || []).filter((h) => h.url !== ch.url)].slice(0, 40);
          store.touch('player');
        }
        return sendJson(res, 200, result);
      }
      if (pathname === '/api/play/stop' && req.method === 'POST') {
        const body = await readBody(req);
        if (body.key) preview.stop(body.key);
        return sendJson(res, 200, { ok: true });
      }

      // ---------- 播放器收藏 / 历史 ----------
      if (pathname === '/api/player' && req.method === 'POST') {
        const body = await readBody(req);
        const p = store.config.player;
        if (body.action === 'favorite' && body.channel) {
          const exists = (p.favorites || []).some((f) => f.url === body.channel.url);
          if (!exists) p.favorites = [{ ...body.channel, addedAt: Date.now() }, ...(p.favorites || [])].slice(0, 200);
        }
        if (body.action === 'unfavorite' && body.channel) {
          p.favorites = (p.favorites || []).filter((f) => f.url !== body.channel.url);
        }
        if (body.action === 'clear-history') p.history = [];
        store.touch('player');
        return sendJson(res, 200, { ok: true, player: p });
      }

      // ---------- 设置 / 备份 ----------
      if (pathname === '/api/settings' && req.method === 'POST') {
        const body = await readBody(req);
        const settings = store.updateSettings(body);
        return sendJson(res, 200, { ok: true, settings });
      }
      if (pathname === '/api/backups' && req.method === 'GET') {
        return sendJson(res, 200, { ok: true, backups: store.listBackups().map((b) => ({ ...b, human: humanBytes(b.size) })) });
      }
      if (pathname === '/api/backups' && req.method === 'POST') {
        const file = store.maybeSnapshot(true);
        return sendJson(res, 200, { ok: Boolean(file), file: file ? path.basename(file) : '', backups: store.listBackups().map((b) => ({ ...b, human: humanBytes(b.size) })) });
      }
      if (pathname === '/api/backups/restore' && req.method === 'POST') {
        const body = await readBody(req);
        await jobs.stopAll();
        const config = store.restoreBackup(body.name);
        broadcast('config', { scope: 'restore' });
        return sendJson(res, 200, { ok: true, config });
      }
      if (pathname === '/api/config/export') {
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Disposition': 'attachment; filename="streampilot-config.json"',
        });
        return res.end(JSON.stringify({
          exportedAt: new Date().toISOString(),
          config: store.config,
          channels: store.channels,
        }, null, 2));
      }
      if (pathname === '/api/config/import' && req.method === 'POST') {
        const body = await readBody(req);
        if (!body.config) throw new Error('文件内容不完整');
        store.config = require('./config').deepDefaults(require('./config').defaultConfig(), body.config);
        store.config.settings.dataDir = dataDir;
        store.saveNow();
        broadcast('config', { scope: 'restore' });
        return sendJson(res, 200, { ok: true });
      }
      if (pathname === '/api/logs') {
        const jobId = query.jobId;
        const logs = jobId ? jobs.getLogs(jobId, 500) : globalLogs.slice(-500);
        return sendJson(res, 200, { ok: true, logs });
      }
      if (pathname === '/api/open-folder' && req.method === 'POST') {
        if (typeof options.openPath === 'function') {
          const body = await readBody(req);
          options.openPath(body.path || dataDir);
          return sendJson(res, 200, { ok: true });
        }
        return sendJson(res, 200, { ok: false, error: '当前为浏览器模式，无法打开本地目录' });
      }

      // ---------- HLS 反代 ----------
      if (pathname === '/api/proxy') {
        const target = String(query.u || '');
        if (!/^https?:\/\//i.test(target)) return sendJson(res, 400, { ok: false, error: '仅支持 http(s) 地址' });
        const kind = urlKind(target);
        try {
          if (kind === 'hls') {
            const { playlist, body, res: upstream } = await proxyHls(target, {
              userAgent: query.ua || store.config.settings.player.userAgent,
              referer: query.ref || store.config.settings.player.referer,
            });
            if (playlist) {
              res.writeHead(200, {
                'Content-Type': MIME['.m3u8'],
                'Cache-Control': 'no-store',
                'Access-Control-Allow-Origin': '*',
              });
              return res.end(body);
            }
            return pipeUpstream(upstream, res, req);
          }
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), 30000);
          const upstream = await fetch(target, {
            signal: ctrl.signal,
            redirect: 'follow',
            headers: {
              'User-Agent': query.ua || store.config.settings.player.userAgent,
              ...(query.ref ? { Referer: query.ref } : (store.config.settings.player.referer ? { Referer: store.config.settings.player.referer } : {})),
              ...(req.headers.range ? { Range: req.headers.range } : {}),
              Accept: '*/*',
            },
          });
          clearTimeout(timer);
          if (!upstream.ok && upstream.status !== 206) {
            return sendJson(res, 502, { ok: false, error: `源站返回 HTTP ${upstream.status}` });
          }
          return pipeUpstream(upstream, res, req);
        } catch (err) {
          if (!res.headersSent) return sendJson(res, 502, { ok: false, error: err.message });
          try { res.end(); } catch (_) {}
          return;
        }
      }

      // ---------- 本地 HLS / 预览静态文件 ----------
      const hlsMatch = /^\/hls\/([\w-]+)\/([\w.-]+)$/.exec(pathname);
      if (hlsMatch) {
        return serveFile(res, path.join(hlsRoot, hlsMatch[1], hlsMatch[2]), pathname);
      }
      const prevMatch = /^\/preview\/(\w+)\/([\w.-]+)$/.exec(pathname);
      if (prevMatch) {
        preview.touch(prevMatch[1]);
        return serveFile(res, path.join(preview.root, prevMatch[1], prevMatch[2]), pathname);
      }

      // ---------- 静态资源 ----------
      if (VENDOR_MAP[pathname]) return serveFile(res, VENDOR_MAP[pathname], pathname);
      if (pathname.startsWith('/api/')) return sendJson(res, 404, { ok: false, error: '接口不存在' });

      const rel = pathname === '/' ? '/index.html' : pathname;
      const file = path.join(WEB_ROOT, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
      if (!file.startsWith(WEB_ROOT)) return sendJson(res, 403, { ok: false, error: '禁止访问' });
      return serveFile(res, file, pathname, true);
    } catch (err) {
      if (!res.headersSent) return sendJson(res, 500, { ok: false, error: err.message });
      try { res.end(); } catch (_) {}
      return;
    }
  };

  const server = http.createServer(handler);
  server.keepAliveTimeout = 65000;

  return {
    server, store, ffmpeg, jobs, iptv, preview, dataDir, systemInfo,
    async listen(port = store.config.settings.http?.port || 8377, host) {
      const allowLan = Boolean(store.config.settings.http?.allowLan);
      const bindHost = host || (allowLan ? '0.0.0.0' : '127.0.0.1');
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, bindHost, resolve);
      });
      const actual = server.address().port;
      store.config.settings.http.port = actual;
      if (allowLan && !store.config.settings.http.lanToken) {
        store.config.settings.http.lanToken = uid('');
      }
      store.saveNow();
      jobs.autoStartAll().catch(() => {});
      iptv.autoRefreshIfStale().catch(() => {});
      return { port: actual, host: bindHost };
    },
    async close() {
      clearInterval(statsTimer);
      preview.stopAll();
      await jobs.stopAll();
      await new Promise((r) => server.close(r));
    },
  };
}

function isLocal(req) {
  const ip = req.socket.remoteAddress || '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

async function pipeUpstream(upstream, res, req) {
  const headers = {
    'Content-Type': upstream.headers.get('content-type') || 'application/octet-stream',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  };
  const len = upstream.headers.get('content-length');
  if (len) headers['Content-Length'] = len;
  const range = upstream.headers.get('content-range');
  if (range) headers['Content-Range'] = range;
  res.writeHead(upstream.status, headers);
  if (!upstream.body) return res.end();
  const reader = upstream.body.getReader();
  let closed = false;
  req.on('close', () => { closed = true; try { reader.cancel(); } catch (_) {} });
  try {
    while (!closed) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!res.write(Buffer.from(value))) {
        await new Promise((r) => res.once('drain', r));
      }
    }
  } catch (_) {
    // 客户端主动断开是常态
  } finally {
    try { res.end(); } catch (_) {}
  }
}

function serveFile(res, file, pathname, fallbackIndex = false) {
  try {
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      if (fallbackIndex) {
        const index = path.join(path.dirname(file), 'index.html');
        if (fs.existsSync(index)) return serveFile(res, index, pathname);
      }
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 Not Found');
    }
    const ext = path.extname(file).toLowerCase();
    const type = MIME_TYPES[ext] || MIME[ext] || 'application/octet-stream';
    const stat = fs.statSync(file);
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': stat.size,
      'Cache-Control': ext === '.html' || ext === '.js' || ext === '.css' ? 'no-cache' : 'public, max-age=60',
      'Access-Control-Allow-Origin': '*',
    });
    fs.createReadStream(file).pipe(res);
  } catch (err) {
    res.writeHead(500);
    res.end(err.message);
  }
}

async function main() {
  const app = await createApp({});
  const { port, host } = await app.listen();
  const info = app.systemInfo();
  console.log('');
  console.log('  StreamPilot 流控台已启动');
  console.log(`  本机地址   http://127.0.0.1:${port}`);
  for (const a of info.addresses) console.log(`  局域网     http://${a.address}:${port}`);
  console.log(`  数据目录   ${app.dataDir}`);
  console.log(`  FFmpeg     ${info.ffmpeg.ok ? `${info.ffmpeg.path} (${info.ffmpeg.version})` : '未检测到，请在设置中指定'}`);
  console.log('');
  const shutdown = async () => {
    console.log('\n正在停止所有推流任务…');
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('启动失败：', err);
    process.exit(1);
  });
}

module.exports = { createApp, sendJson, readBody };
