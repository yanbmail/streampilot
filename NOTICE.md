# 第三方组件说明

本项目运行时依赖以下开源组件，均以其原始许可证分发：

| 组件 | 用途 | 许可证 |
| --- | --- | --- |
| FFmpeg | 转码、封装、协议收发（外部程序调用，不随仓库分发） | LGPL / GPL（取决于编译选项） |
| Electron | 桌面窗口 | MIT |
| hls.js | 浏览器端 HLS 播放（`web/vendor/hls.min.js`） | Apache-2.0 |
| mpegts.js | 浏览器端 HTTP-FLV 播放（`web/vendor/mpegts.js`） | Apache-2.0 |
| node-media-server | 内置 RTMP 收流服务端（纯 JS 实现） | MIT |

## 电视源数据

内置的 IPTV 源索引全部指向第三方公开发布的项目与站点：

- iptv-org（https://github.com/iptv-org/iptv）
- fanmingming/live（https://github.com/fanmingming/live）
- YanG-1989/m3u（https://github.com/YanG-1989/m3u）
- wind005/TVlive

这些项目仅聚合公开的直播流地址。本项目不托管、不缓存、不分发任何视频内容，
频道可用性由对应上游决定。使用者需自行确认所在地区的法律与版权要求。
