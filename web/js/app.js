'use strict';

/* ============================================================
   应用入口：状态、路由、全局动作、实时事件
   ============================================================ */
(() => {
  const { h, attr, icon, toast, confirmDlg, copyText } = SP.util;
  const api = SP.api;

  SP.state = {
    config: { jobs: [], settings: { player: {}, http: {}, defaults: {} }, player: { favorites: [], history: [] } },
    runtime: {}, system: { ffmpeg: { encoders: [], protocols: [] }, addresses: [] },
    iptv: { total: 0, groups: [], catalogs: [], recommended: [] },
    backups: [], template: {},
    rtmp: { available: true, running: false, port: 1935, httpPort: 8399, streams: [] },
  };
  SP.logBuffer = [];
  SP.series = new Map();
  SP.pendingPlay = null;
  SP.currentView = null;
  SP.page = 'dashboard';

  const PAGES = {
    dashboard: { title: '总览', sub: '全局推流状态与实时指标', render: () => SP.views.dashboard() },
    streams: { title: '推流任务', sub: '管理每条推流链路的输入、编码与输出', render: () => SP.views.streams() },
    sources: { title: '电视源', sub: '聚合公开 IPTV 源，支持在线播放与一键转推', render: () => SP.tv.sources() },
    player: { title: '播放器', sub: '播放电视源、网络流与本地媒体', render: () => SP.tv.playerView() },
    logs: { title: '运行日志', sub: 'FFmpeg 实时输出与错误诊断', render: () => SP.views.logs() },
    settings: { title: '设置与备份', sub: '编码默认值、网络访问与配置快照', render: () => SP.views.settings() },
    help: { title: '使用说明', sub: '快速上手与常见问题', render: () => SP.views.help() },
  };

  /* ---------------- 状态 ---------------- */
  function applyState(s) {
    if (!s) return;
    SP.state.config = s.config;
    SP.state.runtime = s.runtime || {};
    SP.state.system = s.system;
    SP.state.iptv = s.iptv;
    SP.state.backups = s.backups || [];
    SP.state.template = s.template || {};
    SP.state.rtmp = s.rtmp || SP.state.rtmp;
    for (const [jobId, r] of Object.entries(s.runtime || {})) {
      if (typeof r.bitrateKbps === 'number' && r.status === 'running') pushSeries(jobId, r.bitrateKbps);
    }
  }

  function pushSeries(jobId, value) {
    let arr = SP.series.get(jobId);
    if (!arr) { arr = []; SP.series.set(jobId, arr); }
    arr.push(value || 0);
    if (arr.length > 120) arr.shift();
  }

  SP.refreshState = async ({ silent = false } = {}) => {
    try {
      const s = await api.state();
      applyState(s);
      if (!silent) SP.render({ keepScroll: true });
      updateShellBadges();
    } catch (err) {
      if (!silent) toast(`读取状态失败：${err.message}`, 'error');
    }
  };

  function updateShellBadges() {
    const running = Object.values(SP.state.runtime || {}).filter((r) => ['running', 'starting', 'reconnecting'].includes(r.status)).length;
    const nr = document.getElementById('nav-running');
    if (nr) { nr.textContent = running ? String(running) : ''; nr.classList.toggle('hot', running > 0); }
    const nc = document.getElementById('nav-channels');
    if (nc) nc.textContent = SP.state.iptv.total ? String(SP.state.iptv.total) : '';
    const pill = document.getElementById('sys-pill');
    if (pill) {
      const ff = SP.state.system.ffmpeg || {};
      pill.className = `sys-pill ${ff.ok ? 'ok' : 'bad'}`;
      pill.querySelector('span').textContent = ff.ok ? `FFmpeg ${ff.version}` : 'FFmpeg 未就绪';
    }
  }

  /* ---------------- 路由 ---------------- */
  function currentPageFromHash() {
    const m = /^#\/([\w-]+)/.exec(location.hash || '');
    const p = m ? m[1] : 'dashboard';
    return PAGES[p] ? p : 'dashboard';
  }

  SP.render = ({ keepScroll = false } = {}) => {
    const page = currentPageFromHash();
    const view = document.getElementById('view');
    if (!view) return;
    const scrollTop = keepScroll ? view.scrollTop : 0;
    if (SP.currentView && typeof SP.currentView.destroy === 'function' && page !== SP.page) {
      try { SP.currentView.destroy(); } catch (_) {}
    }
    SP.page = page;
    const def = PAGES[page];
    document.getElementById('page-title').textContent = def.title;
    document.getElementById('page-sub').textContent = def.sub;
    document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.page === page));
    const inst = def.render();
    SP.currentView = inst;
    view.innerHTML = inst.html;
    try { inst.mount(view); } catch (err) { console.error(err); toast(`页面渲染失败：${err.message}`, 'error'); }
    renderTopActions(page);
    if (keepScroll) view.scrollTop = scrollTop;
    updateShellBadges();
  };

  function renderTopActions(page) {
    const box = document.getElementById('top-actions');
    if (!box) return;
    const buttons = [];
    if (page === 'dashboard' || page === 'streams') {
      buttons.push(`<button class="btn btn-sm" data-act="refresh">${icon('refresh', 13)} 刷新</button>`);
      buttons.push(`<button class="btn btn-sm btn-primary" data-act="new-job">${icon('plus', 13)} 新建推流</button>`);
    } else if (page === 'sources') {
      buttons.push(`<button class="btn btn-sm" data-act="catalog-refresh-all">${icon('refresh', 13)} 更新全部源</button>`);
      buttons.push(`<button class="btn btn-sm" data-act="catalog-import">${icon('upload', 13)} 导入列表</button>`);
    } else if (page === 'player') {
      buttons.push(`<button class="btn btn-sm" data-act="go" data-to="sources">${icon('tv', 13)} 电视源</button>`);
    } else if (page === 'logs') {
      buttons.push(`<button class="btn btn-sm" data-act="refresh">${icon('refresh', 13)} 刷新</button>`);
    } else if (page === 'settings') {
      buttons.push(`<button class="btn btn-sm btn-primary" data-act="save-settings">${icon('save', 13)} 保存设置</button>`);
    } else {
      buttons.push(`<button class="btn btn-sm" data-act="go" data-to="dashboard">${icon('grid', 13)} 返回总览</button>`);
    }
    box.innerHTML = buttons.join('');
  }

  /* ---------------- 动作 ---------------- */
  const actions = {
    async run(act, el) {
      const id = el?.dataset?.id;
      try {
        switch (act) {
          case 'go': {
            location.hash = `#/${el.dataset.to}`;
            break;
          }
          case 'refresh': await SP.refreshState(); break;
          case 'new-job': SP.jobForm.open({ onSaved: () => SP.refreshState() }); break;
          case 'job-edit': {
            const job = SP.state.config.jobs.find((j) => j.id === id);
            if (job) SP.jobForm.open({ job, onSaved: () => SP.refreshState() });
            break;
          }
          case 'job-start': {
            await api.startJob(id);
            toast('已开始推流', 'ok', 1800);
            await SP.refreshState({ silent: true });
            SP.render({ keepScroll: true });
            break;
          }
          case 'job-stop': {
            await api.stopJob(id);
            toast('已停止推流', 'ok', 1800);
            await SP.refreshState({ silent: true });
            SP.render({ keepScroll: true });
            break;
          }
          case 'job-restart': {
            await api.restartJob(id);
            toast('正在重启…', 'ok', 1600);
            await SP.refreshState({ silent: true });
            SP.render({ keepScroll: true });
            break;
          }
          case 'job-clone': {
            await api.cloneJob(id);
            toast('已复制任务', 'ok', 1600);
            await SP.refreshState();
            break;
          }
          case 'job-delete': {
            const job = SP.state.config.jobs.find((j) => j.id === id);
            const ok = await confirmDlg({
              title: '删除推流任务',
              message: `确定删除「${h(job?.name || '')}」吗？如正在推流会立即停止。`,
              confirmText: '删除', danger: true,
            });
            if (!ok) break;
            await api.deleteJob(id);
            toast('任务已删除', 'ok');
            await SP.refreshState();
            break;
          }
          case 'start-all': {
            const jobs = SP.state.config.jobs.filter((j) => !SP.views.isRunning(SP.views.rt(j).status));
            if (!jobs.length) { toast('没有需要启动的任务', 'warn'); break; }
            toast(`正在启动 ${jobs.length} 个任务…`, 'info', 2000);
            for (const j of jobs) await api.startJob(j.id).catch((e) => toast(`${j.name}：${e.message}`, 'error', 5000));
            await SP.refreshState();
            break;
          }
          case 'stop-all': {
            const running = SP.state.config.jobs.filter((j) => SP.views.isRunning(SP.views.rt(j).status));
            if (!running.length) { toast('当前没有运行中的任务', 'warn'); break; }
            for (const j of running) await api.stopJob(j.id).catch(() => {});
            toast('已停止全部任务', 'ok');
            await SP.refreshState();
            break;
          }
          case 'copy-text': await copyText(el.dataset.text || ''); break;
          case 'redetect': {
            const r = await api.redetect();
            SP.state.system = r.system;
            toast(r.ok ? `已识别 FFmpeg ${r.system.ffmpeg.version}` : '未找到 FFmpeg', r.ok ? 'ok' : 'error');
            SP.render();
            break;
          }
          case 'backup-now': {
            const r = await api.createBackup();
            if (r.ok) { toast(`已创建快照 ${r.file}`, 'ok'); await SP.refreshState({ silent: true }); }
            else toast('快照失败', 'error');
            break;
          }
          case 'restore-backup': {
            const ok = await confirmDlg({
              title: '恢复配置快照',
              message: `将使用 <b>${h(el.dataset.name)}</b> 覆盖当前配置，所有运行中的推流会被停止。确定继续吗？`,
              confirmText: '恢复并停止推流', danger: true,
            });
            if (!ok) break;
            await api.restoreBackup(el.dataset.name);
            toast('配置已恢复', 'ok');
            await SP.refreshState();
            break;
          }
          case 'export-config': {
            const a = document.createElement('a');
            a.href = '/api/config/export';
            a.download = 'streampilot-config.json';
            a.click();
            break;
          }
          case 'import-config': {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = '.json';
            input.onchange = async () => {
              const file = input.files[0];
              if (!file) return;
              const text = await file.text();
              try {
                const json = JSON.parse(text);
                await api.post('/api/config/import', { config: json.config || json });
                toast('配置已导入', 'ok');
                await SP.refreshState();
              } catch (err) { toast(`导入失败：${err.message}`, 'error'); }
            };
            input.click();
            break;
          }
          case 'save-settings': {
            const data = SP.currentView?.collect ? SP.currentView.collect() : null;
            if (!data) break;
            await api.settings(data);
            toast('设置已保存', 'ok');
            await SP.refreshState({ silent: true });
            break;
          }
          case 'open-dir': {
            const r = await api.openFolder(SP.state.system.dataDir);
            if (!r.ok) toast(r.error || '无法打开目录', 'warn');
            break;
          }

          /* ---------- 内置 RTMP 收流 ---------- */
          case 'rtmp-start': {
            const port = Number(document.querySelector('#rtmp-port')?.value || 1935);
            const httpPort = Number(document.querySelector('#rtmp-http-port')?.value || 8399);
            toast('正在启动收流服务…', 'info', 1500);
            const r = await api.post('/api/rtmp/start', { port, httpPort }).catch((e) => ({ ok: false, error: e.message }));
            if (r.ok) toast('收流服务已启动，可以开始推流了', 'ok');
            else toast(`启动失败：${r.error}`, 'error', 7000);
            await SP.refreshState({ silent: true });
            break;
          }
          case 'rtmp-stop': {
            const ok = await confirmDlg({ title: '停止收流服务', message: '正在推上来的流会中断，确定停止？', confirmText: '停止', danger: true });
            if (!ok) break;
            await api.post('/api/rtmp/stop', {});
            toast('收流服务已停止', 'ok');
            await SP.refreshState({ silent: true });
            break;
          }
          case 'rtmp-play': {
            SP.pendingPlay = { name: `收流 · ${el.dataset.name || ''}`, url: el.dataset.url };
            location.hash = '#/player';
            break;
          }
          case 'rtmp-push': {
            const stream = el.dataset.stream;
            const r = await api.post('/api/rtmp/push', {
              stream,
              name: `收流转推 · ${stream}`,
              target: { protocol: 'hls', hlsSegmentSeconds: 2, hlsListSize: 6 },
              video: { mode: 'transcode', encoder: 'libx264', preset: 'veryfast', width: 1280, height: 720, fps: 30, rateControl: 'cbr', bitrateKbps: 3000 },
              audio: { mode: 'transcode', bitrateKbps: 128 },
            }).catch((e) => ({ ok: false, error: e.message }));
            if (!r.ok) return toast(`创建失败：${r.error}`, 'error');
            toast('已创建转推任务，可在推流页改成要推的平台', 'ok', 5000);
            await SP.refreshState({ silent: true });
            location.hash = '#/streams';
            break;
          }

          /* ---------- 电视源 ---------- */
          case 'catalog-add': openAddCatalog(); break;
          case 'catalog-import': openImport(); break;
          case 'catalog-refresh': {
            toast('正在更新源…', 'info', 1600);
            const r = await api.refreshCatalog(id);
            if (r.ok) toast(`更新完成，解析到 ${r.count} 个频道`, 'ok');
            else toast(`更新失败：${r.error}`, 'error', 6000);
            await SP.refreshState({ silent: true });
            await refreshChannelTable();
            break;
          }
          case 'catalog-refresh-all': {
            toast('正在更新全部电视源，可能需要几十秒…', 'info', 3000);
            const r = await api.refreshAllCatalogs();
            const okCount = (r.results || []).filter((x) => x.ok).length;
            toast(`更新完成：${okCount} 个源成功，共 ${r.total} 个频道`, okCount ? 'ok' : 'warn', 5000);
            await SP.refreshState({ silent: true });
            await refreshChannelTable();
            break;
          }
          case 'catalog-toggle': {
            await api.updateCatalog(id, { enabled: el.checked });
            await SP.refreshState({ silent: true });
            break;
          }
          case 'catalog-delete': {
            const ok = await confirmDlg({ title: '删除电视源', message: '该源下的频道会一并移除，确定删除？', confirmText: '删除', danger: true });
            if (!ok) break;
            await api.removeCatalog(id);
            toast('源已删除', 'ok');
            await SP.refreshState({ silent: true });
            await refreshChannelTable();
            break;
          }
          case 'catalog-copy': await copyText(el.dataset.url || ''); break;

          /* ---------- 频道 ---------- */
          case 'ch-play': {
            const ch = findChannel(id);
            if (!ch) return toast('频道不存在，请刷新列表', 'warn');
            if (SP.page === 'player') {
              await SP.tv.player.play(ch, { force: true });
            } else {
              SP.pendingPlay = ch;
              location.hash = '#/player';
            }
            break;
          }
          case 'ch-push': {
            const ch = findChannel(id);
            if (!ch) return toast('频道不存在', 'warn');
            SP.jobForm.open({
              preset: {
                name: `${ch.name} 转推`,
                source: { type: 'url', url: ch.url, headers: ch.headers || '' },
                target: { protocol: 'rtmp' },
              },
              onSaved: () => SP.refreshState(),
            });
            break;
          }
          case 'ch-fav': {
            const ch = findChannel(id);
            if (!ch) return;
            const fav = (SP.state.config.player.favorites || []).some((f) => f.url === ch.url);
            await api.playerAction({ action: fav ? 'unfavorite' : 'favorite', channel: ch });
            toast(fav ? '已取消收藏' : '已加入收藏', 'ok', 1500);
            await SP.refreshState({ silent: true });
            SP.tv.renderPlaylist();
            await refreshChannelTable();
            break;
          }
          case 'ch-copy': {
            const ch = findChannel(id);
            if (ch) await copyText(ch.url);
            break;
          }
          case 'ch-check': {
            const ids = SP.tv.chState.items.map((c) => c.id);
            if (!ids.length) return toast('当前没有可检测的频道', 'warn');
            toast(`正在检测 ${ids.length} 个频道…`, 'info', 2500);
            const r = await api.checkChannels(ids);
            const map = new Map((r.results || []).map((x) => [x.id, x]));
            SP.tv.chState.items = SP.tv.chState.items.map((c) => ({ ...c, health: map.get(c.id) || c.health }));
            SP.render({ keepScroll: true });
            const alive = (r.results || []).filter((x) => x.alive).length;
            toast(`检测完成：${alive}/${ids.length} 个可用`, alive ? 'ok' : 'warn', 4000);
            break;
          }
          case 'ch-group': {
            SP.tv.chState.group = el.dataset.group || '';
            SP.tv.chState.offset = 0;
            await refreshChannelTable();
            SP.render({ keepScroll: true });
            break;
          }
          case 'ch-prev': {
            SP.tv.chState.offset = Math.max(0, SP.tv.chState.offset - SP.tv.chState.limit);
            await refreshChannelTable();
            SP.render({ keepScroll: true });
            break;
          }
          case 'ch-next': {
            SP.tv.chState.offset += SP.tv.chState.limit;
            await refreshChannelTable();
            SP.render({ keepScroll: true });
            break;
          }
          case 'ch-reset': {
            Object.assign(SP.tv.chState, { q: '', group: '', quality: '', catalog: '', sort: 'name', offset: 0 });
            await refreshChannelTable();
            SP.render({ keepScroll: true });
            break;
          }

          /* ---------- 播放器 ---------- */
          case 'player-retry': {
            if (SP.tv.player.current) SP.tv.player.play(SP.tv.player.current, { force: true });
            break;
          }
          case 'player-retry-transcode': {
            const p = SP.tv.player;
            if (!p.current) break;
            const hint = document.getElementById('player-hint');
            if (hint) hint.textContent = '正在转码…';
            const res = await api.play({ url: p.current.url, mode: 'transcode', headers: p.current.headers || '', referer: p.current.referer || '' });
            document.getElementById('player-empty').style.display = 'none';
            p.session = res;
            p.attach(res);
            break;
          }
          case 'player-network': openPlayerAdv(); break;
          case 'open-file-play': {
            const r = await api.pickFiles(false, 'media');
            if (r.ok && r.files?.[0]) {
              SP.tv.player.play({ name: r.files[0].split('/').pop(), url: r.files[0] }, { force: true });
            } else if (!r.ok) toast(r.error, 'warn', 5000);
            break;
          }
          case 'iptv-import-submit': break;
          default:
            console.warn('unknown action', act);
        }
      } catch (err) {
        toast(err.message || String(err), 'error', 6000);
      }
    },
  };
  SP.actions = actions;

  function findChannel(id) {
    return (SP.tv.chState.items || []).find((c) => c.id === id) || null;
  }

  async function refreshChannelTable() {
    try {
      await SP.tv.loadChannels({});
    } catch (err) { toast(err.message, 'error'); }
  }

  /* ---------------- 弹窗：添加源 / 导入 / 播放器高级 ---------------- */
  function openAddCatalog() {
    const recs = SP.state.iptv.recommended || [];
    const added = new Set((SP.state.iptv.catalogs || []).map((c) => c.url));
    const html = `
      <div class="modal-head"><div><h3>添加电视源</h3><div class="sub">支持 M3U / M3U8 / TXT 与 JSON 列表地址</div></div></div>
      <div class="modal-body">
        <div class="form-grid">
          <div class="field"><label>源名称</label><input class="input" id="cat-name" placeholder="例如：我的直播源" /></div>
          <div class="field"><label>分组</label><input class="input" id="cat-group" placeholder="综合 / 体育 / 内网源" value="自定义" /></div>
          <div class="field span-2"><label>播放列表地址 <span class="req">*</span></label>
            <input class="input mono" id="cat-url" placeholder="https://example.com/playlist.m3u" style="font-size:12px" />
          </div>
        </div>
        <div class="section-title" style="margin:18px 0 8px"><h2>推荐源</h2><div class="line"></div></div>
        <div style="display:flex;flex-direction:column;gap:7px;max-height:300px;overflow:auto">
          ${recs.map((r) => `
            <div style="display:flex;align-items:center;gap:10px;padding:8px 10px;border:1px solid var(--line);border-radius:9px">
              <div style="flex:1;min-width:0">
                <div style="font-size:12.5px;font-weight:550">${h(r.name)} <span class="dim small">· ${h(r.group)}</span></div>
                <div class="dim small ellipsis">${h(r.desc)}</div>
              </div>
              ${added.has(r.url)
                ? '<span class="pill ok"><i class="dot"></i>已添加</span>'
                : `<button class="btn btn-sm" data-add-url="${attr(r.url)}" data-add-name="${attr(r.name)}" data-add-group="${attr(r.group)}">添加</button>`}
            </div>`).join('')}
        </div>
      </div>
      <div class="modal-foot"><div class="spacer"></div>
        <button class="btn" data-close>取消</button>
        <button class="btn btn-primary" id="cat-submit">添加并更新</button>
      </div>`;
    const m = SP.util.openModal(html);
    m.el.querySelectorAll('[data-add-url]').forEach((b) => b.addEventListener('click', async () => {
      await api.addCatalog({ url: b.dataset.addUrl, name: b.dataset.addName, group: b.dataset.addGroup });
      toast('已添加，开始更新…', 'ok');
      m.close();
      const cats = await api.catalogs();
      const last = cats.catalogs[cats.catalogs.length - 1];
      if (last) await api.refreshCatalog(last.id).catch(() => {});
      await SP.refreshState({ silent: true });
      await refreshChannelTable();
      SP.render({ keepScroll: true });
    }));
    m.el.querySelector('#cat-submit').addEventListener('click', async () => {
      const url = m.el.querySelector('#cat-url').value.trim();
      const name = m.el.querySelector('#cat-name').value.trim() || '自定义源';
      if (!/^https?:\/\//i.test(url)) return toast('请填写 http(s) 开头的地址', 'warn');
      const cat = await api.addCatalog({ url, name, group: m.el.querySelector('#cat-group').value.trim() || '自定义' });
      m.close();
      toast('已添加，开始更新…', 'ok');
      const r = await api.refreshCatalog(cat.catalog.id);
      toast(r.ok ? `解析到 ${r.count} 个频道` : `更新失败：${r.error}`, r.ok ? 'ok' : 'error', 5000);
      await SP.refreshState({ silent: true });
      await refreshChannelTable();
      SP.render({ keepScroll: true });
    });
  }

  function openImport() {
    const html = `
      <div class="modal-head"><div><h3>导入电视源列表</h3><div class="sub">粘贴 M3U / TXT 内容，支持 #EXTINF 与「频道名,地址」两种格式</div></div></div>
      <div class="modal-body">
        <div class="field"><label>名称</label><input class="input" id="imp-name" placeholder="例如：朋友分享的源" value="手动导入" /></div>
        <div class="field" style="margin-top:10px"><label>列表内容</label>
          <textarea class="input" id="imp-text" style="min-height:260px" placeholder="#EXTM3U&#10;#EXTINF:-1 group-title=&quot;央视&quot; tvg-logo=&quot;&quot;,CCTV-1&#10;http://example.com/cctv1.m3u8&#10;&#10;或：&#10;央视,#genre#&#10;CCTV-1,http://example.com/cctv1.m3u8"></textarea>
        </div>
      </div>
      <div class="modal-foot"><div class="spacer"></div>
        <button class="btn" data-close>取消</button>
        <button class="btn btn-primary" id="imp-submit">${icon('upload', 14)} 导入</button>
      </div>`;
    const m = SP.util.openModal(html);
    m.el.querySelector('#imp-submit').addEventListener('click', async () => {
      const text = m.el.querySelector('#imp-text').value;
      if (!text.trim()) return toast('请粘贴播放列表内容', 'warn');
      const r = await api.importList(text, m.el.querySelector('#imp-name').value.trim() || '手动导入');
      toast(`导入成功：新增 ${r.added} 个频道`, 'ok');
      m.close();
      await SP.refreshState({ silent: true });
      await refreshChannelTable();
      SP.render({ keepScroll: true });
    });
  }

  function openPlayerAdv() {
    const p = SP.tv.player;
    const cur = p.current || {};
    const html = `
      <div class="modal-head"><div><h3>播放高级设置</h3><div class="sub">针对防盗链或需要特定 UA 的源</div></div></div>
      <div class="modal-body">
        <div class="field"><label>流地址</label><input class="input mono" id="adv-url" value="${attr(cur.url || '')}" style="font-size:11.5px" /></div>
        <div class="field" style="margin-top:10px"><label>User-Agent</label><input class="input mono" id="adv-ua" value="${attr(cur.userAgent || '')}" placeholder="留空使用全局设置" /></div>
        <div class="field" style="margin-top:10px"><label>Referer</label><input class="input mono" id="adv-ref" value="${attr(cur.referer || '')}" placeholder="例如 https://www.example.com/" /></div>
        <div class="hint-box" style="margin-top:12px">${icon('info')}<div>保存后会立即用新参数重新拉流。若仍失败，可稍后重试或更换同频道其他源。</div></div>
      </div>
      <div class="modal-foot"><div class="spacer"></div>
        <button class="btn" data-close>取消</button>
        <button class="btn btn-primary" id="adv-play">${icon('play', 14)} 应用并播放</button>
      </div>`;
    const m = SP.util.openModal(html);
    m.el.querySelector('#adv-play').addEventListener('click', () => {
      const url = m.el.querySelector('#adv-url').value.trim();
      if (!url) return toast('请填写流地址', 'warn');
      p.play({
        name: cur.name || '自定义地址',
        url,
        userAgent: m.el.querySelector('#adv-ua').value.trim(),
        referer: m.el.querySelector('#adv-ref').value.trim(),
      }, { force: true });
      m.close();
    });
  }

  /* ---------------- 实时事件 ---------------- */
  function connectSSE() {
    api.connect((event, data) => {
      if (event === 'stats') {
        for (const [jobId, stats] of Object.entries(data || {})) {
          const cur = SP.state.runtime[jobId] || {};
          SP.state.runtime[jobId] = { ...cur, ...stats, status: 'running' };
          if (typeof stats.bitrateKbps === 'number') pushSeries(jobId, stats.bitrateKbps);
        }
        if (SP.currentView?.onStats) SP.currentView.onStats();
      } else if (event === 'job-state') {
        SP.state.runtime[data.jobId] = { ...(SP.state.runtime[data.jobId] || {}), ...data.runtime, status: data.status };
        if (SP.page === 'dashboard') {
          const running = Object.values(SP.state.runtime).filter((r) => ['running', 'starting', 'reconnecting'].includes(r.status)).length;
          const el = document.getElementById('stat-running');
          if (el) el.innerHTML = `${running}<small>/ ${SP.state.config.jobs.length}</small>`;
          if (SP.currentView?.onStats) SP.currentView.onStats();
        }
        if (SP.page === 'streams') {
          SP.refreshState({ silent: true }).then(() => SP.render({ keepScroll: true }));
        }
        updateShellBadges();
      } else if (event === 'log') {
        SP.logBuffer.push(data);
        if (SP.logBuffer.length > 900) SP.logBuffer.shift();
        if (SP.page === 'logs' && SP.views._logsRender) SP.views._logsRender();
      } else if (event === 'iptv-refresh') {
        if (data.status === 'start') toast('正在拉取电视源…', 'info', 1600);
        if (data.status === 'done') toast(`源更新完成，新增 ${data.count} 个频道`, 'ok', 2200);
        if (data.status === 'error') toast(`源更新失败：${data.error}`, 'error', 5000);
      } else if (event === 'rtmp') {
        SP.state.rtmp = { ...(SP.state.rtmp || {}), ...data };
        if (SP.page === 'settings') SP.render({ keepScroll: true });
      } else if (event === 'iptv') {
        SP.state.iptv = { ...SP.state.iptv, ...data };
        updateShellBadges();
      } else if (event === 'config') {
        if (SP.jobForm.isOpen) return;
        clearTimeout(connectSSE._t);
        connectSSE._t = setTimeout(async () => {
          await SP.refreshState({ silent: true });
          if (!SP.jobForm.isOpen) SP.render({ keepScroll: true });
        }, 900);
      }
    });
  }

  /* ---------------- 启动 ---------------- */
  async function boot() {
    document.body.classList.toggle('is-mac', /Mac/i.test(navigator.platform));
    document.querySelectorAll('[data-icon]').forEach((el) => {
      el.innerHTML = icon(el.dataset.icon, 17);
    });
    window.addEventListener('hashchange', () => SP.render());
    document.addEventListener('click', (e) => {
      const btn = e.target.closest('#top-actions [data-act]');
      if (btn) actions.run(btn.dataset.act, btn);
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') SP.util.closeTopModal();
      if (e.target.matches('input, textarea, select')) return;
      if (SP.page !== 'player') return;
      if (e.code === 'Space') { e.preventDefault(); SP.tv.player.toggle(); }
      if (e.key === 'f') SP.tv.player.fullscreen();
      if (e.key === 'm') SP.tv.player.mute();
    });

    try {
      const s = await api.state();
      applyState(s);
      if (!location.hash) location.hash = '#/dashboard';
      SP.render();
      document.getElementById('boot').classList.add('hidden');
      document.getElementById('app').classList.remove('hidden');
      connectSSE();
      setInterval(() => {
        if (document.hidden) return;
        SP.refreshState({ silent: true }).then(() => {
          if (SP.page === 'dashboard' && SP.currentView?.onStats) SP.currentView.onStats();
        });
      }, 30000);
    } catch (err) {
      document.querySelector('.boot-text').innerHTML = `启动失败：${SP.util.h(err.message)}<br/><span style="font-size:11px">请确认后端服务已启动，或刷新页面重试</span>`;
      document.querySelector('.boot-bar').style.display = 'none';
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
