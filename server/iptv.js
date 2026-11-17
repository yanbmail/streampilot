'use strict';

const crypto = require('crypto');
const EventEmitter = require('events');
const { safeJsonParse, urlKind, slug } = require('./util');

/** 内置推荐源：一键添加到源仓库 */
const RECOMMENDED = [
  {
    key: 'iptv-org-cn', name: 'IPTV-org · 中国', group: '综合',
    url: 'https://iptv-org.github.io/iptv/countries/cn.m3u',
    site: 'https://github.com/iptv-org/iptv',
    desc: '全球最大公开 IPTV 索引库的中国频道，每日自动校验更新',
    enabled: true,
  },
  {
    key: 'fanmingming', name: '范明明 · 国内直播源', group: '综合',
    url: 'https://raw.githubusercontent.com/fanmingming/live/main/tv/m3u/index.m3u',
    site: 'https://github.com/fanmingming/live',
    desc: '国内可直连、含台标的央视/卫视/地方频道，IPv4/IPv6 双栈',
    enabled: true,
  },
  {
    key: 'yang1989', name: 'YanG-1989 · 聚合源', group: '综合',
    url: 'https://raw.githubusercontent.com/YanG-1989/m3u/main/Gather.m3u',
    site: 'https://github.com/YanG-1989/m3u',
    desc: '社区维护的聚合直播列表，频道覆盖较广',
    enabled: true,
  },
  {
    key: 'iptv-org-global', name: 'IPTV-org · 全球全量', group: '国际',
    url: 'https://iptv-org.github.io/iptv/index.m3u',
    site: 'https://github.com/iptv-org/iptv',
    desc: '200+ 国家上万频道，体量较大，建议按需开启',
    enabled: false,
  },
  {
    key: 'iptv-org-news', name: 'IPTV-org · 全球新闻', group: '新闻',
    url: 'https://iptv-org.github.io/iptv/categories/news.m3u',
    site: 'https://github.com/iptv-org/iptv',
    desc: '各国新闻频道合辑',
    enabled: false,
  },
  {
    key: 'iptv-org-sports', name: 'IPTV-org · 体育', group: '体育',
    url: 'https://iptv-org.github.io/iptv/categories/sports.m3u',
    site: 'https://github.com/iptv-org/iptv',
    desc: '体育赛事频道合辑',
    enabled: false,
  },
  {
    key: 'iptv-org-hk', name: 'IPTV-org · 中国香港', group: '综合',
    url: 'https://iptv-org.github.io/iptv/countries/hk.m3u',
    site: 'https://github.com/iptv-org/iptv',
    desc: '中国香港地区公开频道',
    enabled: false,
  },
  {
    key: 'iptv-org-tw', name: 'IPTV-org · 中国台湾', group: '综合',
    url: 'https://iptv-org.github.io/iptv/countries/tw.m3u',
    site: 'https://github.com/iptv-org/iptv',
    desc: '中国台湾地区公开频道',
    enabled: false,
  },
  {
    key: 'wind005-gd', name: 'TVlive · 广东联通内网', group: '内网源',
    url: 'https://raw.githubusercontent.com/wind005/TVlive/main/m3u/gdlt.m3u',
    site: 'https://github.com/wind005/TVlive',
    desc: '省内运营商内网源，仅对应网络环境可播',
    enabled: false,
  },
  {
    key: 'wind005-hunan', name: 'TVlive · 湖南 IPv6', group: '内网源',
    url: 'https://raw.githubusercontent.com/wind005/TVlive/main/m3u/hunan-ipv6.m3u',
    site: 'https://github.com/wind005/TVlive',
    desc: '需本地 IPv6 网络环境',
    enabled: false,
  },
];

function channelId(name, url) {
  return crypto.createHash('sha1').update(`${name}|${url}`).digest('hex').slice(0, 12);
}

function normGroup(g) {
  const s = String(g == null ? '' : g).trim();
  if (!s || /^(undefined|null|n\/a|unknown)$/i.test(s)) return '未分组';
  return s.slice(0, 40);
}

function detectQuality(name) {
  const s = String(name || '');
  if (/8K/i.test(s)) return '8K';
  if (/4K|UHD|2160/i.test(s)) return '4K';
  if (/1080|FHD|超清/i.test(s)) return '1080P';
  if (/720|高清/i.test(s)) return '720P';
  if (/576|480|标清/i.test(s)) return 'SD';
  return '';
}

/** 解析 #EXTINF 行属性 */
function parseAttrs(line) {
  const attrs = {};
  const body = line.replace(/^#EXTINF:/i, '');
  const commaIdx = body.indexOf(',');
  const meta = commaIdx >= 0 ? body.slice(0, commaIdx) : body;
  const re = /([\w-]+)="([^"]*)"/g;
  let m;
  while ((m = re.exec(meta))) attrs[m[1].toLowerCase()] = m[2];
  const duration = Number((meta.match(/^\s*(-?[\d.]+)/) || [])[1]);
  const title = commaIdx >= 0 ? body.slice(commaIdx + 1).trim() : '';
  return { attrs, title, duration: Number.isFinite(duration) ? duration : -1 };
}

/**
 * 解析 M3U / M3U8 播放列表
 * @returns {Array<{name,url,group,logo,tvgId,quality,headers}>}
 */
function parseM3U(text) {
  const lines = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/);
  const out = [];
  let pending = null;
  let pendingGroup = '';
  let pendingHeaders = '';
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (/^#EXTM3U/i.test(line)) continue;
    if (/^#EXTINF/i.test(line)) {
      const { attrs, title } = parseAttrs(line);
      const name = (title || attrs['tvg-name'] || attrs['tvg-id'] || '未命名频道').trim();
      pending = {
        name,
        group: normGroup(attrs['group-title']),
        logo: attrs['tvg-logo'] || '',
        tvgId: attrs['tvg-id'] || '',
        lang: attrs['tvg-language'] || '',
        country: attrs['tvg-country'] || '',
        quality: detectQuality(name) || detectQuality(attrs['tvg-name'] || ''),
      };
      continue;
    }
    if (/^#EXTGRP:/i.test(line)) {
      pendingGroup = line.replace(/^#EXTGRP:/i, '').trim();
      continue;
    }
    if (/^#EXTVLCOPT:/i.test(line)) {
      const opt = line.replace(/^#EXTVLCOPT:/i, '');
      if (/^http-user-agent=/i.test(opt)) pendingHeaders += `User-Agent: ${opt.split('=')[1]}\r\n`;
      if (/^http-referrer=/i.test(opt)) pendingHeaders += `Referer: ${opt.split('=')[1]}\r\n`;
      continue;
    }
    if (line.startsWith('#')) continue;
    if (!/^[a-z0-9]+:\/\//i.test(line) && !line.startsWith('/')) continue;
    if (pending) {
      out.push({
        name: pending.name,
        url: line,
        group: normGroup(pending.group || pendingGroup),
        logo: pending.logo,
        tvgId: pending.tvgId,
        lang: pending.lang,
        country: pending.country,
        quality: pending.quality,
        headers: pendingHeaders.trim(),
      });
      pending = null;
      pendingHeaders = '';
    }
  }
  return out;
}

/** 解析国内常见的 TXT 列表（频道名,地址 + `分组,#genre#`） */
function parseTXT(text) {
  const out = [];
  let group = '未分组';
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (/,?#genre#/i.test(line)) {
      group = line.split(',')[0].trim() || group;
      continue;
    }
    if (/^#/.test(line)) continue;
    const idx = line.indexOf(',');
    if (idx < 0) continue;
    const name = line.slice(0, idx).trim();
    const url = line.slice(idx + 1).trim().split(/\s+/)[0];
    if (!/^[a-z0-9]+:\/\//i.test(url)) continue;
    out.push({
      name: name || url, url, group, logo: '', tvgId: '',
      lang: '', country: '', quality: detectQuality(name), headers: '',
    });
  }
  return out;
}

function parsePlaylist(text, url = '') {
  const t = String(text || '');
  if (/^#EXTM3U/i.test(t) || /#EXTINF/i.test(t)) return parseM3U(t);
  if (/,?#genre#/i.test(t) || /^[^#\n]+,\s*https?:\/\//m.test(t)) return parseTXT(t);
  if (url.toLowerCase().endsWith('.json')) {
    const json = safeJsonParse(t, null);
    if (Array.isArray(json)) {
      return json.map((it) => ({
        name: it.name || it.title || '未命名',
        url: it.url || it.link,
        group: normGroup(it.group || it.category),
        logo: it.logo || it.tvg_logo || '',
        quality: detectQuality(it.name || ''),
        headers: '',
      })).filter((it) => it.url);
    }
  }
  return [];
}

async function fetchText(url, { timeout = 45000, userAgent, headers } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': userAgent || 'Mozilla/5.0 StreamPilot/1.0',
        Accept: '*/*',
        ...(headers || {}),
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 60 * 1024 * 1024) throw new Error('列表体积过大，已跳过');
    const text = buf.toString('utf8');
    return text;
  } catch (err) {
    if (err.name === 'AbortError' || /aborted/i.test(err.message)) {
      throw new Error(`拉取超时（${Math.round((timeout || 45000) / 1000)} 秒无响应），可稍后重试或更换镜像地址`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

class IPTVService extends EventEmitter {
  constructor({ store, dataDir }) {
    super();
    this.store = store;
    this.dataDir = dataDir;
    this.channels = [];
    this.catalogs = [];
    this.refreshing = new Set();
    this.lastRefresh = 0;
    this.health = new Map();
  }

  load() {
    const raw = this.store.channels;
    if (raw && !Array.isArray(raw) && Array.isArray(raw.channels)) {
      this.channels = raw.channels || [];
      this.catalogs = raw.catalogs || [];
      this.lastRefresh = raw.lastRefresh || 0;
    } else if (Array.isArray(raw)) {
      this.channels = raw;
    }
    if (!this.catalogs.length) this.catalogs = this.defaultCatalogs();
    return this.stats();
  }

  defaultCatalogs() {
    return RECOMMENDED.filter((r) => r.enabled).map((r) => ({
      id: `cat_${r.key}`,
      key: r.key,
      name: r.name,
      url: r.url,
      group: r.group,
      site: r.site,
      desc: r.desc,
      enabled: true,
      count: 0,
      lastUpdated: 0,
      lastError: '',
    }));
  }

  stats() {
    const groups = new Map();
    for (const c of this.channels) groups.set(c.group || '未分组', (groups.get(c.group || '未分组') || 0) + 1);
    return {
      total: this.channels.length,
      catalogs: this.catalogs.length,
      enabledCatalogs: this.catalogs.filter((c) => c.enabled).length,
      groups: [...groups.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([name, count]) => ({ name, count })),
      lastRefresh: this.lastRefresh,
      recommended: RECOMMENDED,
    };
  }

  persist() {
    this.store.saveChannels({
      version: 1,
      channels: this.channels,
      catalogs: this.catalogs,
      lastRefresh: this.lastRefresh,
    });
  }

  listCatalogs() {
    return this.catalogs;
  }

  addCatalog(input = {}) {
    const url = String(input.url || '').trim();
    if (!/^https?:\/\//i.test(url)) throw new Error('请填写 http(s) 开头的播放列表地址');
    if (this.catalogs.some((c) => c.url === url)) throw new Error('该源已存在');
    const rec = RECOMMENDED.find((r) => r.url === url);
    const cat = {
      id: `cat_${Date.now().toString(36)}`,
      key: rec?.key || slug(input.name || 'custom', 'custom'),
      name: String(input.name || rec?.name || '自定义源').slice(0, 60),
      url,
      group: String(input.group || rec?.group || '自定义').slice(0, 30),
      site: input.site || rec?.site || '',
      desc: input.desc || rec?.desc || '',
      enabled: input.enabled !== false,
      count: 0,
      lastUpdated: 0,
      lastError: '',
    };
    this.catalogs.push(cat);
    this.persist();
    this.emit('changed');
    return cat;
  }

  updateCatalog(id, patch = {}) {
    const cat = this.catalogs.find((c) => c.id === id);
    if (!cat) throw new Error('源不存在');
    Object.assign(cat, {
      name: patch.name ?? cat.name,
      url: patch.url ?? cat.url,
      group: patch.group ?? cat.group,
      enabled: patch.enabled ?? cat.enabled,
    });
    this.persist();
    this.emit('changed');
    return cat;
  }

  removeCatalog(id) {
    this.catalogs = this.catalogs.filter((c) => c.id !== id);
    this.channels = this.channels.filter((c) => c.catalogId !== id);
    this.persist();
    this.emit('changed');
    return true;
  }

  /** 导入粘贴的 m3u/txt 文本 */
  importText(text, name = '手动导入') {
    const items = parsePlaylist(text);
    if (!items.length) throw new Error('未解析出任何频道，请检查内容格式');
    const catId = `cat_import_${Date.now().toString(36)}`;
    const cat = {
      id: catId, key: 'import', name, url: '', group: '导入', site: '',
      desc: '手动导入的播放列表', enabled: true, count: 0,
      lastUpdated: Date.now(), lastError: '', imported: true,
    };
    this.catalogs.push(cat);
    const added = this.mergeChannels(items, cat);
    cat.count = added;
    this.persist();
    this.emit('changed');
    return { catalog: cat, added, total: this.channels.length };
  }

  mergeChannels(items, catalog) {
    const existing = new Set(this.channels.map((c) => c.url));
    const batch = [];
    for (const it of items) {
      if (!it.url || existing.has(it.url)) continue;
      existing.add(it.url);
      const name = String(it.name || '').trim().slice(0, 80);
      batch.push({
        id: channelId(name, it.url),
        name,
        url: it.url,
        group: normGroup(it.group),
        logo: it.logo || '',
        tvgId: it.tvgId || '',
        lang: it.lang || '',
        country: it.country || '',
        quality: it.quality || '',
        headers: it.headers || '',
        catalogId: catalog.id,
        catalogName: catalog.name,
        addedAt: Date.now(),
      });
    }
    this.channels.push(...batch);
    return batch.length;
  }

  async refreshCatalog(id) {
    const cat = this.catalogs.find((c) => c.id === id);
    if (!cat) throw new Error('源不存在');
    if (this.refreshing.has(id)) return { ok: false, message: '正在更新中' };
    this.refreshing.add(id);
    this.emit('refresh', { id, status: 'start' });
    try {
      const text = await fetchText(cat.url, { timeout: 120000 });
      const items = parsePlaylist(text, cat.url);
      if (!items.length) throw new Error('未解析出频道，可能是格式不兼容');
      const kept = this.channels.filter((c) => c.catalogId !== id);
      this.channels = kept;
      const added = this.mergeChannels(items, cat);
      cat.count = added;
      cat.lastUpdated = Date.now();
      cat.lastError = '';
      this.persist();
      this.emit('refresh', { id, status: 'done', count: added });
      this.emit('changed');
      return { ok: true, count: added };
    } catch (err) {
      cat.lastError = err.message;
      cat.lastUpdated = Date.now();
      this.persist();
      this.emit('refresh', { id, status: 'error', error: err.message });
      return { ok: false, error: err.message };
    } finally {
      this.refreshing.delete(id);
    }
  }

  async refreshAll({ force = false } = {}) {
    const targets = this.catalogs.filter((c) => c.enabled && c.url);
    const results = [];
    for (const cat of targets) {
      // 顺序执行，避免同时抓大列表占满带宽
      results.push({ id: cat.id, name: cat.name, ...(await this.refreshCatalog(cat.id)) });
    }
    this.lastRefresh = Date.now();
    this.persist();
    this.emit('changed');
    return { results, total: this.channels.length };
  }

  async autoRefreshIfStale() {
    const hours = Number(this.store.config.settings.iptv?.autoRefreshHours ?? 12);
    if (!hours || !this.catalogs.some((c) => c.enabled && c.url)) return;
    const stamp = this.catalogs.reduce((max, c) => Math.max(max, c.lastUpdated || 0), 0);
    if (Date.now() - stamp < hours * 3600 * 1000) return;
    await new Promise((r) => setTimeout(r, 2500));
    this.refreshAll().catch(() => {});
  }

  query({ q = '', group = '', catalog = '', quality = '', fav = '', limit = 100, offset = 0, sort = 'name' } = {}) {
    const kw = String(q || '').trim().toLowerCase();
    const kwParts = kw.split(/\s+/).filter(Boolean);
    let list = this.channels;
    if (group) list = list.filter((c) => c.group === group);
    if (catalog) list = list.filter((c) => c.catalogId === catalog);
    if (quality) list = list.filter((c) => c.quality === quality);
    if (kwParts.length) {
      list = list.filter((c) => {
        const hay = `${c.name} ${c.group} ${c.country} ${c.tvgId}`.toLowerCase();
        return kwParts.every((p) => hay.includes(p));
      });
    }
    if (fav === '1') {
      const ids = new Set((this.store.config.player.favorites || []).map((f) => f.url));
      list = list.filter((c) => ids.has(c.url));
    }
    const total = list.length;
    const arr = [...list];
    if (sort === 'group') arr.sort((a, b) => (a.group || '').localeCompare(b.group || '', 'zh') || a.name.localeCompare(b.name, 'zh'));
    else if (sort === 'recent') arr.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
    else arr.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
    const page = arr.slice(Number(offset) || 0, (Number(offset) || 0) + Math.min(500, Number(limit) || 100));
    return {
      total,
      offset: Number(offset) || 0,
      items: page.map((c) => ({ ...c, health: this.health.get(c.id) || null })),
    };
  }

  findChannel(id) {
    return this.channels.find((c) => c.id === id) || null;
  }

  /** 批量测活：只检测给定的一批（前端通常传当前页） */
  async checkChannels(ids = [], { concurrency = 10, timeout = 7000 } = {}) {
    const targets = this.channels.filter((c) => ids.includes(c.id));
    const results = [];
    let cursor = 0;
    const worker = async () => {
      while (cursor < targets.length) {
        const ch = targets[cursor++];
        const started = Date.now();
        let ok = false;
        let note = '';
        try {
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), timeout);
          const kind = urlKind(ch.url);
          if (['hls', 'http', 'flv', 'http'].includes(kind)) {
            const res = await fetch(ch.url, {
              signal: ctrl.signal,
              redirect: 'follow',
              headers: { 'User-Agent': 'Mozilla/5.0 StreamPilot/1.0', Range: 'bytes=0-2048' },
            });
            ok = res.ok || res.status === 206;
            if (!ok) note = `HTTP ${res.status}`;
            try { ctrl.abort(); } catch (_) {}
          } else {
            ok = true;
            note = '非 HTTP 协议，未做在线检测';
          }
          clearTimeout(timer);
        } catch (err) {
          note = err.name === 'AbortError' ? '超时' : (err.message || '不可用');
        }
        const entry = { alive: ok, latency: Date.now() - started, checkedAt: Date.now(), note };
        this.health.set(ch.id, entry);
        results.push({ id: ch.id, ...entry });
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, targets.length || 1) }, worker));
    return results;
  }
}

module.exports = {
  IPTVService, parseM3U, parseTXT, parsePlaylist, RECOMMENDED, detectQuality, channelId, fetchText,
};
