'use strict';

/* ============================================================
   推流任务编辑器
   ============================================================ */
SP.jobForm = (() => {
  const { h, attr, icon, toast, openModal } = SP.util;
  const api = SP.api;

  const TABS = [
    { id: 'source', label: '输入源', icon: 'route' },
    { id: 'video', label: '画面', icon: 'film' },
    { id: 'audio', label: '音频', icon: 'music' },
    { id: 'target', label: '推流目标', icon: 'cast' },
    { id: 'advanced', label: '高级', icon: 'sliders' },
  ];

  const PROTOCOLS = [
    { v: 'rtmp', l: 'RTMP' }, { v: 'rtmps', l: 'RTMPS' }, { v: 'rtsp', l: 'RTSP' },
    { v: 'srt', l: 'SRT' }, { v: 'udp', l: 'UDP' }, { v: 'hls', l: 'HLS 本地' },
    { v: 'flv', l: 'HTTP-FLV' }, { v: 'file', l: '录制文件' },
  ];

  const SOURCE_TYPES = [
    { v: 'test', l: '测试源', icon: 'activity' },
    { v: 'file', l: '媒体文件', icon: 'film' },
    { v: 'files', l: '多文件轮播', icon: 'list' },
    { v: 'screen', l: '屏幕区域', icon: 'monitor' },
    { v: 'camera', l: '摄像头', icon: 'camera' },
    { v: 'url', l: '网络流', icon: 'globe' },
  ];

  let draft = null;
  let activeTab = 'source';
  let entry = null;
  let callback = null;
  let isNew = true;
  let devices = null;
  let commandText = '';

  /* ---------- 路径存取 ---------- */
  function getPath(obj, path) {
    return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
  }
  function setPath(obj, path, value) {
    const parts = path.split('.');
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      if (typeof cur[parts[i]] !== 'object' || cur[parts[i]] === null) cur[parts[i]] = {};
      cur = cur[parts[i]];
    }
    cur[parts[parts.length - 1]] = value;
  }
  const v = (k) => getPath(draft, k);

  /* ---------- 小部件 ---------- */
  function field(label, inner, help = '', cls = '') {
    return `<div class="field ${cls}"><label>${label}</label>${inner}${help ? `<div class="help">${help}</div>` : ''}</div>`;
  }
  function inputK(k, opts = {}) {
    const val = v(k);
    const type = opts.type || 'text';
    const extra = [
      opts.ph ? `placeholder="${attr(opts.ph)}"` : '',
      opts.min !== undefined ? `min="${opts.min}"` : '',
      opts.max !== undefined ? `max="${opts.max}"` : '',
      opts.step !== undefined ? `step="${opts.step}"` : '',
      opts.type === 'num' ? 'data-type="num"' : '',
      opts.rerender ? 'data-rerender="1"' : '',
      opts.mono ? 'style="font-family:var(--mono);font-size:12px"' : '',
    ].filter(Boolean).join(' ');
    const shown = opts.emptyZero && (val === 0 || val === '0') ? '' : (val ?? '');
    return `<input class="input" data-k="${k}" type="${type === 'num' ? 'number' : type}" value="${attr(shown)}" ${extra} />`;
  }
  function selectK(k, options, cls = '') {
    const val = String(v(k) ?? '');
    return `<select class="select ${cls}" data-k="${k}" ${cls.includes('re') ? 'data-rerender="1"' : ''}>
      ${options.map((o) => `<option value="${attr(o.v)}" ${String(o.v) === val ? 'selected' : ''}>${h(o.l)}</option>`).join('')}
    </select>`;
  }
  function segK(k, options, { rerender = false, wide = true } = {}) {
    const val = String(v(k) ?? '');
    return `<div class="seg ${wide ? 'wide' : ''}">${options.map((o) => `
      <button type="button" class="${String(o.v) === val ? 'active' : ''}"
        data-set="${k}" data-value="${attr(o.v)}" ${rerender ? 'data-re="1"' : ''}>${o.icon ? icon(o.icon, 13) + ' ' : ''}${h(o.l)}</button>`).join('')}
    </div>`;
  }
  function switchK(k, label, help = '') {
    return `<label class="switch">
      <input type="checkbox" data-k="${k}" ${v(k) ? 'checked' : ''} />
      <span class="track"></span><span class="lbl">${h(label)}</span>
    </label>${help ? `<div class="help">${help}</div>` : ''}`;
  }
  function chipSet(k, values, { num = true, unit = '' } = {}) {
    const cur = Number(v(k)) || 0;
    return `<div class="chips">${values.map((x) => `
      <span class="chip ${cur === x ? 'active' : ''}" data-set="${k}" data-value="${x}" ${num ? 'data-type="num"' : ''}>${x}${unit}</span>`).join('')}</div>`;
  }

  /* ---------- 模态骨架 ---------- */
  function open({ job = null, preset = {}, onSaved = null } = {}) {
    const S = SP.state;
    isNew = !job;
    draft = JSON.parse(JSON.stringify(job || S.template || {}));
    if (!job) {
      draft.id = '';
      draft.name = preset.name || '新建推流';
      const d = S.config.settings.defaults || {};
      if (d.video) draft.video = { ...draft.video, ...d.video };
      if (d.audio) draft.audio = { ...draft.audio, ...d.audio };
      if (preset.source) draft.source = { ...draft.source, ...preset.source };
      if (preset.target) draft.target = { ...draft.target, ...preset.target };
      draft.target = { ...draft.target, ...(preset.target || {}) };
    }
    draft.screenMeta = draft.screenMeta || null;
    draft.probeInfo = null;
    commandText = '';
    activeTab = 'source';
    devices = null;
    callback = onSaved;
    renderShell();
    loadDevices();
  }

  function renderShell() {
    const body = `
      <div class="modal-head">
        <div style="flex:1;min-width:0">
          <h3>${isNew ? '新建推流任务' : '编辑推流任务'}</h3>
          <div class="sub">${isNew ? '按需配置输入源、画面参数与推流目标' : `任务 ID：<span class="mono">${h(draft.id)}</span>`}</div>
        </div>
        <label class="switch" title="应用启动后自动开始推流">
          <input type="checkbox" id="jf-autostart" ${draft.autoStart ? 'checked' : ''} />
          <span class="track"></span><span class="lbl">自动启动</span>
        </label>
      </div>
      <div class="tabs" id="jf-tabs">
        ${TABS.map((t) => `<button type="button" data-tab="${t.id}" class="${t.id === activeTab ? 'active' : ''}">${icon(t.icon, 13)} ${t.label}</button>`).join('')}
      </div>
      <div class="modal-body" id="jf-body"></div>
      <div class="modal-foot">
        ${!isNew ? `<button class="btn btn-ghost" id="jf-del" style="color:#ff8b95">${icon('trash', 14)} 删除</button>` : ''}
        <button class="btn btn-ghost" id="jf-cmd">${icon('terminal', 14)} 命令预览</button>
        <div class="spacer"></div>
        <button class="btn" data-close>取消</button>
        <button class="btn" id="jf-save">保存</button>
        <button class="btn btn-primary" id="jf-save-start">${icon('play', 14)} 保存并启动</button>
      </div>`;

    entry = openModal(body, { onClose: () => { entry = null; } });
    const root = entry.el;

    root.querySelector('#jf-autostart').addEventListener('change', (e) => { draft.autoStart = e.target.checked; });
    root.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => {
      activeTab = b.dataset.tab;
      root.querySelectorAll('[data-tab]').forEach((x) => x.classList.toggle('active', x.dataset.tab === activeTab));
      renderTab();
    }));
    root.querySelector('#jf-save').addEventListener('click', () => save(false));
    root.querySelector('#jf-save-start').addEventListener('click', () => save(true));
    root.querySelector('#jf-cmd').addEventListener('click', showCommand);
    const del = root.querySelector('#jf-del');
    if (del) del.addEventListener('click', async () => {
      const ok = await SP.util.confirmDlg({
        title: '删除推流任务',
        message: `确定删除「${h(draft.name)}」吗？正在推流会被立即停止，该操作不可撤销。`,
        confirmText: '删除', danger: true,
      });
      if (!ok) return;
      await api.deleteJob(draft.id);
      toast('任务已删除', 'ok');
      entry.close();
      callback && callback();
    });

    renderTab();
  }

  function renderTab() {
    const body = entry?.el.querySelector('#jf-body');
    if (!body) return;
    body.innerHTML = tabHtml();
    bindForm(body);
    if (activeTab === 'advanced') renderCommandBox();
  }

  function bindForm(body) {
    body.querySelectorAll('[data-k]').forEach((inp) => {
      const k = inp.dataset.k;
      const isCheck = inp.type === 'checkbox';
      const evt = isCheck || inp.tagName === 'SELECT' ? 'change' : 'input';
      inp.addEventListener(evt, () => {
        let val = isCheck ? inp.checked : inp.value;
        if (inp.dataset.type === 'num') val = val === '' ? 0 : Number(val);
        setPath(draft, k, val);
        if (inp.dataset.rerender) renderTab();
        else updateFooterHint();
      });
    });
    body.querySelectorAll('[data-set]').forEach((btn) => {
      btn.addEventListener('click', () => {
        let val = btn.dataset.value;
        if (btn.dataset.type === 'num') val = Number(val);
        const prev = getPath(draft, btn.dataset.set);
        setPath(draft, btn.dataset.set, val);
        // 切换推流协议时端口归零，避免沿用上一个协议的端口
        if (btn.dataset.set === 'target.protocol' && prev !== val && draft.target) draft.target.port = 0;
        if (btn.dataset.re) renderTab();
        else {
          body.querySelectorAll(`[data-set="${btn.dataset.set}"]`).forEach((x) => x.classList.toggle('active', x === btn));
          if (btn.dataset.set.includes('screen.') || btn.dataset.set.includes('width') || btn.dataset.set.includes('height')) renderTab();
          else updateFooterHint();
        }
      });
    });
    body.querySelectorAll('[data-local]').forEach((btn) => {
      btn.addEventListener('click', () => localAction(btn.dataset.local, btn.dataset));
    });
  }

  async function localAction(action, ds) {
    try {
      if (action === 'pick-file') {
        const r = await api.pickFiles(false, 'media');
        if (r.ok && r.files?.[0]) { draft.source.path = r.files[0]; renderTab(); }
        else if (!r.ok) toast(r.error, 'warn');
      }
      if (action === 'add-files') {
        const r = await api.pickFiles(true, 'media');
        if (r.ok && r.files?.length) {
          draft.source.paths = [...(draft.source.paths || []), ...r.files];
          renderTab();
        } else if (!r.ok) toast(r.error, 'warn');
      }
      if (action === 'rm-file') {
        draft.source.paths.splice(Number(ds.idx), 1);
        renderTab();
      }
      if (action === 'up-file') {
        const i = Number(ds.idx);
        if (i > 0) {
          const arr = draft.source.paths;
          [arr[i - 1], arr[i]] = [arr[i], arr[i - 1]];
          renderTab();
        }
      }
      if (action === 'add-extra') {
        draft.targets = Array.isArray(draft.targets) ? draft.targets : [];
        if (draft.targets.length >= 8) return toast('最多 8 个附加目标', 'warn');
        draft.targets.push({ protocol: 'rtmp', host: '', port: 0, app: 'live', streamKey: '', url: '', name: '', srtLatency: 200, udpTTL: 1 });
        renderTab();
      }
      if (action === 'rm-extra') {
        draft.targets.splice(Number(ds.idx), 1);
        renderTab();
      }
      if (action === 'pick-record') {
        const def = draft.record.filePath || `streampilot-${Date.now()}.${draft.record.recordFormat || 'mp4'}`;
        const r = await api.pickSave(def);
        if (r.ok && r.file) { draft.record.filePath = r.file; renderTab(); }
        else if (!r.ok) toast(r.error, 'warn');
      }
      if (action === 'pick-save') {
        const r = await api.pickSave(draft.target.filePath || `record-${Date.now()}.mp4`);
        if (r.ok && r.file) { draft.target.filePath = r.file; renderTab(); }
        else if (!r.ok) toast(r.error, 'warn');
      }
      if (action === 'detect-screen') {
        toast('正在读取屏幕尺寸，如首次使用请允许屏幕录制…', 'info');
        const r = await api.screenSize(draft.source.screen.display || 0);
        if (r.ok) {
          draft.screenMeta = { width: r.width, height: r.height };
          draft.source.screen.width = r.width;
          draft.source.screen.height = r.height;
          draft.source.screen.x = 0;
          draft.source.screen.y = 0;
          toast(`屏幕分辨率 ${r.width}×${r.height}`, 'ok');
          renderTab();
        } else {
          toast(r.error || '读取失败', 'error', 6000);
        }
      }
      if (action === 'screen-preset') {
        const meta = draft.screenMeta;
        if (!meta) return toast('请先点击「检测屏幕尺寸」', 'warn');
        const p = ds.preset;
        const W = meta.width, H = meta.height;
        const map = {
          full: [0, 0, W, H], left: [0, 0, Math.floor(W / 2), H], right: [Math.floor(W / 2), 0, Math.ceil(W / 2), H],
          top: [0, 0, W, Math.floor(H / 2)], bottom: [0, Math.floor(H / 2), W, Math.ceil(H / 2)],
          tl: [0, 0, Math.floor(W / 2), Math.floor(H / 2)], tr: [Math.floor(W / 2), 0, Math.ceil(W / 2), Math.floor(H / 2)],
          bl: [0, Math.floor(H / 2), Math.floor(W / 2), Math.ceil(H / 2)], br: [Math.floor(W / 2), Math.floor(H / 2), Math.ceil(W / 2), Math.ceil(H / 2)],
        };
        const [x, y, w, h] = map[p] || map.full;
        Object.assign(draft.source.screen, { x, y, width: w, height: h });
        draft.source.screen.width = w - (w % 2);
        draft.source.screen.height = h - (h % 2);
        renderTab();
      }
      if (action === 'probe') {
        const url = draft.source.url;
        if (!url) return toast('请先填写流地址', 'warn');
        toast('正在探测流信息…', 'info', 1500);
        const info = await api.probe(url, { userAgent: draft.source.userAgent, headers: draft.source.headers });
        if (!info.ok) {
          draft.probeInfo = { ok: false, error: info.error };
        } else {
          draft.probeInfo = info;
          if (info.video) {
            draft.source._detected = `${info.video.width}×${info.video.height} · ${info.video.codec.toUpperCase()} · ${info.video.fps}fps${info.audio ? ' · ' + info.audio.codec.toUpperCase() : ' · 无音轨'}`;
          }
        }
        renderTab();
      }
      if (action === 'apply-resolution') {
        const [w, hh] = ds.size.split('x').map(Number);
        draft.video.width = w;
        draft.video.height = hh;
        const preset = SP.util.bitratePresets(hh);
        draft.video.bitrateKbps = preset[Math.min(2, preset.length - 1)];
        renderTab();
      }
      if (action === 'refresh-devices') {
        devices = null;
        await loadDevices();
        renderTab();
      }
    } catch (err) {
      toast(err.message, 'error', 5000);
    }
  }

  async function loadDevices() {
    try {
      const r = await api.devices();
      if (r.ok) devices = r.devices;
    } catch (_) { devices = { screen: [], video: [], audio: [], platform: 'unknown' }; }
    if (activeTab === 'source') {
      const body = entry?.el.querySelector('#jf-body');
      if (body && body.querySelector('[data-devices-pending]')) renderTab();
    }
  }

  /* ---------- 各标签页 ---------- */
  function tabHtml() {
    if (activeTab === 'source') return sourceTab();
    if (activeTab === 'video') return videoTab();
    if (activeTab === 'audio') return audioTab();
    if (activeTab === 'target') return targetTab();
    return advancedTab();
  }

  function sourceTab() {
    const t = v('source.type');
    return `
      <div style="margin-bottom:14px">${segK('source.type', SOURCE_TYPES, { rerender: true })}</div>
      ${t === 'file' ? fileFields() : ''}
      ${t === 'files' ? filesFields() : ''}
      ${t === 'screen' ? screenFields() : ''}
      ${t === 'camera' ? cameraFields() : ''}
      ${t === 'url' ? urlFields() : ''}
      ${t === 'test' ? testFields() : ''}
    `;
  }

  function fileFields() {
    return `<div class="form-grid">
      ${field('媒体文件 <span class="req">*</span>', `
        <div class="input-group">
          <input class="input" data-k="source.path" value="${attr(v('source.path'))}" placeholder="选择本地视频文件" style="font-family:var(--mono);font-size:12px" />
          <button type="button" class="btn" data-local="pick-file">${icon('folder', 14)} 浏览</button>
        </div>`,
      '支持 MP4 / MKV / MOV / FLV / TS / WEBM / MP3 / AAC 等 FFmpeg 可解码格式', 'span-2')}
      ${field('循环播放', switchK('source.loop', '播放到结尾后从头循环'), '直播场景通常需要开启循环，避免推流中断')}
      ${field('实时节奏', switchK('advanced.realtime', '按原始帧率推送（-re）'), '关闭后会以最快速度推送，仅用于点播转点播')}
    </div>`;
  }

  function filesFields() {
    const paths = v('source.paths') || [];
    return `<div class="form-grid cols-1">
      ${field('播放列表（按顺序轮播）', `
        <div style="display:flex;flex-direction:column;gap:6px">
          ${paths.length === 0 ? `<div class="empty-state" style="padding:22px">未添加文件，点击下方按钮选择多个媒体文件</div>` : ''}
          ${paths.map((p, i) => `
            <div style="display:flex;align-items:center;gap:6px;background:rgba(255,255,255,.03);border:1px solid var(--line);border-radius:8px;padding:6px 8px">
              <span class="mono dim" style="font-size:10.5px;width:18px">${i + 1}</span>
              <span class="ellipsis mono" style="flex:1;font-size:11.5px" title="${attr(p)}">${h(p)}</span>
              <button type="button" class="icon-btn" data-local="up-file" data-idx="${i}" title="上移">${icon('up', 13)}</button>
              <button type="button" class="icon-btn" data-local="rm-file" data-idx="${i}" title="移除">${icon('x', 13)}</button>
            </div>`).join('')}
          <div><button type="button" class="btn" data-local="add-files">${icon('plus', 14)} 添加文件</button></div>
        </div>`, '多个文件会由 FFmpeg 拼接为一个连续流，适合广告轮播、片头片尾串联', 'span-2')}
      ${field('循环播放', switchK('source.loop', '整个列表循环'), '')}
    </div>`;
  }

  function screenFields() {
    const sc = v('source.screen');
    const screens = devices?.screen || [];
    const meta = draft.screenMeta;
    const presets = [
      ['full', '整屏'], ['left', '左半屏'], ['right', '右半屏'],
      ['top', '上半屏'], ['bottom', '下半屏'], ['tl', '左上 1/4'], ['br', '右下 1/4'],
    ];
    return `
      ${devices === null ? `<div data-devices-pending class="hint-box" style="margin-bottom:12px">${icon('info')}<div>正在读取可用的屏幕与摄像头设备…</div></div>` : ''}
      <div class="form-grid">
        ${field('屏幕', `<select class="select" data-k="source.screen.display">${(screens.length ? screens : [{ index: 0, name: '主屏幕' }]).map((s) => `<option value="${s.index}" ${Number(sc.display) === Number(s.index) ? 'selected' : ''}>${h(s.name)}（设备 ${s.index}）</option>`).join('')}</select>`, '多显示器时选择要采集的屏幕')}
        ${field('屏幕尺寸', `<div style="display:flex;align-items:center;gap:8px">
            <span class="mono" style="font-size:12px;color:${meta ? 'var(--ok)' : 'var(--dim)'}">${meta ? `${meta.width}×${meta.height}` : '未检测'}</span>
            <button type="button" class="btn btn-sm" data-local="detect-screen">${icon('refresh', 12)} 检测</button>
            <button type="button" class="icon-btn" data-local="refresh-devices" title="刷新设备列表">${icon('refresh', 13)}</button>
          </div>`, '首次检测会请求系统「屏幕录制」权限')}
      </div>
      <div class="hint-box" style="margin:12px 0">${icon('info')}<div>区域坐标以屏幕左上角为原点。留空宽高即采集整块屏幕；采集区域宽高建议为偶数。</div></div>
      <div class="form-grid cols-3">
        ${field('X 偏移', inputK('source.screen.x', { type: 'num', min: 0 }))}
        ${field('Y 偏移', inputK('source.screen.y', { type: 'num', min: 0 }))}
        ${field('宽度', inputK('source.screen.width', { type: 'num', min: 0 }))}
        ${field('高度', inputK('source.screen.height', { type: 'num', min: 0 }))}
        ${field('采集帧率', inputK('source.screen.fps', { type: 'num', min: 1, max: 120 }))}
        ${field('鼠标指针', switchK('source.screen.cursor', '包含光标'))}
      </div>
      <div class="field" style="margin-top:12px">
        <label>快速选区</label>
        <div class="chips">
          ${presets.map(([p, l]) => `<span class="chip ${meta ? '' : 'dim'}" data-local="screen-preset" data-preset="${p}">${l}</span>`).join('')}
        </div>
      </div>
      <div class="hint-box warn" style="margin-top:12px">${icon('alert')}<div>macOS 需要在「系统设置 → 隐私与安全性 → 屏幕录制」中勾选 StreamPilot（或启动它的终端），修改后需重启应用生效。Windows 使用 gdigrab，Linux 使用 x11grab，无需额外授权。</div></div>
    `;
  }

  function cameraFields() {
    const c = v('source.camera');
    const vids = devices?.video?.filter((d) => !/capture screen/i.test(d.name)) || [];
    const auds = devices?.audio || [];
    return `
      ${devices === null ? `<div data-devices-pending class="hint-box" style="margin-bottom:12px">${icon('info')}<div>正在读取摄像头与麦克风…</div></div>` : ''}
      <div class="form-grid">
        ${field('摄像头', `<select class="select" data-k="source.camera.videoDevice">
          <option value="">请选择设备</option>
          ${vids.map((d) => `<option value="${attr(d.id)}" ${String(c.videoDevice) === String(d.id) ? 'selected' : ''}>${h(d.name)}</option>`).join('')}
        </select>`, vids.length ? '' : '未检测到摄像头，请检查系统权限或连接设备')}
        ${field('麦克风', `<select class="select" data-k="source.camera.audioDevice">
          <option value="">不采集声音</option>
          ${auds.map((d) => `<option value="${attr(d.id)}" ${String(c.audioDevice) === String(d.id) ? 'selected' : ''}>${h(d.name)}</option>`).join('')}
        </select>`, '选择麦克风后会把声音混入推流')}
        ${field('采集分辨率', `<div class="chips">
          ${[[1280, 720, '720P'], [1920, 1080, '1080P'], [2560, 1440, '2K'], [3840, 2160, '4K']].map(([w, hh, l]) => `
            <span class="chip ${Number(c.width) === w && Number(c.height) === hh ? 'active' : ''}"
              data-set="source.camera.width" data-type="num" data-value="${w}" data-re="1">${l}</span>`).join('')}
        </div>`, '实际输出尺寸由「画面」页的分辨率决定，这里只影响采集')}
        ${field('采集帧率', inputK('source.camera.fps', { type: 'num', min: 1, max: 120 }))}
      </div>`;
  }

  function urlFields() {
    const info = draft.probeInfo;
    return `<div class="form-grid">
      ${field('流地址 <span class="req">*</span>', `<div class="input-group">
          <input class="input" data-k="source.url" value="${attr(v('source.url'))}" placeholder="rtsp:// / rtmp:// / http(s)://...m3u8 / udp:// / srt://" style="font-family:var(--mono);font-size:12px" />
          <button type="button" class="btn" data-local="probe">${icon('activity', 14)} 探测</button>
        </div>`, '支持 RTSP、RTMP(S)、HTTP-FLV、HLS、MPEG-TS、SRT、UDP 组播等任意 FFmpeg 可读协议', 'span-2')}
      ${info ? `<div class="field span-2"><div class="hint-box ${info.ok ? '' : 'warn'}">${icon(info.ok ? 'check' : 'alert')}<div>${
        info.ok
          ? `探测成功：${info.video ? `${info.video.codec.toUpperCase()} ${info.video.width}×${info.video.height} @ ${info.video.fps}fps` : '无视频轨'}${info.audio ? ` · 音频 ${info.audio.codec.toUpperCase()} ${info.audio.sampleRate}Hz/${info.audio.channels}ch` : ' · 无音频轨'}${info.bitrate ? ` · 源码率 ${SP.util.fmtKbps(info.bitrate / 1000)}` : ''}`
          : `探测失败：${h(info.error || '未知错误')}`
      }</div></div></div>` : ''}
      ${field('User-Agent', inputK('source.userAgent', { ph: '留空使用全局设置' }), '部分源站会校验 UA，可填 VLC/浏览器的 UA')}
      ${field('自定义请求头', `<textarea class="input" data-k="source.headers" placeholder="Referer: https://example.com&#10;Cookie: xxx">${h(v('source.headers'))}</textarea>`, '每行一个 Header，用于防盗链源')}
      ${field('断流自动重连', switchK('advanced.inputReconnect', '输入源断开后自动重连'), '针对 HTTP/HLS/RTMP 源生效')}
    </div>`;
  }

  function testFields() {
    return `<div class="form-grid">
      ${field('测试图样', selectK('source.testPattern', [
        { v: 'testsrc2', l: '彩条测试图（带计数器）' },
        { v: 'smptebars', l: 'SMPTE 标准彩条' },
        { v: 'testsrc', l: '经典测试图' },
        { v: 'color=c=0x101820', l: '纯色（深蓝黑）' },
        { v: 'mandelbrot', l: 'Mandelbrot 动态图' },
      ]), '用于在没有素材时验证推流链路与服务器配置')}
      ${field('音频', `<div class="help" style="margin-top:8px">测试源默认混入 440Hz 正弦音，可在「音频」页关闭</div>`)}
    </div>`;
  }

  function videoTab() {
    const capList = (SP.state.system?.ffmpeg?.encoders || []);
    const encoders = ['libx264', 'h264_videotoolbox', 'libx265', 'hevc_videotoolbox']
      .filter((e) => capList.includes(e))
      .map((e) => ({ v: e, l: SP.describeEncoder(e) }));
    if (!encoders.length) encoders.push({ v: 'libx264', l: 'H.264 · x264 软件编码' });
    const size = [Number(v('video.width')) || 1920, Number(v('video.height')) || 1080];
    const presets = SP.util.bitratePresets(size[1]);
    const isCopy = v('video.mode') === 'copy';
    const totalKbps = (Number(v('video.bitrateKbps')) || 0) + (v('audio.mode') === 'none' ? 0 : Number(v('audio.bitrateKbps')) || 0);

    return `
      <div style="margin-bottom:14px">${segK('video.mode', [{ v: 'transcode', l: '转码输出（可调分辨率/码率）' }, { v: 'copy', l: '视频直通（不重编码）' }], { rerender: true })}</div>
      ${isCopy ? `<div class="hint-box warn" style="margin-bottom:14px">${icon('alert')}<div>直通模式不重新编码，画质无损且几乎不占 CPU，但无法调整分辨率与码率，输出参数取决于源；RTMP 场景源必须是 H.264。</div></div>` : ''}
      <div class="form-grid">
        ${field('输出分辨率', `<div class="chips" style="margin-bottom:8px">
          ${[[1280, 720, '720P'], [1920, 1080, '1080P'], [2560, 1440, '2K'], [3840, 2160, '4K'], [1080, 1920, '竖屏 1080×1920'], [720, 1280, '竖屏 720×1280']].map(([w, hh, l]) => `
            <span class="chip ${size[0] === w && size[1] === hh ? 'active' : ''}" data-local="apply-resolution" data-size="${w}x${hh}">${l}</span>`).join('')}
        </div>
        <div class="input-group">
          <input class="input" data-k="video.width" data-type="num" type="number" value="${size[0]}" />
          <span class="unit" style="height:34px;display:flex;align-items:center;padding:0 8px;border:1px solid var(--line-strong);border-left:0;border-right:0;color:var(--dim)">×</span>
          <input class="input" data-k="video.height" data-type="num" type="number" value="${size[1]}" style="border-radius:0 9px 9px 0" />
        </div>`, '常规直播建议 1920×1080（1080P）', 'span-2')}
        ${field('缩放方式', selectK('video.scaling', [
          { v: 'fit', l: '等比缩放 + 黑边（推荐）' },
          { v: 'cover', l: '等比填满 + 裁剪' },
          { v: 'stretch', l: '拉伸变形' },
        ]), '源画面比例与输出不一致时的处理方式')}
        ${field('帧率', `<div class="chips">${[24, 25, 30, 50, 60].map((f) => `<span class="chip ${Number(v('video.fps')) === f ? 'active' : ''}" data-set="video.fps" data-type="num" data-value="${f}">${f}fps</span>`).join('')}</div>`, '直播推荐 30fps；体育/游戏可用 60fps')}
        ${field('编码器', `<select class="select" data-k="video.encoder" data-rerender="1" ${isCopy ? 'disabled' : ''}>${encoders.map((e) => `<option value="${e.v}" ${v('video.encoder') === e.v ? 'selected' : ''}>${h(e.l)}</option>`).join('')}</select>`, 'VideoToolbox 为硬件编码，CPU 占用低、画质略逊于 x264')}
        ${field('编码预设', `<select class="select" data-k="video.preset" ${isCopy ? 'disabled' : ''}>${['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow'].map((p) => `<option value="${p}" ${v('video.preset') === p ? 'selected' : ''}>${p}${p === 'veryfast' ? '（推荐）' : ''}</option>`).join('')}</select>`, '越快越省 CPU，越慢压缩效率越高')}
      </div>

      <div class="section-title" style="margin:18px 0 10px"><h2>码率控制</h2><div class="line"></div></div>
      <div class="form-grid">
        ${field('控制方式', segK('video.rateControl', [
          { v: 'cbr', l: 'CBR 固定码率' }, { v: 'vbr', l: 'VBR 动态码率' }, { v: 'crf', l: 'CRF 恒定质量' },
        ], { rerender: true }), '推流平台通常要求 CBR，网络波动更可控', 'span-2')}
        ${field('视频码率', `<div class="input-group"><input class="input" data-k="video.bitrateKbps" data-type="num" type="number" value="${v('video.bitrateKbps')}" ${isCopy ? 'disabled' : ''} /><span class="unit">kbps</span></div>
          <div class="chips" style="margin-top:7px">${presets.map((p) => `<span class="chip ${Number(v('video.bitrateKbps')) === p ? 'active' : ''}" data-set="video.bitrateKbps" data-type="num" data-value="${p}">${p >= 1000 ? (p / 1000) + ' Mbps' : p + ' kbps'}</span>`).join('')}</div>`,
        `1080P 推荐 4500–8000 kbps，估算上行占用 <b style="color:var(--accent-2)">${(totalKbps / 1000).toFixed(2)} Mbps</b>`, 'span-2')}
        ${v('video.rateControl') === 'vbr' ? field('最大码率', `<div class="input-suffix"><input class="input" data-k="video.maxBitrateKbps" data-type="num" type="number" value="${v('video.maxBitrateKbps')}" /><span class="unit">kbps</span></div>`, '0 表示自动按 1.15 倍计算') : ''}
        ${v('video.rateControl') === 'crf' ? field('CRF 质量', inputK('video.crf', { type: 'num', min: 0, max: 51 }), '18–23 常用，数值越小画质越好、码率越高') : ''}
        ${field('关键帧间隔（GOP）', `<div class="input-suffix"><input class="input" data-k="video.gopSeconds" data-type="num" type="number" step="0.5" value="${v('video.gopSeconds')}" /><span class="unit">秒</span></div>`, `实际 GOP = ${Math.round((Number(v('video.fps')) || 30) * (Number(v('video.gopSeconds')) || 2))} 帧，建议 2 秒`)}
        ${field('编码档次', `<select class="select" data-k="video.profile">${['baseline', 'main', 'high'].map((p) => `<option value="${p}" ${v('video.profile') === p ? 'selected' : ''}>${p}</option>`).join('')}</select>`, '兼容性要求高选 main，常规选 high')}
      </div>`;
  }

  function audioTab() {
    const mode = v('audio.mode');
    return `<div style="margin-bottom:14px">${segK('audio.mode', [
      { v: 'transcode', l: '转码输出' }, { v: 'copy', l: '音频直通' }, { v: 'none', l: '静音（无音频）' },
    ], { rerender: true })}</div>
    <div class="form-grid">
      ${mode === 'transcode' ? `
        ${field('音频编码', selectK('audio.codec', [{ v: 'aac', l: 'AAC（推荐，兼容性最好）' }, { v: 'opus', l: 'Opus' }, { v: 'mp3', l: 'MP3' }, { v: 'ac3', l: 'AC-3' }]))}
        ${field('采样率', selectK('audio.sampleRate', [44100, 48000, 32000, 22050].map((s) => ({ v: s, l: `${s} Hz` }))))}
        ${field('码率', `<div class="input-suffix"><input class="input" data-k="audio.bitrateKbps" data-type="num" type="number" value="${v('audio.bitrateKbps')}" /><span class="unit">kbps</span></div>
          <div class="chips" style="margin-top:7px">${[64, 96, 128, 160, 192, 256].map((b) => `<span class="chip ${Number(v('audio.bitrateKbps')) === b ? 'active' : ''}" data-set="audio.bitrateKbps" data-type="num" data-value="${b}">${b}</span>`).join('')}</div>`, '128 kbps 适合语音+背景音乐')}
        ${field('声道', selectK('audio.channels', [{ v: 1, l: '单声道' }, { v: 2, l: '立体声（推荐）' }]))}
      ` : ''}
      ${mode === 'copy' ? `<div class="field span-2"><div class="hint-box">${icon('info')}<div>音频直通不重新编码，适合源本身是 AAC 且不需要调整音量的场景；若目标容器不支持源音频编码会自动失败。</div></div></div>` : ''}
      ${mode === 'none' ? `<div class="field span-2"><div class="hint-box warn">${icon('alert')}<div>输出将不含音轨。部分平台（如 Twitch）要求必须有音频轨，请确认目标平台支持。</div></div></div>` : ''}
    </div>`;
  }

  function targetPreview() {
    const t = draft.target;
    if (t.url) return t.url;
    const port = t.port;
    const key = t.streamKey || '推流码';
    const app = t.app || 'live';
    if (t.protocol === 'rtmp') return `rtmp://${t.host || '服务器'}:${port || 1935}/${app}/${key}`;
    if (t.protocol === 'rtmps') return `rtmps://${t.host || '服务器'}:${port || 443}/${app}/${key}`;
    if (t.protocol === 'rtsp') return `rtsp://${t.host || '服务器'}:${port || 8554}/${app}/${key}`;
    if (t.protocol === 'srt') return `srt://${t.host || '服务器'}:${port || 9000}?mode=caller&latency=${t.srtLatency * 1000}`;
    if (t.protocol === 'udp') return `udp://${t.host || '239.0.0.1'}:${port || 1234}?ttl=${t.udpTTL}`;
    if (t.protocol === 'flv') return `http://0.0.0.0:${t.flvListenPort}/live.flv（监听，供播放器拉流）`;
    if (t.protocol === 'hls') return `本地 HLS 目录：数据目录/hls/<任务ID>/index.m3u8`;
    if (t.protocol === 'file') return t.filePath || '请选择保存路径';
    return '';
  }

  function targetTab() {
    const t = draft.target;
    const notes = {
      rtmp: '标准直播推流协议，B 站 / 抖音 / YouTube / OBS 生态全部支持。端口一般 1935。',
      rtmps: 'RTMP over TLS，端口常用 443，适合公网传输。',
      rtsp: '需要目标服务端支持 ANNOUNCE/RECORD（如 MediaMTX、Live555、海康/大华 NVR）。默认 TCP 传输。',
      srt: '低延迟抗弱网传输，caller 模式主动连接服务端。延迟建议 120–300ms，公网可适当加大。',
      udp: 'MPEG-TS over UDP，常用于局域网组播分发。组播地址范围 239.0.0.0–239.255.255.255。',
      hls: '在本机生成 HLS 切片，可被同局域网设备直接播放，也适合二次分发。',
      flv: '本机开启 HTTP-FLV 监听端口，播放器（含本应用）主动连接拉流，延迟通常低于 HLS。',
      file: '把转码后的流写入本地文件，适合录制存档或离线转码。',
    };
    return `
      <div style="margin-bottom:14px">${segK('target.protocol', PROTOCOLS, { rerender: true })}</div>
      <div class="hint-box" style="margin-bottom:14px">${icon('info')}<div>${h(notes[t.protocol] || '')}</div></div>
      ${['rtmp', 'rtmps', 'rtsp', 'srt', 'udp'].includes(t.protocol) ? `
        <div class="form-grid cols-3">
          ${field('服务器地址 <span class="req">*</span>', inputK('target.host', { ph: 'live.example.com 或 IP' }), '', 'span-2')}
          ${field('端口', inputK('target.port', { type: 'num', emptyZero: true, ph: String(t.protocol === 'rtmp' ? 1935 : t.protocol === 'rtsp' ? 8554 : t.protocol === 'srt' ? 9000 : 1234) }), '留空则使用协议默认端口')}
          ${['rtmp', 'rtmps', 'rtsp'].includes(t.protocol) ? `
            ${field('应用名 / App', inputK('target.app', { ph: 'live' }), '有些平台称为「流路径」')}
            ${field('推流码 / 流名称 <span class="req">*</span>', inputK('target.streamKey', { ph: 'stream-key', mono: true }), '平台后台提供的串流密钥', 'span-2')}
          ` : ''}
          ${t.protocol === 'srt' ? `
            ${field('延迟（毫秒）', inputK('target.srtLatency', { type: 'num', min: 20, max: 8000 }), '越大抗抖动越强，延迟也越高')}
            ${field('加密口令', inputK('target.srtPassphrase', { ph: '可选，AES-128' }), '设置后服务端需使用相同口令')}
          ` : ''}
          ${t.protocol === 'udp' ? field('TTL', inputK('target.udpTTL', { type: 'num', min: 0, max: 255 }), '组播跨网段时通常设为 16–64') : ''}
        </div>` : ''}
      ${t.protocol === 'hls' ? `
        <div class="form-grid">
          ${field('分片时长', `<div class="input-suffix"><input class="input" data-k="target.hlsSegmentSeconds" data-type="num" type="number" value="${t.hlsSegmentSeconds}" /><span class="unit">秒</span></div>`, '1–2 秒延迟更低，4–6 秒更稳定')}
          ${field('列表长度', inputK('target.hlsListSize', { type: 'num', min: 2, max: 60 }), '播放列表保留的分片数量')}
        </div>
        <div class="hint-box" style="margin-top:12px">${icon('info')}<div>保存后可在任务卡片上复制播放地址，同局域网设备访问 <code>http://本机IP:端口/hls/任务ID/index.m3u8</code> 即可观看。</div></div>` : ''}
      ${t.protocol === 'flv' ? `
        <div class="form-grid">
          ${field('监听端口', inputK('target.flvListenPort', { type: 'num', min: 1024, max: 65535 }), '保存启动后，播放器连接 http://本机IP:端口/live.flv')}
        </div>` : ''}
      ${t.protocol === 'file' ? `
        <div class="form-grid">
          ${field('保存路径 <span class="req">*</span>', `<div class="input-group">
            <input class="input" data-k="target.filePath" value="${attr(t.filePath)}" placeholder="/Users/you/Movies/record.mp4" style="font-family:var(--mono);font-size:12px" />
            <button type="button" class="btn" data-local="pick-save">${icon('folder', 14)} 选择</button>
          </div>`, '根据扩展名自动选择封装格式：mp4 / mkv / ts', 'span-2')}
        </div>` : ''}
      ${['rtmp', 'rtmps', 'rtsp', 'srt', 'udp'].includes(t.protocol) ? `
        <div class="field" style="margin-top:14px">
          <label>完整地址覆盖（可选）</label>
          <input class="input" data-k="target.url" value="${attr(t.url)}" placeholder="如需使用带参数的完整 URL，填这里将忽略上面的字段" style="font-family:var(--mono);font-size:12px" />
        </div>` : ''}
      <div class="field" style="margin-top:16px">
        <label>最终推流地址</label>
        <div class="cmd-box" style="max-height:none">${h(targetPreview())}</div>
      </div>
      ${extraTargetsBlock()}
      ${recordBlock()}`;
  }

  /** 多平台分发：一份编码同时推多路 */
  function extraTargetsBlock() {
    const list = Array.isArray(draft.targets) ? draft.targets : [];
    const rows = list.map((x, i) => {
      const proto = x.protocol || 'rtmp';
      const needPath = ['rtmp', 'rtmps', 'rtsp'].includes(proto);
      return `
      <div class="fan-row">
        <div class="fan-top">
          <span class="fan-idx">${i + 1}</span>
          <input class="input fan-name" data-k="targets.${i}.name" value="${attr(x.name)}" placeholder="备注，例如「抖音」" />
          <button type="button" class="btn btn-sm btn-ghost" data-local="rm-extra" data-idx="${i}" title="移除">${icon('trash', 13)}</button>
        </div>
        <div class="form-grid cols-3">
          <div class="field">
            <label>协议</label>
            <select class="input" data-k="targets.${i}.protocol" data-rerender="1">
              ${PROTOCOLS.filter((p) => !['hls', 'file', 'flv'].includes(p.v)).map((p) => `<option value="${p.v}" ${p.v === proto ? 'selected' : ''}>${h(p.l)}</option>`).join('')}
            </select>
          </div>
          <div class="field span-2">
            <label>服务器地址</label>
            <input class="input" data-k="targets.${i}.host" value="${attr(x.host)}" placeholder="${proto === 'udp' ? '239.0.0.1' : 'live.example.com'}" />
          </div>
          <div class="field">
            <label>端口</label>
            <input class="input" data-k="targets.${i}.port" data-type="num" type="number" value="${x.port || ''}" placeholder="${proto === 'rtmp' ? '1935' : proto === 'rtsp' ? '8554' : proto === 'srt' ? '9000' : '1234'}" />
          </div>
          ${needPath ? `
          <div class="field">
            <label>应用名</label>
            <input class="input" data-k="targets.${i}.app" value="${attr(x.app)}" placeholder="live" />
          </div>
          <div class="field">
            <label>推流码</label>
            <input class="input" data-k="targets.${i}.streamKey" value="${attr(x.streamKey)}" placeholder="stream-key" style="font-family:var(--mono);font-size:12px" />
          </div>` : `
          <div class="field span-2">
            <label>流名称</label>
            <input class="input" data-k="targets.${i}.streamKey" value="${attr(x.streamKey)}" placeholder="stream" />
          </div>`}
          <div class="field span-3">
            <label>完整地址（可选）</label>
            <input class="input" data-k="targets.${i}.url" value="${attr(x.url)}" placeholder="填了这里就忽略上面的字段" style="font-family:var(--mono);font-size:12px" />
          </div>
        </div>
      </div>`;
    }).join('');

    return `
      <div class="section-title" style="margin:22px 0 10px">
        <h2>多平台分发</h2><div class="line"></div>
        <button class="btn btn-sm" data-local="add-extra">${icon('plus', 12)} 添加目标</button>
      </div>
      <div class="hint-box" style="margin-bottom:10px">${icon('info')}<div>同一份编码同时推到多个平台，不额外占用 CPU；某一路挂了会自动跳过，不影响其他路。</div></div>
      <div class="fan-list">${rows || '<div class="empty-inline">还没有附加目标</div>'}</div>`;
  }

  /** 推流同时录制一份到本地 */
  function recordBlock() {
    const rec = draft.record || {};
    const on = Boolean(rec.enabled);
    return `
      <div class="section-title" style="margin:22px 0 10px"><h2>同步录制</h2><div class="line"></div></div>
      <div class="form-grid">
        <div class="field span-3">
          <label class="switch">
            <input type="checkbox" data-k="record.enabled" data-rerender="1" ${on ? 'checked' : ''} />
            <span class="track"></span><span class="lbl">推流的同时录一份到本地磁盘</span>
          </label>
          <div class="help">与推流共用同一份编码，不重复占用 CPU；断流重连后会自动续写同一个文件</div>
        </div>
        ${on ? `
        <div class="field span-2">
          <label>保存路径</label>
          <div class="input-group">
            <input class="input" data-k="record.filePath" value="${attr(rec.filePath)}" placeholder="留空自动存到 ~/.streampilot/records" style="font-family:var(--mono);font-size:12px" />
            <button type="button" class="btn" data-local="pick-record">${icon('folder', 14)} 选择</button>
          </div>
          <div class="help">扩展名决定封装格式：mp4 / mkv / ts</div>
        </div>
        <div class="field">
          <label>封装格式</label>
          <select class="input" data-k="record.recordFormat">
            ${[{ v: 'mp4', l: 'MP4（通用，便于剪辑）' }, { v: 'mkv', l: 'MKV（中断可恢复）' }, { v: 'ts', l: 'TS（最抗异常）' }]
    .map((o) => `<option value="${o.v}" ${o.v === (rec.recordFormat || 'mp4') ? 'selected' : ''}>${h(o.l)}</option>`).join('')}
          </select>
        </div>` : ''}
      </div>`;
  }

  function advancedTab() {
    return `
      <div class="form-grid">
        ${field('断流自动重连', switchK('advanced.reconnect', '推流中断后自动重试'), '目标服务器重启、网络抖动时自动恢复')}
        ${field('重连间隔', `<div class="input-suffix"><input class="input" data-k="advanced.reconnectDelaySec" data-type="num" type="number" value="${v('advanced.reconnectDelaySec')}" /><span class="unit">秒</span></div>`, '失败次数增加时按倍数递增，最长 30 秒')}
        ${field('最大重连次数', inputK('advanced.maxReconnect', { type: 'num', min: 0 }), '0 表示无限重连')}
        ${field('输入队列', inputK('advanced.threadQueue', { type: 'num', min: 32, max: 8192 }), '采集卡顿时可适当加大，默认 512')}
        ${field('日志级别', selectK('advanced.logLevel', [
          { v: 'error', l: 'error（仅错误）' }, { v: 'warning', l: 'warning' }, { v: 'info', l: 'info（推荐）' }, { v: 'verbose', l: 'verbose' }, { v: 'debug', l: 'debug' },
        ]))}
        ${field('保留时间戳', switchK('advanced.copyTimestamps', '使用 -copyts'), '需要与外接设备时间对齐时开启')}
        ${field('附加输入参数', inputK('advanced.extraInputArgs', { ph: '-probesize 5000000', mono: true }), '会追加到输入参数中，高级用法', 'span-2')}
        ${field('附加输出参数', inputK('advanced.extraOutputArgs', { ph: '-max_interleave_delta 0', mono: true }), '会追加到输出参数中，高级用法', 'span-2')}
      </div>
      <div class="section-title" style="margin:18px 0 10px"><h2>即将执行的命令</h2><div class="line"></div>
        <button class="btn btn-sm" id="jf-refresh-cmd">${icon('refresh', 12)} 刷新</button>
      </div>
      <div class="cmd-box" id="jf-cmd-box">点击右上角「刷新」或底部「命令预览」生成</div>`;
  }

  function renderCommandBox() {
    const box = entry?.el.querySelector('#jf-cmd-box');
    if (!box) return;
    box.textContent = commandText || '点击「刷新」生成命令';
    const btn = entry.el.querySelector('#jf-refresh-cmd');
    if (btn) btn.onclick = async () => {
      box.textContent = '正在生成…';
      try {
        const r = await api.post('/api/jobs/preview', cleanDraft());
        commandText = r.command;
        box.textContent = r.command;
        (r.warnings || []).forEach((w) => toast(w, 'warn', 5000));
      } catch (err) {
        box.textContent = `生成失败：${err.message}`;
      }
    };
  }

  async function showCommand() {
    activeTab = 'advanced';
    entry?.el.querySelectorAll('[data-tab]').forEach((x) => x.classList.toggle('active', x.dataset.tab === 'advanced'));
    renderTab();
    const r = await api.post('/api/jobs/preview', cleanDraft()).catch((e) => ({ error: e.message }));
    if (r.error) return toast(r.error, 'error');
    commandText = r.command;
    renderCommandBox();
    (r.warnings || []).forEach((w) => toast(w, 'warn', 5000));
  }

  function updateFooterHint() {
    // 实时刷新码率估算等轻量内容时使用，当前保留占位
  }

  function cleanDraft() {
    const copy = JSON.parse(JSON.stringify(draft));
    delete copy.screenMeta;
    delete copy.probeInfo;
    delete copy.service;
    return copy;
  }

  function validate() {
    if (!String(draft.name || '').trim()) return '请填写任务名称';
    const t = draft.source.type;
    if (t === 'file' && !draft.source.path) return '请选择媒体文件';
    if (t === 'files' && !(draft.source.paths || []).length) return '请至少添加一个媒体文件';
    if (t === 'url' && !draft.source.url) return '请填写网络流地址';
    if (t === 'screen' && devices && devices.screen?.length && draft.source.screen.display === undefined) return '请选择屏幕';
    const tg = draft.target;
    if (['rtmp', 'rtmps', 'rtsp', 'srt', 'udp'].includes(tg.protocol)) {
      if (!tg.url && !tg.host) return '请填写推流服务器地址';
      if (!tg.url && !tg.streamKey && !tg.app) return '请填写推流码 / 流名称';
    }
    if (tg.protocol === 'file' && !tg.filePath) return '请选择录制文件保存路径';
    if (draft.video.mode === 'transcode') {
      if (!(draft.video.width > 0) || !(draft.video.height > 0)) return '输出分辨率不正确';
      if (draft.video.width % 2 || draft.video.height % 2) return '分辨率宽高需为偶数（H.264 要求）';
    }
    return '';
  }

  async function save(start) {
    const err = validate();
    if (err) return toast(err, 'error', 4000);
    const payload = cleanDraft();
    if (start) payload.autoStart = true;
    try {
      let res;
      if (draft.id) {
        res = await api.updateJob(draft.id, payload);
        if (start) await api.startJob(draft.id);
      } else {
        res = await api.createJob(payload);
        if (start) await api.startJob(res.job.id);
      }
      toast(start ? '任务已保存并启动' : '任务已保存', 'ok');
      entry && entry.close();
      callback && callback(res.job);
    } catch (e) {
      toast(e.message, 'error', 6000);
    }
  }

  return { open, get isOpen() { return Boolean(entry); } };
})();

SP.describeEncoder = (name) => ({
  libx264: 'H.264 · x264 软件编码（画质优先）',
  h264_videotoolbox: 'H.264 · VideoToolbox 硬件编码（低占用）',
  libx265: 'H.265 · x265 软件编码（省带宽）',
  hevc_videotoolbox: 'H.265 · VideoToolbox 硬件编码',
}[name] || name);
