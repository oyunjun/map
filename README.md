# 我们的地图 · 源码二次开发指南（AI 版）

> 本文件供 **DeepSeek / Claude / ChatGPT / 通义 / Kimi 等外部 AI** 在阅读本项目源码、进行二次开发前阅读。
> 目的：让接手的 AI 立刻理解项目结构、运行时依赖与数据库约定，**避免误删运行时注入对象导致整站崩溃**。

---

## 1. 这是什么

一个**纯前端（HTML / CSS / 原生 JS，无构建步骤、无框架）**的「爱情旅行回忆地图」网站。
用户在地图上**打点**、填表记录回忆、上传照片，数据保存在**云端**。所有交互逻辑都在 `js/app.js` 这一个文件里。

- 状态：已上线，链接 `https://love-travel-map.app.workbuddy.host/`
- 技术栈：腾讯地图 JS API GL（打点 / 地址解析 / 地点搜索）+ WorkBuddy 云服务（登录 / 云数据库 / 云存储）

---

## 2. 文件结构（改之前先读这里）

| 文件 | 职责 |
|------|------|
| `index.html` | 全部 UI 结构 + 脚本引入（**脚本引入顺序很重要，见底部 `<script>`，不要调换**） |
| `css/style.css` | 粉色浪漫风格的全部样式 |
| `js/config.js` | ☆ **唯一可调参数入口**：腾讯地图 Key、地图代理模板。**改配置只改这里** |
| `js/cloud-config.js` | 云后端公开配置（`endpoint` / `publishableKey`，不含私密密钥） |
| `js/app.js` | 全部业务逻辑（约 4300 行，按功能分段，搜索注释定位） |
| `assets/migration/local-data.json` | 旧版本地数据样例（导入功能参考，非运行必需） |
| `privacy.html` | 隐私政策（**模板**，发布前请法务审核并替换橙色占位内容） |
| `terms.html` | 用户协议（**模板**，同上） |
| `manifest.webmanifest` | PWA 清单（名称 / 图标 / 主题色） |
| `assets/icons/` | PWA 与 favicon 图标（192 / 512 / maskable / apple-touch） |
| `DEPLOY.md` | 部署上线指南（两条路线 + 腾讯 Key 白名单 + 验证清单） |

---

## 3. 运行时依赖（由平台注入，代码中不定义 —— 二次开发时 **禁止删除 / 重命名**）

本项目在 **WorkBuddy 云服务运行时**中运行。以下对象由平台在加载时注入到全局，源码里只使用、不定义：

1. **`WorkBuddyCloud`** — 全局构造函数，来自 CDN `@tencent-ai/workbuddy-cloud-sdk@dev`（`index.html` 中 `<script>` 引入）。
2. **`window.cloud`** — `const cloud = WorkBuddyCloud.createWorkBuddyCloud({...})`，见 `js/app.js` 顶部；提供三个子对象：
   - `cloud.auth`：登录 / 注册 / 登出 / 会话（`getSession`、`signInWithPassword`、`sendOtp`、`verifyOtp`、`signOut`、`onAuthStateChange`、`resetPasswordForOld`）
   - `cloud.database`：云数据库（`from('表名').select/insert/update/delete/upsert`，链式 `.eq/.limit/.select()`）
   - `cloud.storage`：云存储（`sharedPath(uid, path)`、`upload(path, body, opts)`、`createSignedUrls(array, ttl)`、`remove(paths)`）
3. **`window.PUBLIC_CONFIG`** — 来自 `js/cloud-config.js`（endpoint / oauthRelayBaseUrl / publishableKey）。
4. **`window.APP_MAP_KEY`** — 来自 `js/config.js`（腾讯地图 Key）。
5. **`window.TMap`** — 腾讯地图 JS API GL，由 `index.html` 的加载器**动态注入**；`window._mapReady` 是其就绪的 Promise（代码里 `await window._mapReady` 后再初始化地图）。
6. **`__WB_HTTP_PORT__` / `__WB_TMAP_SECRET__`** — `index.html` 中腾讯地图 WebService 代理的**占位符**，仅在 WorkBuddy 内预览时由平台替换为真实值，用于绕过本地 `127.0.0.1` 的域名白名单。**不要把这两个占位符改成真实端口或删掉**，否则本地预览地址解析会失败。

> 若要在 **WorkBuddy 之外**自行运行，需要自己提供等价的后端（兼容 `cloud.auth / cloud.database / cloud.storage` 接口的对象，以及腾讯地图 Key + 合法域名白名单）。

---

## 4. 云数据库表结构（`cloud.database.from('表名')`）

字段以上游代码为准（以下是代码中实际用到的列）：

- **`profiles`**：`id`, `username`, `phone`, `avatar_path`, `updated_at`
- **`memories`**：`id`, `album_id`, `name`, `province`, `city`, `district`, `address`, `lat`, `lng`, `trip_date`, `memory_text`, `mood`, `weather`, `photos[]`（每项 `{path, thumb, caption}`）, `stickies[]`（路径字符串数组）, `marker{}`（`{type, data?, path?}`）, `created_at`, `updated_at`
- **`albums`**：`id`, `owner_id`, `name`, `kind`, `cover_path`, `is_public`, `share_code`
- **`album_members`**：`album_id`, `user_id`, `role`（`owner` / `editor` / `viewer`）
- **`album_invites`**：`id`, `album_id`, `phone`, `role`, `status`（`pending` / `accepted` / `declined`）, `invited_by`
- **`album_presence`**：`album_id`, `user_id`, `name`, `last_at`

> 云存储额外约定：`bio` / `anniversary` / 表情头像保存在 `sharedPath(uid, 'profile_extra.json')`；照片在 `shared/<uid>/photos/`、便签在 `shared/<uid>/notes/`、封面在 `shared/<uid>/covers/`、头像在 `shared/<uid>/avatar_*.jpg`。

> 改动任何表名 / 字段前，必须同步改动云端 schema，否则运行时会报错。

---

## 5. 核心功能代码位置（`js/app.js` 内）

| 功能 | 关键函数 |
|------|----------|
| 地图打点 | `initMap()`、`setFormLocation()`、`makePickerLayer()`、`refreshMarkers()` |
| 点地图 → 自动填省/市/区 | `reverseGeocode()`、`addrParts()`、`parseAddressText()`、`offlineRegion()` |
| 搜索地点定位 | `forwardGeocode()`、`poiSuggest()`（腾讯 `TMap.service.Suggestion`）、`searchAndLocate()` |
| 回忆表单与保存 | `openForm()`、`saveForm()`、`loadMemories()`、`deleteSelected()` |
| 照片 / 头像 / 封面 / 便签上传 | `uploadBlob()`（统一入口，含重试与 ArrayBuffer 降级）、`uploadPhotoPair()`、`changeAvatar()` 等 |
| 相册类型（与 Ta 一起 / 个人 / 旅行…） | `ALBUM_KINDS`、`renderAlbumKindTags()`、`setAlbumKind()` |
| 登录注册 | `submitPwd()`、`submitSms()`、`sendPhoneCode()`、`cloud.auth.*` 调用 |
| 时光流 / 行程线 / 那年今日 | `openTimeline()`、`renderTimeline()`、`renderRoute()`、`maybeShowOnThisDay()` |
| 年度回顾 | `openYearReview()`、`renderYearReview()`、`yearStep()`、`haversineKm()` |
| 数据导出备份 | `exportData()`（菜单「导出数据备份」，下载全量 JSON） |

---

## 6. AI 修改守则（必读）

- ✅ 改文案 / 配色：直接改 `index.html` / `css/style.css`。
- ✅ 换腾讯地图 Key：只改 `js/config.js` 的 `APP_MAP_KEY`（记得去腾讯控制台给该 Key 启用 WebServiceAPI 并把部署域名加入白名单）。
- ✅ 加新功能：在 `js/app.js` 对应分段后追加函数，遵守现有 `await cloud.*` 调用约定。
- 🚫 切勿删除 / 重命名：`WorkBuddyCloud`、`window.cloud`、`PUBLIC_CONFIG`、`APP_MAP_KEY`、`TMap`、`_mapReady`，以及 `index.html` 里的两个 `__WB_` 占位符。
- 🚫 切勿改动 `cloud.database` 的表名 / 字段，除非同步改云端 schema。
- 🚫 不要调换 `index.html` 底部脚本的加载顺序（`cloud-config.js` → cloud SDK → `config.js` → 地图加载器 → `app.js`）。

---

## 7. 已修复的历史问题（供参考，避免重复踩坑）

1. **上传 `Failed to fetch`**：改为统一 `uploadBlob()`，body 包装成带文件名的 `File`，失败自动改走 `ArrayBuffer` 分支并重试。
2. **点地图省/市/区不填充**：腾讯逆解析返回 `address_component`（单数），旧代码读 `address_components`（复数，Nominatim 遗留），已修复并兼容三种返回结构（逆解析单数 / 正向解析复数 / POI 顶层字段）。
3. **搜索地点定位失败**：旧代码用了 SDK 中不存在的 `TMap.service.SearchService`，已改为真实存在的 `TMap.service.Suggestion` 做关键词 POI 搜索，无结果时回退 `Geocoder.getLocation`。
4. **本地预览来源域名被拦**：`127.0.0.1` 下腾讯 WebService 返回「来源域名未被授权」，已通过运行时代理占位符绕过；线上域名白名单已通过。

---

## 8. 上线 / 部署清单（公开发布前逐项确认）

本项目是纯静态前端，托管任何静态空间即可（GitHub Pages / Vercel / Netlify / 对象存储 CDN 等）；认证、数据库、存储由 WorkBuddy 云服务提供，无需自建后端。

1. **腾讯地图 Key（最重要）**
   - 当前 `js/config.js` 里的 `APP_MAP_KEY` 是「个人开发者 Key + 免费额度」。**公开商用前**需按腾讯位置服务条款申请商用授权，并替换 Key。
   - 在腾讯控制台确认该 Key 已启用 **WebServiceAPI**（逆/正向地址解析依赖），并把**最终上线域名**加入白名单（否则点地图不会自动填省市区）。
2. **云服务地址**：`js/cloud-config.js` 的 `endpoint` 指向 `https://love-travel-map.app.workbuddy.host`；若换了后端环境，同步改这里（`publishableKey` 是公开密钥，不含私密密钥，可放前端）。
3. **HTTPS**：上线必须用 HTTPS。手机浏览器、剪贴板、通知、地图定位等能力在非 HTTPS 下会被限制。
4. **分享预览（SEO/社交卡片）**：`index.html` 里的 `og:title/description` 已就位；若要微信/微博分享出带缩略图的卡片，补一条 `og:image`（指向一张已上线的绝对 URL 图片，例如 1200×630 的封面图）。
5. **PWA 图标**：`manifest.webmanifest` 与 `assets/icons/` 下的图标已就位（192/512/遮罩/苹果 touch icon），可「添加到主屏幕」。
6. **清缓存**：每次改完 `css` / `js` 记得把 `index.html` 里的 `?v=N` 版本号 +1（当前 `v=9`），避免老用户拿到缓存。
7. **备份**：`assets/migration/local-data.json` 仅是旧版样例，可删除；上线前确认不需要再导入旧数据。
8. **可访问性**：已移除 `user-scalable=no`、加了关键按钮 `aria-label` 和 `prefers-reduced-motion`；上线前用键盘走一遍核心流程（登录 → 打点 → 保存 → 详情 → 分享）。

> 本项目仍依赖 `WorkBuddyCloud` / `PUBLIC_CONFIG` / `APP_MAP_KEY` / `TMap` / `_mapReady` / `__WB_` 占位符，部署时保持 `index.html` 底部脚本顺序不变、占位符原样保留。

### 8.1 面向「所有人可注册使用」的合规项

1. **ICP 备案**：若使用中国大陆服务器 / 国内 CDN / 国内域名，需完成网站备案；用境外托管则不受此限（但国内访问速度受影响）。
2. **隐私政策 + 用户协议** ✅ 已实现：`privacy.html` / `terms.html` + 登录页勾选（未勾选无法登录，勾选状态记在 `localStorage.ltm_agree`）。**两页均为模板**，发布前需法务审核并替换橙色占位内容。
3. **账号注销 / 数据删除** ✅ 已实现：`个人资料 → 账户与数据` 提供「清空全部回忆」与「注销账号」，均需手动输入确认词。
   - 清空：仅删除**自己创建的相册**中的 `memories` 行与对应存储文件，账号保留。
   - 注销：删除自己创建的相册及其 `memories` / `album_members` / `album_invites` / `album_presence` / 相册行，删除自己的成员关系与在线记录，删除 `profiles` 行、头像与 `profile_extra.json`，最后登出。
   - ⚠️ **已知限制**：`cloud.auth` 未提供删除登录身份的接口，因此**手机号这条登录记录本身不会被删除**（业务数据已全部清除）。若需彻底删除，需在后端/控制台手动处理，或在 SDK 提供接口后补充。
4. **内容合规**：用户上传的照片与文字属于 UGC，公开分享场景下建议有举报/删除机制（相册主人可移除成员/删除相册，已具备基础手段；暂无举报按钮）。
5. **手机号验证码成本**：短信发送有资费与频控，公开后需关注后端额度与防刷。
