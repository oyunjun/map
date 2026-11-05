# 部署上线指南（我们的地图）

> 目标：把改造后的站点发布到公网，让任何人都能注册使用。
> 站点是**纯静态前端**（HTML/CSS/JS），认证/数据库/存储在 WorkBuddy 云服务，地图用腾讯位置服务。
>
> **当前决策：走路线 B（独立域名托管）。** 请先读 §0.2 的两个硬性前提。

---

## 0. 先选路线

### 路线 A（最省事）：继续用 WorkBuddy 托管

当前站点已在 `https://love-travel-map.app.workbuddy.host/` 运行。

- **做法**：把本项目目录下的文件替换到 WorkBuddy 项目的对应位置，然后在 WorkBuddy 里发布。
- **优点**：域名不变、腾讯地图 Key 白名单已包含 `*.workbuddy.host`、无需备案、`__WB_HTTP_PORT__` / `__WB_TMAP_SECRET__` 占位符由平台自动注入。
- **注意**：**不要**改 `index.html` 里的两个 `__WB_` 占位符，也**不要**调换底部脚本顺序。

### 路线 B：迁到独立静态托管（Vercel / Netlify / GitHub Pages / 对象存储）

- **需要**：自己的域名 + HTTPS；到腾讯位置服务控制台把**新域名**加入 Key 白名单；若用中国大陆服务器/国内 CDN，还需 **ICP 备案**。
- **优点**：完全自主、可绑定好看域名、可接 CDN。
- **代价**：配置更多，备案耗时。

> 只想尽快上线给人用 → 先走路线 A；想长期运营、绑自己的域名 → 走路线 B。

### 0.2 ⚠️ 走路线 B 之前，必须先确认这两件事

这两条不通，换域名后**登录会直接失败**，且不是前端能修的：

**① 云后端的跨域（CORS）是否放行你的新域名**

前端会用 `fetch` 请求 `https://love-travel-map.app.workbuddy.host/.cloud/...`（见 `js/cloud-config.js` 的 `endpoint`）。
浏览器会做跨域校验，若后端只允许 `*.workbuddy.host` 来源，你的新域名会被拦截。

- 验证方法：新域名上线后，打开控制台看是否有 `blocked by CORS policy` / `Access-Control-Allow-Origin` 报错。
- 处理：在 WorkBuddy 后端/控制台把新域名加入允许来源（Origin 白名单）。**这一步做不了，就只能留在路线 A，或自建等价后端。**

**② 腾讯地图 Key 的域名白名单**

到 <https://lbs.qq.com/console/key.html> 把新域名加入白名单，并确认已启用 **WebServiceAPI**。生效约 5 分钟。

> 另注意：`index.html` 里 `__WB_HTTP_PORT__` / `__WB_TMAP_SECRET__` 的本地代理只在 `127.0.0.1` 生效。部署到独立域名后走的是直连，因此**必须**靠白名单放行——这正是第 ② 条的关键。

---

## 1. 前置检查（两条路线都做）

- [ ] `js/config.js` 的 `APP_MAP_KEY` 是可用 Key；公开商用前按腾讯条款换成商用 Key。
- [ ] 腾讯控制台确认该 Key 已启用 **WebServiceAPI**（否则点地图不自动填省市区）。
- [ ] `js/cloud-config.js` 的 `endpoint` 指向你要用的后端（当前是 `https://love-travel-map.app.workbuddy.host`）。
- [ ] 所有资源都是相对路径（`css/`、`js/`、`assets/`），可直接丢到任意子目录/根目录。
- [ ] `index.html` 里 `?v=8` 版本号已是最新（改过 css/js 就 +1）。

---

## 2. 腾讯地图 Key 白名单（路线 B 必做）

1. 打开 <https://lbs.qq.com/console/key.html>，找到本项目用的 Key。
2. 「产品」里勾选/启用 **WebServiceAPI**。
3. 「域名白名单」加入最终域名，例如：
   - `https://your-domain.com`
   - `https://www.your-domain.com`
   - 预览域名（如 `*.vercel.app`）
4. 保存后约 **5 分钟生效**。生效前点地图会报「来源域名未被授权」。

> 若暂时不想配白名单，可把域名白名单留空（不限制来源）——但**不推荐**用于公开站点，容易被盗用额度。

---

## 3. 各平台部署步骤

### 3.1 Vercel（推荐，免费 + 自动 HTTPS）

1. 把 `love-travel-map/` 目录初始化为一个 Git 仓库并推到 GitHub（或直接用 Vercel CLI）。
2. 在 <https://vercel.com> 新建项目，导入该仓库。
3. Framework Preset 选 **Other**，Build Command 留空，Output Directory 填 `.`（根目录）。
4. Deploy。拿到 `https://xxx.vercel.app`。
5. 到腾讯 Key 白名单加入 `https://xxx.vercel.app`（及自定义域名）。
6. 需要自定义域名时，在 Vercel → Settings → Domains 绑定并按提示配 DNS。

### 3.2 Netlify（同样免费 + 自动 HTTPS）

1. 新建站点，选择「Deploy manually」，把整个 `love-travel-map/` 文件夹拖进去。
2. 或连 Git 仓库，Publish directory 填 `.`，Build command 留空。
3. 拿到 `https://xxx.netlify.app` 后，加入腾讯 Key 白名单。

### 3.3 GitHub Pages

**零安装、纯网页操作的完整步骤见 → [GITHUB-PAGES.md](GITHUB-PAGES.md)**（含上传、开 Pages、自检、CORS 排查）。

要点：

1. 新建 **Public** 仓库，把 `love-travel-map` 目录**里面的内容**上传到仓库**根目录**（`index.html` 必须与 `css/`、`js/` 同级）。
2. Settings → Pages → Source 选 **Deploy from a branch** → `main` / `(root)` → Save。
3. 访问 `https://<user>.github.io/<repo>/`，再打开 `diagnose.html` 做自检。
4. 把该域名加入腾讯 Key 白名单。
5. ⚠️ **先确认后端放行该域名的 CORS**，否则登录会失败（见 §0.2 ①）。

### 3.4 国内对象存储 + CDN（访问最快，但需备案）

1. 阿里云 OSS / 腾讯云 COS 创建 Bucket，开启静态网站托管。
2. 上传全部文件，入口设为 `index.html`。
3. 绑定已备案域名 + 开 HTTPS（免费证书）。
4. 把域名加入腾讯 Key 白名单。

---

## 4. 发布后验证清单

- [ ] 打开首页，能看到粉色登录页，无白屏、无 404。
- [ ] 手机验证码/密码能正常登录（后端可用）。
- [ ] 点地图能自动填省/市/区（说明腾讯 Key 白名单生效）。
- [ ] 添加一条回忆并上传照片，刷新后仍在。
- [ ] 详情面板地址行显示为灰色小字（不是 `<span class="muted">` 字面文本）。
- [ ] 顶栏出现「❤ 在一起 N 天」（在个人资料里设了纪念日时）。
- [ ] 菜单 →「时光流」能打开图文流。
- [ ] 地图右上「🧭 行程线」能开关并画出轨迹（≥2 条带日期的回忆）。
- [ ] 菜单 →「导出数据备份」能下载 JSON。
- [ ] 退出登录后，地图上的标记/轨迹消失（隐私清理）。
- [ ] 手机浏览器「添加到主屏幕」出现粉色爱心图标。

---

## 5. 回滚

- 路线 A：在 WorkBuddy 里回退到上一个发布版本。
- 路线 B（Vercel/Netlify）：在 Deployments 里一键回滚到上一版；GitHub Pages 用 `git revert` 重新推送。
- 本项目的改造是**增量**的：新增了 `manifest.webmanifest`、`assets/icons/*`、若干函数与菜单项；若要完全回到改造前，用原始导出文件重新覆盖即可。
