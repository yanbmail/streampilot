'use strict';

/* ============================================================
   推流模板
   ------------------------------------------------------------
   把一套「分辨率 / 码率 / 目标 / 录制 / 阶梯」存成模板，
   新任务一键套用，也能批量套用到已有任务。
   ============================================================ */
SP.templates = (() => {
  const { h, attr, icon, toast, openModal, confirmDlg } = SP.util;
  const api = SP.api;

  const list = () => SP.state.templates || [];
  const get = (id) => list().find((t) => t.id === id) || null;

  function targetText(t) {
    const l = t.ladder || {};
    if (l.enabled && (l.rungs || []).length) {
      const first = l.rungs[0].target || {};
      const host = first.host || (first.url ? first.url.replace(/^[a-z]+:\/\//, '').split('/')[0] : '');
      return `阶梯 ${l.rungs.length} 档${host ? ` · 首档 ${host}` : ''}`;
    }
    const tgt = t.target || {};
    if (tgt.protocol === 'hls') return 'HLS 本地分发';
    if (tgt.protocol === 'file') return `录制到 ${(tgt.filePath || '').split('/').pop() || '文件'}`;
    if (tgt.protocol === 'flv') return `HTTP-FLV :${tgt.flvListenPort}`;
    if (tgt.url) return tgt.url;
    if (!tgt.host) return `${String(tgt.protocol || 'rtmp').toUpperCase()} · 未填地址`;
    return `${String(tgt.protocol).toUpperCase()} · ${tgt.host}${tgt.port ? `:${tgt.port}` : ''}`;
  }

  function ladderText(t) {
    const l = t.ladder || {};
    if (!l.enabled || !(l.rungs || []).length) return '';
    return (l.rungs || []).map((r) => `${r.name} ${r.bitrateKbps}k`).join(' / ');
  }

  /* ---------------- 页面 ---------------- */
  function page() {
    const items = list();
    const jobs = SP.state.config.jobs || [];
    const html = `
      <div class="sch-toolbar">
        <span class="small dim">共 ${items.length} 套模板 · 新建任务时可在「推流目标」页直接套用</span>
      </div>
      ${items.length ? `<div class="tpl-grid">${items.map(tplCard).join('')}</div>` : `
        <div class="card"><div class="empty-state">
          ${icon('save')}
          <b>还没有推流模板</b>
          <p>把常用的一套「1080P 6Mbps + 三个平台」存成模板，下次建任务一键套用，不用再一条条填</p>
          <div style="margin-top:14px;display:flex;gap:8px;justify-content:center">
            <button class="btn btn-primary" data-act="tpl-save-from-job">${icon('save', 14)} 从现有任务保存</button>
            <button class="btn" data-act="go" data-to="streams">${icon('cast', 14)} 去看推流任务</button>
          </div>
        </div></div>`}
      ${jobs.length ? `
        <div class="section-title" style="margin:20px 0 10px"><h2>快速套用</h2><div class="line"></div></div>
        <div class="hint-box">${icon('info')}<div>选一套模板，勾选要应用的任务，一次改完所有任务的编码与目标配置（不会动输入源和任务名）。</div></div>
        <div class="tpl-apply-row">
          <select class="select" id="tpl-quick-select" style="max-width:280px">
            <option value="">选择模板…</option>
            ${items.map((t) => `<option value="${attr(t.id)}">${h(t.name)}</option>`).join('')}
          </select>
          <button class="btn" id="tpl-quick-apply" ${items.length ? '' : 'disabled'}>${icon('copy', 14)} 批量套用到任务</button>
        </div>` : ''}`;

    function tplCard(t) {
      const v = t.video || {};
      const a = t.audio || {};
      const fan = (t.targets || []).length;
      const rec = t.record && t.record.enabled;
      const lad = ladderText(t);
      return `<div class="tpl-card" data-tpl="${attr(t.id)}">
        <div class="tc-head">
          <div style="min-width:0">
            <div class="tc-name">${h(t.name)}</div>
            ${t.desc ? `<div class="tc-desc ellipsis">${h(t.desc)}</div>` : ''}
          </div>
        </div>
        <div class="tc-specs">
          <div><span>画面</span><b>${v.mode === 'copy' ? '直通（不重编码）' : `${v.width || 1920}×${v.height || 1080} · ${v.fps || 30}fps`}</b></div>
          <div><span>码率</span><b>${v.mode === 'copy' ? '—' : `${((v.bitrateKbps || 0) / 1000).toFixed(1)} Mbps · ${String(v.rateControl || 'cbr').toUpperCase()}`}</b></div>
          <div><span>音频</span><b>${a.mode === 'none' ? '静音' : a.mode === 'copy' ? '直通' : `${String(a.codec || 'aac').toUpperCase()} ${a.bitrateKbps || 128}k`}</b></div>
          <div><span>主目标</span><b class="ellipsis" title="${attr(targetText(t))}">${h(targetText(t))}</b></div>
        </div>
        <div class="tc-tags">
          ${lad ? `<span class="tag-fan">阶梯 ${lad}</span>` : ''}
          ${fan ? `<span class="tag-fan">+${fan} 路分发</span>` : ''}
          ${rec ? '<span class="tag-rec">● 录制</span>' : ''}
          ${!lad && !fan && !rec ? '<span class="dim small">单路输出</span>' : ''}
        </div>
        <div class="tc-foot">
          <button class="btn btn-sm btn-primary" data-act="tpl-use" data-id="${attr(t.id)}">${icon('plus', 12)} 用模板建任务</button>
          <button class="btn btn-sm" data-act="tpl-apply-one" data-id="${attr(t.id)}">${icon('copy', 12)} 套用到…</button>
          <div class="spacer"></div>
          <button class="icon-btn" title="重命名 / 改描述" data-act="tpl-rename" data-id="${attr(t.id)}">${icon('edit', 14)}</button>
          <button class="icon-btn" title="另存一份" data-act="tpl-duplicate" data-id="${attr(t.id)}">${icon('copy', 14)}</button>
          <button class="icon-btn" title="删除" data-act="tpl-delete" data-id="${attr(t.id)}">${icon('trash', 14)}</button>
        </div>
      </div>`;
    }

    return {
      html,
      mount(root) {
        root.querySelectorAll('[data-act]').forEach((el) => {
          el.addEventListener('click', (e) => { e.stopPropagation(); SP.actions.run(el.dataset.act, el); });
        });
        const btn = root.querySelector('#tpl-quick-apply');
        if (btn) btn.addEventListener('click', () => {
          const id = root.querySelector('#tpl-quick-select').value;
          if (!id) return toast('请先选择一套模板', 'warn');
          openApply(id);
        });
      },
    };
  }

  /* ---------------- 从任务保存 ---------------- */
  function openSave({ jobId = '', onSaved = null } = {}) {
    const jobs = SP.state.config.jobs || [];
    if (!jobs.length) return toast('还没有推流任务，先创建一个再保存模板', 'warn');
    const body = `
      <div class="modal-head"><div><h3>保存为推流模板</h3>
        <div class="sub">会保存画面、音频、推流目标、多路分发、录制与阶梯设置（不含输入源）</div></div></div>
      <div class="modal-body">
        <div class="field"><label>来源任务 <span class="req">*</span></label>
          <select class="select" id="ts-job">
            ${jobs.map((j) => `<option value="${attr(j.id)}" ${j.id === jobId ? 'selected' : ''}>${h(j.name)}</option>`).join('')}
          </select></div>
        <div class="form-grid" style="margin-top:12px">
          <div class="field"><label>模板名称 <span class="req">*</span></label>
            <input class="input" id="ts-name" placeholder="例如：1080P 六兆 · 三平台" /></div>
          <div class="field"><label>说明</label>
            <input class="input" id="ts-desc" placeholder="例如：B站 + 抖音 + 视频号，同步录制" /></div>
        </div>
      </div>
      <div class="modal-foot"><div class="spacer"></div>
        <button class="btn" data-close>取消</button>
        <button class="btn btn-primary" id="ts-save">${icon('save', 14)} 保存模板</button>
      </div>`;
    const m = openModal(body);
    const el = m.el;
    const sel = el.querySelector('#ts-job');
    const fillName = () => {
      const job = jobs.find((j) => j.id === sel.value);
      const input = el.querySelector('#ts-name');
      if (job && !input.value) input.value = `${job.name} 模板`;
    };
    fillName();
    sel.addEventListener('change', () => { el.querySelector('#ts-name').value = ''; fillName(); });
    el.querySelector('#ts-save').addEventListener('click', async () => {
      const name = el.querySelector('#ts-name').value.trim();
      if (!name) return toast('请填写模板名称', 'warn');
      try {
        await api.saveTemplate({ from: sel.value, name, desc: el.querySelector('#ts-desc').value.trim() });
        toast('模板已保存', 'ok');
        m.close();
        await SP.refreshState({ silent: true });
        onSaved ? onSaved() : SP.render({ keepScroll: true });
      } catch (err) { toast(err.message, 'error', 6000); }
    });
  }

  /* ---------------- 批量套用 ---------------- */
  function openApply(tplId) {
    const tpl = get(tplId);
    const jobs = SP.state.config.jobs || [];
    if (!tpl) return;
    const body = `
      <div class="modal-head"><div><h3>套用模板「${h(tpl.name)}」</h3>
        <div class="sub">勾选要应用的任务，会覆盖它们的画面 / 音频 / 目标 / 录制 / 阶梯设置</div></div></div>
      <div class="modal-body">
        <div class="tpl-pick-list" id="ta-list">
          ${jobs.map((j) => `
            <label class="tpl-pick">
              <input type="checkbox" value="${attr(j.id)}" />
              <div style="min-width:0">
                <div style="font-weight:550" class="ellipsis">${h(j.name)}</div>
                <div class="small dim ellipsis">${j.video.width}×${j.video.height} · ${((j.video.bitrateKbps || 0) / 1000).toFixed(1)} Mbps · ${(j.target.protocol || '').toUpperCase()}</div>
              </div>
            </label>`).join('')}
        </div>
        <div class="chips" style="margin-top:10px">
          <span class="chip sm" id="ta-all">全选</span>
          <span class="chip sm" id="ta-none">全不选</span>
        </div>
        <div class="hint-box warn" style="margin-top:12px">${icon('alert')}<div>正在推流的任务套用后需要重启才会生效。</div></div>
      </div>
      <div class="modal-foot"><div class="spacer"></div>
        <button class="btn" data-close>取消</button>
        <button class="btn btn-primary" id="ta-apply">${icon('check', 14)} 应用</button>
      </div>`;
    const m = openModal(body);
    const el = m.el;
    const boxes = () => Array.from(el.querySelectorAll('#ta-list input[type=checkbox]'));
    el.querySelector('#ta-all').addEventListener('click', () => boxes().forEach((b) => { b.checked = true; }));
    el.querySelector('#ta-none').addEventListener('click', () => boxes().forEach((b) => { b.checked = false; }));
    el.querySelector('#ta-apply').addEventListener('click', async () => {
      const ids = boxes().filter((b) => b.checked).map((b) => b.value);
      if (!ids.length) return toast('请至少选择一个任务', 'warn');
      try {
        const r = await api.applyTemplate(tplId, ids);
        toast(`已套用到 ${r.applied} 个任务`, 'ok');
        m.close();
        await SP.refreshState({ silent: true });
        SP.render({ keepScroll: true });
      } catch (err) { toast(err.message, 'error', 6000); }
    });
  }

  /* ---------------- 新建 / 重命名 / 复制 / 删除 ---------------- */
  function openBlank() {
    const body = `
      <div class="modal-head"><div><h3>新建空白模板</h3>
        <div class="sub">先建一个默认模板，之后用「套用到…」或编辑任务来调整参数</div></div></div>
      <div class="modal-body">
        <div class="form-grid">
          <div class="field"><label>模板名称 <span class="req">*</span></label><input class="input" id="tb-name" placeholder="例如：竖屏 720P 直播" /></div>
          <div class="field"><label>说明</label><input class="input" id="tb-desc" placeholder="可选" /></div>
        </div>
        <div class="form-grid" style="margin-top:12px">
          <div class="field"><label>分辨率</label>
            <select class="select" id="tb-res">
              ${[[1280, 720, '720P'], [1920, 1080, '1080P'], [2560, 1440, '2K'], [3840, 2160, '4K'], [1080, 1920, '竖屏 1080×1920']]
    .map(([w, hh, l]) => `<option value="${w}x${hh}" ${w === 1920 ? 'selected' : ''}>${l}</option>`).join('')}
            </select></div>
          <div class="field"><label>码率</label>
            <div class="input-suffix"><input class="input" id="tb-bitrate" type="number" value="6000" /><span class="unit">kbps</span></div></div>
        </div>
      </div>
      <div class="modal-foot"><div class="spacer"></div>
        <button class="btn" data-close>取消</button>
        <button class="btn btn-primary" id="tb-save">创建模板</button>
      </div>`;
    const m = openModal(body);
    const el = m.el;
    el.querySelector('#tb-save').addEventListener('click', async () => {
      const name = el.querySelector('#tb-name').value.trim();
      if (!name) return toast('请填写模板名称', 'warn');
      const [w, hh] = el.querySelector('#tb-res').value.split('x').map(Number);
      try {
        await api.saveTemplate({
          name,
          desc: el.querySelector('#tb-desc').value.trim(),
          video: { width: w, height: hh, bitrateKbps: Number(el.querySelector('#tb-bitrate').value) || 6000 },
        });
        toast('模板已创建', 'ok');
        m.close();
        await SP.refreshState({ silent: true });
        SP.render({ keepScroll: true });
      } catch (err) { toast(err.message, 'error', 6000); }
    });
  }

  function openRename(tplId) {
    const tpl = get(tplId);
    if (!tpl) return;
    const body = `
      <div class="modal-head"><div><h3>编辑模板信息</h3></div></div>
      <div class="modal-body">
        <div class="field"><label>名称</label><input class="input" id="tr-name" value="${attr(tpl.name)}" /></div>
        <div class="field" style="margin-top:10px"><label>说明</label><input class="input" id="tr-desc" value="${attr(tpl.desc || '')}" /></div>
      </div>
      <div class="modal-foot"><div class="spacer"></div>
        <button class="btn" data-close>取消</button>
        <button class="btn btn-primary" id="tr-save">保存</button>
      </div>`;
    const m = openModal(body);
    const el = m.el;
    el.querySelector('#tr-save').addEventListener('click', async () => {
      const name = el.querySelector('#tr-name').value.trim();
      if (!name) return toast('请填写名称', 'warn');
      await api.updateTemplate(tplId, { name, desc: el.querySelector('#tr-desc').value.trim() });
      toast('已保存', 'ok');
      m.close();
      await SP.refreshState({ silent: true });
      SP.render({ keepScroll: true });
    });
  }

  async function duplicate(tplId) {
    const tpl = get(tplId);
    if (!tpl) return;
    await api.saveTemplate({ ...tpl, id: '', name: `${tpl.name} 副本` });
    toast('已复制模板', 'ok');
    await SP.refreshState({ silent: true });
    SP.render({ keepScroll: true });
  }

  async function remove(tplId) {
    const tpl = get(tplId);
    const ok = await confirmDlg({
      title: '删除模板',
      message: `确定删除模板「<b>${h(tpl?.name || '')}</b>」吗？已套用的任务不受影响。`,
      confirmText: '删除', danger: true,
    });
    if (!ok) return;
    await api.deleteTemplate(tplId);
    toast('模板已删除', 'ok');
    await SP.refreshState({ silent: true });
    SP.render({ keepScroll: true });
  }

  async function useTemplate(tplId) {
    const tpl = get(tplId);
    if (!tpl) return;
    const r = await api.newJobFromTemplate(tplId, { name: `${tpl.name} 任务` });
    toast('已按模板创建任务，补充输入源即可开播', 'ok', 4000);
    await SP.refreshState({ silent: true });
    SP.jobForm.open({ job: r.job, onSaved: () => SP.refreshState() });
  }

  /** 任务编辑器里用：把模板套到当前草稿（前端直接合并，无需请求） */
  function mergeInto(draft, tplId) {
    const tpl = get(tplId);
    if (!tpl) return draft;
    const next = { ...draft };
    for (const key of ['video', 'audio', 'target', 'targets', 'record', 'ladder', 'advanced']) {
      if (tpl[key] === undefined || tpl[key] === null) continue;
      next[key] = JSON.parse(JSON.stringify(tpl[key]));
    }
    return next;
  }

  return { page, openSave, openApply, openBlank, openRename, duplicate, remove, useTemplate, mergeInto, list, get };
})();
