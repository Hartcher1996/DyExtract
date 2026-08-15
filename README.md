# DyExtract - 抖音视频/图文解析工具

一个完全自建的抖音视频/图文解析去水印工具，不依赖任何第三方 API，支持在线预览和下载无水印视频及图片。

## ✨ 功能特性

- 🔗 **链接解析** - 支持抖音短链接、分享链接解析
- 🎬 **视频解析** - 解析视频，在线预览播放，下载无水印高清视频
- 🖼️ **图文解析** - 自动识别图文类型，提取所有图片
- 📸 **封面下载** - 支持视频封面预览和下载
- 📥 **批量下载** - 图文支持单张下载和批量下载全部图片
- 📱 **手机比例预览** - 视频/封面/图片均以 9:16 手机比例展示
- ℹ️ **信息展示** - 显示标题、作者、图片数量等信息
- 🛡️ **防盗链绕过** - 服务器代理绕过抖音防盗链限制
- ⚡ **自建API** - 完全独立自主解析，不依赖第三方服务
- 🪶 **轻量零依赖** - 仅依赖 express，无 Puppeteer/无浏览器进程，常驻内存 ~50MB

## 🚀 快速开始

### 环境要求

- **Node.js**: >= 18.0.0（推荐 20 LTS）
- **npm**: >= 8.0.0

### 安装与运行

```bash
# 克隆项目
git clone <your-repo-url>
cd dyextract

# 安装依赖
npm install

# 启动服务
npm start
```

启动后访问：**http://localhost:3001**

## 📁 项目结构

```
.
├── server.js              # 后端主程序 (Express)
├── package.json           # 项目配置
├── package-lock.json
├── LICENSE                # MIT 许可证
├── node_modules/          # 依赖包
└── public/                # 前端静态文件
    ├── index.html         # 前端页面
    └── favicon.ico        # 站点图标
```

## 🔧 API 接口

### 解析接口（前端主入口）

自动识别内容是视频还是图文，前端页面实际调用的接口。

```
POST /api/parse
Content-Type: application/json

{ "url": "<抖音分享链接>" }
```

也支持 query 方式：`POST /api/parse?url=<链接>`

### 解析接口（统一入口）

```
GET /api/douyin?url=<抖音分享链接>
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
    {
      "url": "https://...",
      "width": 1440,
      "height": 1440,
      "uri": "tos-cn-i-0813/..."
    }
  ],
  "item_id": "7597706291793311333",
  "cover": "https://...",
  "platform": "douyin",
  "source": "self"
}
```

### 自建解析接口（底层）

```
GET /api/douyin/self?url=<抖音分享链接>
```

与统一入口返回格式相同。

### 视频代理

```
GET /api/video?id=<video_key>
GET /api/video?id=<video_key>&download=1
```

- `id`: 视频缓存ID（由解析接口返回）
- `download`: 可选，加此参数会触发下载

### 图片/封面代理

```
GET /api/cover?url=<图片URL>
GET /api/cover?url=<图片URL>&download=1
```

- `url`: 原始图片/封面 URL（URL编码）
- `download`: 可选，加此参数会触发下载

## 🛠️ 技术栈

- **后端**: Node.js + Express（运行时唯一第三方依赖）
- **前端**: 原生 HTML/CSS/JavaScript
- **网络请求**: Node 原生 `https`/`http` 模块，支持 gzip/br/deflate 解压、重定向跟随、超时控制
- **视频/图片代理**: Node 原生模块流式传输，支持 Range 断点续传
- **缓存**: 内存缓存（视频 URL 30 分钟过期）
- **无**: Puppeteer / Playwright / 任何无头浏览器、任何第三方解析 API

## 📝 实现原理

### 解析流程（三级降级策略）

1. **提取 itemId** - 从短链跟随重定向，正则匹配 17~19 位数字内容 ID；若 URL 中直接含 ID 则跳过重定向
2. **请求分享页** - 模拟 iPhone Safari UA 访问 `https://www.iesdouyin.com/share/video/{itemId}`，绕过 WAF JS 挑战，拿到 ~38KB 的 SSR 页面及 `ttwid` Cookie
3. **策略 A：嵌入式数据提取** - 用括号配平算法从 HTML 中切出 `window._ROUTER_DATA`，递归深度优先搜索含 `video.play_addr` 或 `images` 的节点
4. **策略 B：官方 API 兜底** - 若策略 A 未取到媒体，带 Cookie 调用 `iesdouyin/douyin` 两个端点 × 两组参数组合，从 `aweme_detail` 中提取媒体
5. **URL 修复** - 将 `playwm` 替换为 `play` 拿无水印视频，解码 `\u002F` 等转义字符
6. **缓存视频 URL** - 视频类型用短 ID 缓存真实播放地址（30 分钟过期），避免长 URL 在前端传递

### 视频/图片代理

- **图片/封面预览直连抖音 CDN**：`<img>` 标签加 `referrerpolicy="no-referrer"`，浏览器不发送 Referer，绕过防盗链，零带宽占用
- **图片/封面下载直连**：跨域 `<a download>` 配合 `rel="noreferrer"` 可直接下载图片资源，不占用服务器带宽
- **视频预览走服务器代理**：抖音视频 CDN（`douyinvod.com`）强制校验 Referer，空 Referer 返回 403 HTML，Chrome ORB 会拦截，无法直连
- **视频下载双通道**：
  - 主按钮"下载视频"走服务器代理（兼容性最好）
  - 副按钮"直链另存"在新标签打开抖音直链，用户右键"视频另存为"，不占用服务器带宽
- 服务器端添加 `Referer: https://www.douyin.com/` 和 `User-Agent` 请求头
- 支持流式传输和 Range 断点续传（视频）
- 视频使用短 ID 缓存机制，避免 URL 过长问题

### 自动类型识别

通过 URL 路径自动识别内容类型：
- `/video/xxx` → 视频类型
- `/note/xxx` → 图文类型

## 📄 许可证

MIT License

## ⚠️ 免责声明

本项目仅供学习研究使用，请勿用于商业用途。使用本工具请遵守抖音相关服务条款，尊重视频创作者的知识产权。
