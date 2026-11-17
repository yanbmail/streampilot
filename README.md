# StreamPilot · 跨平台推流控制台

仓库地址：**https://github.com/yanbmail/streampilot**

把「本地/屏幕/摄像头/网络流/电视源」统一变成可精确控参数的直播推流。
一套代码同时提供 **桌面应用**（Electron 窗口）和 **浏览器控制台**（局域网内手机、其他电脑可打开切流）。

- 引擎：Node.js + FFmpeg（子进程管理，实时解析指标）
- 界面：原生 Web（零构建），`hls.js` / `mpegts.js` 负责播放
- 平台：macOS（Apple Silicon / Intel）、Windows、Linux

---

## 1. 核心能力

### 推流输出（8 种目标）

| 协议 | 场景 | 关键参数 |
| --- | --- | --- |
| RTMP / RTMPS | B 站、抖音、YouTube、OBS 生态 | 服务器、应用名、推流码，默认 1935 |
| RTSP | 内网监控、流媒体服务器 | TCP 传输、0.1s muxdelay |
| SRT | 弱网、跨公网高质量回传 | 延迟、加密口令、pkt_size |
| UDP | 组播分发、内网广播 | TTL、pkt_size 1316 |
| HLS 本地 | 本地预览、切片分发 | 分片时长、列表长度 |
| HTTP-FLV 监听 | 浏览器低延迟播放 | 监听端口，播放器拉 `http://ip:port/live.flv` |
| 录制文件 | 直接落盘 mp4 / mkv / ts | 保存路径、容器 |
| 自定义完整 URL | 带鉴权参数的特殊平台 | 覆盖上面所有字段 |

### 推流源（6 种）

- **测试源**：彩条 / 计数 / 渐变等 FFmpeg 内置图样，用于验证链路
- **媒体文件**：单个文件，可循环
- **多文件轮播**：`concat` 无缝拼接，播完自动续下一个
- **屏幕区域**：整屏或指定 `x/y/宽/高` 裁剪，可带光标
- **摄像头**：AVFoundation / DirectShow / V4L2，可带麦克风
- **网络流**：RTSP / RTMP / HLS / HTTP-FLV / UDP / SRT 的任意源

### 画质与码流（实时可控）

- 分辨率：720P / 1080P / 2K / 4K / 竖屏，或任意自定义宽高
- 缩放策略：留黑边（fit）/ 裁切填满（cover）/ 拉伸（stretch）
- 码率控制：**CBR**（直播平台要求）/ VBR / CRF
- 编码器：x264 / x265（软件）、VideoToolbox（macOS 硬件），按机器自动探测
- 音频：AAC / Opus / MP3 / AC3，码率、采样率、声道可调
- GOP、preset、profile、B 帧策略可调；也可「视频直通」不重编码

### 电视源（IPTV）

- 预置公开源：IPTV-org（中国/全球/新闻/体育/港澳台）、范明明 live、YanG-1989 聚合、TVlive
- 支持 **M3U / M3U8 / TXT(#genre,#EXTINF)** 与 JSON 列表，可本地导入或粘贴
- 自动去重、按分组/画质筛选、关键词搜索、分页
- 频道健康检查（HTTP 探测 + 延迟），标记可用/失效
- **一键转推**：任意频道 → 自定义码率/分辨率 → 推到任意目标协议
- 部分源跨域或有防盗链，内置本地代理与请求头透传

### 播放器

- 支持 HLS / HTTP-FLV / RTSP / RTMP / UDP / SRT / 本地文件
- 浏览器不支持的协议自动走 FFmpeg 本地转封装
- 频道收藏、播放历史、粘贴地址直播

### 备份与可靠性

- 配置写入采用 **原子写 + `.bak` 双份**
- 定时快照（默认 30 分钟、保留 40 份），停止推流时自动快照一次
- 一键恢复任意快照、导出/导入完整配置 JSON
- 断流自动重连（可配次数与退避）
- 进程意外退出后仍保留日志与错误诊断，便于定位

---

## 2. 快速开始

### 依赖

- **Node.js ≥ 18**
- **FFmpeg ≥ 5**（需要 `ffmpeg`、`ffprobe` 在 PATH 中，或稍后在设置里指定绝对路径）

```bash
# macOS
brew install ffmpeg
# Ubuntu / Debian
sudo apt install ffmpeg
# Windows: 下载 https://www.gyan.dev/ffmpeg/builds/ 解压后把 bin 加入 PATH
```

### 安装与运行

```bash
git clone https://github.com/yanbmail/streampilot.git
cd streampilot
npm install

# 桌面应用（推荐）
npm start

# 或者只跑后台服务，用浏览器访问 http://127.0.0.1:8377
npm run serve
```

首次启动会自动创建数据目录 `~/.streampilot`（配置、快照、HLS 片段都在这里）。

### 更新代码与同步版本

```bash
./scripts/sync.sh "这次改了什么"   # 提交并推送到 GitHub
./scripts/publish.sh              # 只推送，不改动提交
```

详见 `docs/PUBLISH.md`。

### 桌面端与浏览器端

- 桌面窗口和 `npm run serve` **共用同一数据目录**，配置互通
- 设置 → 网络与远程访问 → 打开「允许局域网访问」，即可在手机/平板/另一台电脑用 `http://<本机IP>:8377` 管理
- 开启局域网访问后建议设置访问令牌（`lanToken`），避免同网段任意访问

### macOS 权限

屏幕与摄像头采集需要在「系统设置 → 隐私与安全性」里给对应程序授权：

- 屏幕录制（屏幕区域推流必须）
- 摄像头、麦克风（摄像头推流必须）

未授权时 FFmpeg 会报 `Operation not permitted`，任务卡片上会给出中文诊断提示。

---

## 3. 典型用法

### 3.1 推流到 B 站 / 抖音

1. 推流任务 → 新建推流
2. 输入源选「屏幕区域」或「媒体文件」
3. 画面：1080P、30fps、CBR 6000 kbps、编码器按机器选硬件或 x264
4. 推流目标：RTMP，填平台给的「服务器地址」和「推流码」
5. 保存并启动，总览页能看到实时码率曲线

> 平台地址通常形如 `rtmp://live-push.bilivideo.com/live-bvc/`，推流码是一长串参数。若平台要求整串 URL，直接粘到「完整地址覆盖」。

### 3.2 把电视源转成自己的推流

1. 电视源 → 更新全部源（或导入自己的 m3u）
2. 找到频道 → 点「转推」
3. 在弹出表单里设分辨率/码率/目标协议
4. 启动后该频道就被重新编码成你要求的码流

适合把低码率公开源统一成 1080P/6Mbps，或把 HLS 源转成 RTMP 喂给平台。

### 3.3 屏幕区域推流

1. 输入源 →「屏幕区域」
2. 选显示器，点「全屏」或手动填 `x / y / 宽 / 高`
3. 需要鼠标指针就打开「采集光标」
4. 之后与普通推流一致

### 3.4 局域网低延迟分发（HTTP-FLV）

推流目标选「HTTP-FLV」，设监听端口（默认 8380），启动后：

- 播放器地址：`http://<本机IP>:8380/live.flv`
- 任何支持 FLV 的播放器（PotPlayer、VLC、OBS、本应用播放器）都能拉

---

## 4. 目录结构

```
streampilot/
├── electron/main.js      桌面壳：窗口、原生文件对话框、单实例
├── server/
│   ├── index.js          HTTP 服务与全部 API
│   ├── ffmpeg.js         FFmpeg 参数构建、设备/编码器探测、指标解析
│   ├── jobs.js           推流任务生命周期、日志、重连、体积采样
│   ├── iptv.js           电视源抓取、解析、去重、健康检查
│   ├── preview.js        播放转封装（RTSP/FLV → 浏览器可播）
│   ├── config.js         配置存储：原子写、快照、导入导出
│   └── util.js
├── web/                  前端（无需构建）
│   ├── index.html
│   ├── css/app.css
│   ├── js/{app,views,job-form,tv,api,util}.js
│   └── vendor/           hls.js、mpegts.js
├── scripts/
│   ├── launch.js         启动器（清理 ELECTRON_RUN_AS_NODE 等环境干扰）
│   ├── publish.sh        推送仓库（默认推到 GitHub）
│   └── sync.sh           一键提交 + 推送
└── docs/                 发布与维护说明
```

数据目录 `~/.streampilot`：

```
config.json        主配置（任务、设置、播放器数据）
config.json.bak    上一次的配置，损坏时自动回退
backups/           定时快照
channels.json      电视源频道库
hls/<任务ID>/      HLS 输出切片
preview/           播放转封装临时文件
tmp/               多文件轮播的 concat 清单
```

---

## 5. 常见问题

**任务起不来，日志显示 `No such file or directory: ffmpeg`**
FFmpeg 不在 PATH。设置 → FFmpeg 路径填绝对路径，例如 `/opt/homebrew/bin/ffmpeg`。

**`Operation not permitted`**
macOS 权限未授予，见上文「macOS 权限」。

**`Connection refused` / `404` / `401`**
推流地址、应用名、推流码有一项不对，或平台尚未开播。日志里会给出中文诊断。

**电视源刷新失败 / 频道打不开**
公开 IPTV 源本身不稳定，且部分源限制了地区或需要特定 UA。可以：换一个源、在播放器「高级」里改 UA/Referer、或用自己的 m3u 替换。

**HLS 播放延迟大**
把分片时长调到 1–2 秒、列表长度 3–6；要更低延迟请改用 HTTP-FLV。

**需要重新打包分发**
```bash
npm run dist:mac     # dmg + zip
npm run dist:win     # nsis + portable
npm run dist:linux   # AppImage + deb
```

---

## 6. 备份与迁移

- 设置 → 配置备份：立即备份 / 导出 / 导入
- 恢复：快照列表点「恢复」，当前配置会先自动备份一份再覆盖
- 迁移到新机器：导出 JSON → 新机器导入即可

---

## 7. 开发约定

- 前端零构建：改完 `web/` 直接刷新浏览器（硬刷新可绕过缓存）
- 后端改动需要重启 `npm run serve`
- 所有 FFmpeg 参数集中在 `server/ffmpeg.js`，新增协议只需在 `buildTargetUrl` / `buildOutput` 加一个分支
- 新增源类型：`buildInput` 加分支 + `job-form.js` 的 `SOURCE_TYPES` 加一项

---

## 8. 许可与声明

MIT License，见 `LICENSE`。

本项目只做**聚合与转推**，不存储、不托管任何视频内容。内置电视源均来自公开发布的 IPTV 索引项目，链接随时可能失效；请在所在地法律法规与版权要求范围内使用，不要用于传播侵权内容。
