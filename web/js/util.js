'use strict';

/* ============================================================
   通用工具：图标、格式化、弹窗、提示、迷你图表
   ============================================================ */
window.SP = window.SP || {};

SP.util = (() => {
  const ICONS = {
    grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
    cast: '<path d="M2 8V6a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-6"/><path d="M2 12a9 9 0 0 1 9 9"/><path d="M2 16a5 5 0 0 1 5 5"/><circle cx="2.5" cy="20.5" r="1"/>',
    tv: '<rect x="2" y="7" width="20" height="13" rx="2"/><path d="M8 3l4 4 4-4"/>',
    play: '<circle cx="12" cy="12" r="9"/><path d="M10 8.5l6 3.5-6 3.5z"/>',
    terminal: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="M6 9l3 3-3 3"/><path d="M12 15h6"/>',
    sliders: '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
    help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.6 2.6 0 1 1 3.4 2.5c-.6.2-.9.8-.9 1.5v.5"/><circle cx="12" cy="17" r=".6" fill="currentColor"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
    power: '<path d="M12 3v9"/><path d="M6.4 6.4a8 8 0 1 0 11.2 0"/>',
    refresh: '<path d="M3 12a9 9 0 0 1 15.5-6.2L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15.5 6.2L3 16"/><path d="M3 21v-5h5"/>',
    edit: '<path d="M4 20h4l10-10-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>',
    trash: '<path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"/>',
    copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M15 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3"/>',
    external: '<path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"/>',
    folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
    left: '<path d="M15 6l-6 6 6 6"/>',
    right: '<path d="M9 6l6 6-6 6"/>',
    down: '<path d="M6 9l6 6 6-6"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    x: '<path d="M6 6l12 12M18 6L6 18"/>',
    alert: '<path d="M12 3.5l9.5 16.5H2.5z"/><path d="M12 9v5"/><circle cx="12" cy="17" r=".7" fill="currentColor"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6"/><circle cx="12" cy="7.6" r=".7" fill="currentColor"/>',
    link: '<path d="M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1"/>',
    download: '<path d="M12 4v11"/><path d="M7 11l5 5 5-5"/><path d="M4 20h16"/>',
    upload: '<path d="M12 16V5"/><path d="M7 9l5-5 5 5"/><path d="M4 20h16"/>',
    save: '<path d="M5 3h11l3 3v15H5z"/><path d="M8 3v6h7V3"/><path d="M8 14h8v7H8z"/>',
    monitor: '<rect x="2" y="4" width="20" height="13" rx="2"/><path d="M8 21h8M12 17v4"/>',
    camera: '<path d="M4 8h3l1.5-2h7L17 8h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/><circle cx="12" cy="13" r="3.5"/>',
    file: '<path d="M6 3h8l5 5v13H6z"/><path d="M14 3v5h5"/>',
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3c2.5 2.4 3.8 5.4 3.8 9S14.5 18.6 12 21c-2.5-2.4-3.8-5.4-3.8-9S9.5 5.4 12 3z"/>',
    activity: '<path d="M3 12h3l2.5-6 4 12 3-6h5.5"/>',
    star: '<path d="M12 3.5l2.6 5.4 5.9.8-4.3 4.2 1 5.9-5.2-2.8-5.2 2.8 1-5.9L3.5 9.7l5.9-.8z"/>',
    volume: '<path d="M4 10v4h3l4 3V7L7 10z"/><path d="M15 9.5a3.5 3.5 0 0 1 0 5"/><path d="M17.5 7a7 7 0 0 1 0 10"/>',
    mute: '<path d="M4 10v4h3l4 3V7L7 10z"/><path d="M15 10l4 4M19 10l-4 4"/>',
    max: '<path d="M4 9V4h5M20 15v5h-5M20 9V4h-5M4 15v5h5"/>',
    list: '<path d="M8 6h13M8 12h13M8 18h13"/><circle cx="4" cy="6" r="1" fill="currentColor"/><circle cx="4" cy="12" r="1" fill="currentColor"/><circle cx="4" cy="18" r="1" fill="currentColor"/>',
    arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
    music: '<circle cx="7" cy="18" r="2.5"/><circle cx="18" cy="16" r="2.5"/><path d="M9.5 18V7l11-2v11"/>',
    cpu: '<rect x="7" y="7" width="10" height="10" rx="2"/><path d="M10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4"/>',
    database: '<ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6"/><path d="M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/>',
    film: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M8 4v16M16 4v16M3 9h5M3 15h5M16 9h5M16 15h5"/>',
    wifi: '<path d="M3 9a14 14 0 0 1 18 0"/><path d="M6.5 12.5a9 9 0 0 1 11 0"/><path d="M10 16a4 4 0 0 1 4 0"/><circle cx="12" cy="19" r=".9" fill="currentColor"/>',
    radio: '<circle cx="12" cy="12" r="2.5"/><path d="M7.8 7.8a6 6 0 0 0 0 8.4M16.2 7.8a6 6 0 0 1 0 8.4"/><path d="M4.9 4.9a10 10 0 0 0 0 14.2M19.1 4.9a10 10 0 0 1 0 14.2"/>',
    shield: '<path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z"/><path d="M9 12l2 2 4-4"/>',
    route: '<circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="6" r="2.5"/><path d="M8.5 18H14a4 4 0 0 0 0-8H9.5a3 3 0 0 1 0-6H15"/>',
    pin: '<path d="M12 21s7-6.2 7-11a7 7 0 1 0-14 0c0 4.8 7 11 7 11z"/><circle cx="12" cy="10" r="2.5"/>',
    key: '<circle cx="8" cy="12" r="3.5"/><path d="M11.5 12H21M17 12v3M20 12v2"/>',
  };

  function icon(name, size = 16, cls = '') {
    const p = ICONS[name] || ICONS.info;
    return `<svg class="${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
  }

  function h(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function attr(v) { return h(v).replace(/\n/g, '&#10;'); }

  function fmtKbps(n) {
    const v = Number(n) || 0;
    if (v >= 1000) return `${(v / 1000).toFixed(v >= 10000 ? 1 : 2)} Mbps`;
    return `${Math.round(v)} kbps`;
  }

  function fmtBytes(n) {
    const v = Number(n) || 0;
    if (v <= 0) return '0 B';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.min(u.length - 1, Math.floor(Math.log(v) / Math.log(1024)));
    return `${(v / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
  }

  function fmtDuration(sec) {
    const s = Math.max(0, Math.floor(Number(sec) || 0));
    const hh = Math.floor(s / 3600);
    const mm = Math.floor((s % 3600) / 60);
    const ss = s % 60;
    const p = (n) => String(n).padStart(2, '0');
    return hh > 0 ? `${hh}:${p(mm)}:${p(ss)}` : `${p(mm)}:${p(ss)}`;
  }

  function fmtTime(ts) {
    if (!ts) return '—';
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getMonth() + 1}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  function relTime(ts) {
    if (!ts) return '从未';
    const diff = Date.now() - ts;
    if (diff < 60000) return '刚刚';
    if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`;
    return `${Math.floor(diff / 86400000)} 天前`;
  }

  function fmtSizePair(w, h) {
    if (!w || !h) return '原始尺寸';
    const name = w >= 3800 ? '4K' : w >= 2500 ? '2K' : w >= 1900 ? '1080P' : w >= 1260 ? '720P' : `${w}×${h}`;
    return `${name} · ${w}×${h}`;
  }

  const STATUS_TEXT = {
    running: '推流中', starting: '启动中', stopping: '停止中', stopped: '已停止',
    idle: '未启动', error: '异常', reconnecting: '重连中',
  };

  function statusPill(status) {
    return `<span class="pill ${h(status)}"><i class="dot"></i>${STATUS_TEXT[status] || h(status)}</span>`;
  }

  /* ---------------- Toast ---------------- */
  function toast(message, type = 'info', ms = 3200) {
    const root = document.getElementById('toast-root');
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.innerHTML = `<div class="bar"></div><div class="txt">${h(message)}</div>`;
    root.appendChild(el);
    setTimeout(() => {
      el.style.transition = 'opacity .2s, transform .2s';
      el.style.opacity = '0';
      el.style.transform = 'translateX(12px)';
      setTimeout(() => el.remove(), 220);
    }, ms);
  }

  /* ---------------- 模态框 ---------------- */
  const stack = [];
  function openModal(html, { onMount, narrow = false, onClose } = {}) {
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    mask.innerHTML = `<div class="modal${narrow ? ' narrow' : ''}">${html}</div>`;
    document.getElementById('modal-root').appendChild(mask);
    const close = () => {
      const i = stack.indexOf(entry);
      if (i >= 0) stack.splice(i, 1);
      mask.remove();
      onClose && onClose();
    };
    const entry = { mask, close, el: mask.querySelector('.modal') };
    stack.push(entry);
    mask.addEventListener('mousedown', (e) => { if (e.target === mask) close(); });
    mask.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', close));
    onMount && onMount(entry.el, close);
    return entry;
  }

  function closeTopModal() {
    const top = stack[stack.length - 1];
    if (top) top.close();
  }

  function confirmDlg({ title = '确认操作', message = '', confirmText = '确认', cancelText = '取消', danger = false } = {}) {
    return new Promise((resolve) => {
      const m = openModal(`
        <div class="modal-head"><div><h3>${h(title)}</h3></div></div>
        <div class="modal-body"><div class="muted" style="line-height:1.65">${message}</div></div>
        <div class="modal-foot"><div class="spacer"></div>
          <button class="btn" data-close>${h(cancelText)}</button>
          <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-ok>${h(confirmText)}</button>
        </div>`, { narrow: true, onClose: () => resolve(false) });
      m.el.querySelector('[data-ok]').addEventListener('click', () => {
        m.close();
        resolve(true);
      });
    });
  }

  /* ---------------- 迷你图 ---------------- */
  function sparkline(canvas, series, color = '#4c8dff') {
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth || 300;
    const hgt = canvas.clientHeight || 38;
    canvas.width = w * dpr;
    canvas.height = hgt * dpr;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, hgt);
    if (!series || series.length < 2) {
      ctx.strokeStyle = 'rgba(255,255,255,.08)';
      ctx.beginPath();
      ctx.moveTo(0, hgt - 4);
      ctx.lineTo(w, hgt - 4);
      ctx.stroke();
      return;
    }
    const max = Math.max(...series, 1);
    const min = Math.min(...series, 0);
    const range = Math.max(max - min, 1);
    const step = w / (series.length - 1);
    const y = (v) => hgt - 3 - ((v - min) / range) * (hgt - 8);
    ctx.beginPath();
    series.forEach((v, i) => {
      const px = i * step;
      const py = y(v);
      if (i === 0) ctx.moveTo(px, py);
      else {
        const prevX = (i - 1) * step;
        const prevY = y(series[i - 1]);
        const cx = (prevX + px) / 2;
        ctx.bezierCurveTo(cx, prevY, cx, py, px, py);
      }
    });
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.6;
    ctx.stroke();
    ctx.lineTo(w, hgt);
    ctx.lineTo(0, hgt);
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, 0, 0, hgt);
    grad.addColorStop(0, `${color}44`);
    grad.addColorStop(1, `${color}00`);
    ctx.fillStyle = grad;
    ctx.fill();
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      toast('已复制到剪贴板', 'ok', 1800);
    } catch (_) {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); toast('已复制', 'ok', 1800); } catch (e) { toast('复制失败', 'error'); }
      ta.remove();
    }
  }

  function debounce(fn, wait = 320) {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), wait);
    };
  }

  const BITRATE_PRESETS = {
    '720': [1800, 2500, 3500, 5000],
    '1080': [3500, 4500, 6000, 8000, 12000],
    '1440': [8000, 12000, 16000, 20000],
    '2160': [18000, 25000, 35000, 50000],
  };

  function bitratePresets(height) {
    if (height >= 2000) return BITRATE_PRESETS['2160'];
    if (height >= 1400) return BITRATE_PRESETS['1440'];
    if (height >= 1000) return BITRATE_PRESETS['1080'];
    return BITRATE_PRESETS['720'];
  }

  return {
    icon, h, attr, fmtKbps, fmtBytes, fmtDuration, fmtTime, relTime, fmtSizePair,
    statusPill, STATUS_TEXT, toast, openModal, closeTopModal, confirmDlg, sparkline,
    copyText, debounce, bitratePresets,
  };
})();
