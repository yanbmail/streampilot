'use strict';

/**
 * 内置 RTMP 收流服务端
 *
 * 让本机直接成为推流接收端：OBS / 手机推流 App / 其他设备把流推上来，
 * 控制台里就能看到、预览、转推、录制，不必另外部署 nginx-rtmp 或 SRS。
 *
 * 依赖 node-media-server（纯 JS 实现），同时提供：
 *   - RTMP 收流：rtmp://<本机IP>:1935/live/<流名>
 *   - HTTP-FLV 播放：http://<本机IP>:8399/live/<流名>.flv（浏览器可直接播）
 *   - HLS 播放：http://<本机IP>:8399/live/<流名>/index.m3u8
 */

const net = require('net');
const EventEmitter = require('events');

const DEFAULT_HTTP_PORT = 8399;

/** 端口是否被占用 */
function portBusy(port, host = '0.0.0.0') {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', (err) => resolve(err.code === 'EADDRINUSE' ? true : false));
    srv.once('listening', () => srv.close(() => resolve(false)));
    srv.listen(port, host);
  });
}

class RtmpServer extends EventEmitter {
  constructor() {
    super();
    this.nms = null;
    this.config = { port: 1935, httpPort: DEFAULT_HTTP_PORT, chunkSize: 60000, gopCache: true };
    this.startedAt = 0;
    this.lastError = '';
    this.streams = new Map(); // streamPath -> { app, name, startedAt, clients, bytesIn }
  }

  /** 依赖是否安装（打包或精简安装时可能缺失） */
  static available() {
    try {
      require.resolve('node-media-server');
      return true;
    } catch (_) {
      return false;
    }
  }

  get running() {
    return Boolean(this.nms);
  }

  async localIp() {
    for (const [name, addrs] of Object.entries(require('os').networkInterfaces())) {
      if (/^(utun|lo|docker|vmnet|bridge)/.test(name)) continue;
      for (const a of addrs || []) {
        if (a.family === 'IPv4' && !a.internal) return a.address;
      }
    }
    return '127.0.0.1';
  }

  async start(opts = {}) {
    if (this.nms) return this.status();

    if (!RtmpServer.available()) {
      throw new Error('未安装 node-media-server，请先执行 npm install');
    }

    const port = Number(opts.port) || 1935;
    const httpPort = Number(opts.httpPort) || DEFAULT_HTTP_PORT;

    if (await portBusy(port)) throw new Error(`RTMP 端口 ${port} 已被占用（可能已有其他流媒体服务在跑）`);
    if (await portBusy(httpPort)) throw new Error(`HTTP-FLV 端口 ${httpPort} 已被占用`);

    const NodeMediaServer = require('node-media-server');
    const conf = {
      logType: 1, // 只打 error，避免刷屏
      rtmp: {
        port,
        chunk_size: Number(opts.chunkSize) || 60000,
        gop_cache: opts.gopCache !== false,
        ping: 30,
        ping_timeout: 60,
      },
      http: {
        port: httpPort,
        allow_origin: '*',
      },
    };

    this.config = { port, httpPort, chunkSize: conf.rtmp.chunk_size, gopCache: conf.rtmp.gop_cache };

    const nms = new NodeMediaServer(conf);
    this.nms = nms;

    const onPublish = (a, b) => {
      const s = normalizeSession(a, b);
      if (!s.streamPath) return;
      this.streams.set(s.streamPath, { ...s, startedAt: Date.now(), clients: 0 });
      this.emit('publish', s);
    };
    const onDone = (a, b) => {
      const s = normalizeSession(a, b);
      if (!s.streamPath) return;
      this.streams.delete(s.streamPath);
      this.emit('unpublish', s);
    };
    const onPlay = (a, b) => {
      const s = normalizeSession(a, b);
      const st = this.streams.get(s.streamPath);
      if (st) st.clients += 1;
    };
    const onDonePlay = (a, b) => {
      const s = normalizeSession(a, b);
      const st = this.streams.get(s.streamPath);
      if (st) st.clients = Math.max(0, st.clients - 1);
    };

    nms.on('postPublish', onPublish);
    nms.on('donePublish', onDone);
    nms.on('prePlay', onPlay);
    nms.on('donePlay', onDonePlay);

    try {
      await nms.run();
    } catch (err) {
      this.nms = null;
      this.lastError = err.message;
      throw err;
    }

    this.startedAt = Date.now();
    this.lastError = '';
    this.emit('started', this.status());
    return this.status();
  }

  stop() {
    if (!this.nms) return this.status();
    try {
      const nms = this.nms;
      this.nms = null;
      if (typeof nms.stop === 'function') Promise.resolve(nms.stop()).catch(() => {});
    } catch (err) {
      this.lastError = err.message;
    }
    this.streams.clear();
    this.startedAt = 0;
    this.emit('stopped');
    return this.status();
  }

  async status() {
    const ip = await this.localIp();
    const { port, httpPort } = this.config;
    return {
      available: RtmpServer.available(),
      running: this.running,
      port,
      httpPort,
      startedAt: this.startedAt,
      error: this.lastError,
      ip,
      ingestUrl: `rtmp://${ip}:${port}/live/`,
      streams: [...this.streams.entries()].map(([streamPath, s]) => ({
        app: s.app,
        name: s.name,
        startedAt: s.startedAt,
        seconds: Math.floor((Date.now() - s.startedAt) / 1000),
        clients: s.clients,
        rtmpUrl: `rtmp://127.0.0.1:${port}${streamPath}`,
        lanUrl: `rtmp://${ip}:${port}${streamPath}`,
        flvUrl: `http://${ip}:${httpPort}${streamPath}.flv`,
      })),
    };
  }
}

function parsePath(streamPath) {
  const parts = String(streamPath || '').split('/').filter(Boolean);
  return { app: parts[0] || 'live', name: parts[1] || 'stream' };
}

/**
 * node-media-server v4 的事件只传一个 session 对象，旧版传 (id, streamPath)。
 * 这里两种都兼容，拿不到路径就返回空，由调用方跳过。
 */
function normalizeSession(a, b) {
  if (a && typeof a === 'object') {
    const path = a.streamPath
      || (a.appName && a.streamName ? `/${a.appName}/${a.streamName}` : '')
      || (a.req && a.req.app && a.req.name ? `/${a.req.app}/${a.req.name}` : '');
    return { sessionId: a.id || '', streamPath: path, ...parsePath(path) };
  }
  const path = typeof b === 'string' ? b : '';
  return { sessionId: a || '', streamPath: path, ...parsePath(path) };
}

module.exports = { RtmpServer, portBusy };
