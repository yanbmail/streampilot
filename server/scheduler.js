'use strict';

/* ============================================================
   一周排播调度器
   ------------------------------------------------------------
   · 按「星期几 + 开始时间 + 结束方式」决定某个任务此刻该不该在推
   · 支持跨午夜时段（20:00 开、01:30 停）
   · 结束方式两种：指定结束时刻 / 按开始后时长自动断
   · 手动「立即开播」按指定时长运行，到点自动停
   ============================================================ */

const EventEmitter = require('events');

const DAY_MS = 86400000;
const DOW_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const RUNNING_STATES = ['running', 'starting', 'reconnecting'];

/** "HH:MM" → 当天第几秒 */
function parseClock(value) {
  const [h, m] = String(value || '00:00').split(':').map(Number);
  return (h || 0) * 3600 + (m || 0) * 60;
}

/** 某个时间戳所在自然日的 0 点（本地时区） */
function dayStart(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * 计算任务在 now 所处的活动窗口。
 * 返回 { start, end }（时间戳）或 null。
 * 跨午夜时段要同时看「今天开的窗口」和「昨天开的、延续到今天的窗口」。
 */
function activeWindow(task, now = Date.now()) {
  const days = Array.isArray(task.days) ? task.days : [];
  if (!days.length) return null;
  const startSec = parseClock(task.start);
  const endSec = task.endMode === 'duration'
    ? startSec + Math.max(1, Number(task.durationMin) || 60) * 60
    : parseClock(task.end);
  // end 早于 start 说明跨了午夜
  const len = endSec > startSec ? endSec - startSec : 86400 - startSec + endSec;
  const today = dayStart(now);
  for (const offset of [0, -1]) {
    const ds = today + offset * DAY_MS;
    if (!days.includes(new Date(ds).getDay())) continue;
    const s = ds + startSec * 1000;
    const e = s + len * 1000;
    if (now >= s && now < e) return { start: s, end: e };
  }
  return null;
}

/** 下一次开播时间戳（未来 7 天内），没有排期返回 0 */
function nextStart(task, now = Date.now()) {
  const days = Array.isArray(task.days) ? task.days : [];
  if (!days.length) return 0;
  const startSec = parseClock(task.start);
  const today = dayStart(now);
  for (let i = 0; i <= 7; i++) {
    const ds = today + i * DAY_MS;
    if (!days.includes(new Date(ds).getDay())) continue;
    const s = ds + startSec * 1000;
    if (s > now) return s;
  }
  return 0;
}

/** 把任务展开成未来 n 天的具体场次，供「未来 7 天」视图使用 */
function upcoming(task, now = Date.now(), days = 7) {
  const list = [];
  const startSec = parseClock(task.start);
  const endSec = task.endMode === 'duration'
    ? startSec + Math.max(1, Number(task.durationMin) || 60) * 60
    : parseClock(task.end);
  const len = endSec > startSec ? endSec - startSec : 86400 - startSec + endSec;
  const today = dayStart(now);
  for (let i = 0; i < days; i++) {
    const ds = today + i * DAY_MS;
    const dow = new Date(ds).getDay();
    if (!(task.days || []).includes(dow)) continue;
    const s = ds + startSec * 1000;
    if (s + len * 1000 <= now) continue;
    list.push({ start: s, end: s + len * 1000, day: dow });
  }
  return list;
}

class Scheduler extends EventEmitter {
  constructor({ store, jobs }) {
    super();
    this.store = store;
    this.jobs = jobs;
    this.timer = null;
    this.active = new Map(); // taskId -> { jobId, start, end, manual }
    this.manual = new Map(); // taskId -> { start, end } 手动开播的临时时段
    this.retryAt = new Map(); // taskId -> 时间戳，失败后退避，避免每 10 秒猛重试
    this.lastError = new Map();
    this.tickTimer = null;
  }

  start(intervalMs = 10000) {
    if (this.timer) return;
    this.timer = setInterval(() => { this.tick().catch(() => {}); }, intervalMs);
    this.timer.unref?.();
    setTimeout(() => this.tick().catch(() => {}), 1500).unref?.();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    this.active.clear();
  }

  isBusy(jobId) {
    return RUNNING_STATES.includes(this.jobs.runtime(jobId).status);
  }

  /** 记录一条排播日志，交由上层推入全局日志与事件流 */
  note(line, level = 'info', taskId = '') {
    this.emit('event', { t: Date.now(), jobId: 'schedule', level, line, taskId });
  }

  async tick() {
    const cfg = this.store.schedule;
    const now = Date.now();
    const tasks = (cfg.tasks || []).filter((t) => t.enabled && t.jobId);

    // 1. 收集当前应处于运行状态的任务
    const wanted = new Map();
    for (const task of tasks) {
      const win = activeWindow(task, now);
      if (win) wanted.set(task.id, { ...win, manual: false });
    }
    for (const [taskId, info] of this.manual) {
      const task = this.store.getScheduleTask(taskId);
      if (!task) { this.manual.delete(taskId); continue; }
      if (now >= info.end) {
        this.manual.delete(taskId);
        continue;
      }
      wanted.set(taskId, { start: info.start, end: info.end, manual: true });
    }

    // 2. 该开的开
    if (cfg.enabled) {
      for (const [taskId, win] of wanted) {
        if (this.active.has(taskId)) continue;
        const task = this.store.getScheduleTask(taskId);
        if (!task) continue;
        const retry = this.retryAt.get(taskId) || 0;
        if (now < retry) continue;
        const job = this.store.getJob(task.jobId);
        if (!job) {
          if (!this.lastError.get(taskId)) {
            this.lastError.set(taskId, '关联任务不存在');
            this.note(`排播「${task.name}」关联的推流任务已被删除，已跳过`, 'error', taskId);
          }
          continue;
        }
        try {
          if (!this.isBusy(task.jobId)) {
            await this.jobs.start(task.jobId, { manual: false });
          }
          this.active.set(taskId, { jobId: task.jobId, start: now, end: win.end, manual: win.manual });
          this.lastError.delete(taskId);
          this.note(
            `${win.manual ? '手动开播' : '按排播表开播'}「${task.name}」→ ${job.name}，`
            + `${win.manual ? '按时长' : ''}到 ${clockOf(win.end)} 自动停止`,
            'ok', taskId,
          );
        } catch (err) {
          this.retryAt.set(taskId, now + 60000);
          this.lastError.set(taskId, err.message);
          this.note(`排播「${task.name}」开播失败：${err.message}（1 分钟后重试）`, 'error', taskId);
        }
      }
    }

    // 3. 该停的停
    for (const [taskId, entry] of [...this.active]) {
      const still = cfg.enabled && wanted.get(taskId);
      const expired = entry.end && now >= entry.end;
      const task = this.store.getScheduleTask(taskId);
      if (!task) { this.active.delete(taskId); continue; }
      if (still && !expired) continue;

      this.active.delete(taskId);
      // 同一任务可能被多条排播共用，别的时候还在用就不停
      const shared = [...this.active.values()].some((e) => e.jobId === entry.jobId);
      const job = this.store.getJob(entry.jobId);
      if (!shared && job) {
        try {
          await this.jobs.stop(entry.jobId);
          this.note(`排播「${task.name}」时段结束，已停止推流`, 'ok', taskId);
        } catch (err) {
          this.note(`排播「${task.name}」停止失败：${err.message}`, 'error', taskId);
        }
      } else if (shared) {
        this.note(`排播「${task.name}」时段结束，但仍有其他排播在用同一任务，保持推流`, 'info', taskId);
      }
    }

    // 只有真正发生变化时才推送，避免每 10 秒刷新一次界面
    const sig = JSON.stringify([...this.active.entries()].map(([k, v]) => [k, v.end]));
    if (sig !== this._sig) {
      this._sig = sig;
      this.emit('change', this.snapshot());
    }
  }

  /** 立即按排播计划开播（不受时间表限制），minutes 分钟后自动停 */
  async runNow(taskId, minutes = 60) {
    const task = this.store.getScheduleTask(taskId);
    if (!task) throw new Error('排播不存在');
    const job = this.store.getJob(task.jobId);
    if (!job) throw new Error('关联的推流任务不存在');
    const mins = Math.max(1, Math.min(1440, Number(minutes) || 60));
    const now = Date.now();
    this.manual = this.manual || new Map();
    this.manual.set(taskId, { start: now, end: now + mins * 60000 });
    if (this.isBusy(task.jobId)) {
      this.active.set(taskId, { jobId: task.jobId, start: now, end: now + mins * 60000, manual: true });
      this.note(`「${task.name}」手动开播：任务已在推流，${mins} 分钟后将自动停止`, 'ok', taskId);
      return this.snapshot();
    }
    await this.jobs.start(task.jobId, { manual: true });
    this.active.set(taskId, { jobId: task.jobId, start: now, end: now + mins * 60000, manual: true });
    this.note(`「${task.name}」手动开播，${mins} 分钟后自动停止`, 'ok', taskId);
    return this.snapshot();
  }

  /** 立即停止某个排播（连同它带起来的推流） */
  async stopNow(taskId) {
    const task = this.store.getScheduleTask(taskId);
    if (!task) throw new Error('排播不存在');
    this.manual = this.manual || new Map();
    this.manual.delete(taskId);
    this.active.delete(taskId);
    const shared = [...this.active.values()].some((e) => e.jobId === task.jobId);
    if (!shared) await this.jobs.stop(task.jobId);
    this.note(`「${task.name}」已手动停止`, 'warn', taskId);
    return this.snapshot();
  }

  /** 清掉某任务的所有运行态（删除排播时调用） */
  forget(taskId) {
    this.active.delete(taskId);
    this.manual?.delete(taskId);
    this.retryAt.delete(taskId);
    this.lastError.delete(taskId);
  }

  snapshot() {
    const cfg = this.store.schedule;
    const now = Date.now();
    const tasks = (cfg.tasks || []).map((t) => {
      const entry = this.active.get(t.id);
      const win = activeWindow(t, now);
      const job = this.store.getJob(t.jobId);
      const runtime = job ? this.jobs.runtime(job.id) : null;
      return {
        ...t,
        jobName: job ? job.name : '',
        jobMissing: !job,
        jobStatus: runtime ? runtime.status : 'idle',
        running: Boolean(entry),
        endsAt: entry ? entry.end : 0,
        startedAt: entry ? entry.start : 0,
        manual: Boolean(entry && entry.manual),
        inWindow: Boolean(win),
        windowEnd: win ? win.end : 0,
        nextStart: nextStart(t, now),
        upcoming: upcoming(t, now, 7),
        lastError: this.lastError.get(t.id) || '',
        daysText: (t.days || []).map((d) => DOW_NAMES[d]).join('、'),
      };
    });
    return {
      enabled: Boolean(cfg.enabled),
      tasks,
      serverTime: now,
      activeCount: tasks.filter((t) => t.running).length,
    };
  }

  /** 未来 N 天的节目单（按开始时间排序） */
  agenda(days = 7) {
    const now = Date.now();
    const out = [];
    for (const t of this.store.schedule.tasks || []) {
      if (!t.enabled || !t.jobId) continue;
      for (const s of upcoming(t, now, days)) {
        out.push({ ...s, taskId: t.id, name: t.name, jobId: t.jobId, jobName: this.store.getJob(t.jobId)?.name || '' });
      }
    }
    return out.sort((a, b) => a.start - b.start);
  }
}

function clockOf(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

module.exports = {
  Scheduler, activeWindow, nextStart, upcoming, parseClock, dayStart, DOW_NAMES,
};
