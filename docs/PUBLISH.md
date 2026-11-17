# 代码托管与版本更新

仓库已经建好并且推送完成了：

**https://github.com/yanbmail/streampilot**

- 账号：`yanbmail`（邮箱 371966911@qq.com）
- 分支：`main`
- 本机已把 HTTPS 凭据存进 macOS 钥匙串，日常推送不用再输密码

## 一、以后的日常更新（一条命令）

```bash
cd /Users/yanbin/WorkBuddy/2026-11-17-07-53-43/streampilot
./scripts/sync.sh "这次改了什么"
```

不带参数也行，会自动用时间戳当提交说明：

```bash
./scripts/sync.sh
```

等价于 `git add -A && git commit -m "..." && git push`，只是不用记这些。

想手动来也可以：

```bash
git add -A
git commit -m "改了什么都写一句"
git push
```

## 二、在另一台电脑上接着做

```bash
git clone https://github.com/yanbmail/streampilot.git
cd streampilot
npm install
npm start
```

需要 FFmpeg：macOS `brew install ffmpeg`，Windows `winget install Gyan.FFmpeg`，
Linux `sudo apt install ffmpeg`。首次 `npm install` 会下载 Electron 运行时（约 100 MB）。

## 三、换远程地址（比如想改用 Gitee 镜像）

```bash
./scripts/publish.sh https://gitee.com/<你的用户名>/streampilot.git
```

Gitee 上先建一个空仓库（不要勾 README / .gitignore / license），地址换成你自己的即可。
同时推两个远端：

```bash
git remote add gitee https://gitee.com/<你的用户名>/streampilot.git
git push gitee main
```

## 四、关于访问令牌

当前本机用的是 GitHub Personal Access Token（classic，`repo` 权限），
有效期到 **2026-12-17**，已存进钥匙串。到期后推送会报 403，重新生成一个即可：

1. 打开 https://github.com/settings/tokens/new
2. Note 随便填（例如 `StreamPilot CLI`），Expiration 选 90 天或 No expiration
3. 勾选 `repo`，拉到页面底部点 **Generate token**
4. 复制生成的 `ghp_...`，重新存入钥匙串：

```bash
printf "protocol=https\nhost=github.com\nusername=yanbmail\npassword=<新的token>\n\n" | git credential-osxkeychain store
```

令牌等同密码，只存在本机钥匙串里，不要写进任何文件或提交到仓库。

## 五、发布可执行安装包（可选）

仓库里已配好 electron-builder：

```bash
npm run dist:mac     # 生成 dmg + zip 到 release/
npm run dist:win     # 生成 nsis 安装包 + 免安装版
npm run dist:linux   # AppImage + deb
```

打包产物不要提交（`.gitignore` 已排除 `release/`），要分发就上传到 GitHub Releases。

## 五之二、发布一个新版本（打 tag + 写版本说明）

版本号在三个地方保持一致：`package.json` 的 `version`、`web/index.html` 里的版本号、git tag。

```bash
cd /Users/yanbin/WorkBuddy/2026-11-17-07-53-43/streampilot

# 1. 改版本号（三处）
#    package.json  -> "version": "1.2.0"
#    web/index.html -> 侧栏/标题里的 v1.2.0

# 2. 提交并推送
git add -A
git commit -m "feat: 多码率阶梯转码 / 排播表 / 推流模板（v1.2.0）"
git push

# 3. 打标签并推送
git tag -a v1.2.0 -m "v1.2.0 阶梯转码 + 排播表 + 推流模板"
git push origin v1.2.0

# 4. 创建 Release（有 gh 命令时）
gh release create v1.2.0 --title "v1.2.0 · 多码率阶梯转码 / 一周排播 / 推流模板" --notes-file docs/release-notes.md
```

没有 `gh` 也可以网页操作：仓库 → Releases → Draft a new release → 选 tag → 粘贴说明。

版本说明建议按「新增 / 修复 / 升级提示」三段写，写清有没有配置结构变化。

## 六、建议先看一遍再公开的内容

- `package.json` 里的 `author`，可改成你的名字/ID
- `README.md` 的署名与说明
- 如果你打算公开仓库，确认 `NOTICE.md` 里的第三方声明保留着
