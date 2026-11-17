'use strict';

/* ============================================================
   电视源聚合页 + 内置播放器
   ============================================================ */
SP.tv = (() => {
  const { h, attr, icon, fmtTime, relTime, toast, confirmDlg, copyText } = SP.util;
  const api = SP.api;
  const q = (root, s) => root.querySelector(s);
  const qa = (root, s) => Array.from(root.querySelectorAll(s));
  const bind = (root, s, evt, fn) => qa(root, s).forEach((el) => el.addEventListener(evt, (e) => fn(e, el)));

  /* ============================ 电视源 ============================ */
  const chState = {
    items: [], total: 0, offset: 0, limit: 60, q: '', group: '', quality: '', catalog: '', sort: 'name', loaded: false,
  };

  async function loadChannels(extra = {}) {
    Object.assign(chState, extra);
    const r = await api.channels({
      q: chState.q, group: chState.group, quality: chState.quality, catalog: chState.catalog,
      sort: chState.sort, offset: chState.offset, limit: chState.limit,
    });
    chState.items = r.items || [];
    chState.total = r.total || 0;
    chState.loaded = true;
    return r;
  }

  function catalogCard(cat) {
    return `<div class="cat" data-cat="${cat.id}">
      <div class="cat-top">
        <label class="switch"><input type="checkbox" data-act="catalog-toggle" data-id="${cat.id}" ${cat.enabled ? 'checked' : ''} /><span class="track"></span></label>
        <div class="cat-name" title="${attr(cat.url)}">${h(cat.name)}</div>
        <span class="badge">${cat.count || 0}</span>
      </div>
      <div class="cat-meta">
        <span>${h(cat.group || '自定义')}</span>
        <span>·</span>
        <span>${cat.lastUpdated ? relTime(cat.lastUpdated) + '更新' : '未更新'}</span>
      </div>
      ${cat.lastError ? `<div class="cat-err">${h(cat.lastError).slice(0, 90)}</div>` : ''}
      <div class="cat-actions">
        <button class="icon-btn" title="更新此源" data-act="catalog-refresh" data-id="${cat.id}">${icon('refresh', 13)}</button>
        <button class="icon-btn" title="复制地址" data-act="catalog-copy" data-url="${attr(cat.url)}">${icon('copy', 13)}</button>
        <button class="icon-btn" title="删除源" data-act="catalog-delete" data-id="${cat.id}">${icon('trash', 13)}</button>
      </div>
    </div>`;
  }

  function channelRow(ch) {
    const fav = (SP.state.config.player.favorites || []).some((f) => f.url === ch.url);
    const health = ch.health;
    const healthHtml = health
      ? `<span class="health ${health.alive ? 'alive' : 'dead'}"><i class="d"></i>${health.alive ? `${health.latency}ms` : (health.note || '不可用')}</span>`
      : '<span class="dim small">—</span>';
    return `<tr data-ch="${ch.id}">
      <td>
        <div class="ch-cell">
          ${ch.logo ? `<img class="ch-logo" loading="lazy" src="${attr(ch.logo)}" onerror="this.style.display='none';this.nextElementSibling&&(this.nextElementSibling.style.display='flex')" /><span class="ch-logo ph" style="display:none">TV</span>` : `<span class="ch-logo ph">TV</span>`}
          <div style="min-width:0">
            <div class="ch-name ellipsis" title="${attr(ch.name)}">${h(ch.name)}</div>
            <div class="ch-sub ellipsis" title="${attr(ch.url)}">${h(ch.catalogName || '')}${ch.country ? ` · ${h(ch.country)}` : ''}</div>
          </div>
        </div>
      </td>
      <td class="small muted">${h(ch.group || '未分组')}</td>
      <td>${ch.quality ? `<span class="pill info">${h(ch.quality)}</span>` : '<span class="dim">—</span>'}</td>
      <td>${healthHtml}</td>
      <td><div class="row-actions">
        <button class="icon-btn" title="播放" data-act="ch-play" data-id="${ch.id}">${icon('play', 14)}</button>
        <button class="icon-btn" title="转推此频道" data-act="ch-push" data-id="${ch.id}">${icon('cast', 14)}</button>
        <button class="icon-btn" title="${fav ? '取消收藏' : '收藏'}" data-act="ch-fav" data-id="${ch.id}" style="${fav ? 'color:#f6b93b' : ''}">${icon('star', 14)}</button>
        <button class="icon-btn" title="复制地址" data-act="ch-copy" data-id="${ch.id}">${icon('link', 14)}</button>
      </div></td>
    </tr>`;
  }

  function sources() {
    const S = SP.state;
    const cats = S.iptv.catalogs || [];
    const groups = (S.iptv.groups || []).slice(0, 18);
    const html = `
      <div class="src-layout">
        <div style="display:flex;flex-direction:column;gap:10px">
          <div class="card">
            <div class="card-head"><h3>源仓库</h3><div class="spacer"></div>
              <button class="btn btn-sm" data-act="catalog-add">${icon('plus', 12)} 添加</button>
            </div>
            <div class="card-body" style="padding-top:10px">
              <div class="cat-list">
                ${cats.map(catalogCard).join('') || '<div class="dim small">还没有添加任何源</div>'}
              </div>
              <div style="display:flex;gap:6px;margin-top:10px">
                <button class="btn btn-sm" style="flex:1" data-act="catalog-refresh-all">${icon('refresh', 12)} 更新全部</button>
                <button class="btn btn-sm" style="flex:1" data-act="catalog-import">${icon('upload', 12)} 导入列表</button>
              </div>
            </div>
          </div>
          <div class="card">
            <div class="card-body" style="font-size:11.5px;color:var(--dim);line-height:1.65">
              ${icon('info', 13)} 电视源来自公开的 IPTV 索引项目，链接随时可能失效。本应用只做聚合与转推，不存储任何视频内容。请遵守当地法律法规与版权要求。
            </div>
          </div>
        </div>

        <div>
          <div class="card" style="margin-bottom:12px">
            <div class="card-body" style="padding:12px">
              <div class="filters">
                <div class="search">${icon('search')}<input class="input" id="ch-search" placeholder="搜索频道名称、分组、地区…" value="${attr(chState.q)}" /></div>
                <select class="select" id="ch-quality" style="width:120px">
                  <option value="">全部画质</option>
                  ${['4K', '1080P', '720P', 'SD'].map((x) => `<option value="${x}" ${chState.quality === x ? 'selected' : ''}>${x}</option>`).join('')}
                </select>
                <select class="select" id="ch-sort" style="width:120px">
                  <option value="name" ${chState.sort === 'name' ? 'selected' : ''}>按名称</option>
                  <option value="group" ${chState.sort === 'group' ? 'selected' : ''}>按分组</option>
                  <option value="recent" ${chState.sort === 'recent' ? 'selected' : ''}>最近收录</option>
                </select>
                <button class="btn btn-sm" data-act="ch-check">${icon('activity', 12)} 测活本页</button>
                <button class="btn btn-sm btn-ghost" data-act="ch-reset">${icon('x', 12)} 重置</button>
              </div>
              <div class="group-chips" style="margin-top:10px">
                <span class="chip sm ${!chState.group ? 'active' : ''}" data-act="ch-group" data-group="">全部</span>
                ${groups.map((g) => `<span class="chip sm ${chState.group === g.name ? 'active' : ''}" data-act="ch-group" data-group="${attr(g.name)}">${h(g.name)} ${g.count}</span>`).join('')}
              </div>
            </div>
          </div>

          <div class="table-wrap">
            <table class="tbl">
              <thead><tr><th style="width:38%">频道</th><th>分组</th><th>画质</th><th>检测</th><th style="width:140px"></th></tr></thead>
              <tbody id="ch-rows">${chState.loaded ? (chState.items.length ? chState.items.map(channelRow).join('') : emptyChannels()) : loadingRows()}</tbody>
            </table>
          </div>
          <div class="pager">
            <span>共 <b id="ch-total">${chState.total}</b> 个频道</span>
            <span class="dim">·</span>
            <span>第 ${Math.floor(chState.offset / chState.limit) + 1} / ${Math.max(1, Math.ceil(chState.total / chState.limit))} 页</span>
            <button class="btn btn-sm" data-act="ch-prev" ${chState.offset === 0 ? 'disabled' : ''}>${icon('left', 12)} 上一页</button>
            <button class="btn btn-sm" data-act="ch-next" ${chState.offset + chState.limit >= chState.total ? 'disabled' : ''}>下一页 ${icon('right', 12)}</button>
          </div>
        </div>
      </div>`;

    return {
      html,
      mount(root) {
        bind(root, '[data-act]', 'click', (e, el) => SP.actions.run(el.dataset.act, el));
        const search = q(root, '#ch-search');
        if (search) {
          let t;
          search.addEventListener('input', () => {
            clearTimeout(t);
            t = setTimeout(async () => { await loadChannels({ q: search.value.trim(), offset: 0 }); reload(); }, 350);
          });
        }
        const quality = q(root, '#ch-quality');
        quality && quality.addEventListener('change', async () => { await loadChannels({ quality: quality.value, offset: 0 }); reload(); });
        const sort = q(root, '#ch-sort');
        sort && sort.addEventListener('change', async () => { await loadChannels({ sort: sort.value, offset: 0 }); reload(); });
        if (!chState.loaded) {
          loadChannels({ offset: 0 }).then(() => {
            const rows = q(document, '#ch-rows');
            if (rows) { rows.innerHTML = chState.items.map(channelRow).join('') || emptyChannels(); }
            const total = q(document, '#ch-total');
            if (total) total.textContent = chState.total;
          }).catch((err) => toast(err.message, 'error'));
        }
        function reload() { SP.render({ keepScroll: true }); }
      },
    };
  }

  function emptyChannels() {
    return `<tr><td colspan="5"><div class="empty-state">${icon('tv')}<b>没有匹配的频道</b><p>试试更换关键词，或先在左侧「源仓库」更新电视源</p></div></td></tr>`;
  }
  function loadingRows() {
    return `<tr><td colspan="5"><div class="empty-state">${icon('refresh')}<b>正在加载频道…</b></div></td></tr>`;
  }

  /* ============================ 播放器 ============================ */
  const player = {
    video: null, hls: null, flv: null, current: null, session: null, volume: 0.85, tab: 'favorites',

    init(root) {
      this.video = q(root, '#player-video');
      const v = this.video;
      if (!v) return;
      this.volume = Number(SP.state.config.settings.player?.volume ?? 0.85);
      v.volume = this.volume;
      const vol = q(root, '#player-vol');
      if (vol) {
        vol.value = String(this.volume);
        vol.addEventListener('input', () => { v.volume = Number(vol.value); this.volume = v.volume; });
      }
      q(root, '#player-toggle')?.addEventListener('click', () => this.toggle());
      q(root, '#player-mute')?.addEventListener('click', () => this.mute());
      q(root, '#player-full')?.addEventListener('click', () => this.fullscreen());
      q(root, '#player-reload')?.addEventListener('click', () => { if (this.current) this.play(this.current, { force: true }); });
      q(root, '#player-fav')?.addEventListener('click', () => this.favorite());
      q(root, '#player-snapshot')?.addEventListener('click', () => this.snapshot());
      v.addEventListener('play', () => this.syncIcons());
      v.addEventListener('pause', () => this.syncIcons());
      // 浏览器解码/加载失败时必须给反馈，否则界面永远停在「正在连接…」
      v.addEventListener('error', () => {
        if (!this.current) return;
        const code = v.error ? v.error.code : 0;
        const map = {
          1: '播放被中止',
          2: '网络错误，流地址无法访问',
          3: '解码失败，当前格式浏览器播不了',
          4: '这个地址不是浏览器能直接播放的格式',
        };
        this.showError(`${map[code] || '播放失败'}（错误码 ${code}）· 可点「强制转码重试」`);
      });
      v.addEventListener('stalled', () => {
        if (!this.current) return;
        const hint = q(document, '#player-hint');
        if (hint && v.readyState < 3) hint.textContent = '网络卡住了，正在重连…';
      });
      q(root, '#player-url-go')?.addEventListener('click', () => {
        const url = q(root, '#player-url')?.value.trim();
        if (!url) return toast('请填写播放地址', 'warn');
        this.play({ name: '自定义地址', url }, { force: true });
      });
      q(root, '#player-url')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') q(root, '#player-url-go')?.click(); });
      bind(root, '[data-pl-tab]', 'click', async (e, el) => {
        this.tab = el.dataset.plTab;
        if (this.tab === 'channels' && !chState.loaded) {
          document.querySelectorAll('[data-pl-tab]').forEach((b) => b.classList.toggle('active', b.dataset.plTab === this.tab));
          const box = document.querySelector('#pl-items');
          if (box) box.innerHTML = `<div class="empty-state" style="padding:26px 12px">${icon('refresh')}<b>正在加载频道…</b></div>`;
          try { await loadChannels({ offset: 0 }); } catch (err) { toast(err.message, 'error'); }
        }
        renderPlaylist();
      });
      bind(root, '[data-pl-play]', 'click', (e, el) => {
        const item = JSON.parse(el.dataset.item || '{}');
        this.play(item, { force: true });
      });
      bind(root, '#player-video', 'dblclick', () => this.fullscreen());

      renderPlaylist();
      this.syncIcons();

      // 直接进播放器页时频道列表还没拉过，这里补一次
      if (this.tab === 'channels' && !chState.loaded) {
        loadChannels({ offset: 0 }).then(() => renderPlaylist()).catch(() => {});
      }

      // 如果从电视源页点了播放，进入本页后自动续播
      if (SP.pendingPlay) {
        const item = SP.pendingPlay;
        SP.pendingPlay = null;
        setTimeout(() => this.play(item, { force: true }), 120);
      }
    },

    async play(item, { force = false } = {}) {
      if (!this.video) return;
      if (!force && this.current && this.current.url === item.url) return;
      this.current = item;
      const label = q(document, '#player-now');
      if (label) label.textContent = item.name || item.url;
      const hint = q(document, '#player-hint');
      if (hint) hint.textContent = '正在连接…';
      const empty = q(document, '#player-empty');
      if (empty) empty.style.display = 'none';
      try {
        const res = await api.play({
          url: item.url,
          channelId: item.id,
          userAgent: item.userAgent || '',
          headers: item.headers || '',
          referer: item.referer || '',
        });
        this.session = res;
        const modeText = res.mode === 'proxy'
          ? (res.kind === 'flv' ? '直连 · FLV' : '直连代理 · HLS')
          : (res.copy ? '本地转封装' : '本地转码');
        if (hint) hint.textContent = modeText;
        this.attach(res);
        this.updateButtons();
      } catch (err) {
        if (hint) hint.textContent = '播放失败';
        this.showError(err.message);
      }
    },

    attach(res) {
      const v = this.video;
      this.destroyPlayers();
      const u = res.playUrl || '';
      // 以服务端探测出的真实类型为准：无扩展名的 IPTV 地址光看 URL 判断不了
      const kind = res.kind || (/\.m3u8/i.test(u) ? 'hls' : /\.flv/i.test(u) ? 'flv' : 'file');
      const isHls = kind === 'hls';
      const isFlv = kind === 'flv';
      const onErr = (msg) => this.showError(msg);
      if (isHls) {
        if (window.Hls && window.Hls.isSupported()) {
          const hls = new window.Hls({
            lowLatencyMode: true,
            backBufferLength: 30,
            maxBufferLength: 20,
            manifestLoadingTimeOut: 12000,
            manifestLoadingMaxRetry: 2,
          });
          this.hls = hls;
          let retried = 0;
          hls.on(window.Hls.Events.ERROR, (_e, data) => {
            if (!data.fatal) return;
            if (retried < 2) {
              retried += 1;
              if (data.type === 'networkError') { setTimeout(() => hls.startLoad(), 800); return; }
              if (data.type === 'mediaError') { hls.recoverMediaError(); return; }
            }
            const detail = data.details || data.type || '';
            onErr(/manifest|levelLoad|fragLoad/i.test(detail)
              ? `拉不到播放列表或分片（${detail}），该源可能已失效`
              : `HLS 播放错误：${detail}`);
          });
          hls.loadSource(u);
          hls.attachMedia(v);
        } else {
          v.src = u;
        }
      } else if (isFlv) {
        if (window.mpegts && window.mpegts.isSupported()) {
          const flv = window.mpegts.createPlayer({ type: 'flv', url: u, isLive: true }, {
            enableStashBuffer: false,
            liveBufferLatencyChasing: true,
            lazyLoad: false,
            autoCleanupSourceBuffer: true,
          });
          this.flv = flv;
          flv.attachMediaElement(v);
          flv.on(window.mpegts.Events.ERROR, (type, detail) => onErr(`FLV 播放错误：${detail || type}`));
          flv.load();
        } else {
          onErr('当前环境不支持 FLV 播放');
        }
      } else {
        v.src = u;
      }
      const p = v.play();
      if (p && p.catch) {
        p.catch(() => {
          const hint = q(document, '#player-hint');
          if (hint) hint.textContent = '已就绪，点击播放';
          this.video.muted = true;
          this.video.play().catch(() => {});
        });
      }
    },

    showError(msg) {
      const hint = q(document, '#player-hint');
      if (hint) hint.textContent = msg.slice(0, 80);
      const empty = q(document, '#player-empty');
      if (empty) {
        empty.style.display = 'flex';
        empty.innerHTML = `<div style="color:#ff8b95;max-width:520px">${icon('alert', 40)}<b style="display:block;margin:12px 0 6px">无法播放这个源</b>
          <span style="font-size:11.5px;line-height:1.6">${h(msg)}</span>
          <div style="margin-top:14px;display:flex;gap:8px;justify-content:center">
            <button class="btn btn-sm" data-act="player-retry">重试</button>
            <button class="btn btn-sm" data-act="player-retry-transcode">强制转码重试</button>
          </div></div>`;
        bind(empty, '[data-act]', 'click', (e, el) => SP.actions.run(el.dataset.act, el));
      }
    },

    destroyPlayers() {
      try { this.hls && this.hls.destroy(); } catch (_) {}
      try { this.flv && this.flv.destroy(); } catch (_) {}
      this.hls = null; this.flv = null;
      if (this.video) {
        try { this.video.pause(); } catch (_) {}
        this.video.removeAttribute('src');
        this.video.load();
      }
    },

    stop() {
      this.destroyPlayers();
      if (this.session?.playUrl?.startsWith('/preview/')) {
        const key = this.session.playUrl.split('/')[2];
        api.stopPlay(key).catch(() => {});
      }
    },

    toggle() {
      if (!this.video) return;
      if (this.video.paused) this.video.play().catch(() => {});
      else this.video.pause();
    },

    mute() {
      if (!this.video) return;
      this.video.muted = !this.video.muted;
      this.syncIcons();
    },

    fullscreen() {
      const scr = document.querySelector('.screen');
      if (!scr) return;
      if (document.fullscreenElement) document.exitFullscreen();
      else scr.requestFullscreen?.().catch(() => {});
    },

    async favorite() {
      if (!this.current) return toast('请先播放一个频道', 'warn');
      const isFav = (SP.state.config.player.favorites || []).some((f) => f.url === this.current.url);
      await api.playerAction({ action: isFav ? 'unfavorite' : 'favorite', channel: this.current });
      toast(isFav ? '已取消收藏' : '已收藏', 'ok', 1500);
      await SP.refreshState({ silent: true });
      renderPlaylist();
      this.updateButtons();
    },

    snapshot() {
      if (!this.video || !this.video.videoWidth) return toast('画面尚未就绪', 'warn');
      const c = document.createElement('canvas');
      c.width = this.video.videoWidth;
      c.height = this.video.videoHeight;
      c.getContext('2d').drawImage(this.video, 0, 0);
      const a = document.createElement('a');
      a.href = c.toDataURL('image/png');
      a.download = `streampilot-${Date.now()}.png`;
      a.click();
      toast('截图已保存', 'ok', 1600);
    },

    updateButtons() {
      const btn = document.querySelector('#player-fav');
      if (!btn || !this.current) return;
      const isFav = (SP.state.config.player.favorites || []).some((f) => f.url === this.current.url);
      btn.style.color = isFav ? '#f6b93b' : '';
    },

    syncIcons() {
      const btn = document.querySelector('#player-toggle');
      if (btn && this.video) btn.innerHTML = this.video.paused ? SP.util.icon('play', 15) : SP.util.icon('stop', 15);
      const m = document.querySelector('#player-mute');
      if (m && this.video) m.innerHTML = this.video.muted ? SP.util.icon('mute', 15) : SP.util.icon('volume', 15);
      const scr = document.querySelector('.screen');
      if (scr && this.video) scr.classList.toggle('paused', this.video.paused);
    },
  };

  function renderPlaylist() {
    const box = document.querySelector('#pl-items');
    if (!box) return;
    const S = SP.state;
    let items = [];
    if (player.tab === 'favorites') items = S.config.player.favorites || [];
    else if (player.tab === 'history') items = S.config.player.history || [];
    else items = chState.items || [];
    document.querySelectorAll('[data-pl-tab]').forEach((b) => b.classList.toggle('active', b.dataset.plTab === player.tab));
    // 局部刷新时同步「收藏 N」计数（整页不重渲染，否则会中断正在播的视频）
    const favBtn = document.querySelector('[data-pl-tab="favorites"]');
    if (favBtn) favBtn.textContent = `收藏 ${(S.config.player.favorites || []).length}`;
    if (!items.length) {
      const text = player.tab === 'favorites' ? '还没有收藏频道，播放时点星标即可收藏'
        : player.tab === 'history' ? '还没有播放记录'
          : '频道列表为空，请先到「电视源」更新源';
      box.innerHTML = `<div class="empty-state" style="padding:26px 12px">${icon(player.tab === 'favorites' ? 'star' : 'tv')}<b>${text}</b></div>`;
      return;
    }
    box.innerHTML = items.map((it, i) => `
      <div class="pl-item ${player.current && player.current.url === it.url ? 'active' : ''}" data-pl-play data-item="${attr(JSON.stringify({ id: it.id, name: it.name, url: it.url, logo: it.logo, headers: it.headers }))}">
        <span class="idx">${i + 1}</span>
        ${it.logo ? `<img class="ch-logo" style="width:22px;height:22px" src="${attr(it.logo)}" onerror="this.style.display='none'" />` : ''}
        <div style="min-width:0"><div class="ch-name ellipsis">${h(it.name)}</div>
          <div class="ch-sub ellipsis">${h(it.group || (it.quality || ''))}</div></div>
      </div>`).join('');
    bind(box, '[data-pl-play]', 'click', (e, el) => {
      const item = JSON.parse(el.dataset.item || '{}');
      player.play(item, { force: true });
    });
  }

  function playerView() {
    const S = SP.state;
    const fav = (S.config.player.favorites || []);
    const html = `
      <div class="player-layout">
        <div>
          <div class="screen paused">
            <video id="player-video" playsinline></video>
            <div id="player-empty" class="empty">
              ${icon('play')}
              <b>选择左侧频道开始播放</b>
              <span>支持 HLS / HTTP-FLV / RTSP / RTMP / UDP / SRT 与本地文件</span>
              <div style="display:flex;gap:8px;margin-top:6px">
                <button class="btn btn-sm" data-act="go" data-to="sources">${icon('tv', 13)} 浏览电视源</button>
                <button class="btn btn-sm" data-act="open-file-play">${icon('folder', 13)} 播放本地文件</button>
              </div>
            </div>
            <div class="live-badge"><i class="dot"></i>LIVE<div style="opacity:.6;margin-left:4px" id="player-now"></div></div>
            <div class="play-hint" id="player-hint">待播放</div>
            <div class="ctrl-bar">
              <button class="icon-btn" id="player-toggle" title="播放/暂停">${icon('play', 15)}</button>
              <button class="icon-btn" id="player-mute" title="静音">${icon('volume', 15)}</button>
              <input type="range" class="vol" id="player-vol" min="0" max="1" step="0.01" value="0.85" />
              <div class="spacer"></div>
              <button class="icon-btn" id="player-snapshot" title="截图">${icon('camera', 15)}</button>
              <button class="icon-btn" id="player-fav" title="收藏">${icon('star', 15)}</button>
              <button class="icon-btn" id="player-reload" title="重连">${icon('refresh', 15)}</button>
              <button class="icon-btn" id="player-full" title="全屏">${icon('max', 15)}</button>
            </div>
          </div>

          <div class="card" style="margin-top:12px">
            <div class="card-body" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
              <input class="input mono" id="player-url" placeholder="粘贴流地址：rtsp:// / rtmp:// / http://...m3u8 / udp:// / srt://" style="flex:1;min-width:260px;font-size:12px" />
              <button class="btn btn-primary" id="player-url-go">${icon('play', 14)} 播放</button>
              <button class="btn" data-act="player-network">${icon('sliders', 14)} 高级</button>
            </div>
          </div>

          <div class="hint-box warn" style="margin-top:10px">${icon('info')}<div>部分公开源的画面比例为 4:3 或被二次压缩，属于源本身的问题；若提示跨域或防盗链，系统已自动走本地代理与转封装，仍失败可尝试「强制转码」。</div></div>
        </div>

        <div class="playlist">
          <div class="pl-head">
            <button class="btn btn-sm" data-pl-tab="favorites" style="flex:1">收藏 ${fav.length}</button>
            <button class="btn btn-sm" data-pl-tab="history" style="flex:1">最近</button>
            <button class="btn btn-sm" data-pl-tab="channels" style="flex:1">频道</button>
          </div>
          <div class="pl-items" id="pl-items"></div>
        </div>
      </div>`;
    return {
      html,
      mount(root) {
        player.init(root);
        bind(root, '[data-act]', 'click', (e, el) => SP.actions.run(el.dataset.act, el));
      },
      destroy() { player.stop(); },
      player,
    };
  }

  return {
    sources, playerView, player, loadChannels, chState, renderPlaylist,
    catalogCard, channelRow,
  };
})();
