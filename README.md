# DyExtract - 短视频无水印解析与预览工具

一个完全自建的短视频分享链接解析工具，**不依赖任何第三方解析 API，不使用 Puppeteer / Playwright 等无头浏览器**。纯前端 + Cloudflare Pages Functions 零成本部署。

## ✨ 功能特性

- 🔗 **链接解析** - 自动识别短链、分享文本，提取真实视频/图文内容 ID
- 🎬 **视频解析** - 解析无水印视频，在线预览播放，支持一键下载
- 🖼️ **图文解析** - 自动识别图文类型，提取全部图片，单张或批量下载
- 📸 **封面下载** - 视频封面预览 + 一键下载
- 📱 **响应式布局** - PC / 移动端自适应，视频区按 9:16 比例展示
- 🛡️ **防盗链绕过** - 图片预览直连零带宽，视频代理注入合规 `Referer`
- ⚡ **完全自建** - 解析逻辑全部自写，直接请求抖音官方 API
- 🪶 **零成本运行** - 部署在 Cloudflare Pages，免费额度足够个人使用
  - Functions 调用：10 万次 / 天
  - 出站带宽：**无限免费**
- 🔓 **不绑定 KV 也能跑** - 视频 URL 直接从前端传到代理接口，KV 仅作为可选缓存优化

## 支持的平台

目前支持 **抖音**（`douyin.com` / `iesdouyin.com` / `v.douyin.com` 短链）。

---

## 🚀 一键部署到 Cloudflare Pages（推荐，零成本）

### 第一步：Fork 并创建 Pages 项目

1. 点击页面右上角 **Fork** 把本仓库克隆到你自己的 GitHub 账号
2. 打开 [Cloudflare Dashboard → Workers & Pages](https://dash.cloudflare.com/?to=/:account/workers-and-pages)
3. 点击 **Create → Pages → Connect to Git**
4. 授权 GitHub，选择你刚 Fork 的 `DyExtract` 仓库，点击 **Begin setup**
5. 构建设置（框架预设选 **None**）：
   - **Build command**：留空（本项目没有构建步骤，静态文件直接在 `public/`）
   - **Build output directory**：`public`
6. 点击 **Save and Deploy**，等待 1~2 分钟首次部署完成
7. 访问部署好的 `*.pages.dev` 域名，能看到首页即成功

### 第二步：绑定 KV（可选，跨实例缓存优化）

> **跳过也能完全正常使用**。KV 仅作为跨实例的视频 URL 缓存优化（30 分钟 TTL），不绑 KV 时前端直接通过 `?url=` 参数把直链传给代理接口，效果完全相同。

1. Cloudflare 控制台 → **Workers & Pages → KV**
2. 点击 **Create a namespace**
3. **Name** 填 `VIDEO_CACHE`（必须完全一致），点击 **Add**
4. 回到 Pages 项目 → **Settings → Functions**
5. 找到 **KV namespace bindings** → **Add binding**：
   - **Variable name**：`VIDEO_CACHE`（大小写敏感，必须完全一致）
   - **KV namespace**：选择刚创建的 `VIDEO_CACHE`
6. 保存后随便推一个空提交触发重新部署（或在 Deployments 页对最近成功部署点 **Retry deployment**）

### 第三步：自定义域名（可选）

1. Pages 项目 → **Custom domains → Set up a custom domain**
2. 输入你的域名（如果 DNS 托管在 Cloudflare，会自动配 CNAME 和 SSL）
3. 等待证书签发完毕即可用 `https://你的域名` 访问

---

## 📁 项目结构

```
.
├── lib/
│   └── core.js                # 核心解析逻辑：URL 解析 + ttwid + 签名 + 抖音 API + 缓存
├── functions/                 # Cloudflare Pages Functions（按文件映射路由）
│   └── api/
│       └── entry.js           # 统一入口：/__dy__/entry?action=parse|video|cover|health
├── public/                    # 静态资源（Pages 直接托管，不走函数）
│   ├── index.html             # 前端页面
│   └── favicon.ico
├── package.json               # 脚本 + 依赖（仅 wrangler 作为 devDependency）
├── LICENSE                    # MIT
└── README.md
```

**路由匹配（Cloudflare Pages Functions）：**

| 文件 | 匹配路径 |
|------|---------|
| `functions/api/entry.js` | `/api/entry` |

前端实际走 `/api/entry?action=parse`，由 `entry.js` 根据 `action` 参数分发到 parse/video/cover/health 四个逻辑。所有非 `/api/*` 的路径（`/`、`index.html`、favicon 等）直接走静态托管，不触发函数。

---

## 🔧 API 接口

前端统一使用 `/api/entry?action=` 入口。`action` 缺省时默认为 `parse`。

### 解析

```
GET  /api/entry?action=parse&url=<URL编码的分享链接>
POST /api/entry?action=parse
Content-Type: application/json

{ "url": "<分享链接>" }
```

**视频响应示例：**

```json
{
  "success": true,
  "type": "video",
  "video_key": "v1",
  "title": "视频标题",
  "author": "作者名称",
  "play_url": "https://...无水印直链...",
  "cover": "https://...封面...",
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
    { "url": "https://...图片直链...", "width": 1440, "height": 1440, "uri": "..." }
  ],
  "cover": "https://...",
  "item_id": "7597706291793311333",
  "platform": "douyin",
  "source": "self"
}
```

### 视频代理

```
GET /api/entry?action=video&url=<URL编码的抖音直链>
GET /api/entry?action=video&url=<...>&download=1      # 触发浏览器下载
GET /api/entry?action=video&id=<video_key>            # 旧模式（需绑定 KV）
```

- `download=1`：返回 `Content-Disposition: attachment`，浏览器弹出保存
- **支持 HTTP Range**：拖动进度条、下载工具续传均可正常使用

### 封面 / 图片代理

```
GET /api/entry?action=cover&url=<图片URL>
GET /api/entry?action=cover&url=<图片URL>&download=1
```

> 前端预览时图片走 `<img referrerpolicy="no-referrer">` 直连，**不占任何带宽**；仅当直连被跨域拦截时才回退到此代理。

### 健康检查

```
GET /api/entry?action=health
```

返回 `{ "status": "ok", "ts": 1700000000000 }`，用于监控或快速验证 Functions 是否正常。

---

## 🧠 解析原理（三级降级策略）

1. **提取 itemId** — 处理短链重定向，正则匹配 17~19 位数字内容 ID；若 URL 中直接有 ID 则跳过跳转
2. **获取 ttwid + Cookie** — 调用 `ttwid.bytedance.com/union/register/` 注册会话，得到合法 ttwid Cookie
3. **策略 A：Share 页 SSR 数据提取** — 模拟 iPhone Safari UA 访问公开分享页，从 `window._ROUTER_DATA` 中深度优先搜索媒体节点
4. **策略 B：官方 aweme API 提取** — 带 ttwid Cookie + 生成的 `a_bogus` 签名调用 `/aweme/v1/web/aweme/detail/`，从 `aweme_detail` 取媒体
5. **URL 清洗** — `playwm` → `play` 去水印，Unicode 转义还原

---

## 带宽优化：预览直连 + 下载按需代理

| 场景 | 实现方式 | 服务器带宽 |
|------|---------|-----------|
| 图片预览 | `<img referrerpolicy="no-referrer">` 直连 CDN | **0** |
| 图片下载 | `<a href="直链" download rel="noreferrer">` 跨域下载 | **0** |
| 封面预览 / 下载 | 同上 | **0** |
| 视频预览 | Functions 代理注入合规 Referer 取流 | 占用 |
| 视频下载主按钮 | Functions 代理（兼容性最佳） | 占用 |
| 视频直链另存 | 新标签打开直链 + 用户右键另存 | **0** |

视频 CDN 强制校验 `Referer`，浏览器空 Referer 直连会 403 被 Chrome ORB 拦截，因此视频必须经过代理；图片 CDN 接受空 Referer 可直接放行。

---

## 🛠️ 本地调试（可选）

```bash
# 克隆仓库
git clone https://github.com/Hartcher1996/DyExtract.git
cd DyExtract

# 安装依赖（只有 wrangler，作为 devDependency）
npm install

# 本地模拟 Cloudflare Pages Functions（端口 8788）
npm run pages:dev
```

首次运行会弹出浏览器要求授权 Cloudflare 账号（登录一次即可）。访问 `http://localhost:8788` 等同线上 Pages 行为，改完代码推 Git 自动部署。

---

## ❓ 常见问题

### Q: 解析失败 / 返回 "解析服务暂不可用" 怎么办？

1. 先访问 `/api/entry?action=health`，如果返回 JSON 说明 Functions 正常；如果返回 HTML 545 或 404，检查 Pages 项目是否部署成功
2. 打开浏览器 DevTools → Network，看 `/api/entry?action=parse` 的响应内容是什么
3. 抖音接口可能偶发限流，多试一次通常能成功

### Q: 视频无法直链下载 / 预览只有封面图？

视频直链必须经过代理（抖音 CDN 校验 Referer），检查：
- Functions 是否成功部署（`/api/entry?action=health`）
- 视频代理走 `/api/entry?action=video&url=` 而不是直链

### Q: 绑定自定义域名后视频仍无法播放？

确认自定义域名的 DNS 已切到 Cloudflare（黄色云朵开启），且 Pages 项目里证书状态为 **Active**。

---

## 📄 许可证

MIT License

## ⚠️ 免责声明

本项目仅供学习研究使用，请勿用于商业用途。使用本工具请遵守相关服务条款，尊重创作者的知识产权。
