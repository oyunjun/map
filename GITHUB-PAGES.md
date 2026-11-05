# 用 GitHub Pages 上线（零安装版）

> 目标：把 `love-travel-map` 发布成 `https://<你的用户名>.github.io/<仓库名>/`，任何人可访问。
> 全程只需要浏览器，**不用装任何软件**。

---

## 0. 先知道两个前提

**① 这站是纯静态前端**，可以直接放 GitHub Pages，不需要构建。

**② 登录能不能用，取决于云后端是否放行 GitHub 的域名。**

前端会跨域请求 `https://love-travel-map.app.workbuddy.host/.cloud/...`。
GitHub Pages 的域名是 `https://<用户名>.github.io`，如果后端只允许 `*.workbuddy.host`，
浏览器会拦下请求，**登录会失败**。

> 这一条前端改不了。部署完成后打开自检页 `diagnose.html`，它会明确告诉你通没通。
> 如果没通，你有三个选择：让后端加白名单 / 继续用 WorkBuddy 域名（路线 A）/ 自建后端。

---

## 1. 新建仓库（约 1 分钟）

1. 登录 <https://github.com>，点右上角 **＋ → New repository**。
2. **Repository name** 填一个短名，例如 `our-map`（它会成为网址的一部分，建议只用小写字母和短横线）。
3. **Visibility** 选 **Public**。
   > 私有仓库的 Pages 需要付费账号；选 Public 最省事。
4. **不要**勾选 "Add a README file" / ".gitignore" / "license"（保持空仓库）。
5. 点 **Create repository**。

---

## 2. 上传文件（约 2 分钟）

进入刚建好的仓库，点 **Add file → Upload files**。

然后在本机打开文件夹：

```
D:\Users\32262\Documents\deepseek-harness\default-workspace\love-travel-map
```

**把里面的「所有文件和文件夹」全选，拖进网页的上传区域**：

```
index.html   privacy.html   terms.html   diagnose.html
css/   js/   assets/   manifest.webmanifest   .nojekyll
```

### ⚠️ 最常见的错误

**不要**把 `love-travel-map` 这个外层文件夹整个拖进去——那样网站会变成
`https://…/love-travel-map/index.html`，根路径打开是 404。

正确做法：进入 `love-travel-map` 文件夹**里面**，全选内容再拖。
上传完成后，仓库首页**必须能直接看到 `index.html`**（和 `css`、`js` 同级）。

> 浏览器不会显示以点开头的 `.nojekyll`。如果它没被选中也没关系，
> 后面在仓库里手动新建一个空文件叫 `.nojekyll` 即可（作用：关闭 Jekyll 处理）。

填一句提交说明，点 **Commit changes**。

---

## 3. 开启 Pages（约 1 分钟）

1. 仓库页 → **Settings**（顶部标签）→ 左侧 **Pages**。
2. **Source** 选 **Deploy from a branch**。
3. **Branch** 选 `main`，目录选 **/(root)**，点 **Save**。
4. 等 1–2 分钟，页面顶部会出现网址：

```
https://<你的用户名>.github.io/<仓库名>/
```

---

## 4. 打开自检页（重要）

访问：

```
https://<你的用户名>.github.io/<仓库名>/diagnose.html
```

它会逐项检查：

| 检查项 | 通过 | 不通过怎么办 |
|---|---|---|
| 静态资源 | ✓ | `index.html` 没放在仓库根目录 → 重新上传 |
| 云后端跨域 | ✓ | 见下方「CORS 拦截」 |
| 腾讯地图 SDK | ✓ | 把该域名加入腾讯 Key 白名单（见下） |

### 若「云后端跨域」为 ✗

说明后端没有放行 `https://<用户名>.github.io`。两条路：

- **让后端加白名单**：在 WorkBuddy 后端/控制台把该域名加入允许来源（Origin 白名单）。
- **换回 WorkBuddy 域名**：即 `DEPLOY.md` 的路线 A，那边白名单天然通过。

### 若「腾讯地图 SDK」为 ✗ 或 !

1. 打开 <https://lbs.qq.com/console/key.html>
2. 找到 `js/config.js` 里那个 Key
3. 「域名白名单」加入：`https://<你的用户名>.github.io`
4. 确认「WebServiceAPI」已启用
5. 保存，等约 5 分钟生效

---

## 5. 以后怎么更新

改完本地文件后，两种方式二选一：

**方式一（网页，简单）**
仓库页 → Add file → Upload files → 把改过的文件重新拖进去 → Commit。
注意带上同名文件会覆盖。

**方式二（命令行，装了 git 才可用）**

```bash
cd D:\Users\32262\Documents\deepseek-harness\default-workspace\love-travel-map
git init
git add .
git commit -m "first commit"
git branch -M main
git remote add origin https://github.com/<用户名>/<仓库名>.git
git push -u origin main
```

> 每次改完 `css` / `js`，记得把 `index.html` 里的 `?v=N` 加 1（当前 `v=9`），
> 否则老访客可能拿到缓存。

---

## 6. 可选：绑定自己的域名

1. 在仓库根目录新建一个文件 `CNAME`，内容只有一行（不带 `https://`）：

   ```
   map.yourdomain.com
   ```

2. 到你的域名服务商加一条 DNS 记录：

   | 类型 | 主机记录 | 记录值 |
   |---|---|---|
   | CNAME | `map` | `<用户名>.github.io` |

3. 回 GitHub → Settings → Pages → 填 Custom domain → 勾选 **Enforce HTTPS**。

4. **然后必须把 `map.yourdomain.com` 也加进腾讯 Key 白名单**，否则地图会失效。

---

## 7. 速查：上线后必须确认的 4 件事

- [ ] 首页能打开，不是 404
- [ ] `diagnose.html` 三项都是 ✓
- [ ] 能注册 / 登录
- [ ] 点地图能自动填省市区（说明 Key 白名单生效）
