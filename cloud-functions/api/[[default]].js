// cloud-functions/api/[[default]].js — EdgeOne Pages Cloud Functions 入口
//
// 关键发现（从日志）：
//   1. Runtime 是 Node.js 20.19，有原生 fetch（不需要 polyfill）
//   2. EdgeOne 用 esbuild 打包成单个 /var/user/index.mjs
//      → require('相对路径') 在打包后不存在
//      → require('express') 不可用（node_modules 不打包）
//      → 必须用 ESM import 让 esbuild 在构建时内联（lib/core.js 会被打包进去）
//   3. export default 是一个 (req, res) => {} HTTP handler
//   4. 不能用 top-level await（esbuild target 是 node14）
//
// 方案：完全自包含，零 Express 依赖
// ————————————————————————————————————————————————————————————————————

// ESM import → esbuild 构建时内联打包 lib/core.js
import core from '../../lib/core.js';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const {
    MOBILE_UA,
    setKVStore,
    getCachedVideo,
    buildParseResponse
} = core;

// ========== KV 绑定（可选，失败降级内存 Map） ==========
// createRequire 用于运行时 require EdgeOne 内置 SDK（不是 npm 包，esbuild 不会打包它）
try {
    const sdk = require('@edgeone/cloudfunctions-sdk');
    if (sdk?.KVNamespace?.getBinding) {
        const ns = sdk.KVNamespace.getBinding('VIDEO_CACHE');
        if (ns && typeof ns.put === 'function' && typeof ns.get === 'function') {
            setKVStore(ns);
            console.log('[EdgeOne] KV 绑定成功');
        }
    }
} catch (e) {
    console.log('[EdgeOne] KV 不可用，使用内存缓存');
}

// ========== 工具函数 ==========

function cors(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, HEAD');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range, If-None-Match, If-Modified-Since');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Content-Length, Accept-Ranges');
}

function json(res, data, status = 200) {
    cors(res);
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(data));
}

function getQueryParam(urlStr, key) {
    try {
        const u = new URL(urlStr, 'http://localhost');
        return u.searchParams.get(key) || '';
    } catch { return ''; }
}

// ========== 路由处理 ==========

// /api/health
function handleHealth(req, res) {
    json(res, {
        status: 'ok',
        runtime: 'edgeone-nodejs20',
        ts: Date.now(),
        hasFetch: typeof fetch === 'function'
    });
}

// /api/parse (POST) | /api/douyin (GET) | /api/douyin/self (GET)
async function handleParse(req, res, urlStr) {
    let rawUrl = getQueryParam(urlStr, 'url');
    if (!rawUrl && req.method === 'POST') {
        // 读取 POST body
        const body = await new Promise((resolve) => {
            let data = '';
            req.on('data', c => data += c);
            req.on('end', () => resolve(data));
        });
        try { rawUrl = JSON.parse(body).url || ''; } catch { rawUrl = ''; }
    }
    if (!rawUrl) return json(res, { error: '缺少URL参数' }, 400);

    try {
        const { payload } = await buildParseResponse(rawUrl);
        json(res, payload);
    } catch (e) {
        console.error('[EdgeOne] 解析失败:', e.message);
        json(res, { error: e.message || '解析失败' }, 500);
    }
}

// /api/video?url=...  (视频代理)
async function handleVideo(req, res, urlStr) {
    let videoUrl = getQueryParam(urlStr, 'url');
    const id = getQueryParam(urlStr, 'id');
    const download = getQueryParam(urlStr, 'download');

    if (id) {
        const c = await getCachedVideo(id);
        if (c) videoUrl = c.url;
        else return json(res, { error: '视频缓存已过期，请重新解析' }, 404);
    }
    if (!videoUrl) return json(res, { error: '缺少URL参数' }, 400);

    try {
        const fwdHeaders = {
            'User-Agent': MOBILE_UA,
            'Referer': 'https://www.douyin.com/',
            'Accept': '*/*',
            'Accept-Language': 'zh-CN,zh;q=0.9',
            'Accept-Encoding': 'identity'
        };
        // 透传 Range
        const range = req.headers['range'];
        if (range) fwdHeaders['Range'] = range;

        const resp = await fetch(videoUrl, {
            method: 'GET',
            headers: fwdHeaders,
            redirect: 'follow'
        });

        cors(res);
        res.statusCode = resp.status;
        res.setHeader('Content-Type', resp.headers.get('content-type') || 'video/mp4');
        res.setHeader('Accept-Ranges', 'bytes');
        const cl = resp.headers.get('content-length');
        if (cl) res.setHeader('Content-Length', cl);
        const cr = resp.headers.get('content-range');
        if (cr) res.setHeader('Content-Range', cr);
        if (download) res.setHeader('Content-Disposition', 'attachment; filename="douyin_video.mp4"');

        // 流式传输
        const reader = resp.body.getReader();
        const pump = async () => {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                res.write(value);
            }
            res.end();
        };
        pump().catch(e => {
            console.error('[EdgeOne] 视频流错误:', e.message);
            if (!res.writableEnded) res.end();
        });
    } catch (e) {
        console.error('[EdgeOne] 视频代理失败:', e.message);
        json(res, { error: '视频代理失败: ' + e.message }, 500);
    }
}

// /api/cover?url=...  (封面代理)
async function handleCover(req, res, urlStr) {
    const target = getQueryParam(urlStr, 'url');
    const download = getQueryParam(urlStr, 'download');
    if (!target) return json(res, { error: '缺少URL参数' }, 400);

    try {
        const fwdHeaders = {
            'User-Agent': MOBILE_UA,
            'Referer': 'https://www.douyin.com/',
            'Accept': 'image/*,image/webp,image/apng,*/*;q=0.8',
            'Accept-Language': 'zh-CN,zh;q=0.9',
            'Accept-Encoding': 'gzip, deflate, br'
        };

        const resp = await fetch(target, {
            method: 'GET',
            headers: fwdHeaders,
            redirect: 'follow'
        });

        cors(res);
        res.statusCode = resp.status;
        res.setHeader('Content-Type', resp.headers.get('content-type') || 'image/jpeg');
        if (download) res.setHeader('Content-Disposition', 'attachment; filename="douyin_cover.jpg"');

        const reader = resp.body.getReader();
        const pump = async () => {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                res.write(value);
            }
            res.end();
        };
        pump().catch(e => {
            if (!res.writableEnded) res.end();
        });
    } catch (e) {
        json(res, { error: '封面代理失败: ' + e.message }, 500);
    }
}

// ========== 主请求处理 ==========

export default async function handler(req, res) {
    const urlStr = req.url || '/';
    const method = req.method || 'GET';

    // CORS 预检
    if (method === 'OPTIONS') {
        cors(res);
        res.statusCode = 204;
        return res.end();
    }

    console.log(`[EdgeOne] ${method} ${urlStr}`);

    // 路由匹配
    // EdgeOne catch-all 可能传入 /api/xxx 或 /xxx，统一处理
    let path = urlStr.split('?')[0];
    if (!path.startsWith('/api/') && path !== '/api') {
        // 补 /api 前缀
        path = '/api' + (path.startsWith('/') ? path : '/' + path);
    }

    try {
        if (path === '/api/health') return handleHealth(req, res);
        if (path === '/api/parse' || path === '/api/douyin' || path === '/api/douyin/self') {
            return await handleParse(req, res, urlStr);
        }
        if (path === '/api/video') return await handleVideo(req, res, urlStr);
        if (path === '/api/cover') return await handleCover(req, res, urlStr);

        json(res, { error: 'API 路由不存在: ' + method + ' ' + path }, 404);
    } catch (e) {
        console.error('[EdgeOne] 未捕获异常:', e.message, e.stack);
        if (!res.writableEnded) {
            json(res, { error: '服务器内部错误: ' + e.message }, 500);
        }
    }
}
