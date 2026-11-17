# 把 StreamPilot 放到 GitHub / Gitee 上

本地仓库已经初始化并提交好了（分支 `main`，24 个文件）。剩下只差**一个远程仓库地址**。

> GitHub 账号注册需要你本人的邮箱 / 手机验证码，这一步只能由你完成，任何工具都无法代替。

## 一、注册账号（约 2 分钟）

- GitHub：https://github.com/signup
- 国内访问不畅时用 Gitee：https://gitee.com/signup

## 二、新建一个空仓库

GitHub：右上角 `+` → **New repository**

- Repository name：`streampilot`
- 可见性：Private（私有）或 Public 都行
- **不要**勾选 “Add a README file / .gitignore / license”，仓库必须是空的

创建后页面会显示仓库地址，二选一：

```
https://github.com/<你的用户名>/streampilot.git
git@github.com:<你的用户名>/streampilot.git
```

## 三、推送

在项目目录执行（把地址换成你自己的）：

```bash
cd /Users/yanbin/WorkBuddy/2026-11-17-07-53-43/streampilot
chmod +x scripts/publish.sh
./scripts/publish.sh https://github.com/<你的用户名>/streampilot.git
```

HTTPS 方式会要求输入用户名和 **Personal Access Token**（不是登录密码）：

1. GitHub → Settings → Developer settings → Personal access tokens → Tokens (classic)
2. Generate new token → 勾 `repo` → 生成后复制
3. 推送时密码处粘贴这个 token

想免密码，就把本机公钥加到 GitHub（Settings → SSH and GPG keys）：

```bash
# 没有公钥就先生成
ssh-keygen -t ed25519 -C "你的邮箱"
cat ~/.ssh/id_ed25519.pub      # 复制这一整行到 GitHub
# 然后把 publish.sh 的地址换成一、里面的 git@ 形式
```

## 四、以后的日常更新

```bash
git add -A
git commit -m "改了什么都写一句"
git push
```

## 五、发布可执行安装包（可选）

仓库里已配好 electron-builder：

```bash
npm run dist:mac     # 生成 dmg + zip 到 release/
npm run dist:win     # 生成 nsis 安装包 + 免安装版
npm run dist:linux   # AppImage + deb
```

打包产物不要提交到仓库（`.gitignore` 已排除 `release/`），
需要分发给别人时上传到 GitHub Releases 即可。

## 六、建议先看一遍再提交的内容

- `package.json` 里的 `author`，可改成你的名字/ID
- `README.md` 的仓库说明，可加一行你的署名
- 如果你打算公开仓库，确认 `NOTICE.md` 里的第三方声明保留着
