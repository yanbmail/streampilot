'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const EventEmitter = require('events');
const { ensureDir, parseTime, formatDuration, urlKind, sleep } = require('./util');
const { buildTargetUrl } = require('./config');
const { parseProgress, parseProgressKV } = require('./ffmpeg');

const MAX_LOG_LINES = 500;

const ERROR_HINTS = [
  [/Connection refused/i, '目标服务器拒绝连接：请检查地址、端口，以及服务端是否允许推流'],
  [/No route to host|Network is unreachable/i, '网络不可达：请检查主机地址与网络连通性'],
  [/Name or service not known|nodename nor servname|Temporary failure in name resolution/i, '域名解析失败：请检查地址拼写或 DNS'],
  [/401 Unauthorized|403 Forbidden/i, '鉴权失败：推流密钥或账号权限不正确'],
  [/404 Not Found/i, '地址不存在：请确认 app / 流名称是否正确'],
  [/Operation not permitted|Permission denied/i, '系统权限不足：macOS 请到「系统设置 → 隐私与安全性 → 屏幕录制/摄像头/麦克风」中授权本应用'],
  [/Configuration of video device failed/i, '摄像头不支持所请求的分辨率/帧率组合：已回退为设备默认参数，若仍黑屏请检查相机权限或设备是否被占用'],
  [/avfoundation.*(Input\/output error|I\/O error)/i, '摄像头打不开：macOS 相机权限未授权，或设备正被其他程序（会议 / OBS / 微信视频）占用'],
  [/Selected pixel format .* not supported/i, '摄像头像素格式不受支持：已自动改用设备支持格式，不影响输出'],
  [/Input\/output error/i, '读写错误：macOS 相机/屏幕可能未授权或被其他程序占用；网络源则可能是地址失效或中断'],
  [/Cannot open display|Could not find video device|No such device/i, '采集设备不可用：请重新选择屏幕或摄像头设备'],
  [/Unknown encoder|Encoder .* not found/i, '编码器不可用：请在设置中更换编码器或安装完整版 FFmpeg'],
  [/Protocol not found/i, '当前 FFmpeg 不支持的协议：请安装带完整协议的 FFmpeg'],
  [/Invalid data found when processing input/i, '输入流无法解析：源地址可能已失效'],
  [/Server returned 5\d\d/i, '源服务器异常：稍后重试或更换源'],
  [/Connection timed out|timed out/i, '连接超时：源站响应过慢或网络受限'],
  [/Immediate exit requested/i, '任务被主动停止'],
  [/No space left on device/i, '磁盘空间不足'],
];

class JobManager extends EventEmitter {
  constructor({ store, ffmpeg, dataDir, hlsRoot }) {
    super();
    this.store = store;
    this.ffmpeg = ffmpeg;
    this.dataDir = dataDir;
    this.hlsRoot = hlsRoot;
    this.tmpDir = ensureDir(path.join(dataDir, 'tmp'));
    this.recordsRoot = ensureDir(path.join(dataDir, 'records'));
    this.running = new Map();
    this.history = new Map(); // jobId -> {totalBytes, restarts}
    this.logStore = new Map(); // jobId -> 日志（进程退出后仍保留，便于排错）
    this.lastState = new Map(); // jobId -> {status, lastError, outputUrl, command}
  }

  /**
   * HLS / 本地文件等容器不上报字节数，直接采样磁盘输出测算码率。
   * HLS 采用「最新分片体积 ÷ 分片时长」，避免删除旧分片导致总量恒定。
   */
  startOutputMeter(job, rt) {
    const t = job.target || {};
    const ladderOn = this.ffmpeg.ladderActive(job);
    const hlsRung = ladderOn ? (job.ladder.rungs || []).find((r) => (r.target || {}).protocol === 'hls') : null;
    const hlsDir = ladderOn
      ? (hlsRung ? path.join(this.hlsRoot, `${job.id}_${hlsRung.id}`) : '')
      : (t.protocol === 'hls' ? path.join(this.hlsRoot, job.id) : '');
    let probe = null;

    if (hlsDir) {
      const segSec = Math.max(1, Number(t.hlsSegmentSeconds) || 2);
      probe = () => {
        let total = 0;
        let newest = 0;
        let newestMtime = 0;
        try {
          for (const f of fs.readdirSync(hlsDir)) {
            if (!/\.(ts|m4s|mp4|m4v)$/i.test(f)) continue;
            try {
              const st = fs.statSync(path.join(hlsDir, f));
              total += st.size;
              if (st.mtimeMs > newestMtime) { newestMtime = st.mtimeMs; newest = st.size; }
            } catch (_) {}
          }
        } catch (_) {}
        return { bytes: total, kbps: Math.round((newest * 8) / segSec / 1000) };
      };
    } else if (t.protocol === 'file' && t.filePath && !ladderOn) {
      probe = () => {
        try { return { bytes: fs.statSync(t.filePath).size }; } catch (_) { return { bytes: 0 }; }
      };
    } else if (job.record && job.record.enabled && job.record.filePath) {
      // 多路分发（tee）/ 阶梯转码时 ffmpeg 不报总字节数，用同步录制的文件体积推算实际码流
      const recPath = job.record.filePath;
      probe = () => {
        try { return { bytes: fs.statSync(recPath).size }; } catch (_) { return { bytes: 0 }; }
      };
    }
    if (!probe) return;

    let prevBytes = 0;
    let prevTs = Date.now();
    rt.meterTimer = setInterval(() => {
      if (!this.running.has(job.id)) return;
      const { bytes, kbps } = probe();
      const now = Date.now();
      const dt = (now - prevTs) / 1000;
      let rate = kbps;
      if (!rate && dt > 0 && bytes >= prevBytes) rate = Math.round(((bytes - prevBytes) * 8) / dt / 1000);
      rt.stats = { ...rt.stats, sizeBytes: bytes, ...(rate > 0 ? { bitrateKbps: rate } : {}) };
      prevBytes = bytes;
      prevTs = now;
      this.emit('stats', { jobId: job.id, stats: rt.stats });
    }, 2000);
    if (rt.meterTimer.unref) rt.meterTimer.unref();
  }

  log(jobId, line, level = 'info') {
    const entry = { t: Date.now(), jobId, level, line };
    let arr = this.logStore.get(jobId);
    if (!arr) { arr = []; this.logStore.set(jobId, arr); }
    arr.push(entry);
    if (arr.length > MAX_LOG_LINES) arr.shift();
    const rt = this.running.get(jobId);
    if (rt) {
      rt.logs.push(entry);
      if (rt.logs.length > MAX_LOG_LINES) rt.logs.shift();
    }
    this.emit('log', entry);
  }

  /** 记录一次状态迁移，供进程退出后查询 */
  remember(jobId, patch) {
    const cur = this.lastState.get(jobId) || {};
    this.lastState.set(jobId, { ...cur, ...patch });
  }

  runtime(jobId) {
    const rt = this.running.get(jobId);
    const hist = this.history.get(jobId) || { totalBytes: 0, restarts: 0 };
    if (!rt) {
      const last = this.lastState.get(jobId) || {};
      return {
        status: last.status || 'idle', pid: null, uptimeSec: 0, bitrateKbps: 0, fps: 0,
        speed: 0, timeSec: 0, sizeBytes: 0, totalBytes: hist.totalBytes,
        restarts: hist.restarts, lastError: last.lastError || '',
        outputUrl: last.outputUrl || '', command: last.command || '',
        health: last.status === 'error' ? 'bad' : null,
        rungs: this.rungUrls(this.store.getJob(jobId) || {}),
      };
    }
    return {
      status: rt.status,
      pid: rt.proc?.pid || null,
      uptimeSec: Math.floor((Date.now() - rt.startedAt) / 1000),
      bitrateKbps: rt.stats.bitrateKbps || 0,
      fps: rt.stats.fps || 0,
      speed: rt.stats.speed || 0,
      frame: rt.stats.frame || 0,
      timeSec: rt.stats.timeSec || 0,
      sizeBytes: rt.stats.sizeBytes || 0,
      dropFrames: rt.stats.dropFrames || 0,
      totalBytes: hist.totalBytes + (rt.stats.sizeBytes || 0),
      restarts: hist.restarts,
      lastError: rt.lastError || '',
      outputUrl: rt.outputUrl,
      command: rt.command,
      startedAt: rt.startedAt,
      health: rt.health,
      recordPath: (this.store.getJob(jobId)?.record || {}).enabled
        ? (this.store.getJob(jobId)?.record || {}).filePath : '',
      rungs: this.rungUrls(this.store.getJob(jobId) || {}),
    };
  }

  /** 准备运行上下文：输出地址、HLS 目录、多文件播放列表 */
  prepare(job) {
    const warnings = [];
    const target = buildTargetUrl(job.target);
    const t = job.target;
    const ladderOn = this.ffmpeg.ladderActive(job);

    if (ladderOn) {
      // 阶梯转码下主目标不参与输出，逐个校验每一档的目标
      (job.ladder.rungs || []).forEach((r, i) => {
        const rt = r.target || {};
        const label = `第 ${i + 1} 档（${r.name}）`;
        if (['rtmp', 'rtmps', 'rtsp', 'srt', 'udp'].includes(rt.protocol)) {
          if (!rt.url && !rt.host) throw new Error(`${label}还没填推流服务器地址`);
          if (!rt.url && !rt.streamKey && !rt.app) throw new Error(`${label}还没填推流码 / 流名称`);
        }
        if (rt.protocol === 'hls') ensureDir(path.join(this.hlsRoot, `${job.id}_${r.id}`));
        if (rt.protocol === 'file') {
          if (!rt.filePath) throw new Error(`${label}还没选择保存路径`);
          ensureDir(path.dirname(rt.filePath));
        }
        if (rt.protocol === 'flv') throw new Error(`${label}不支持 HTTP-FLV 监听模式，请换成 RTMP / SRT`);
      });
      const seen = new Set();
      (job.ladder.rungs || []).forEach((r, i) => {
        const key = buildTargetUrl(r.target).url;
        if (key && seen.has(key)) warnings.push(`第 ${i + 1} 档与其他档的目标地址相同，可能会互相覆盖`);
        if (key) seen.add(key);
      });
    } else {
      if (['rtmp', 'rtmps', 'rtsp', 'srt', 'udp'].includes(t.protocol) && !t.url) {
        if (!t.host) throw new Error('请填写推流服务器地址');
        if (!t.streamKey && !t.app) throw new Error('请填写推流码 / 流名称');
      }
      if (t.protocol === 'hls') {
        ensureDir(path.join(this.hlsRoot, job.id));
      }
      if (t.protocol === 'file') {
        if (!t.filePath) throw new Error('请选择录制文件保存路径');
        ensureDir(path.dirname(t.filePath));
      }
    }
    if (job.source.type === 'file' && !fs.existsSync(job.source.path)) {
      throw new Error(`媒体文件不存在：${job.source.path}`);
    }
    if (job.source.type === 'files') {
      const list = (job.source.paths || []).filter(Boolean);
      const missing = list.filter((p) => !fs.existsSync(p));
      if (missing.length) throw new Error(`媒体文件不存在：${missing[0]}`);
    }
    if (job.source.type === 'url' && !job.source.url) throw new Error('请填写输入流地址');

    // 附加分发目标校验（阶梯模式下各档自带目标，附加目标不参与输出）
    const extras = job.targets || [];
    if (!ladderOn) {
      extras.forEach((e, i) => {
        if (e.url) return;
        if (!e.host) throw new Error(`第 ${i + 1} 个附加目标缺少服务器地址`);
        if (!e.streamKey) throw new Error(`第 ${i + 1} 个附加目标缺少推流码 / 流名称`);
      });
    }

    // 同步录制：没填路径就自动落到数据目录
    const rec = job.record || {};
    if (rec.enabled) {
      if (!rec.filePath) {
        const ext = rec.recordFormat || 'mp4';
        rec.filePath = path.join(this.recordsRoot, `${job.id}_${Date.now()}.${ext}`);
      }
      ensureDir(path.dirname(rec.filePath));
    }

    let concatFile = '';
    if (job.source.type === 'files') {
      concatFile = path.join(this.tmpDir, `${job.id}.txt`);
      const lines = (job.source.paths || []).filter(Boolean)
        .map((p) => `file '${String(p).replace(/'/g, "'\\''").replace(/\\/g, '/')}'`);
      fs.writeFileSync(concatFile, lines.join('\n'));
    }

    if (job.video.mode === 'copy' && job.target.protocol === 'rtmp' && job.video.codec === 'hevc') {
      warnings.push('RTMP 标准协议不支持 HEVC 直通，建议改用 RTMP(S) + H.264 或 SRT');
    }
    if (!ladderOn && job.video.bitrateKbps > 12000 && job.video.height >= 2160) {
      warnings.push('4K 高码率对上行带宽要求较高，建议先测速');
    }
    if (ladderOn) {
      const totalKbps = (job.ladder.rungs || []).reduce((a, r) => a + (r.bitrateKbps || 0), 0);
      const encCount = (job.ladder.rungs || []).length;
      warnings.push(`阶梯转码共 ${encCount} 档，合计约 ${(totalKbps / 1000).toFixed(1)} Mbps 编码负载，CPU 占用会比单路高`);
    }
    const caps = this.ffmpeg.caps;
    if (caps && t.protocol === 'srt' && !caps.protocols.includes('srt')) {
      throw new Error('当前 FFmpeg 未启用 SRT 支持，请安装带 libsrt 的版本');
    }

    let outputUrl = '';
    if (ladderOn) {
      // 本地 HLS 档位可直接给出播放地址，方便自测
      const hlsRung = (job.ladder.rungs || []).find((r) => r.protocol === 'hls' || (r.target || {}).protocol === 'hls');
      if (hlsRung) outputUrl = `/hls/${job.id}_${hlsRung.id}/index.m3u8`;
    } else if (t.protocol === 'hls') {
      outputUrl = `/hls/${job.id}/index.m3u8`;
    }
    if (!ladderOn && t.protocol === 'flv') {
      const ips = this.ffmpeg.localAddresses();
      const ip = ips[0]?.address || '127.0.0.1';
      outputUrl = `http://${ip}:${t.flvListenPort}/live.flv`;
    }

    return { target, concatFile, warnings, outputUrl, ladderOn, rungUrls: this.rungUrls(job) };
  }

  /** 每一档实际会推往的地址，供界面展示与排查 */
  rungUrls(job) {
    if (!this.ffmpeg.ladderActive(job)) return [];
    return (job.ladder.rungs || []).map((r) => ({
      id: r.id,
      name: r.name,
      width: r.width,
      height: r.height,
      bitrateKbps: r.bitrateKbps,
      protocol: r.target?.protocol || 'rtmp',
      url: buildTargetUrl(r.target || {}).url || '',
    }));
  }

  async start(jobId, { manual = true } = {}) {
    const job = this.store.getJob(jobId);
    if (!job) throw new Error('任务不存在');
    if (this.running.has(jobId) && ['running', 'starting', 'reconnecting'].includes(this.running.get(jobId).status)) {
      return this.runtime(jobId);
    }
    const prep = this.prepare(job);
    const warnings = [...prep.warnings];
    const ctx = {
      target: prep.target,
      concatFile: prep.concatFile,
      hlsRoot: this.hlsRoot,
      warn: (msg) => warnings.push(msg),
    };
    const args = this.ffmpeg.buildStreamArgs(job, ctx);
    const command = `${this.ffmpeg.bin} ${args.map(quoteArg).join(' ')}`;

    const rt = {
      proc: null,
      status: 'starting',
      startedAt: Date.now(),
      stats: {},
      logs: [],
      lastError: '',
      command,
      outputUrl: prep.outputUrl,
      stopping: false,
      restarts: 0,
      health: 'ok',
    };
    this.running.set(jobId, rt);
    this.startOutputMeter(job, rt);
    warnings.forEach((w) => this.log(jobId, `提示：${w}`, 'warn'));
    const extraCount = (job.targets || []).filter((x) => x.url || x.host).length;
    const recOn = Boolean(job.record && job.record.enabled && job.record.filePath);
    const fanCount = extraCount + (recOn ? 1 : 0);
    if (prep.ladderOn) {
      const urls = prep.rungUrls;
      this.log(jobId, `启动阶梯转码 → 一次解码输出 ${urls.length} 档`, 'ok');
      urls.forEach((r) => this.log(jobId, `  ${r.name} ${r.width}×${r.height} ${r.bitrateKbps}kbps → ${r.url || '(未设置)'}`));
      if (recOn) this.log(jobId, `同步录制（跟随第 1 档）→ ${job.record.filePath}`, 'ok');
    } else {
      this.log(jobId, `启动推流 → ${prep.target.url || '(本地 HLS)'}${fanCount ? `（同一份编码分发 ${fanCount + 1} 路）` : ''}`);
      if (recOn) this.log(jobId, `同步录制 → ${job.record.filePath}`, 'ok');
      if (extraCount) {
        this.log(jobId, `附加目标：${(job.targets || []).filter((x) => x.url || x.host)
          .map((x) => `${x.protocol}://${x.host || '-'}/${[x.app, x.streamKey].filter(Boolean).join('/')}`).join(' , ')}`);
      }
    }
    this.emit('state', { jobId, status: 'starting' });

    const proc = spawn(this.ffmpeg.bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    rt.proc = proc;

    // 本地采集（摄像头/屏幕）如果被系统拒权或被别的程序占用，FFmpeg 会开着进程却永远不吐帧：
    // 界面上就成了「推流中」但 0 帧、没有输出文件，用户完全看不出问题。这里做一次兜底体检。
    if (job.source.type === 'camera' || job.source.type === 'screen') {
      const warmup = setTimeout(() => {
        if (rt.stopping || !this.running.has(jobId)) return;
        const st = rt.stats || {};
        if ((st.frame || 0) > 0 || (st.sizeBytes || 0) > 0) return;
        const what = job.source.type === 'camera' ? '摄像头' : '屏幕';
        const why = rt.lastError || `20 秒内没有拿到任何画面`;
        rt.lastError = `${what}没有输出画面：${why}`;
        this.log(jobId, `诊断：${rt.lastError}`, 'error');
        this.log(jobId, `排查建议：macOS 到「系统设置 → 隐私与安全性 → ${job.source.type === 'camera' ? '相机' : '屏幕录制'}」勾选运行 StreamPilot 的应用（终端/iTerm）并重启它；确认${what}没有被其他软件占用（会议、OBS、微信视频等）。`, 'warn');
        this.emit('state', { jobId, status: 'error', error: rt.lastError });
        this.stop(jobId).catch(() => {});
      }, 20000);
      rt.warmupTimer = warmup;
      proc.once('exit', () => clearTimeout(warmup));
    }

    const handleChunk = (buf) => {
      const text = buf.toString();
      for (const raw of text.split(/\r?\n|\r/)) {
        const line = raw.trim();
        if (!line) continue;
        const stats = parseProgress(line);
        if (stats) {
          rt.stats = { ...rt.stats, ...stats };
          // ffmpeg 对部分容器（如 HLS）不报 bitrate，用字节增量自行测算
          const now = Date.now();
          if (!stats.bitrateKbps && stats.sizeBytes) {
            const prev = rt.rateMeter || { t: now, bytes: 0 };
            const dt = (now - prev.t) / 1000;
            if (dt >= 0.9) {
              const kbps = Math.round(((stats.sizeBytes - prev.bytes) * 8) / dt / 1000);
              if (kbps > 0) rt.stats.bitrateKbps = kbps;
              rt.rateMeter = { t: now, bytes: stats.sizeBytes };
            }
          } else if (stats.sizeBytes) {
            rt.rateMeter = { t: now, bytes: stats.sizeBytes };
          }
          rt.status = 'running';
          this.emit('stats', { jobId, stats: rt.stats });
          continue;
        }
        // HLS 分片写入的例行日志不进入任务日志，避免刷屏
        if (/^\[hls @ .*\] Opening .* for writing$/.test(line)) continue;
        this.log(jobId, line, classifyLog(line));
        // 这类提示属于正常的重连/清单刷新，不算错误
        if (/Will reconnect|error=End of file|Connection reset by peer/i.test(line)) continue;
        if (/error|failed|invalid|unable|cannot|refused|denied/i.test(line)) {
          const hint = ERROR_HINTS.find(([re]) => re.test(line));
          if (hint) { rt.lastError = hint[1]; this.log(jobId, `诊断：${hint[1]}`, 'error'); }
          else if (!rt.lastError) rt.lastError = line.slice(0, 200);
          rt.health = 'warn';
        }
      }
    };
    // stdout：-progress 机器可读指标
    let kv = {};
    const handleProgress = (buf) => {
      for (const raw of buf.toString().split(/\r?\n|\r/)) {
        const line = raw.trim();
        if (!line) continue;
        const part = parseProgressKV(line);
        if (part) {
          Object.assign(kv, part);
          if (part.progress) {
            rt.stats = { ...rt.stats, ...kv };
            kv = {};
            rt.status = 'running';
            this.emit('stats', { jobId, stats: rt.stats });
          }
        } else if (!/^[a-z_0-9]+=/.test(line)) {
          // 极少数情况下 stdout 混入日志；已知但无需处理的键值行直接忽略
          this.log(jobId, line, classifyLog(line));
        }
      }
    };
    proc.stdout.on('data', handleProgress);
    proc.stderr.on('data', handleChunk);

    proc.on('spawn', () => {
      rt.status = 'running';
      this.remember(jobId, { status: 'running', lastError: '', outputUrl: rt.outputUrl, command: rt.command });
      this.log(jobId, `FFmpeg 进程已启动 (pid ${proc.pid})`, 'ok');
      this.emit('state', { jobId, status: 'running' });
    });

    proc.on('error', (err) => {
      rt.lastError = `无法启动 FFmpeg：${err.message}`;
      this.log(jobId, rt.lastError, 'error');
      this.emit('state', { jobId, status: 'error' });
    });

    proc.on('exit', (code, signal) => {
      if (rt.meterTimer) { clearInterval(rt.meterTimer); rt.meterTimer = null; }
      const hist = this.history.get(jobId) || { totalBytes: 0, restarts: 0 };
      hist.totalBytes += rt.stats.sizeBytes || 0;
      this.history.set(jobId, hist);
      const wasRunning = rt.status === 'running' || rt.status === 'starting';
      this.running.delete(jobId);

      if (rt.stopping) {
        this.log(jobId, '推流已停止', 'ok');
        this.remember(jobId, { status: 'stopped', lastError: '' });
        this.emit('state', { jobId, status: 'stopped' });
        return;
      }
      // 摄像头/屏幕一帧都没出就退出了 —— 基本是系统没授权或设备被占用，重试再多次也没用，
      // 直接报错并给出排查路径，比无限重连更有用。
      const localCapture = job.source.type === 'camera' || job.source.type === 'screen';
      const produced = (rt.stats.frame || 0) > 0 || (rt.stats.sizeBytes || 0) > 0;
      if (wasRunning && localCapture && !produced) {
        const what = job.source.type === 'camera' ? '摄像头' : '屏幕';
        rt.lastError = rt.lastError || `${what}打不开`;
        this.log(jobId, `诊断：${rt.lastError}`, 'error');
        this.log(jobId, `排查建议：macOS 打开「系统设置 → 隐私与安全性 → ${job.source.type === 'camera' ? '相机' : '屏幕录制'}」，勾选运行 StreamPilot 的程序（终端 / iTerm / WorkBuddy），改完要退出并重新打开它；同时确认${what}没有被会议、OBS、微信视频等占用。`, 'warn');
        this.remember(jobId, { status: 'error', lastError: rt.lastError });
        this.emit('state', { jobId, status: 'error', error: rt.lastError });
        return;
      }
      if (wasRunning && job.advanced.reconnect && (job.advanced.maxReconnect === 0 || rt.restarts < job.advanced.maxReconnect)) {
        rt.restarts += 1;
        hist.restarts += 1;
        this.history.set(jobId, hist);
        const delay = Math.min(30, job.advanced.reconnectDelaySec * Math.max(1, rt.restarts));
        this.log(jobId, `推流中断 (exit ${code ?? signal})，${delay}s 后第 ${rt.restarts} 次自动重连`, 'warn');
        this.remember(jobId, { status: 'reconnecting', lastError: rt.lastError || '' });
        this.emit('state', { jobId, status: 'reconnecting', restarts: rt.restarts });
        this.scheduleReconnect(jobId, delay, rt.restarts);
        return;
      }
      this.log(jobId, `推流结束 (exit ${code ?? signal})`, code === 0 ? 'ok' : 'error');
      this.remember(jobId, { status: code === 0 ? 'stopped' : 'error', lastError: rt.lastError || `FFmpeg 退出码 ${code ?? signal}` });
      this.emit('state', { jobId, status: code === 0 ? 'stopped' : 'error', error: rt.lastError });
    });

    return this.runtime(jobId);
  }

  scheduleReconnect(jobId, delaySec, attempt) {
    const timer = setTimeout(async () => {
      if (!this.store.getJob(jobId)) return;
      const pending = this.running.get(jobId);
      if (pending?.stopping) return;
      // 保留重连计数，避免无限叠加
      const prevRestarts = attempt;
      try {
        await this.start(jobId, { manual: false });
        const rt = this.running.get(jobId);
        if (rt) {
          rt.restarts = prevRestarts;
          const hist = this.history.get(jobId) || { totalBytes: 0, restarts: 0 };
          hist.restarts = prevRestarts;
          this.history.set(jobId, hist);
        }
      } catch (err) {
        this.log(jobId, `重连失败：${err.message}`, 'error');
        if (delaySec < 30) this.scheduleReconnect(jobId, delaySec * 2, attempt + 1);
        else this.emit('state', { jobId, status: 'error', error: err.message });
      }
    }, delaySec * 1000);
    timer.unref?.();
  }

  async stop(jobId) {
    const rt = this.running.get(jobId);
    if (!rt) {
      this.emit('state', { jobId, status: 'stopped' });
      return { ok: true };
    }
    rt.stopping = true;
    rt.status = 'stopping';
    this.emit('state', { jobId, status: 'stopping' });
    const proc = rt.proc;
    if (!proc) { this.running.delete(jobId); return { ok: true }; }

    if (process.platform === 'win32') {
      try { spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F']); } catch (_) {}
    } else {
      try { proc.kill('SIGTERM'); } catch (_) {}
    }
    // 给它 4 秒优雅退出，否则强杀
    for (let i = 0; i < 20; i++) {
      if (!this.running.has(jobId)) return { ok: true };
      await sleep(200);
    }
    try { proc.kill('SIGKILL'); } catch (_) {}
    this.running.delete(jobId);
    this.log(jobId, '进程已强制结束', 'warn');
    this.emit('state', { jobId, status: 'stopped' });
    return { ok: true };
  }

  async restart(jobId) {
    await this.stop(jobId);
    await sleep(400);
    return this.start(jobId);
  }

  async stopAll() {
    const ids = [...this.running.keys()];
    await Promise.all(ids.map((id) => this.stop(id)));
  }

  async autoStartAll() {
    const jobs = this.store.config.jobs.filter((j) => j.autoStart);
    for (const j of jobs) {
      try { await this.start(j.id); } catch (err) { this.log(j.id, `自动启动失败：${err.message}`, 'error'); }
    }
  }

  getLogs(jobId, limit = 300) {
    return (this.logStore.get(jobId) || []).slice(-limit);
  }

  snapshot() {
    const out = {};
    for (const job of this.store.config.jobs) out[job.id] = this.runtime(job.id);
    return out;
  }
}

function classifyLog(line) {
  if (/Will reconnect|error=End of file/i.test(line)) return 'warn';
  if (/error|failed|invalid|unable|cannot|refused|denied|no such/i.test(line)) return 'error';
  if (/warn|deprecated|guessed|assuming/i.test(line)) return 'warn';
  return 'info';
}

function quoteArg(a) {
  const s = String(a);
  if (/^[\w@%+=:,./-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

module.exports = { JobManager, ERROR_HINTS };
