'use strict';

/* ============================================================
   一周排播表
   ------------------------------------------------------------
   周视图网格：横轴 7 天，纵轴 24 小时
    · 点空白格 → 在那一刻新建排播
    · 点色块 → 编辑
    · 红色游标为当前时间
   ============================================================ */
SP.schedule = (() => {
  const { h, attr, icon, toast, openModal, confirmDlg } = SP.util;
  const api = SP.api;

  const ROW_H = 26; // 每小时像素高度
  const DAY_LABEL = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
  // 显示顺序：周一到周日；JS getDay() 里 0 是周日
  const DAY_INDEX = [1, 2, 3, 4, 5, 6, 0];
  const PALETTE = ['#4c8dff', '#22c1a4', '#f2a33c', '#b06bff', '#ff5c8a', '#3ec1e0', '#8bc34a', '#ff8a5c'];

  const pad = (n) => String(n).padStart(2, '0');
  const clock = (ts) => {
    const d = new Date(ts);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  const dateLabel = (ts) => {
    const d = new Date(ts);
    return `${d.getMonth() + 1}/${d.getDate()}`;
  };
  /** "今天 20:00 开播 · 还有 2 小时 12 分" */
  function humanCountdown(ts) {
    if (!ts) return '';
    const diff = ts - Date.now();
    if (diff <= 0) return '即将开始';
    const m = Math.floor(diff / 60000);
    if (m < 60) return `还有 ${m} 分钟`;
    const hh = Math.floor(m / 60);
    if (hh < 24) return `还有 ${hh} 小时 ${m % 60} 分`;
    return `还有 ${Math.floor(hh / 24)} 天`;
  }
  function colorOf(key) {
    let n = 0;
    for (let i = 0; i < String(key).length; i++) n = (n * 31 + String(key).charCodeAt(i)) % 9973;
    return PALETTE[n % PALETTE.length];
  }

  const snap = () => SP.state.schedule || { enabled: true, tasks: [] };

  /* ---------------- 时间计算（与后端一致，用于绘制） ---------------- */
  function minutes(clockStr) {
    const [hh, mm] = String(clockStr || '0:0').split(':').map(Number);
    return (hh || 0) * 60 + (mm || 0);
  }
  function spanOf(task) {
    const start = minutes(task.start);
    const end = task.endMode === 'duration'
      ? start + Math.max(1, Number(task.durationMin) || 60)
      : minutes(task.end);
    const length = end > start ? end - start : 1440 - start + end;
    return { start, length: Math.max(5, length), endMin: end };
  }
  function durationText(task) {
    const { length } = spanOf(task);
    const hh = Math.floor(length / 60);
    const mm = length % 60;
    return `${hh ? `${hh} 小时` : ''}${mm ? `${mm} 分` : ''}` || '0 分';
  }

  /* ---------------- 周视图 ---------------- */
  function gridHtml(tasks) {
    const now = new Date();
    const todayDow = now.getDay();
    const base = new Date();
    base.setHours(0, 0, 0, 0);
    const mondayOffset = (todayDow + 6) % 7; // 本周一
    const monday = base.getTime() - mondayOffset * 86400000;

    const head = DAY_INDEX.map((dow, i) => {
      const dayTs = monday + i * 86400000;
      const isToday = dow === todayDow;
      return `<div class="sch-dayhead ${isToday ? 'today' : ''}">
        <b>${DAY_LABEL[i]}</b><span>${dateLabel(dayTs)}</span>
      </div>`;
    }).join('');

    const hourLines = Array.from({ length: 24 }, (_, i) => `
      <div class="sch-hour"><span>${pad(i)}:00</span></div>`).join('');

    const cols = DAY_INDEX.map((dow, i) => {
      const blocks = tasks
        .filter((t) => (t.days || []).includes(dow))
        .map((t, idx) => {
          const { start, length } = spanOf(t);
          const top = (start / 60) * ROW_H;
          const height = Math.max(16, (length / 60) * ROW_H);
          const color = colorOf(t.jobId || t.id);
          const compact = height < 34;
          const runningNow = t.running;
          const endMin = (start + length) % 1440;
          const endText = `${pad(Math.floor(endMin / 60))}:${pad(endMin % 60)}`;
          return `<div class="sch-block ${t.enabled ? '' : 'off'} ${runningNow ? 'live' : ''} ${compact ? 'compact' : ''}"
              style="top:${top}px;height:${height}px;--c:${color};z-index:${runningNow ? 5 : 2 + idx}"
              data-sch-block="${attr(t.id)}" title="${attr(`${t.name} · ${t.start}–${endText}`)}">
            <div class="sb-name">${h(t.name)}</div>
            ${compact ? '' : `<div class="sb-meta">${h(t.start)}–${endText}${runningNow ? ' · 正在播' : ''}</div>`}
          </div>`;
        }).join('');
      return `<div class="sch-col ${dow === todayDow ? 'today' : ''}" data-day="${dow}">${blocks}</div>`;
    }).join('');

    const nowMin = now.getHours() * 60 + now.getMinutes();
    const nowTop = (nowMin / 60) * ROW_H;
    const todayIdx = DAY_INDEX.indexOf(todayDow);
    return `
      <div class="sch-grid">
        <div class="sch-corner">${icon('clock', 13)}</div>
        ${head}
        <div class="sch-gutter">${hourLines}</div>
        <div class="sch-cols" style="--cols:7">
          <div class="sch-now" style="top:${nowTop}px">
            <span class="t">${pad(now.getHours())}:${pad(now.getMinutes())}</span>
          </div>
          ${cols}
          <div class="sch-now-dot" style="top:${nowTop}px;left:calc(${todayIdx} * (100% / 7))"></div>
        </div>
      </div>`;
  }
  /* ---------------- 列表 ---------------- */
  function listHtml(tasks) {
    if (!tasks.length) {
      return `<div class="empty-state" style="padding:34px">${icon('clock')}
        <b>还没有排播计划</b>
        <p>在上面的周视图点一个时间段，就能安排「周几几点开播、播多久」</p>
      </div>`;
    }
    return `<div class="table-wrap"><table class="tbl">
      <thead><tr>
        <th style="width:22%">名称</th><th>关联任务</th><th>重复</th><th>时段</th>
        <th>状态</th><th>下一次</th><th class="col-actions" style="width:150px"></th>
      </tr></thead>
      <tbody>
      ${tasks.map((t) => {
    const color = colorOf(t.jobId || t.id);
    const next = t.running
      ? `<span class="pill running"><i class="dot"></i>${t.endsAt ? `${clock(t.endsAt)} 停` : '播送中'}</span>`
      : (t.nextStart ? `<span class="dim small">${dateLabel(t.nextStart)} ${clock(t.nextStart)} · ${humanCountdown(t.nextStart)}</span>` : '<span class="dim small">—</span>');
    return `<tr data-sch-row="${attr(t.id)}">
          <td><div style="display:flex;align-items:center;gap:7px">
            <span style="width:8px;height:8px;border-radius:50%;background:${color};flex:none"></span>
            <div style="min-width:0"><div style="font-weight:550" class="ellipsis">${h(t.name)}</div>
            ${t.note ? `<div class="small dim ellipsis">${h(t.note)}</div>` : ''}</div>
          </div></td>
          <td class="small">${t.jobMissing ? '<span class="tag-bad">任务已删除</span>' : h(t.jobName || '—')}</td>
          <td class="small">${h(t.daysText || '未选择')}</td>
          <td class="small mono">${h(t.start)} – ${t.endMode === 'duration' ? `${durationText(t)}（按长度）` : h(t.end)}</td>
          <td>${t.running ? '<span class="pill running"><i class="dot"></i>播送中</span>' : (t.enabled ? '<span class="pill info"><i class="dot"></i>待播</span>' : '<span class="pill stopped"><i class="dot"></i>已停用</span>')}</td>
          <td>${next}</td>
          <td class="cell-actions"><div class="row-actions">
            ${t.running
      ? `<button class="icon-btn" title="立即停止" data-act="schedule-stop" data-id="${attr(t.id)}">${icon('stop', 14)}</button>`
      : `<button class="icon-btn" title="立即开播" data-act="schedule-run" data-id="${attr(t.id)}" ${t.jobMissing ? 'disabled' : ''}>${icon('play', 14)}</button>`}
            <button class="icon-btn" title="编辑" data-act="schedule-edit" data-id="${attr(t.id)}">${icon('edit', 14)}</button>
            <button class="icon-btn" title="${t.enabled ? '停用' : '启用'}" data-act="schedule-toggle" data-id="${attr(t.id)}" data-on="${t.enabled ? '0' : '1'}">${icon(t.enabled ? 'x' : 'check', 14)}</button>
            <button class="icon-btn" title="删除" data-act="schedule-delete" data-id="${attr(t.id)}">${icon('trash', 14)}</button>
          </div></td>
        </tr>`;
  }).join('')}
      </tbody></table></div>`;
  }

  /* ---------------- 页面 ---------------- */
  function page() {
    const S = snap();
    const tasks = S.tasks || [];
    const active = tasks.filter((t) => t.running).length;
    const nextOne = tasks.filter((t) => !t.running && t.nextStart).sort((a, b) => a.nextStart - b.nextStart)[0];

    const html = `
      <div class="sch-toolbar">
        <label class="switch">
          <input type="checkbox" id="sch-enabled" ${S.enabled ? 'checked' : ''} />
          <span class="track"></span><span class="lbl">自动执行排播</span>
        </label>
        <span class="sep"></span>
        <span class="small dim">共 ${tasks.length} 条计划 · 正在播 ${active} 条</span>
        ${nextOne ? `<span class="small dim">· 下一条：${h(nextOne.name)} ${dateLabel(nextOne.nextStart)} ${clock(nextOne.nextStart)}（${humanCountdown(nextOne.nextStart)}）</span>` : ''}
        <div class="spacer"></div>
        <button class="btn btn-sm" data-act="schedule-now-tick">${icon('refresh', 12)} 立即检查</button>
        <button class="btn btn-sm btn-primary" data-act="schedule-new">${icon('plus', 12)} 新建排播</button>
      </div>
      ${S.enabled ? '' : `<div class="hint-box warn" style="margin-bottom:12px">${icon('alert')}<div>排播自动执行已关闭：时间表照常显示，但到点不会自动开关推流。</div></div>`}
      <div class="card sch-card">
        <div class="card-head"><h3>一周节目表</h3><div class="spacer"></div>
          <span class="dim small">点空白处新建 · 点色块编辑</span>
        </div>
        <div class="sch-scroll">${gridHtml(tasks)}</div>
      </div>
      <div class="section-title" style="margin:18px 0 10px"><h2>全部排播</h2><div class="line"></div></div>
      ${listHtml(tasks)}`;

    return {
      html,
      mount(root) {
        const en = root.querySelector('#sch-enabled');
        en && en.addEventListener('change', async () => {
          await api.toggleSchedule(en.checked);
          toast(en.checked ? '已开启排播自动执行' : '已关闭排播自动执行', en.checked ? 'ok' : 'warn');
          await SP.refreshState({ silent: true });
          SP.render({ keepScroll: true });
        });
        root.querySelectorAll('[data-act]').forEach((el) => {
          el.addEventListener('click', (e) => {
            e.stopPropagation();
            SP.actions.run(el.dataset.act, el);
          });
        });
        root.querySelectorAll('[data-sch-block]').forEach((el) => {
          el.addEventListener('click', (e) => {
            e.stopPropagation();
            const task = (snap().tasks || []).find((t) => t.id === el.dataset.schBlock);
            if (task) openEditor(task);
          });
        });
        root.querySelectorAll('.sch-col').forEach((col) => {
          col.addEventListener('click', (e) => {
            if (e.target.closest('[data-sch-block]')) return;
            const rect = col.getBoundingClientRect();
            const y = e.clientY - rect.top;
            const mins = Math.max(0, Math.min(23 * 60 + 30, Math.round((y / ROW_H) * 60 / 30) * 30));
            openEditor(null, { day: Number(col.dataset.day), startMin: mins });
          });
        });
        // 滚到当前时间附近，早上的计划也能一眼看到
        const scroller = root.querySelector('.sch-scroll');
        if (scroller) {
          const now = new Date();
          const top = ((now.getHours() * 60 + now.getMinutes()) / 60) * ROW_H;
          scroller.scrollTop = Math.max(0, top - 160);
        }
      },
    };
  }

  /* ---------------- 编辑器 ---------------- */
  function openEditor(task, seed = {}) {
    const isNew = !task;
    const jobs = SP.state.config.jobs || [];
    const initial = task || {
      id: '',
      name: '',
      jobId: jobs[0]?.id || '',
      enabled: true,
      days: seed.day !== undefined ? [seed.day] : [new Date().getDay()],
      start: seed.startMin !== undefined
        ? `${pad(Math.floor(seed.startMin / 60))}:${pad(seed.startMin % 60)}`
        : '20:00',
      endMode: 'time',
      end: seed.startMin !== undefined
        ? `${pad(Math.floor((seed.startMin + 120) / 60) % 24)}:${pad((seed.startMin + 120) % 60)}`
        : '22:00',
      durationMin: 120,
      note: '',
    };
    const d = { ...initial };

    const jobOptions = jobs.length
      ? jobs.map((j) => `<option value="${attr(j.id)}" ${j.id === d.jobId ? 'selected' : ''}>${h(j.name)}</option>`).join('')
      : '<option value="">（还没有推流任务，请先创建一个）</option>';

    const body = `
      <div class="modal-head">
        <div style="flex:1;min-width:0">
          <h3>${isNew ? '新建排播' : '编辑排播'}</h3>
          <div class="sub">按时段自动开关推流，支持一周内任意多天重复</div>
        </div>
        <label class="switch"><input type="checkbox" id="se-enabled" ${d.enabled ? 'checked' : ''} />
          <span class="track"></span><span class="lbl">启用</span></label>
      </div>
      <div class="modal-body">
        <div class="form-grid">
          <div class="field"><label>节目名称</label>
            <input class="input" id="se-name" value="${attr(d.name)}" placeholder="例如：晚间新闻转播" /></div>
          <div class="field"><label>关联推流任务 <span class="req">*</span></label>
            <select class="select" id="se-job">${jobOptions}</select>
            <div class="help">到点后自动启动这条推流任务</div></div>
        </div>

        <div class="field" style="margin-top:14px"><label>重复星期</label>
          <div class="day-picker" id="se-days">
            ${DAY_INDEX.map((dow, i) => `<button type="button" class="day-btn ${(d.days || []).includes(dow) ? 'active' : ''}" data-day="${dow}">${DAY_LABEL[i]}</button>`).join('')}
          </div>
          <div class="chips" style="margin-top:8px">
            <span class="chip sm" data-quick="weekday">工作日</span>
            <span class="chip sm" data-quick="weekend">周末</span>
            <span class="chip sm" data-quick="all">每天</span>
            <span class="chip sm" data-quick="none">清空</span>
          </div>
        </div>

        <div class="form-grid" style="margin-top:14px">
          <div class="field"><label>开始时间</label>
            <input class="input mono" id="se-start" type="time" value="${attr(d.start)}" /></div>
          <div class="field"><label>结束方式</label>
            <div class="seg" id="se-endmode">
              <button type="button" data-mode="time" class="${d.endMode === 'time' ? 'active' : ''}">指定结束时刻</button>
              <button type="button" data-mode="duration" class="${d.endMode === 'duration' ? 'active' : ''}">按时长自动断</button>
            </div></div>
          <div class="field" id="se-end-wrap" ${d.endMode === 'duration' ? 'style="display:none"' : ''}><label>结束时间</label>
            <input class="input mono" id="se-end" type="time" value="${attr(d.end)}" />
            <div class="help">早于开始时间表示跨午夜（如 23:30 → 01:00）</div></div>
          <div class="field" id="se-dur-wrap" ${d.endMode === 'time' ? 'style="display:none"' : ''}><label>持续时长</label>
            <div class="input-suffix"><input class="input" id="se-duration" type="number" min="1" max="1440" value="${d.durationMin}" /><span class="unit">分钟</span></div>
            <div class="help">开播后到点自动停止</div></div>
        </div>

        <div class="field" style="margin-top:12px"><label>备注</label>
          <input class="input" id="se-note" value="${attr(d.note)}" placeholder="可选，例如：周五加播一场" /></div>

        <div class="hint-box" style="margin-top:12px" id="se-preview">${icon('info')}<div>选择任务与时间后这里会显示具体安排</div></div>
      </div>
      <div class="modal-foot">
        ${!isNew ? `<button class="btn btn-ghost" id="se-run" style="color:var(--ok)">${icon('play', 14)} 立即开播</button>` : ''}
        <div class="spacer"></div>
        <button class="btn" data-close>取消</button>
        <button class="btn btn-primary" id="se-save">${isNew ? '创建排播' : '保存'}</button>
      </div>`;

    const m = openModal(body);
    const el = m.el;
    const $ = (s) => el.querySelector(s);

    const read = () => ({
      ...(task || {}),
      name: $('#se-name').value.trim() || '未命名排播',
      jobId: $('#se-job').value,
      enabled: $('#se-enabled').checked,
      days: Array.from(el.querySelectorAll('.day-btn.active')).map((b) => Number(b.dataset.day)),
      start: $('#se-start').value || '20:00',
      endMode: el.querySelector('#se-endmode .active')?.dataset.mode || 'time',
      end: $('#se-end').value || '22:00',
      durationMin: Number($('#se-duration').value) || 60,
      note: $('#se-note').value.trim(),
    });
    const refreshPreview = () => {
      const d2 = read();
      const box = el.querySelector('#se-preview');
      const job = jobs.find((j) => j.id === d2.jobId);
      if (!d2.days.length) { box.className = 'hint-box warn'; box.innerHTML = `${icon('alert')}<div>还没有选择重复的星期</div>`; return; }
      if (!job) { box.className = 'hint-box warn'; box.innerHTML = `${icon('alert')}<div>请选择一个推流任务</div>`; return; }
      const { length, endMin } = spanOf(d2);
      const endText = `${pad(Math.floor(endMin / 60) % 24)}:${pad(endMin % 60)}`;
      const cross = endMin <= minutes(d2.start) || endMin >= 1440;
      box.className = 'hint-box';
      box.innerHTML = `${icon('info')}<div>${d2.days.slice().sort().map((x) => DAY_LABEL[DAY_INDEX.indexOf(x)]).join('、')}　
        每天 <b>${d2.start}</b> 自动开播「${h(job.name)}」，${d2.endMode === 'duration' ? `播 <b>${length}</b> 分钟后` : `<b>${endText}</b>`} 自动停止${cross ? '（跨午夜）' : ''}。</div>`;
    };

    el.querySelectorAll('.day-btn').forEach((b) => b.addEventListener('click', () => {
      b.classList.toggle('active');
      refreshPreview();
    }));
    el.querySelectorAll('[data-quick]').forEach((c) => c.addEventListener('click', () => {
      const q = c.dataset.quick;
      const want = q === 'weekday' ? [1, 2, 3, 4, 5] : q === 'weekend' ? [0, 6] : q === 'all' ? [0, 1, 2, 3, 4, 5, 6] : [];
      el.querySelectorAll('.day-btn').forEach((b) => b.classList.toggle('active', want.includes(Number(b.dataset.day))));
      refreshPreview();
    }));
    el.querySelectorAll('#se-endmode button').forEach((b) => b.addEventListener('click', () => {
      el.querySelectorAll('#se-endmode button').forEach((x) => x.classList.toggle('active', x === b));
      const byDur = b.dataset.mode === 'duration';
      el.querySelector('#se-end-wrap').style.display = byDur ? 'none' : '';
      el.querySelector('#se-dur-wrap').style.display = byDur ? '' : 'none';
      refreshPreview();
    }));
    ['#se-name', '#se-job', '#se-start', '#se-end', '#se-duration', '#se-enabled'].forEach((sel) => {
      const node = el.querySelector(sel);
      node && node.addEventListener('change', refreshPreview);
      node && node.addEventListener('input', refreshPreview);
    });
    refreshPreview();

    el.querySelector('#se-save').addEventListener('click', async () => {
      const payload = read();
      if (!payload.jobId) return toast('请先选择一个推流任务', 'warn');
      if (!payload.days.length) return toast('请至少选择一个重复的星期', 'warn');
      try {
        if (task) await api.updateSchedule(task.id, payload);
        else await api.createSchedule(payload);
        toast(task ? '排播已保存' : '排播已创建', 'ok');
        m.close();
        await SP.refreshState({ silent: true });
        SP.render({ keepScroll: true });
      } catch (err) { toast(err.message, 'error', 6000); }
    });

    const runBtn = el.querySelector('#se-run');
    if (runBtn) runBtn.addEventListener('click', async () => {
      const d2 = read();
      const mins = d2.endMode === 'duration' ? d2.durationMin : Math.max(1, spanOf(d2).length);
      try {
        await api.runSchedule(d2.id, mins);
        toast(`已开播，${mins} 分钟后自动停止`, 'ok');
        m.close();
        await SP.refreshState({ silent: true });
        SP.render({ keepScroll: true });
      } catch (err) { toast(err.message, 'error', 6000); }
    });
  }

  /* ---------------- 立即开播（列表直接用） ---------------- */
  async function runNow(taskId) {
    const task = (snap().tasks || []).find((t) => t.id === taskId);
    if (!task) return;
    const mins = task.endMode === 'duration' ? task.durationMin : Math.max(1, spanOf(task).length);
    const ok = await confirmDlg({
      title: '立即开播',
      message: `「<b>${h(task.name)}</b>」现在开始，${mins} 分钟后自动停止。`,
      confirmText: '开始推流',
    });
    if (!ok) return;
    await api.runSchedule(taskId, mins);
    toast('已开播', 'ok');
    await SP.refreshState({ silent: true });
    SP.render({ keepScroll: true });
  }

  async function remove(taskId) {
    const task = (snap().tasks || []).find((t) => t.id === taskId);
    const ok = await confirmDlg({
      title: '删除排播',
      message: `确定删除「<b>${h(task?.name || '')}</b>」吗？正在播送会一并停止。`,
      confirmText: '删除', danger: true,
    });
    if (!ok) return;
    await api.deleteSchedule(taskId);
    toast('排播已删除', 'ok');
    await SP.refreshState({ silent: true });
    SP.render({ keepScroll: true });
  }

  return { page, openEditor, runNow, remove, spanOf, spanText: durationText };
})();
