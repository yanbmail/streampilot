'use strict';

/* ============================================================
   API 客户端 + 实时事件总线
   ============================================================ */
window.SP = window.SP || {};

SP.api = (() => {
  const params = new URLSearchParams(location.search);
  const token = params.get('token') || '';
  if (token) localStorage.setItem('sp_token', token);
  const authToken = token || localStorage.getItem('sp_token') || '';

  async function req(path, { method = 'GET', body, raw = false } = {}) {
    const headers = { 'X-Streampilot-Token': authToken };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (raw) return res;
    let data = null;
    try { data = await res.json(); } catch (_) { data = null; }
    if (!res.ok) {
      const msg = data?.error || `请求失败 (HTTP ${res.status})`;
      throw new Error(msg);
    }
    return data;
  }

  return {
    token: authToken,
    get: (p) => req(p),
    post: (p, b = {}) => req(p, { method: 'POST', body: b }),
    patch: (p, b = {}) => req(p, { method: 'PATCH', body: b }),
    del: (p) => req(p, { method: 'DELETE' }),

    state: () => req('/api/state'),
    system: () => req('/api/system'),
    redetect: () => req('/api/system/redetect', { method: 'POST' }),
    devices: () => req('/api/devices'),
    deviceTest: (b) => req('/api/devices/test', { method: 'POST', body: b }),
    caps: () => req('/api/caps'),
    probe: (target, extra = {}) => req('/api/probe', { method: 'POST', body: { target, ...extra } }),
    screenSize: (index) => req(`/api/screen-size?index=${encodeURIComponent(index)}`),

    createJob: (job) => req('/api/jobs', { method: 'POST', body: job }),
    updateJob: (id, job) => req(`/api/jobs/${id}`, { method: 'PATCH', body: job }),
    deleteJob: (id) => req(`/api/jobs/${id}`, { method: 'DELETE' }),
    startJob: (id) => req(`/api/jobs/${id}/start`, { method: 'POST' }),
    stopJob: (id) => req(`/api/jobs/${id}/stop`, { method: 'POST' }),
    restartJob: (id) => req(`/api/jobs/${id}/restart`, { method: 'POST' }),
    cloneJob: (id) => req(`/api/jobs/${id}/clone`, { method: 'POST' }),
    jobCommand: (id) => req(`/api/jobs/${id}/command`),
    jobLogs: (id) => req(`/api/jobs/${id}/logs`),

    catalogs: () => req('/api/catalogs'),
    addCatalog: (b) => req('/api/catalogs', { method: 'POST', body: b }),
    updateCatalog: (id, b) => req(`/api/catalogs/${id}`, { method: 'PATCH', body: b }),
    removeCatalog: (id) => req(`/api/catalogs/${id}`, { method: 'DELETE' }),
    refreshCatalog: (id) => req(`/api/catalogs/${id}/refresh`, { method: 'POST' }),
    refreshAllCatalogs: () => req('/api/catalogs/refresh-all', { method: 'POST', body: {} }),
    importList: (text, name) => req('/api/iptv/import', { method: 'POST', body: { text, name } }),
    channels: (q) => req(`/api/channels?${new URLSearchParams(q).toString()}`),
    checkChannels: (ids) => req('/api/channels/check', { method: 'POST', body: { ids } }),
    pushChannel: (b) => req('/api/channels/push', { method: 'POST', body: b }),

    play: (b) => req('/api/play', { method: 'POST', body: b }),
    stopPlay: (key) => req('/api/play/stop', { method: 'POST', body: { key } }),
    playerAction: (b) => req('/api/player', { method: 'POST', body: b }),

    // 排播表
    schedule: () => req('/api/schedule'),
    createSchedule: (b) => req('/api/schedule', { method: 'POST', body: b }),
    updateSchedule: (id, b) => req(`/api/schedule/${id}`, { method: 'PATCH', body: b }),
    deleteSchedule: (id) => req(`/api/schedule/${id}`, { method: 'DELETE' }),
    toggleSchedule: (enabled) => req('/api/schedule/toggle', { method: 'POST', body: { enabled } }),
    tickSchedule: () => req('/api/schedule/tick', { method: 'POST' }),
    runSchedule: (id, minutes) => req(`/api/schedule/${id}/run`, { method: 'POST', body: { minutes } }),
    stopSchedule: (id) => req(`/api/schedule/${id}/stop`, { method: 'POST' }),

    // 推流模板
    templates: () => req('/api/templates'),
    saveTemplate: (b) => req('/api/templates', { method: 'POST', body: b }),
    updateTemplate: (id, b) => req(`/api/templates/${id}`, { method: 'PATCH', body: b }),
    deleteTemplate: (id) => req(`/api/templates/${id}`, { method: 'DELETE' }),
    applyTemplate: (id, jobIds) => req(`/api/templates/${id}/apply`, { method: 'POST', body: { jobIds } }),
    newJobFromTemplate: (id, b) => req(`/api/templates/${id}/new-job`, { method: 'POST', body: b || {} }),

    settings: (b) => req('/api/settings', { method: 'POST', body: b }),
    backups: () => req('/api/backups'),
    createBackup: () => req('/api/backups', { method: 'POST' }),
    restoreBackup: (name) => req('/api/backups/restore', { method: 'POST', body: { name } }),
    logs: (jobId) => req(`/api/logs${jobId ? `?jobId=${jobId}` : ''}`),

    pickFiles: (multiple = false, kind = 'media') => req('/api/pick-files', { method: 'POST', body: { multiple, kind } }),
    pickFolder: () => req('/api/pick-folder', { method: 'POST' }),
    pickSave: (defaultName) => req('/api/pick-save', { method: 'POST', body: { defaultName } }),
    openFolder: (p) => req('/api/open-folder', { method: 'POST', body: { path: p } }),

    connect(onEvent) {
      const qs = authToken ? `?token=${encodeURIComponent(authToken)}` : '';
      let es;
      const open = () => {
        es = new EventSource(`/api/events${qs}`);
        es.addEventListener('message', (e) => onEvent('message', safe(e.data)));
        for (const name of ['stats', 'log', 'job-state', 'config', 'iptv', 'iptv-refresh', 'hello', 'rtmp', 'schedule']) {
          es.addEventListener(name, (e) => onEvent(name, safe(e.data)));
        }
        es.onerror = () => {
          // EventSource 会自动重连，这里只标记状态
          onEvent('sse-error', {});
        };
      };
      open();
      return { close: () => es && es.close() };
    },
  };

  function safe(v) {
    try { return JSON.parse(v); } catch (_) { return v; }
  }
})();
