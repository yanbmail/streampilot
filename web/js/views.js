'use strict';

/* ============================================================
   主视图：总览 / 推流任务 / 日志 / 设置 / 说明
   ============================================================ */
SP.views = (() => {
  const { h, attr, icon, fmtKbps, fmtBytes, fmtDuration, fmtTime, relTime, statusPill, toast, confirmDlg, copyText } = SP.util;
  const api = SP.api;

  const q = (root, s) => root.querySelector(s);
  const qa = (root, s) => Array.from(root.querySelectorAll(s));
  const bind = (root, s, evt, fn) => qa(root, s).forEach((el) => el.addEventListener(evt, (e) => fn(e, el)));

  const isRunning = (status) => ['running', 'starting', 'reconnecting'].includes(status);

  function rt(job) {
    return (SP.state.runtime && SP.state.runtime[job.id]) || { status: 'idle', bitrateKbps: 0, fps: 0, uptimeSec: 0, speed: 0, totalBytes: 0 };
  }

  function sourceLabel(job) {
    const s = job.source;
    if (s.type === 'file') return `文件 · ${(s.path || '').split('/').pop() || '未选择'}`;
    if (s.type === 'files') return `轮播 · ${(s.paths || []).length} 个文件`;
    if (s.type === 'screen') return `屏幕区域 · ${s.screen.width || '全'}×${s.screen.height || '屏'}`;
    if (s.type === 'camera') return '摄像头';
    if (s.type === 'url') {
      try { return `网络流 · ${new URL(s.url).host}`; } catch (_) { return '网络流'; }
    }
    return '测试源';
  }

  function targetLabel(job) {
    const t = job.target;
    if (t.protocol === 'hls') return 'HLS · 本机分发';
    if (t.protocol === 'file') return `录制 · ${(t.filePath || '').split('/').pop() || '未设置'}`;
    if (t.protocol === 'flv') return `HTTP-FLV · :${t.flvListenPort}`;
    return `${t.protocol.toUpperCase()} · ${t.host || t.url || '未设置'}`;
  }

  /* ---------------- 任务卡 ---------------- */
  function jobCard(job) {
    const r = rt(job);
    const running = isRunning(r.status);
    const out = r.outputUrl ? `<span class="out" data-act="copy-text" data-text="${attr(location.origin + r.outputUrl)}">${icon('link', 11)} 播放地址</span>` : '';
    return `<div class="job-card ${running ? 'running' : ''}" data-job="${job.id}">
      <div class="jc-head">
        <div style="flex:1;min-width:0">
          <div class="jc-name">${h(job.name)}</div>
          <div class="jc-sub">
            <span class="route-chip">${icon(job.source.type === 'screen' ? 'monitor' : job.source.type === 'camera' ? 'camera' : job.source.type === 'url' ? 'globe' : 'film', 11)}${h(sourceLabel(job))}</span>
            <span class="route-arrow">→</span>
            <span class="route-chip">${icon('cast', 11)}${h(targetLabel(job))}</span>
          </div>
        </div>
        ${statusPill(r.status)}
      </div>
      <div class="metrics">
        <div class="metric"><span>码率</span><b data-m="bitrate">${r.bitrateKbps ? fmtKbps(r.bitrateKbps).replace(' ', '') : '—'}</b></div>
        <div class="metric"><span>帧率</span><b data-m="fps">${r.fps ? Math.round(r.fps) : '—'}</b></div>
        <div class="metric"><span>已推</span><b data-m="uptime">${r.uptimeSec ? fmtDuration(r.uptimeSec) : '—'}</b></div>
        <div class="metric"><span>速率</span><b data-m="speed">${r.speed ? `${r.speed.toFixed(2)}x` : '—'}</b></div>
      </div>
      <canvas class="spark" data-spark="${job.id}"></canvas>
      <div class="jc-foot">
        ${running
          ? `<button class="btn btn-sm" data-act="job-stop" data-id="${job.id}">${icon('stop', 12)} 停止</button>
             <button class="btn btn-sm" data-act="job-restart" data-id="${job.id}">${icon('refresh', 12)} 重启</button>`
          : `<button class="btn btn-sm btn-primary" data-act="job-start" data-id="${job.id}">${icon('play', 12)} 开始推流</button>`}
        <button class="btn btn-sm btn-ghost" data-act="job-edit" data-id="${job.id}">${icon('edit', 12)} 编辑</button>
        ${out}
      </div>
      ${r.lastError ? `<div class="small" style="color:#ff9aa4;margin-top:6px">${h(r.lastError).slice(0, 120)}</div>` : ''}
    </div>`;
  }

  function drawSparks(root) {
    qa(root, '[data-spark]').forEach((c) => {
      const job = SP.state.config.jobs.find((j) => j.id === c.dataset.spark);
      const series = (SP.series.get(c.dataset.spark) || []).slice(-90);
      const running = job && isRunning(rt(job).status);
      SP.util.sparkline(c, series, running ? '#ff5c6c' : '#4c8dff');
    });
  }

  /* ---------------- 总览 ---------------- */
  function dashboard() {
    const S = SP.state;
    const jobs = S.config.jobs;
    const runtimes = jobs.map(rt);
    const running = runtimes.filter((r) => r.status === 'running').length;
    const bitrate = runtimes.reduce((a, r) => a + (r.bitrateKbps || 0), 0);
    const bytes = runtimes.reduce((a, r) => a + (r.totalBytes || 0), 0);
    const ff = S.system.ffmpeg;

    const html = `
      <div class="stats">
        <div class="stat live">
          <div class="label">${icon('cast', 13)} 运行中任务</div>
          <div class="value" id="stat-running">${running}<small>/ ${jobs.length}</small></div>
          <div class="foot">${jobs.length ? `已配置 ${jobs.length} 条推流链路` : '还没有创建推流任务'}</div>
        </div>
        <div class="stat">
          <div class="label">${icon('activity', 13)} 实时输出码率</div>
          <div class="value" id="stat-bitrate">${bitrate ? (bitrate / 1000).toFixed(2) : '0.00'}<small>Mbps</small></div>
          <div class="foot">所有运行中任务之和</div>
        </div>
        <div class="stat ok">
          <div class="label">${icon('upload', 13)} 累计送出</div>
          <div class="value" id="stat-bytes">${fmtBytes(bytes)}</div>
          <div class="foot">本次运行累计推流数据量</div>
        </div>
        <div class="stat">
          <div class="label">${icon('tv', 13)} 电视源频道</div>
          <div class="value" id="stat-channels">${S.iptv.total || 0}<small>个</small></div>
          <div class="foot">${S.iptv.enabledCatalogs || 0} 个源已启用 · ${relTime(S.iptv.lastRefresh)}更新</div>
        </div>
      </div>

      <div class="dash-grid">
        <div>
          <div class="section-title">
            <h2>推流任务</h2><span class="hint">${jobs.length ? `${jobs.length} 条链路` : ''}</span>
            <div class="line"></div>
            <button class="btn btn-sm btn-ghost" data-act="start-all">${icon('play', 12)} 全部启动</button>
            <button class="btn btn-sm btn-ghost" data-act="stop-all">${icon('stop', 12)} 全部停止</button>
            <button class="btn btn-sm btn-primary" data-act="new-job">${icon('plus', 12)} 新建推流</button>
          </div>
          ${jobs.length ? `<div class="jobs-grid">${jobs.map(jobCard).join('')}</div>` : `
            <div class="card"><div class="empty-state">
              ${icon('cast')}
              <b>还没有推流任务</b>
              <p>从本地文件、屏幕区域、摄像头或电视源开始推流，支持 RTMP / RTSP / SRT / HLS / UDP</p>
              <div style="margin-top:14px;display:flex;gap:8px;justify-content:center">
                <button class="btn btn-primary" data-act="new-job">${icon('plus', 14)} 创建第一个任务</button>
                <button class="btn" data-act="go" data-to="sources">${icon('tv', 14)} 浏览电视源</button>
              </div>
            </div></div>`}
        </div>

        <div style="display:flex;flex-direction:column;gap:12px">
          <div class="card">
            <div class="card-head"><h3>运行环境</h3><div class="spacer"></div>
              <span class="pill ${ff.ok ? 'ok' : 'error'}"><i class="dot"></i>${ff.ok ? '就绪' : '未就绪'}</span>
            </div>
            <div class="card-body">
              <dl class="kv">
                <dt>FFmpeg</dt><dd>${h(ff.version || '未检测到')}</dd>
                <dt>可执行文件</dt><dd title="${attr(ff.path)}">${h(ff.path || '—')}</dd>
                <dt>硬件编码</dt><dd>${ff.hardware?.length ? h(ff.hardware.join(', ')) : '无'}</dd>
                <dt>平台</dt><dd>${h(S.system.platform)} / ${h(S.system.arch)}</dd>
                <dt>数据目录</dt><dd title="${attr(S.system.dataDir)}">${h(S.system.dataDir)}</dd>
              </dl>
              <div style="display:flex;gap:6px;margin-top:10px">
                <button class="btn btn-sm" data-act="redetect">${icon('refresh', 12)} 重新检测</button>
                <button class="btn btn-sm" data-act="go" data-to="settings">${icon('sliders', 12)} 设置</button>
              </div>
            </div>
          </div>

          <div class="card">
            <div class="card-head"><h3>快捷操作</h3></div>
            <div class="card-body" style="display:flex;flex-direction:column;gap:6px">
              <button class="btn" data-act="new-job">${icon('plus', 14)} 新建推流任务</button>
              <button class="btn" data-act="go" data-to="sources">${icon('tv', 14)} 电视源 / 一键转推</button>
              <button class="btn" data-act="go" data-to="player">${icon('play', 14)} 打开播放器</button>
              <button class="btn" data-act="backup-now">${icon('save', 14)} 立即备份配置</button>
            </div>
          </div>

          <div class="card">
            <div class="card-head"><h3>推荐电视源</h3><div class="spacer"></div>
              <button class="btn btn-sm btn-ghost" data-act="go" data-to="sources">全部</button>
            </div>
            <div class="card-body" style="display:flex;flex-direction:column;gap:8px">
              ${(S.iptv.groups || []).slice(0, 5).map((g) => `
                <div style="display:flex;align-items:center;gap:8px;font-size:12px">
                  <span class="dot" style="width:6px;height:6px;border-radius:50%;background:var(--accent)"></span>
                  <span class="ellipsis">${h(g.name)}</span>
                  <span class="spacer"></span>
                  <span class="mono dim" style="font-size:10.5px">${g.count}</span>
                </div>`).join('') || '<div class="dim small">尚未同步频道数据，前往「电视源」页更新</div>'}
            </div>
          </div>
        </div>
      </div>`;

    return {
      html,
      mount(root) {
        drawSparks(root);
        bind(root, '[data-act]', 'click', (e, el) => SP.actions.run(el.dataset.act, el));
      },
      onStats() {
        const S = SP.state;
        const jobs = S.config.jobs;
        const runtimes = jobs.map(rt);
        const running = runtimes.filter((r) => r.status === 'running').length;
        const bitrate = runtimes.reduce((a, r) => a + (r.bitrateKbps || 0), 0);
        const bytes = runtimes.reduce((a, r) => a + (r.totalBytes || 0), 0);
        const set = (id, val) => { const el = document.getElementById(id); if (el) el.innerHTML = val; };
        set('stat-running', `${running}<small>/ ${jobs.length}</small>`);
        set('stat-bitrate', `${bitrate ? (bitrate / 1000).toFixed(2) : '0.00'}<small>Mbps</small>`);
        set('stat-bytes', fmtBytes(bytes));
        for (const job of jobs) {
          const r = rt(job);
          const card = document.querySelector(`.job-card[data-job="${job.id}"]`);
          if (!card) continue;
          const m = (k) => card.querySelector(`[data-m="${k}"]`);
          if (m('bitrate')) m('bitrate').textContent = r.bitrateKbps ? fmtKbps(r.bitrateKbps).replace(' ', '') : '—';
          if (m('fps')) m('fps').textContent = r.fps ? Math.round(r.fps) : '—';
          if (m('uptime')) m('uptime').textContent = r.uptimeSec ? fmtDuration(r.uptimeSec) : '—';
          if (m('speed')) m('speed').textContent = r.speed ? `${r.speed.toFixed(2)}x` : '—';
        }
        drawSparks(document);
      },
    };
  }

  /* ---------------- 推流任务列表 ---------------- */
  function streams() {
    const S = SP.state;
    const jobs = S.config.jobs;
    const html = `
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:14px;flex-wrap:wrap">
        <div class="search" style="max-width:300px">${icon('search')}<input class="input" id="job-search" placeholder="搜索任务名称 / 地址" /></div>
        <div class="spacer"></div>
        <button class="btn btn-sm" data-act="start-all">${icon('play', 12)} 全部启动</button>
        <button class="btn btn-sm" data-act="stop-all">${icon('stop', 12)} 全部停止</button>
        <button class="btn btn-primary" data-act="new-job">${icon('plus', 14)} 新建推流</button>
      </div>
      <div class="table-wrap">
        <table class="tbl">
          <thead><tr>
            <th style="width:26%">任务</th><th class="col-optional">输入源</th><th class="col-optional">推流目标</th><th>状态</th>
            <th class="num">码率</th><th class="num col-optional">帧率</th><th class="num">已推</th><th class="col-actions" style="width:150px"></th>
          </tr></thead>
          <tbody id="job-rows">${jobs.map(jobRow).join('') || `<tr><td colspan="8"><div class="empty-state">${icon('cast')}<b>暂无任务</b><p>点击右上角「新建推流」开始</p></div></td></tr>`}</tbody>
        </table>
      </div>`;

    function jobRow(job) {
      const r = rt(job);
      const running = isRunning(r.status);
      const fanCount = (job.targets || []).filter((x) => x.url || x.host).length;
      const recOn = Boolean(job.record && job.record.enabled);
      const tags = [
        fanCount ? `<span class="tag-fan">+${fanCount} 路</span>` : '',
        recOn ? '<span class="tag-rec">● 录制</span>' : '',
      ].join('');
      return `<tr data-job-row="${job.id}" data-search="${attr(`${job.name} ${job.source.url || ''} ${job.target.host || ''} ${job.target.filePath || ''}`.toLowerCase())}">
        <td class="cell-name"><div style="font-weight:550">${h(job.name)}${tags}</div>
          <div class="small dim mono">${h(job.id)}</div></td>
        <td class="small muted cell-trunc col-optional">${h(sourceLabel(job))}</td>
        <td class="small muted cell-trunc col-optional">${h(targetLabel(job))}</td>
        <td>${statusPill(r.status)}</td>
        <td class="num">${r.bitrateKbps ? fmtKbps(r.bitrateKbps) : '—'}</td>
        <td class="num col-optional">${r.fps ? Math.round(r.fps) : '—'}</td>
        <td class="num">${r.uptimeSec ? fmtDuration(r.uptimeSec) : '—'}</td>
        <td class="cell-actions"><div class="row-actions">
          ${running
            ? `<button class="icon-btn" title="停止" data-act="job-stop" data-id="${job.id}">${icon('stop', 14)}</button>
               <button class="icon-btn" title="重启" data-act="job-restart" data-id="${job.id}">${icon('refresh', 14)}</button>`
            : `<button class="icon-btn" title="启动" data-act="job-start" data-id="${job.id}">${icon('play', 14)}</button>`}
          <button class="icon-btn" title="编辑" data-act="job-edit" data-id="${job.id}">${icon('edit', 14)}</button>
          <button class="icon-btn" title="复制任务" data-act="job-clone" data-id="${job.id}">${icon('copy', 14)}</button>
          <button class="icon-btn" title="删除" data-act="job-delete" data-id="${job.id}">${icon('trash', 14)}</button>
        </div></td>
      </tr>`;
    }

    return {
      html,
      mount(root) {
        bind(root, '[data-act]', 'click', (e, el) => SP.actions.run(el.dataset.act, el));
        const search = q(root, '#job-search');
        search && search.addEventListener('input', () => {
          const kw = search.value.trim().toLowerCase();
          qa(root, '[data-job-row]').forEach((tr) => {
            tr.style.display = !kw || tr.dataset.search.includes(kw) ? '' : 'none';
          });
        });
      },
      onStats() {
        for (const job of SP.state.config.jobs) {
          const tr = document.querySelector(`[data-job-row="${job.id}"]`);
          if (!tr) continue;
          const r = rt(job);
          const cells = tr.querySelectorAll('td');
          if (cells[4]) cells[4].textContent = r.bitrateKbps ? fmtKbps(r.bitrateKbps) : '—';
          if (cells[5]) cells[5].textContent = r.fps ? Math.round(r.fps) : '—';
          if (cells[6]) cells[6].textContent = r.uptimeSec ? fmtDuration(r.uptimeSec) : '—';
        }
      },
    };
  }

  /* ---------------- 日志 ---------------- */
  function logs() {
    return {
      html: `
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px;flex-wrap:wrap">
          <select class="select" id="log-job" style="width:220px">
            <option value="">全部任务</option>
            ${SP.state.config.jobs.map((j) => `<option value="${j.id}">${h(j.name)}</option>`).join('')}
          </select>
          <select class="select" id="log-level" style="width:150px">
            <option value="">全部级别</option><option value="info">信息</option><option value="warn">警告</option><option value="error">错误</option><option value="ok">成功</option>
          </select>
          <label class="switch"><input type="checkbox" id="log-follow" checked /><span class="track"></span><span class="lbl">自动滚动</span></label>
          <div class="spacer"></div>
          <button class="btn btn-sm" id="log-clear">${icon('trash', 12)} 清空视图</button>
          <button class="btn btn-sm" id="log-download">${icon('download', 12)} 导出</button>
        </div>
        <div class="log-box" id="log-box"></div>`,
      mount(root) {
        const box = q(root, '#log-box');
        const render = () => {
          const jobId = q(root, '#log-job').value;
          const level = q(root, '#log-level').value;
          const lines = (SP.logBuffer || []).filter((l) => (!jobId || l.jobId === jobId) && (!level || l.level === level));
          box.innerHTML = lines.slice(-600).map((l) => {
            const job = SP.state.config.jobs.find((j) => j.id === l.jobId);
            const t = new Date(l.t);
            const p = (n) => String(n).padStart(2, '0');
            return `<div class="log-line ${l.level}"><span class="t">${p(t.getHours())}:${p(t.getMinutes())}:${p(t.getSeconds())}</span><span class="j">${h((job?.name || '').slice(0, 10))}</span><span>${h(l.line)}</span></div>`;
          }).join('') || '<div class="dim">暂无日志。启动推流后，FFmpeg 的输出会实时显示在这里。</div>';
          if (q(root, '#log-follow').checked) box.scrollTop = box.scrollHeight;
        };
        render();
        q(root, '#log-job').addEventListener('change', render);
        q(root, '#log-level').addEventListener('change', render);
        q(root, '#log-clear').addEventListener('click', () => { SP.logBuffer = []; render(); });
        q(root, '#log-download').addEventListener('click', () => {
          const text = (SP.logBuffer || []).map((l) => `[${new Date(l.t).toISOString()}] [${l.level}] ${l.line}`).join('\n');
          const blob = new Blob([text], { type: 'text/plain' });
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = `streampilot-${Date.now()}.log`;
          a.click();
        });
        SP.views._logsRender = render;
      },
    };
  }

  /* ---------------- 设置 ---------------- */
  function settings() {
    const S = SP.state;
    const st = S.config.settings;
    const ff = S.system.ffmpeg;
    const rc = S.rtmp || { running: false, port: 1935, httpPort: 8399, streams: [] };
    const lanIp = (S.system.addresses || [])[0]?.address || '127.0.0.1';
    const encoders = ['libx264', 'h264_videotoolbox', 'libx265', 'hevc_videotoolbox'].filter((e) => ff.encoders.includes(e));
    const html = `
      <div class="settings-grid">
        <div class="card">
          <div class="card-head"><h3>FFmpeg 环境</h3><div class="spacer"></div>
            <span class="pill ${ff.ok ? 'ok' : 'error'}"><i class="dot"></i>${ff.ok ? ff.version : '未检测到'}</span>
          </div>
          <div class="card-body">
            <div class="field">
              <label>FFmpeg 路径</label>
              <div class="input-group">
                <input class="input mono" id="set-ffmpeg" value="${attr(st.ffmpegPath || ff.path)}" placeholder="留空自动探测" />
                <button class="btn" id="set-redetect">${icon('refresh', 14)} 检测</button>
              </div>
              <div class="help">支持系统 PATH、Homebrew、以及自定义完整路径。重新检测会立即刷新能力列表。</div>
            </div>
            <div style="margin-top:12px">
              <div class="small dim" style="margin-bottom:6px">已启用协议</div>
              <div class="chips">${(ff.protocols || []).filter((p) => /^(rtmp|rtmps|rtsp|srt|udp|rtp|http|https|hls|tcp|file)$/.test(p)).map((p) => `<span class="chip sm">${p}</span>`).join('') || '<span class="dim small">—</span>'}</div>
            </div>
            <div style="margin-top:10px">
              <div class="small dim" style="margin-bottom:6px">可用编码器</div>
              <div class="chips">${encoders.map((e) => `<span class="chip sm">${h(SP.describeEncoder(e).split('（')[0])}</span>`).join('') || '<span class="dim small">—</span>'}</div>
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card-head"><h3>默认推流参数</h3></div>
          <div class="card-body">
            <div class="form-grid">
              ${fieldSelect('默认分辨率', 'set-default-res', [
                ['1280x720', '720P · 1280×720'], ['1920x1080', '1080P · 1920×1080'],
                ['2560x1440', '2K · 2560×1440'], ['3840x2160', '4K · 3840×2160'],
                ['1080x1920', '竖屏 · 1080×1920'],
              ], `${st.defaults?.video?.width || 1920}x${st.defaults?.video?.height || 1080}`)}
              <div class="field"><label>默认码率</label><input class="input" id="set-default-bitrate" type="number" value="${st.defaults?.video?.bitrateKbps || 6000}" /></div>
              <div class="field"><label>默认帧率</label><select class="select" id="set-default-fps">${[24, 25, 30, 50, 60].map((f) => `<option value="${f}" ${(st.defaults?.video?.fps || 30) === f ? 'selected' : ''}>${f} fps</option>`).join('')}</select></div>
              <div class="field"><label>默认编码器</label><select class="select" id="set-default-encoder">${['libx264', 'h264_videotoolbox', 'libx265', 'hevc_videotoolbox'].map((e) => `<option value="${e}" ${(st.defaults?.video?.encoder || 'libx264') === e ? 'selected' : ''}>${h(SP.describeEncoder(e))}</option>`).join('')}</select></div>
            </div>
            <div class="hint-box" style="margin-top:12px">${icon('info')}<div>新建任务时自动带入这些参数，单个任务可再调整。</div></div>
          </div>
        </div>

        <div class="card">
          <div class="card-head"><h3>播放与拉流</h3></div>
          <div class="card-body">
            <div class="field"><label>默认 User-Agent</label><input class="input mono" id="set-ua" value="${attr(st.player?.userAgent || '')}" /></div>
            <div class="field" style="margin-top:10px"><label>默认 Referer（防盗链源）</label><input class="input mono" id="set-referer" value="${attr(st.player?.referer || '')}" placeholder="留空不发送" /></div>
            <div class="form-grid" style="margin-top:10px">
              <div class="field"><label>拉流方式</label><select class="select" id="set-preview-mode">
                ${[['auto', '自动（能转封装就转封装）'], ['transcode', '始终转码（兼容性最好）'], ['copy', '优先直通']].map(([v, l]) => `<option value="${v}" ${(st.preview?.mode || 'auto') === v ? 'selected' : ''}>${l}</option>`).join('')}
              </select></div>
              <div class="field"><label>预览最大高度</label><select class="select" id="set-preview-height">${[720, 1080, 1440].map((hh) => `<option value="${hh}" ${(st.preview?.maxHeight || 1080) === hh ? 'selected' : ''}>${hh}P</option>`).join('')}</select></div>
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card-head"><h3>网络与远程访问</h3><div class="spacer"></div>
            <span class="pill info"><i class="dot"></i>端口 ${S.config.settings.http.port}</span>
          </div>
          <div class="card-body">
            <div class="setting-row">
              <div class="txt"><b>允许局域网访问</b><span>开启后可在手机、平板或其他电脑上管理推流（需重启应用生效）</span></div>
              <label class="switch"><input type="checkbox" id="set-lan" ${st.http?.allowLan ? 'checked' : ''} /><span class="track"></span></label>
            </div>
            ${st.http?.lanToken ? `<div class="field" style="margin-top:10px"><label>访问令牌</label>
              <div class="input-group"><input class="input mono" readonly value="${attr(st.http.lanToken)}" /><button class="btn" data-act="copy-text" data-text="${attr(st.http.lanToken)}">复制</button></div>
            </div>` : ''}
            <div style="margin-top:10px">
              <div class="small dim" style="margin-bottom:6px">本机可用地址</div>
              ${(S.system.addresses || []).map((a) => `<div class="mono small" style="margin-bottom:3px">http://${h(a.address)}:${S.config.settings.http.port}${st.http?.lanToken ? `?token=${h(st.http.lanToken)}` : ''} <span class="dim">(${h(a.name)})</span></div>`).join('') || '<div class="dim small">未检测到局域网地址</div>'}
            </div>
          </div>
        </div>

        <div class="card span-full">
          <div class="card-head"><h3>内置 RTMP 收流服务</h3><div class="spacer"></div>
            <span class="pill ${rc.running ? 'ok' : 'info'}"><i class="dot"></i>${rc.running ? '运行中' : '已停止'}</span>
          </div>
          <div class="card-body">
            <div class="hint-box">${icon('info')}<div>开启后本机就是推流接收端：OBS、手机推流 App、其他设备直接推到本机，收上来的流可以预览、转推、同时录制，不必再另装 nginx-rtmp / SRS。</div></div>
            <div class="form-grid" style="margin-top:12px">
              <div class="field"><label>RTMP 收流端口</label><input class="input" id="rtmp-port" type="number" value="${rc.port || 1935}" ${rc.running ? 'disabled' : ''} />
                <div class="help">OBS「服务器」填 rtmp://本机IP:端口/live</div></div>
              <div class="field"><label>HTTP-FLV 播放端口</label><input class="input" id="rtmp-http-port" type="number" value="${rc.httpPort || 8399}" ${rc.running ? 'disabled' : ''} />
                <div class="help">浏览器可直接播放 http://IP:端口/live/流名.flv</div></div>
              <div class="field" style="justify-content:flex-end;display:flex">
                ${rc.running
    ? `<button class="btn btn-danger" data-act="rtmp-stop">${icon('stop', 14)} 停止收流</button>`
    : `<button class="btn btn-primary" data-act="rtmp-start">${icon('cast', 14)} 启动收流</button>`}
              </div>
            </div>
            ${rc.running ? `
            <div class="field" style="margin-top:6px">
              <label>推流地址（OBS「服务器」+「串流密钥」）</label>
              <div class="input-group">
                <input class="input mono" readonly value="rtmp://${h(lanIp)}:${rc.port}/live/" />
                <button class="btn" data-act="copy-text" data-text="rtmp://${attr(lanIp)}:${rc.port}/live/">复制</button>
              </div>
              <div class="help">串流密钥自己定，例如 <code>myphone</code>，推上来后下面会出现这一路流</div>
            </div>` : ''}
            <div style="margin-top:14px">
              <div class="small dim" style="margin-bottom:6px">当前收到的流</div>
              ${(rc.streams || []).length ? (rc.streams || []).map((s) => `
                <div class="ingest-item">
                  <span class="nm mono">${h(s.app)}/${h(s.name)}</span>
                  <span class="dim small">${Math.floor((Date.now() - s.startedAt) / 1000)}s</span>
                  <div class="spacer"></div>
                  <button class="btn btn-sm" data-act="copy-text" data-text="http://${attr(lanIp)}:${rc.httpPort}/live/${attr(s.name)}.flv">复制播放地址</button>
                  <button class="btn btn-sm" data-act="rtmp-play" data-url="http://${attr(lanIp)}:${rc.httpPort}/live/${attr(s.name)}.flv" data-name="${attr(s.name)}">${icon('play', 12)} 预览</button>
                  <button class="btn btn-sm btn-primary" data-act="rtmp-push" data-stream="${attr(s.name)}">${icon('cast', 12)} 转推</button>
                </div>`).join('') : '<div class="dim small">暂无推流接入，启动服务后用 OBS 或手机推流试试</div>'}
            </div>
          </div>
        </div>

        <div class="card span-full">
          <div class="card-head"><h3>配置备份</h3><div class="spacer"></div>
            <button class="btn btn-sm" data-act="backup-now">${icon('save', 12)} 立即备份</button>
            <button class="btn btn-sm" data-act="export-config">${icon('download', 12)} 导出</button>
            <button class="btn btn-sm" data-act="import-config">${icon('upload', 12)} 导入</button>
          </div>
          <div class="card-body">
            <div class="setting-row">
              <div class="txt"><b>自动快照</b><span>每次配置变更会实时写入磁盘，并按间隔保留历史快照；停止推流前会自动快照一次</span></div>
              <label class="switch"><input type="checkbox" id="set-backup" ${st.backup?.enabled ? 'checked' : ''} /><span class="track"></span><span class="lbl">启用</span></label>
            </div>
            <div class="form-grid" style="margin:10px 0">
              <div class="field"><label>快照间隔（分钟）</label><input class="input" id="set-backup-interval" type="number" value="${st.backup?.intervalMin || 30}" /></div>
              <div class="field"><label>保留份数</label><input class="input" id="set-backup-keep" type="number" value="${st.backup?.keep || 40}" /></div>
            </div>
            <div style="max-height:190px;overflow:auto">
              ${(S.backups || []).map((b) => `<div class="backup-item">
                <span class="nm">${h(b.name)}</span><span class="dim">${b.human}</span>
                <span class="tm">${fmtTime(b.mtime)}</span>
                <button class="btn btn-sm btn-ghost" data-act="restore-backup" data-name="${attr(b.name)}">恢复</button>
              </div>`).join('') || '<div class="dim small">暂无历史快照</div>'}
            </div>
          </div>
        </div>

        <div class="card span-full">
          <div class="card-head"><h3>数据目录与关于</h3></div>
          <div class="card-body" style="display:flex;gap:24px;flex-wrap:wrap">
            <dl class="kv" style="flex:1;min-width:260px">
              <dt>数据目录</dt><dd>${h(S.system.dataDir)}</dd>
              <dt>配置版本</dt><dd>v${S.config.version}</dd>
              <dt>应用版本</dt><dd>${h(S.system.appVersion)}</dd>
              <dt>运行模式</dt><dd>${window.navigator.userAgent.includes('Electron') ? '桌面客户端' : '浏览器'}</dd>
            </dl>
            <div style="display:flex;flex-direction:column;gap:8px;min-width:180px">
              <button class="btn" data-act="open-dir">${icon('folder', 14)} 打开数据目录</button>
              <button class="btn" data-act="save-settings">${icon('save', 14)} 保存全部设置</button>
            </div>
          </div>
        </div>
      </div>`;

    function fieldSelect(label, id, options, value) {
      return `<div class="field"><label>${label}</label><select class="select" id="${id}">
        ${options.map(([v, l]) => `<option value="${v}" ${v === value ? 'selected' : ''}>${l}</option>`).join('')}
      </select></div>`;
    }

    return {
      html,
      mount(root) {
        bind(root, '[data-act]', 'click', (e, el) => SP.actions.run(el.dataset.act, el));
        q(root, '#set-redetect').addEventListener('click', async () => {
          const path = q(root, '#set-ffmpeg').value.trim();
          try {
            await api.settings({ ffmpegPath: path });
            const r = await api.redetect();
            SP.state.system = r.system;
            toast(r.ok ? `已识别 FFmpeg ${r.system.ffmpeg.version}` : '未找到可用的 FFmpeg', r.ok ? 'ok' : 'error');
            SP.render();
          } catch (err) { toast(err.message, 'error'); }
        });
        q(root, '#set-lan').addEventListener('change', async (e) => {
          await api.settings({ http: { allowLan: e.target.checked } });
          toast(e.target.checked ? '已开启局域网访问，重启应用后生效' : '已关闭局域网访问，重启应用后生效', 'warn', 5000);
          SP.refreshState();
        });
      },
      collect() {
        const root = document.querySelector('#view');
        const [w, hh] = (q(root, '#set-default-res').value || '1920x1080').split('x').map(Number);
        return {
          ffmpegPath: q(root, '#set-ffmpeg').value.trim(),
          defaults: {
            video: {
              width: w, height: hh,
              bitrateKbps: Number(q(root, '#set-default-bitrate').value) || 6000,
              fps: Number(q(root, '#set-default-fps').value) || 30,
              encoder: q(root, '#set-default-encoder').value,
            },
          },
          player: {
            userAgent: q(root, '#set-ua').value.trim(),
            referer: q(root, '#set-referer').value.trim(),
          },
          preview: {
            mode: q(root, '#set-preview-mode').value,
            maxHeight: Number(q(root, '#set-preview-height').value),
          },
          backup: {
            enabled: q(root, '#set-backup').checked,
            intervalMin: Number(q(root, '#set-backup-interval').value) || 30,
            keep: Number(q(root, '#set-backup-keep').value) || 40,
          },
        };
      },
    };
  }

  /* ---------------- 使用说明 ---------------- */
  function help() {
    return {
      html: `
        <div class="settings-grid">
          <div class="card span-full">
            <div class="card-head"><h3>快速上手</h3></div>
            <div class="card-body" style="line-height:1.85;font-size:12.5px;color:#c3d1e4">
              <p><b>1. 推一个本地视频到 RTMP</b>：推流任务 → 新建 → 输入源选「媒体文件」→ 画面选 1080P、码率 6000 kbps → 推流目标选 RTMP，填服务器与推流码 → 保存并启动。</p>
              <p><b>2. 推屏幕区域</b>：输入源选「屏幕区域」→ 点「检测」拿到屏幕分辨率 → 用快速选区或直接填 X/Y/宽/高 → 画面分辨率按需设置。macOS 首次需要授权「屏幕录制」。</p>
              <p><b>3. 电视源转推</b>：电视源 → 更新源 → 搜到频道 → 「转推」，自动生成一个网络流任务，改好码率和目标即可开播。</p>
              <p><b>4. 本地分发/自测</b>：推流目标选「HLS 本地」或「HTTP-FLV」，保存后任务卡上会出现播放地址，同局域网设备可直接打开。</p>
            </div>
          </div>

          <div class="card">
            <div class="card-head"><h3>协议与推荐参数</h3></div>
            <div class="card-body">
              <table class="tbl" style="font-size:11.5px">
                <thead><tr><th>协议</th><th>端口</th><th>适用场景</th></tr></thead>
                <tbody>
                  <tr><td>RTMP</td><td class="mono">1935</td><td>B 站/抖音/YouTube 等平台推流</td></tr>
                  <tr><td>RTMPS</td><td class="mono">443</td><td>需要 TLS 的公网推流</td></tr>
                  <tr><td>RTSP</td><td class="mono">8554</td><td>安防/NVR/MediaMTX 内网分发</td></tr>
                  <tr><td>SRT</td><td class="mono">9000</td><td>弱网、跨地域低延迟回传</td></tr>
                  <tr><td>UDP</td><td class="mono">1234</td><td>局域网组播、酒店/广电系统</td></tr>
                  <tr><td>HLS</td><td class="mono">本机</td><td>浏览器/手机直接观看，兼容性最好</td></tr>
                </tbody>
              </table>
              <div class="hint-box" style="margin-top:12px">${icon('info')}<div>1080P 常规档：H.264 + 6000 kbps + 30fps + GOP 2 秒；带宽紧张时降到 4500 kbps，体育/游戏可上 8000 kbps。</div></div>
            </div>
          </div>

          <div class="card">
            <div class="card-head"><h3>常见问题</h3></div>
            <div class="card-body" style="line-height:1.7;font-size:12px;color:#b9c7dc">
              <p><b>屏幕采集黑屏/报错？</b><br/>macOS：系统设置 → 隐私与安全性 → 屏幕录制，勾选 StreamPilot 或启动它的终端，然后重启应用。Windows 无需授权。</p>
              <p><b>推流提示 Connection refused？</b><br/>确认服务器地址、端口、app/推流码；RTSP 目标需服务端支持 ANNOUNCE（推荐 MediaMTX）。</p>
              <p><b>电视源打不开？</b><br/>公开源经常失效，可换同名频道或稍后重试；部分源限制地区或运营商网络。播放页支持自定义 UA / Referer。</p>
              <p><b>RTMP 目标能否用 HEVC？</b><br/>标准 RTMP 只支持 H.264，需要 HEVC 请用 SRT 或 RTMP 增强协议的服务端。</p>
            </div>
          </div>
        </div>`,
      mount() {},
    };
  }

  return { dashboard, streams, logs, settings, help, drawSparks, isRunning, rt, sourceLabel, targetLabel };
})();
