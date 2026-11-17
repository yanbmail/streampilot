'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileP, ensureDir, parseSize, urlKind, clamp } = require('./util');
const { buildTargetUrl } = require('./config');

const IS_MAC = process.platform === 'darwin';
const IS_WIN = process.platform === 'win32';

const ENCODER_LABELS = {
  libx264: 'H.264 · x264 软件编码（画质优先）',
  h264_videotoolbox: 'H.264 · VideoToolbox 硬件编码（低占用）',
  libx265: 'H.265 · x265 软件编码（省带宽）',
  hevc_videotoolbox: 'H.265 · VideoToolbox 硬件编码',
};

const FALLBACK_PATHS = IS_WIN
  ? ['C:\\ffmpeg\\bin\\ffmpeg.exe', 'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe']
  : ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg', '/snap/bin/ffmpeg'];

class FFmpegService {
  constructor() {
    this.caps = null;
    this.bin = 'ffmpeg';
    this.probeBin = 'ffprobe';
  }

  /** 依次尝试：设置项 → 环境变量 → PATH → 常见安装路径 */
  async resolve(settings = {}) {
    const candidates = [];
    if (settings.ffmpegPath) candidates.push(settings.ffmpegPath);
    if (process.env.FFMPEG_PATH) candidates.push(process.env.FFMPEG_PATH);
    candidates.push(IS_WIN ? 'ffmpeg.exe' : 'ffmpeg');
    candidates.push(...FALLBACK_PATHS);

    for (const c of candidates) {
      if (!c) continue;
      const r = await execFileP(c, ['-hide_banner', '-version'], { timeout: 8000 });
      if (r.ok && /ffmpeg version/i.test(r.stdout + r.stderr)) {
        this.bin = c;
        this.probeBin = settings.ffprobePath
          || c.replace(/ffmpeg(\.exe)?$/i, IS_WIN ? 'ffprobe.exe' : 'ffprobe');
        if (!fs.existsSync(this.probeBin)) {
          const alt = c.replace(/-ffmpeg(\.exe)?$/i, '');
          if (alt !== c) this.probeBin = alt;
        }
        return { ok: true, path: c, ffprobe: this.probeBin };
      }
    }
    return { ok: false, path: '', ffprobe: '' };
  }

  async probeCapabilities(force = false) {
    if (this.caps && !force) return this.caps;
    const [ver, protocols, encoders, filters] = await Promise.all([
      execFileP(this.bin, ['-hide_banner', '-version']),
      execFileP(this.bin, ['-hide_banner', '-protocols']),
      execFileP(this.bin, ['-hide_banner', '-encoders']),
      execFileP(this.bin, ['-hide_banner', '-filters']),
    ]);
    const versionLine = (ver.stdout + ver.stderr).split('\n').find((l) => /ffmpeg version/i.test(l)) || '';
    const protoList = (protocols.stdout + protocols.stderr)
      .split('\n').filter((l) => /^\s{1,4}\S/.test(l))
      .join(' ').split(/\s+/).filter(Boolean);
    const encList = (encoders.stdout + encoders.stderr)
      .split('\n').filter((l) => /^ [VAS][.FS][.X][.B][.D]/.test(l))
      .map((l) => l.trim().split(/\s+/)[1])
      .filter(Boolean);
    const filterList = (filters.stdout + filters.stderr)
      .split('\n').filter((l) => /^ [T.][S.][C.] /.test(l))
      .map((l) => l.trim().split(/\s+/)[1])
      .filter(Boolean);
    this.caps = {
      version: versionLine.replace(/^ffmpeg version\s*/i, '').split(' ')[0] || 'unknown',
      versionLine,
      protocols: [...new Set(protoList)].sort(),
      encoders: [...new Set(encList)].sort(),
      filters: [...new Set(filterList)].sort(),
      platform: process.platform,
    };
    return this.caps;
  }

  hasEncoder(name) {
    return !this.caps || this.caps.encoders.includes(name);
  }

  /** 选择可用编码器，失败时降级 */
  resolveEncoder(video) {
    const want = video.encoder;
    if (this.hasEncoder(want)) return { encoder: want, fallback: false };
    const chain = video.codec === 'hevc'
      ? ['libx265', 'hevc_videotoolbox', 'libx264', 'h264_videotoolbox']
      : ['libx264', 'h264_videotoolbox'];
    for (const c of chain) if (this.hasEncoder(c)) return { encoder: c, fallback: true, original: want };
    return { encoder: 'libx264', fallback: true, original: want };
  }

  /** 探测媒体信息（本地文件或网络流） */
  async probeMedia(target, opts = {}) {
    if (!target) return { ok: false, error: '地址为空' };
    const args = ['-hide_banner', '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams'];
    const kind = urlKind(target);
    if (opts.userAgent) args.push('-user_agent', opts.userAgent);
    if (opts.headers) args.push('-headers', String(opts.headers).replace(/\n/g, '\r\n'));
    if (kind === 'rtsp') args.push('-rtsp_transport', 'tcp');
    if (['http', 'hls', 'flv', 'rtsp', 'rtmp', 'srt'].includes(kind)) {
      args.push('-rw_timeout', '12000000');
    }
    args.push('-i', target);
    const r = await execFileP(this.probeBin, args, { timeout: opts.timeout || 20000 });
    const raw = (r.stdout || '').trim();
    if (!raw) return { ok: false, error: (r.stderr || '探测失败').split('\n').slice(-4).join('\n') };
    let json;
    try { json = JSON.parse(raw); } catch (_) { return { ok: false, error: '解析探测结果失败' }; }
    const v = (json.streams || []).find((s) => s.codec_type === 'video');
    const a = (json.streams || []).find((s) => s.codec_type === 'audio');
    const fpsRaw = v?.avg_frame_rate || v?.r_frame_rate || '0/1';
    const [n, d] = String(fpsRaw).split('/').map(Number);
    const fps = d ? n / d : Number(fpsRaw) || 0;
    return {
      ok: true,
      duration: Number(json.format?.duration) || 0,
      bitrate: Number(json.format?.bit_rate) || 0,
      format: json.format?.format_name || '',
      size: Number(json.format?.size) || 0,
      video: v ? {
        codec: v.codec_name, width: v.width, height: v.height,
        fps: Math.round(fps * 100) / 100, pixFmt: v.pix_fmt, bitrate: Number(v.bit_rate) || 0,
        profile: v.profile,
      } : null,
      audio: a ? {
        codec: a.codec_name, channels: a.channels, sampleRate: Number(a.sample_rate) || 0,
        bitrate: Number(a.bit_rate) || 0,
      } : null,
    };
  }

  /** 扫描可用采集设备 */
  async listDevices() {
    if (IS_MAC) {
      const r = await execFileP(this.bin, ['-hide_banner', '-f', 'avfoundation', '-list_devices', 'true', '-i', ''], { timeout: 12000 });
      const text = r.stdout + r.stderr;
      const video = [];
      const audio = [];
      let section = '';
      for (const line of text.split('\n')) {
        if (/AVFoundation video devices/i.test(line)) { section = 'video'; continue; }
        if (/AVFoundation audio devices/i.test(line)) { section = 'audio'; continue; }
        const m = /\[(\d+)\]\s+(.+?)\s*$/.exec(line);
        if (!m) continue;
        const item = { index: Number(m[1]), name: m[2], id: `${m[1]}` };
        if (section === 'video') video.push(item);
        else if (section === 'audio') audio.push(item);
      }
      return { platform: 'darwin', screen: video.filter((d) => /capture screen/i.test(d.name)), video, audio };
    }
    if (IS_WIN) {
      const r = await execFileP(this.bin, ['-hide_banner', '-f', 'dshow', '-list_devices', 'true', '-i', 'dummy'], { timeout: 12000 });
      const text = r.stdout + r.stderr;
      const video = [];
      const audio = [];
      let section = '';
      for (const line of text.split('\n')) {
        if (/DirectShow video devices/i.test(line)) { section = 'video'; continue; }
        if (/DirectShow audio devices/i.test(line)) { section = 'audio'; continue; }
        const m = /"([^"]+)"/.exec(line);
        if (!m) continue;
        const item = { index: video.length + audio.length, name: m[1], id: m[1] };
        if (section === 'video') video.push(item);
        else if (section === 'audio') audio.push(item);
      }
      return { platform: 'win32', screen: [{ index: 0, name: '整个桌面', id: 'desktop' }], video, audio };
    }
    return {
      platform: 'linux',
      screen: [{ index: 0, name: '主显示器 (:0.0)', id: ':0.0' }],
      video: [],
      audio: [],
    };
  }

  /** 构建输入参数 */
  buildInput(job, ctx) {
    const s = job.source;
    const adv = job.advanced;
    const pre = ['-nostdin', '-hide_banner', '-loglevel', adv.logLevel || 'info',
      '-stats_period', '0.5', '-progress', 'pipe:1', '-nostats'];
    const input = [];
    const filterPrefix = [];
    let audioFromLavfi = false;

    const queue = (n = adv.threadQueue || 512) => input.push('-thread_queue_size', String(n));

    switch (s.type) {
      case 'file': {
        if (!s.path) throw new Error('未选择媒体文件');
        if (s.loop) input.push('-stream_loop', '-1');
        if (adv.realtime) input.push('-re');
        input.push('-i', s.path);
        break;
      }
      case 'files': {
        const list = (s.paths || []).filter(Boolean);
        if (!list.length) throw new Error('未选择媒体文件');
        if (!ctx.concatFile) throw new Error('播放列表未准备完成');
        if (s.loop) input.push('-stream_loop', '-1');
        if (adv.realtime) input.push('-re');
        input.push('-f', 'concat', '-safe', '0', '-i', ctx.concatFile);
        break;
      }
      case 'screen': {
        const sc = s.screen;
        const fps = clamp(sc.fps, 1, 120, 30);
        queue();
        if (IS_MAC) {
          input.push('-f', 'avfoundation', '-capture_cursor', sc.cursor ? '1' : '0',
            '-capture_mouse_clicks', '1', '-framerate', String(fps),
            '-pixel_format', 'uyvy422', '-i', `${sc.display || 0}:none`);
          if (sc.width > 0 && sc.height > 0) {
            filterPrefix.push(`crop=${sc.width}:${sc.height}:${sc.x || 0}:${sc.y || 0}`);
          }
        } else if (IS_WIN) {
          input.push('-f', 'gdigrab', '-draw_mouse', sc.cursor ? '1' : '0', '-framerate', String(fps));
          if (sc.width > 0 && sc.height > 0) {
            input.push('-offset_x', String(sc.x || 0), '-offset_y', String(sc.y || 0),
              '-video_size', `${sc.width}x${sc.height}`);
          }
          input.push('-i', 'desktop');
        } else {
          input.push('-f', 'x11grab', '-draw_mouse', sc.cursor ? '1' : '0', '-framerate', String(fps));
          if (sc.width > 0 && sc.height > 0) {
            input.push('-video_size', `${sc.width}x${sc.height}`, '-i', `:0.0+${sc.x || 0},${sc.y || 0}`);
          } else {
            input.push('-i', ':0.0');
          }
        }
        break;
      }
      case 'camera': {
        const c = s.camera;
        queue(256);
        if (IS_MAC) {
          input.push('-f', 'avfoundation', '-framerate', String(c.fps));
          if (c.width && c.height) input.push('-video_size', `${c.width}x${c.height}`);
          const vIdx = c.videoDevice || '0';
          const aIdx = c.audioDevice ? c.audioDevice : 'none';
          input.push('-i', `${vIdx}:${aIdx}`);
        } else if (IS_WIN) {
          const dev = `video=${c.videoDevice || 'none'}`;
          input.push('-f', 'dshow', '-i', c.audioDevice ? `${dev}:audio=${c.audioDevice}` : dev);
        } else {
          input.push('-f', 'v4l2', '-i', c.videoDevice || '/dev/video0');
        }
        break;
      }
      case 'url': {
        const u = String(s.url || '').trim();
        if (!u) throw new Error('未填写流地址');
        const kind = urlKind(u);
        queue(1024);
        if (s.userAgent) input.push('-user_agent', s.userAgent);
        if (s.headers) input.push('-headers', String(s.headers).replace(/\n/g, '\r\n'));
        if (kind === 'rtsp') {
          input.push('-rtsp_transport', 'tcp', '-rtsp_flags', 'prefer_tcp');
        } else if (kind === 'udp') {
          input.push('-buffer_size', '4194304', '-f', 'mpegts');
        } else if (kind === 'srt') {
          input.push('-f', 'mpegts');
        } else if (kind === 'hls') {
          // HLS 自带播放列表刷新与重试；加 reconnect_at_eof 会让主清单反复重连、卡在探测阶段
          if (adv.inputReconnect) {
            input.push('-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '8');
          }
          // 限制探测窗口，避免多码率主清单把每个分支都探一遍（起播慢）
          input.push('-probesize', '5000000', '-analyzeduration', '5000000');
        } else if (['http', 'flv'].includes(kind)) {
          if (adv.inputReconnect) {
            input.push('-reconnect', '1', '-reconnect_streamed', '1',
              '-reconnect_delay_max', '8', '-reconnect_at_eof', '1');
          }
        }
        // rtmp/rtmps 由 librtmp 自行处理断线，不接受 -reconnect 系列参数（会直接报 Option not found）
        if (kind === 'rtmp' || kind === 'rtmps') {
          input.push('-rtmp_live', 'live');
        }
        if (kind !== 'udp' && kind !== 'srt') input.push('-rw_timeout', '15000000');
        if (adv.copyTimestamps) input.push('-copyts');
        input.push('-i', u);
        break;
      }
      case 'test':
      default: {
        const w = job.video.width || 1920;
        const h = job.video.height || 1080;
        const fps = job.video.fps || 30;
        const pattern = s.testPattern || 'testsrc2';
        if (adv.realtime) input.push('-re');
        input.push('-f', 'lavfi', '-i', `${pattern}=size=${w}x${h}:rate=${fps}`);
        audioFromLavfi = true;
        break;
      }
    }
    return { args: [...pre, ...input], filterPrefix, audioFromLavfi };
  }

  /** 缩放/补边滤镜链：fit 等比加黑边、cover 填满裁剪、stretch 拉伸 */
  scaleFilters(width, height, fps, scaling = 'fit') {
    const W = width || 1920;
    const H = height || 1080;
    const vf = [];
    if (scaling === 'cover') {
      vf.push(`scale=${W}:${H}:force_original_aspect_ratio=increase:flags=bicubic`, `crop=${W}:${H}`);
    } else if (scaling === 'stretch') {
      vf.push(`scale=${W}:${H}:flags=bicubic`);
    } else {
      vf.push(`scale=${W}:${H}:force_original_aspect_ratio=decrease:flags=bicubic`,
        `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black`);
    }
    vf.push('setsar=1', `fps=${fps || 30}`, 'format=yuv420p');
    return vf.join(',');
  }

  /**
   * 视频编码参数（不含滤镜与容器）。
   * v 既可以是 job.video，也可以是阶梯里的某一档，结构一致。
   */
  videoEncodeArgs(v, ctx = {}) {
    const args = [];
    const gop = Math.max(1, Math.round((v.fps || 30) * (v.gopSeconds || 2)));

    if (v.mode === 'copy') {
      args.push('-c:v', 'copy');
      if (ctx.filterPrefix?.length && ctx.warn) ctx.warn('直通模式下画面裁剪/缩放参数将被忽略');
      return args;
    }

    const enc = this.resolveEncoder(v);
    if (enc.fallback && ctx.warn) ctx.warn(`编码器 ${enc.original} 不可用，已自动切换为 ${enc.encoder}`);
    if (enc.encoder === 'libx264' || enc.encoder === 'libx265') {
      const preset = v.preset || 'veryfast';
      args.push('-c:v', enc.encoder, '-preset', preset);
      if (enc.encoder === 'libx264') {
        args.push('-tune', 'zerolatency', '-profile:v', v.profile || 'high', '-pix_fmt', 'yuv420p');
      }
      const maxr = v.maxBitrateKbps > 0 ? v.maxBitrateKbps : Math.round(v.bitrateKbps * 1.15);
      if (v.rateControl === 'crf') {
        args.push('-crf', String(v.crf), '-maxrate', `${maxr}k`, '-bufsize', `${maxr * 2}k`);
      } else if (v.rateControl === 'vbr') {
        args.push('-b:v', `${v.bitrateKbps}k`, '-maxrate', `${maxr}k`, '-bufsize', `${v.bitrateKbps * 2}k`);
      } else {
        args.push('-b:v', `${v.bitrateKbps}k`, '-minrate', `${v.bitrateKbps}k`,
          '-maxrate', `${v.bitrateKbps}k`, '-bufsize', `${v.bitrateKbps * 2}k`);
      }
      if (enc.encoder === 'libx264') {
        const params = [`keyint=${gop}`, `min-keyint=${gop}`, 'scenecut=0', 'force-cfr=1'];
        if (v.rateControl === 'cbr') params.push('nal-hrd=cbr');
        args.push('-x264-params', params.join(':'));
      } else {
        const params = [`keyint=${gop}`, `min-keyint=${gop}`, 'scenecut=0'];
        if (v.rateControl === 'cbr') params.push('nal-hrd=cbr', `vbv-maxrate=${v.bitrateKbps}`, `vbv-bufsize=${v.bitrateKbps * 2}`);
        args.push('-x265-params', params.join(':'), '-tag:v', 'hvc1');
      }
    } else {
      const hw = enc.encoder.includes('videotoolbox');
      args.push('-c:v', enc.encoder, '-pix_fmt', 'yuv420p');
      args.push('-b:v', `${v.bitrateKbps}k`);
      if (hw) {
        args.push('-maxrate', `${v.maxBitrateKbps || v.bitrateKbps}k`,
          '-bufsize', `${(v.maxBitrateKbps || v.bitrateKbps) * 2}k`,
          '-realtime', '1', '-prio_speed', '1');
        if (enc.encoder === 'h264_videotoolbox') args.push('-profile:v', v.profile || 'high');
        if (enc.encoder === 'hevc_videotoolbox') args.push('-tag:v', 'hvc1');
      }
    }
    args.push('-g', String(gop), '-keyint_min', String(gop), '-sc_threshold', '0');
    return args;
  }

  /** 音频编码参数 */
  audioEncodeArgs(a, audioFromLavfi = false) {
    if (a.mode === 'none') return ['-an'];
    if (a.mode === 'copy') return audioFromLavfi ? ['-c:a', 'copy', '-c:a', 'aac'] : ['-c:a', 'copy'];
    const codec = a.codec === 'opus' ? 'libopus' : a.codec === 'mp3' ? 'libmp3lame' : a.codec === 'ac3' ? 'ac3' : 'aac';
    return ['-c:a', codec, '-b:a', `${a.bitrateKbps}k`, '-ar', String(a.sampleRate), '-ac', String(a.channels)];
  }

  /** 构建输出编码参数 */
  buildOutput(job, ctx) {
    const v = job.video;
    const a = job.audio;
    const t = job.target;
    const adv = job.advanced;
    const args = [];
    args.push(...this.videoEncodeArgs(v, ctx));


    // 视频滤镜
    const vf = [];
    if (ctx.filterPrefix.length) vf.push(...ctx.filterPrefix);
    if (v.mode !== 'copy') vf.push(this.scaleFilters(v.width, v.height, v.fps, v.scaling));
    if (vf.length) args.push('-vf', vf.join(','));

    // 音频
    args.push(...this.audioEncodeArgs(a, ctx.audioFromLavfi));

    // 输出容器
    const tgt = ctx.target;
    args.push('-max_muxing_queue_size', '1024');

    // 多路分发 / 同步录制：用 tee 复用同一份编码，避免重复转码
    const fanout = this.buildFanout(job, ctx);
    if (fanout) {
      // tee 无法回写文件头，必须内联 extradata，否则 mkv/mp4 会报 Invalid data
      args.push('-flags', '+global_header');
      if (adv.extraOutputArgs) args.push(...String(adv.extraOutputArgs).split(/\s+/).filter(Boolean));
      args.push('-f', 'tee', fanout);
      return args;
    }

    if (tgt.muxer === 'flv') {
      args.push('-f', 'flv', ...(tgt.extra || []));
    } else if (tgt.muxer === 'rtsp') {
      args.push('-f', 'rtsp', ...(tgt.extra || []));
    } else if (tgt.muxer === 'mpegts') {
      args.push('-f', 'mpegts', '-mpegts_flags', '+resend_headers');
    } else if (tgt.muxer === 'hls') {
      const dir = this.prepareHlsDir(job, ctx);
      args.push('-f', 'hls',
        '-hls_time', String(t.hlsSegmentSeconds || 2),
        '-hls_list_size', String(t.hlsListSize || 6),
        '-hls_flags', 'delete_segments+append_list+omit_endlist+temp_file',
        '-hls_segment_type', 'mpegts',
        '-hls_segment_filename', path.join(dir, 'seg_%06d.ts'));
      if (adv.extraOutputArgs) args.push(...String(adv.extraOutputArgs).split(/\s+/).filter(Boolean));
      args.push(path.join(dir, 'index.m3u8'));
      return args;
    } else if (!tgt.muxer) {
      // 录制文件：按扩展名推断容器，未识别时退回 matroska
      const ext = path.extname(tgt.url || '').toLowerCase();
      if (ext === '.mp4') args.push('-f', 'mp4', '-movflags', '+faststart');
      else if (ext === '.mkv') args.push('-f', 'matroska');
      else if (ext === '.ts') args.push('-f', 'mpegts');
      else args.push('-f', 'matroska');
    } else {
      args.push('-f', tgt.muxer);
    }

    if (adv.extraOutputArgs) args.push(...String(adv.extraOutputArgs).split(/\s+/).filter(Boolean));
    args.push(tgt.url || '-');
    return args;
  }

  /** 清空并返回本任务的 HLS 输出目录（suffix 用于阶梯转码按档分目录） */
  prepareHlsDir(job, ctx, suffix = '') {
    const dir = ensureDir(path.join(ctx.hlsRoot, `${job.id}${suffix}`));
    for (const f of fs.readdirSync(dir)) {
      if (/\.(ts|m4s|mp4|m3u8|tmp)$/.test(f)) { try { fs.unlinkSync(path.join(dir, f)); } catch (_) {} }
    }
    return dir;
  }

  /** 单个目标 → tee 的 slave 片段：[格式:选项]地址 */
  slaveSpec(spec, { ignore = false, hlsTime = 2, hlsList = 6 } = {}) {
    const opts = [];
    const muxer = spec.muxer || 'matroska';
    opts.push(`f=${muxer}`);
    if (ignore) opts.push('onfail=ignore');

    if (muxer === 'flv') {
      opts.push('flvflags=no_duration_filesize');
    } else if (muxer === 'mpegts') {
      opts.push('mpegts_flags=+resend_headers');
    } else if (muxer === 'rtsp') {
      opts.push('rtsp_transport=tcp', 'muxdelay=0.1');
    } else if (muxer === 'mp4' || muxer === 'mov') {
      opts.push('movflags=+faststart');
    } else if (muxer === 'hls') {
      opts.push(`hls_time=${hlsTime}`, `hls_list_size=${hlsList}`,
        'hls_flags=delete_segments+append_list+omit_endlist');
    }
    return `[${opts.join(':')}]${spec.url}`;
  }

  /**
   * 多路分发 + 同步录制。
   * 返回 tee 目标串；没有附加目标也没开录制时返回空。
   * 用 tee 的好处：只编码一次，N 个平台共用一份码流，CPU 占用与单路接近。
   */
  buildFanout(job, ctx) {
    const extras = (job.targets || []);
    const rec = job.record || {};
    const doRecord = Boolean(rec.enabled && rec.filePath);
    if (!extras.length && !doRecord) return null;

    const main = ctx.target;
    // HTTP-FLV 监听靠 -listen 协议参数，tee 无法承载，退回单路
    if (main.listen) {
      ctx.warn('HTTP-FLV 监听模式不支持多路分发/同步录制，已按单路输出');
      return null;
    }

    const t = job.target;
    const slaves = [];
    if (main.muxer === 'hls') {
      const dir = this.prepareHlsDir(job, ctx);
      slaves.push(this.slaveSpec(
        { muxer: 'hls', url: path.join(dir, 'index.m3u8') },
        { hlsTime: t.hlsSegmentSeconds || 2, hlsList: t.hlsListSize || 6 },
      ));
    } else {
      slaves.push(this.slaveSpec({ muxer: main.muxer, url: main.url || '-' }));
    }

    for (const extra of extras) {
      const spec = buildTargetUrl(extra);
      if (!spec.url) continue;
      if (spec.listen) continue;
      slaves.push(this.slaveSpec({ muxer: spec.muxer, url: spec.url }, { ignore: true }));
    }

    if (doRecord) {
      ensureDir(path.dirname(rec.filePath));
      const fmt = rec.recordFormat === 'ts' ? 'mpegts' : rec.recordFormat === 'mkv' ? 'matroska' : 'mp4';
      slaves.push(this.slaveSpec({ muxer: fmt, url: rec.filePath }, { ignore: true }));
    }

    if (slaves.length < 2) return null;
    return slaves.join('|');
  }

  /** 是否走阶梯转码：一次解码出多档，每档独立编码 + 独立目标 */
  ladderActive(job) {
    const l = job.ladder || {};
    return Boolean(l.enabled && Array.isArray(l.rungs) && l.rungs.length >= 2 && job.video.mode !== 'copy');
  }

  /** 阶梯中某一档的容器参数与目标地址 */
  rungMuxerArgs(rung, job, ctx) {
    const spec = buildTargetUrl(rung.target);
    const t = rung.target || {};
    const args = [];
    if (spec.muxer === 'flv') {
      args.push('-f', 'flv', ...(spec.extra || []));
    } else if (spec.muxer === 'rtsp') {
      args.push('-f', 'rtsp', ...(spec.extra || []));
    } else if (spec.muxer === 'mpegts') {
      args.push('-f', 'mpegts', '-mpegts_flags', '+resend_headers');
    } else if (spec.muxer === 'hls') {
      const dir = this.prepareHlsDir(job, ctx, `_${rung.id}`);
      args.push('-f', 'hls',
        '-hls_time', String(t.hlsSegmentSeconds || 2),
        '-hls_list_size', String(t.hlsListSize || 6),
        '-hls_flags', 'delete_segments+append_list+omitendlist+temp_file',
        '-hls_segment_type', 'mpegts',
        '-hls_segment_filename', path.join(dir, 'seg_%06d.ts'));
      return { args, url: path.join(dir, 'index.m3u8'), spec };
    } else if (!spec.muxer) {
      const ext = path.extname(spec.url || '').toLowerCase();
      if (ext === '.mp4') args.push('-f', 'mp4', '-movflags', '+faststart');
      else if (ext === '.mkv') args.push('-f', 'matroska');
      else if (ext === '.ts') args.push('-f', 'mpegts');
      else args.push('-f', 'matroska');
    } else {
      args.push('-f', spec.muxer);
    }
    return { args, url: spec.url || '-', spec };
  }

  /**
   * 多码率阶梯转码：只解码一次，用 split 分出 N 条分支各自缩放编码，
   * 再分别输出到各自的平台。相比跑 N 个 ffmpeg 进程，解码开销只算一次。
   */
  buildLadderArgs(job, ctx) {
    const { args: inArgs, filterPrefix, audioFromLavfi } = this.buildInput(job, ctx);
    const isTest = job.source.type === 'test';
    const audioIn = isTest
      ? [...(job.advanced.realtime ? ['-re'] : []), '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100']
      : [];
    const audioIdx = isTest ? 1 : 0;
    const rungs = job.ladder.rungs;
    const adv = job.advanced;
    const rec = job.record || {};

    const pre = filterPrefix.length ? `${filterPrefix.join(',')},` : '';
    const chain = [`[0:v:0]${pre}split=${rungs.length}${rungs.map((_, i) => `[s${i}]`).join('')}`];
    rungs.forEach((r, i) => {
      chain.push(`[s${i}]${this.scaleFilters(r.width, r.height, r.fps, job.video.scaling)}[v${i}]`);
    });

    const args = [...inArgs, ...audioIn, '-filter_complex', chain.join(';')];

    rungs.forEach((r, i) => {
      const enc = {
        ...job.video,
        mode: 'transcode',
        width: r.width,
        height: r.height,
        fps: r.fps,
        bitrateKbps: r.bitrateKbps,
        maxBitrateKbps: r.maxBitrateKbps,
        preset: r.preset,
        profile: r.profile,
      };
      const mux = this.rungMuxerArgs(r, job, ctx);
      args.push('-map', `[v${i}]`);
      if (job.audio.mode !== 'none') args.push('-map', `${audioIdx}:a:0`);
      args.push(...this.videoEncodeArgs(enc, ctx));
      args.push(...this.audioEncodeArgs(job.audio, audioFromLavfi));
      args.push('-max_muxing_queue_size', '1024');

      // 第一档顺带录制：同一份编码用 tee 再写一份文件，不重复转码
      const wantRecord = i === 0 && rec.enabled && rec.filePath;
      if (wantRecord && mux.spec.muxer !== 'hls') {
        ensureDir(path.dirname(rec.filePath));
        const fmt = rec.recordFormat === 'ts' ? 'mpegts' : rec.recordFormat === 'mkv' ? 'matroska' : 'mp4';
        const slaves = [
          this.slaveSpec({ muxer: mux.spec.muxer || 'matroska', url: mux.url }),
          this.slaveSpec({ muxer: fmt, url: rec.filePath }, { ignore: true }),
        ];
        args.push('-flags', '+global_header', '-f', 'tee', slaves.join('|'));
        return;
      }
      if (wantRecord) ctx.warn('阶梯转码首档为本地 HLS，无法同时写录制文件，已跳过录制');

      args.push(...mux.args);
      if (adv.extraOutputArgs) args.push(...String(adv.extraOutputArgs).split(/\s+/).filter(Boolean));
      args.push(mux.url);
    });

    return args;
  }

  /** 完整推流命令 */
  buildStreamArgs(job, ctx) {
    if (this.ladderActive(job)) return this.buildLadderArgs(job, ctx);
    const { args: inArgs, filterPrefix, audioFromLavfi } = this.buildInput(job, ctx);
    const innerCtx = { ...ctx, filterPrefix, audioFromLavfi };
    if (job.source.type === 'test') {
      // test 源需要额外音轨
      const audio = [...(job.advanced.realtime ? ['-re'] : []), '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100'];
      const outArgs = this.buildOutput(job, innerCtx);
      const map = ['-map', '0:v:0', '-map', '1:a:0'];
      return [...inArgs, ...audio, ...map, ...outArgs];
    }
    const outArgs = this.buildOutput(job, innerCtx);
    if (job.advanced.extraInputArgs) {
      const extra = String(job.advanced.extraInputArgs).split(/\s+/).filter(Boolean);
      // 追加在 -i 之前更安全：这里插到输入参数末尾
      inArgs.push(...extra);
    }
    return [...inArgs, ...outArgs];
  }

  /** 播放预览：优先转封装，必要时转码 */
  buildPreviewArgs(source, outDir, opts = {}) {
    const kind = urlKind(source.url);
    const args = ['-nostdin', '-hide_banner', '-loglevel', 'warning'];
    if (opts.userAgent) args.push('-user_agent', opts.userAgent);
    if (opts.headers) args.push('-headers', String(opts.headers).replace(/\n/g, '\r\n'));
    if (kind === 'rtsp') args.push('-rtsp_transport', 'tcp', '-rtsp_flags', 'prefer_tcp');
    if (kind === 'udp') args.push('-buffer_size', '4194304', '-f', 'mpegts');
    if (kind === 'srt') args.push('-f', 'mpegts');
    if (['http', 'hls', 'flv', 'rtmp', 'rtmps'].includes(kind)) {
      args.push('-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5');
    }
    if (['rtsp', 'http', 'hls', 'flv', 'rtmp', 'rtmps', 'srt'].includes(kind)) {
      args.push('-rw_timeout', '15000000');
    }
    args.push('-fflags', '+genpts', '-i', source.url);

    const maxH = opts.maxHeight || 1080;
    if (opts.copy && (!opts.videoHeight || opts.videoHeight <= maxH)) {
      args.push('-c', 'copy');
    } else {
      args.push(
        '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency',
        '-profile:v', 'main', '-pix_fmt', 'yuv420p',
        '-b:v', `${opts.bitrateKbps || 3000}k`, '-maxrate', `${(opts.bitrateKbps || 3000) * 1.2}k`,
        '-bufsize', `${(opts.bitrateKbps || 3000) * 2}k`,
        '-vf', `scale=-2:'min(${maxH},ih)',fps=30`,
        '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2',
      );
    }
    ensureDir(outDir);
    args.push(
      '-f', 'hls',
      '-hls_time', '1',
      '-hls_list_size', '6',
      '-hls_flags', 'delete_segments+omit_endlist+temp_file',
      '-hls_segment_type', 'mpegts',
      '-hls_segment_filename', path.join(outDir, 'seg_%06d.ts'),
      path.join(outDir, 'index.m3u8'),
    );
    return args;
  }

  /** 探测屏幕采集设备的实际分辨率（采集 1 帧后丢弃） */
  async screenSize(index = 0) {
    let args;
    if (IS_MAC) {
      args = ['-hide_banner', '-f', 'avfoundation', '-framerate', '1',
        '-i', `${index}:none`, '-frames:v', '1', '-f', 'null', '-'];
    } else if (IS_WIN) {
      args = ['-hide_banner', '-f', 'gdigrab', '-i', 'desktop', '-frames:v', '1', '-f', 'null', '-'];
    } else {
      args = ['-hide_banner', '-f', 'x11grab', '-i', ':0.0', '-frames:v', '1', '-f', 'null', '-'];
    }
    const r = await execFileP(this.bin, args, { timeout: 20000 });
    const text = `${r.stdout}\n${r.stderr}`;
    const m = /Video:.*?(\d{2,5})x(\d{2,5})/.exec(text.replace(/\n/g, ' '));
    if (m) return { ok: true, width: Number(m[1]), height: Number(m[2]) };
    const perm = /Permission|not permitted|denied/i.test(text);
    return {
      ok: false,
      error: perm
        ? '没有屏幕录制权限：请到「系统设置 → 隐私与安全性 → 屏幕录制」勾选 StreamPilot / 终端后重试'
        : '无法读取屏幕尺寸，请确认设备序号或手动填写',
      detail: text.split('\n').slice(-6).join('\n'),
    };
  }

  /** 列出本机网络出口地址，便于局域网推流/拉流 */
  localAddresses() {    const out = [];
    const nets = os.networkInterfaces();
    for (const [name, list] of Object.entries(nets)) {
      for (const n of list || []) {
        if (n.family === 'IPv4' && !n.internal) out.push({ name, address: n.address });
      }
    }
    return out;
  }

  describeEncoder(name) {
    return ENCODER_LABELS[name] || name;
  }
}

/** 解析 -progress 输出的键值行（key=value） */
function parseProgressKV(line) {
  const m = /^([a-z_0-9]+)=(.+)$/.exec(line.trim());
  if (!m) return null;
  const key = m[1];
  const raw = m[2].trim();
  switch (key) {
    case 'frame': return { frame: Number(raw) };
    case 'fps': return { fps: parseFloat(raw) };
    case 'bitrate': {
      const v = parseFloat(raw);
      return Number.isFinite(v) ? { bitrateKbps: v } : {};
    }
    case 'total_size': {
      const v = Number(raw);
      return Number.isFinite(v) ? { sizeBytes: v } : {};
    }
    case 'out_time_us': {
      const v = Number(raw);
      return Number.isFinite(v) && v >= 0 ? { timeSec: v / 1e6 } : {};
    }
    case 'out_time': {
      const t = /^(\d+):(\d+):(\d+(?:\.\d+)?)$/.exec(raw);
      if (!t) return null;
      return { timeSec: Number(t[1]) * 3600 + Number(t[2]) * 60 + parseFloat(t[3]) };
    }
    case 'speed': return { speed: parseFloat(raw) || 0 };
    case 'drop_frames': return { dropFrames: Number(raw) };
    case 'dup_frames': return { dupFrames: Number(raw) };
    case 'progress': return { progress: raw };
    default: return null;
  }
}

/** 解析 ffmpeg 进度行 */
function parseProgress(line) {
  if (!/frame=|size=|time=|bitrate=/.test(line)) return null;
  const out = {};
  const num = (re, key, cast = Number) => {
    const m = re.exec(line);
    if (m) out[key] = cast(m[1]);
  };
  num(/frame=\s*(\d+)/, 'frame', (v) => Number(v));
  num(/fps=\s*([\d.]+)/, 'fps');
  num(/q=\s*([\d.]+)/, 'q');
  const size = /(?:L?size)=\s*(\d+)(\w+)/.exec(line);
  if (size) {
    const mult = /kB/i.test(size[2]) ? 1024 : /mB/i.test(size[2]) ? 1024 * 1024 : /gB/i.test(size[2]) ? 1024 ** 3 : 1;
    out.sizeBytes = Number(size[1]) * mult;
  }
  const t = /time=\s*(\d+:\d+:\d+(?:\.\d+)?)/.exec(line);
  if (t) {
    const [h, m, s] = t[1].split(':').map(Number);
    out.timeSec = h * 3600 + m * 60 + s;
  }
  num(/bitrate=\s*([\d.]+)\s*kbits\/s/, 'bitrateKbps');
  num(/speed=\s*([\d.]+)x/, 'speed');
  num(/drop=\s*(\d+)/, 'dropFrames');
  num(/dup=\s*(\d+)/, 'dupFrames');
  return Object.keys(out).length ? out : null;
}

module.exports = { FFmpegService, parseProgress, parseProgressKV, ENCODER_LABELS, IS_MAC, IS_WIN };
