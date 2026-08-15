# DyExtract - 通用分享链接解析预览工具

一个完全自建的公网分享链接解析工具，不依赖任何第三方 API，支持在线预览和下载无水印媒体内容。支持两种部署模式：本地 Node.js 直启 / Cloudflare Pages 无服务器托管。

## ✨ 功能特性

- 🔗 **链接解析** - 支持短链接、分享文本自动提取
- 🎬 **视频解析** - 解析视频，在线预览播放，下载无水印高清视频
- 🖼️ **图文解析** - 自动识别图文类型，提取所有图片
- 📸 **封面下载** - 支持视频封面预览和下载
- 📥 **批量下载** - 图文支持单张下载和批量下载全部图片
- 📱 **响应式布局** - 支持 PC 与移动端，手机比例 9:16 展示
- ℹ️ **信息展示** - 显示标题、作者、图片数量等信息
- 🛡️ **防盗链绕过** - 代理注入合规 Referer / 前端直链零带宽双模式
- ⚡ **自建 API** - 完全独立自主解析，不依赖第三方服务
- 🪶 **双运行时轻量架构**：
  - **本地模式**：仅依赖 express，常驻内存 ~50MB
  - **Cloudflare Pages**：Functions + KV，无服务器，带宽无限免费
- 🚫 **无** Puppeteer / Playwright / 任何无头浏览器 / 任何第三方解析 API

## 🚀 快速开始

### 环境要求

- **Node.js**: >= 18.0.0（推荐 20 LTS；需内置 `fetch` API）
- **npm**: >= 8.0.0

### 本地运行

```bash
# 克隆项目
git clone https://github.com/Hartcher1996/DyExtract.git
cd DyExtract

# 安装依赖
npm install

# 启动服务
npm start
```

启动后访问：**http://localhost:3001**

> 本地模式下视频 URL 缓存使用内存 Map（30 分钟过期），进程重启会失效。

---

## ☁️ 部署到 Cloudflare Pages（推荐，零成本、带宽无限）

### 零、前置说明

| 项目 | 免费额度 |
|------|---------|
| Pages Functions 请求 | 10 万次 / 天 |
| KV 读取 | 10 万次 / 天 |
| KV 写入 | 1000 次 / 天 |
| KV 存储 | 1 GB |
| 出站带宽 | **无限免费** 🔥 |

### 一、在 Cloudflare 控制台创建 Pages 项目

1. 打开 [Cloudflare Dashboard → Workers & Pages](https://dash.cloudflare.com/?to=/:account/workers-and-pages)
2. 点击 **Create → Pages → Connect to Git**
3. 授权 GitHub 后选择 `Hartcher1996/DyExtract` 仓库，点击 **Begin setup**
4. 配置构建信息（框架预设选 **None**）：
   - **Build command**：留空（本项目静态文件直接在 `public/`，无需构建）
   - **Build output directory**：`public`
5. 点击 **Save and Deploy**，等首次部署完成（会拿到一个 `*.pages.dev` 域名，先用它访问能看到首页即可）

### 二、创建 KV 命名空间（视频 URL 跨实例缓存）

1. Cloudflare 控制台 → **Workers & Pages → KV**
2. 点击 **Create a namespace**
3. 填：**Name = `VIDEO_CACHE`**（必须完全一致），点 **Add**

### 三、把 KV 绑定到 Pages 项目（最关键一步）

1. 回到 **Pages → 你的 DyExtract 项目 → Settings → Functions**
2. 滚动到 **KV namespace bindings**，点击 **Add binding**
   - **Variable name**：`VIDEO_CACHE`（大小写敏感，必须完全一致）
   - **KV namespace**：选刚才创建的 `VIDEO_CACHE`
3. 保存后必须**重新触发一次部署**（Settings → Env variables 那里保存会触发，或在 Git 推一次空提交，或在 Deployments 里对最近一次 successful deployment 点 **Retry deployment**）

### 四、验证

1. 访问你的 `*.pages.dev` 域名，首页正常显示
2. 粘贴分享链接点击解析，能拿到视频/图片结果说明解析通了
3. 点击视频预览能正常播放说明 `/api/video` Functions 通了

### 五、自定义域名（可选）

1. Pages 项目 → **Custom domains → Set up a custom domain**
2. 输入你的域名（Cloudflare 托管的 DNS 会自动配 CNAME/SSL）
3. 等待证书签发完成，直接用 `https://你的域名/` 访问

---

### Pages Functions 路由机制（为什么不会静态资源 404）

项目根下的 [`_routes.json`](./_routes.json) 配置为：

```json
{ "include": ["/api/*"], "exclude": [] }
```

这意味着**只有 `/api/*` 的请求才会进入 Functions 处理**，其余所有路径（首页 `/`、`/index.html`、CSS/JS 内联资源、favicon 等）都由 Pages 静态托管直接返回，不会触发函数，不会 404。

---

## 📁 项目结构

```
.
├── server.js                  # 本地运行：Express 主程序（Node.js 原生流代理）
├── lib/
│   └── core.js                # 通用核心逻辑：fetch 网络层 + 解析 + KV/内存双模式缓存
├── functions/                 # Cloudflare Pages Functions（仅 /api/* 命中）
│   └── api/
│       ├── parse.js           # POST/GET /api/parse
│       ├── douyin.js          # GET /api/douyin
│       ├── cover.js           # GET /api/cover  封面/图片代理
│       ├── video.js           # GET /api/video  视频代理（支持 Range）
│       └── douyin/
│           └── self.js        # GET /api/douyin/self  兼容旧接口
├── public/                    # 前端静态资源（Pages 直接托管，不走函数）
│   ├── index.html
│   └── favicon.ico
├── _routes.json               # Pages Functions 路由规则：只接管 /api/*
├── package.json               # 依赖 + 脚本（本地启动 / wrangler 本地调试）
├── LICENSE                    # MIT
└── README.md
```

---

## 🔧 API 接口

### 解析接口（前端主入口）

自动识别是视频还是图文，前端页面实际调用的接口。

```
POST /api/parse
Content-Type: application/json

{ "url": "<分享链接>" }
```

也支持 query 方式：`POST /api/parse?url=<链接>`、`GET /api/parse?url=<链接>`。

### 解析接口（统一入口）

```
GET /api/douyin?url=<分享链接>
GET /api/douyin/self?url=<分享链接>
```

**视频响应示例：**

```json
{
  "success": true,
  "type": "video",
  "video_key": "v1",
  "title": "视频标题",
  "author": "作者名称",
  "play_url": "https://...",
  "cover": "https://...",
  "item_id": "7624888803265880255",
  "platform": "douyin",
  "source": "self"
}
```

**图文响应示例：**

```json
{
  "success": true,
  "type": "image",
  "title": "图文标题",
  "author": "作者名称",
  "image_count": 9,
  "images": [
    { "url": "https://...", "width": 1440, "height": 1440, "uri": "..." }
  ],
  "item_id": "7597706291793311333",
  "cover": "https://...",
  "platform": "douyin",
  "source": "self"
}
```

### 视频代理

```
GET /api/video?id=<video_key>
GET /api/video?id=<video_key>&download=1
```

- `id`：视频缓存 ID（解析接口返回的 `video_key`），Cloudflare 模式下存 KV、本地模式存内存 Map
- `download`：可选，加此参数返回 `Content-Disposition: attachment` 触发浏览器下载
- 支持 HTTP Range 断点续传（拖动进度条、下载续传都能用）

### 图片/封面代理

```
GET /api/cover?url=<图片URL>
GET /api/cover?url=<图片URL>&download=1
```

- `url`：原始图片/封面 URL（需要 URL 编码）
- 前端预览实际走 `<img referrerpolicy="no-referrer">` 直连，**零带宽占用**；此代理作为直连失败的兜底

---

## 🛠️ 技术栈

| 层 | 技术选型 |
|----|---------|
| 本地 HTTP 服务 | Node.js + Express（运行时唯一第三方依赖） |
| Cloudflare 函数 | Pages Functions（Workers V8 运行时） |
| 核心网络请求 | Web Standard `fetch()`（Node.js 18+ / Workers 双兼容） |
| 缓存 | Cloudflare KV（跨实例共享 30 分钟过期）/ 内存 Map（本地降级） |
| 媒体代理（本地） | Node.js 原生 `http`/`https` 模块流式 `pipe()` |
| 媒体代理（Pages） | `fetch()` 返回 ReadableStream，`new Response(body, …)` 直接透传 |
| 前端 | 原生 HTML / CSS / JavaScript，无框架 |
| **明确不使用** | Puppeteer / Playwright / 任何无头浏览器 / 任何第三方解析 API |

---

## 🧠 实现原理

### 解析流程（三级降级策略）

1. **提取 itemId** - 从短链跟随重定向，正则匹配 17~19 位数字内容 ID；若 URL 中直接含 ID 则跳过重定向
2. **请求分享页** - 模拟 iPhone Safari UA 访问公开分享页面，绕过 WAF JS 挑战，拿到 ~38KB 的 SSR 页面及 `ttwid` Cookie
3. **策略 A：嵌入式数据提取** - 用括号配平算法从 HTML 中切出 `window._ROUTER_DATA`，递归深度优先搜索含 `video.play_addr` 或 `images` 的节点
4. **策略 B：官方 API 兜底** - 若策略 A 未取到媒体，带 Cookie 调用两个端点 × 两组参数组合，从 `aweme_detail` 中提取媒体
5. **URL 修复** - 将 `playwm` 替换为 `play` 拿无水印视频，解码 `\u002F` 等转义字符
6. **缓存视频 URL** - 视频类型用短 ID（`v1` / `v2` …）缓存真实播放地址（30 分钟过期）。Cloudflare Pages 模式下存 KV 多实例共享，本地模式存内存 Map

### 带宽优化：预览直连 + 下载按需代理

| 场景 | 流量走向 | 服务器带宽占用 |
|------|---------|--------------|
| 图片预览 | `<img referrerpolicy="no-referrer">` 直连 CDN | **0** |
| 封面预览 | 同上 | **0** |
| 图片下载 | `<a href="直链" download rel="noreferrer">` 跨域下载 | **0** |
| 封面下载 | 同上 | **0** |
| 视频预览 | 服务器代理（视频 CDN 强制校验 Referer，浏览器无法直连） | 占用 |
| 视频下载·主按钮 | 服务器代理（兼容性最佳） | 占用 |
| 视频下载·直链另存 | 新标签打开直链 → 用户右键"视频另存为" | **0** |

> 盗链机制：图片 CDN 接受空 Referer 直接放行，视频 CDN 强制校验合规 Referer，空 Referer 返回 403 被 Chrome ORB 拦截。
> 代理侧统一注入 `Referer: https://www.douyin.com/` + iPhone Safari UA 取流。

### 视频代理特性

- **流式透传**：`fetch → Response.body → new Response(...)`（Pages）或 `http.request → pipe(res)`（本地），不在服务器内存中缓存媒体，大视频也 O(1) 内存
- **Range 断点续传**：原样透传 `Range` 请求头与 `Content-Range` 响应头，拖动进度条 / 下载软件续传均可
- **跨域可用**：代理返回加 `Access-Control-Allow-Origin: *`，前端在预览直连失败时回退到代理也能正常拿到 Blob

---

## 🧪 本地调试 Pages Functions（可选）

项目提供 `wrangler` 一键本地调试 Pages 函数：

```bash
# （首次需要安装 wrangler 到全局或到项目 devDeps，已写在 npm scripts）
npm run pages:dev
```

会在 **http://localhost:8788** 启一个模拟 Pages 的服务，等同线上 Pages Functions + 静态托管行为。调试完毕后推 Git 即自动部署。

---

## 📄 许可证

MIT License

## ⚠️ 免责声明

本项目仅供学习研究使用，请勿用于商业用途。使用本工具请遵守相关服务条款，尊重创作者的知识产权。
