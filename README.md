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
├── node_modules/          # 依赖包
└── public/                # 前端静态文件
    └── index.html         # 前端页面
```

## 🔧 API 接口

### 解析接口（统一入口）

自动识别内容是视频还是图文。

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

- **后端**: Node.js + Express
- **前端**: 原生 HTML/CSS/JavaScript
- **视频/图片代理**: Node 原生 http/https 模块 + 流式传输
- **缓存**: 内存缓存（30分钟过期）

## 📝 实现原理

### 解析流程

1. 访问抖音短链接，跟随重定向获取真实 URL
2. 从 URL 中提取内容 ID，并判断类型（视频 video / 图文 note）
3. 访问移动端分享页面（iesdouyin.com）
4. 从 HTML 中提取 `window._ROUTER_DATA` JSON 数据
5. 从 JSON 数据中提取视频播放地址或图片列表
6. 获取 CDN 真实视频 URL 并缓存（视频类型）

### 视频/图片代理

- 服务器端添加 `Referer: https://www.douyin.com/` 和 `User-Agent` 请求头
- 支持流式传输和 Range 断点续传（视频）
- 视频使用短 ID 缓存机制，避免 URL 过长问题
- 图片通过代理接口绕过防盗链限制

### 自动类型识别

通过 URL 路径自动识别内容类型：
- `/video/xxx` → 视频类型
- `/note/xxx` → 图文类型

## 📄 许可证

MIT License

## ⚠️ 免责声明

本项目仅供学习研究使用，请勿用于商业用途。使用本工具请遵守抖音相关服务条款，尊重视频创作者的知识产权。
