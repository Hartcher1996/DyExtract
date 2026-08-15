// node-functions/api/[[default]].js — EdgeOne Pages Node Functions 入口
//
// 模式：EdgeOne 原生 onRequest handler（不用 Express，避免 esbuild 兼容问题）
// Runtime: Node.js v20.x，有原生 fetch
// 目录匹配：node-functions/api/[[default]].js → /api/*
//
// 可用的 context:
//   context.request - Web Standard Request
//   context.params   - 路由参数（这里用不到，[[default]] 把所有子路径兜住了）
//   context.env      - 环境变量
//   context.waitUntil - 延长请求生命周期
// ————————————————————————————————————————————————————————————————————

import core from '../../lib/core.js';
import { createRequire } from 'module';

// 兼容 esbuild 打包后的 default 嵌套
const _core = (core && core.default && !core.buildParseResponse) ? core.default : core;
const {
    MOBILE_UA,
    setKVStore,
    getCachedVideo,
    buildParseResponse
} = _core || {};

// KV 绑定（可选，不用 top-level await）
const _require = createRequire(import.meta.url);
try {
    const sdk = _require('@edgeone/cloudfunctions-sdk');
    if (sdk?.KVNamespace?.getBinding) {
        const ns = sdk.KVNamespace.getBinding('VIDEO_CACHE');
        if (ns && typeof ns.put === 'function') {
            setKVStore(ns);
            console.log('[EdgeOne] KV 绑定成功');
        }
    }
} catch (e) {
    console.log('[EdgeOne] KV 不可用，使用内存缓存');
}

// ========== 工具函数 ==========

function jsonResponse(data, status = 200, extraHeaders = {}) {
    const headers = {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, HEAD',
        'Access-Control-Allow-Headers': 'Content-Type, Range',
        ...extraHeaders
    };
    return new Response(JSON.stringify(data), { status, headers });
}

// 从 Request 对象提取路径和查询参数
function parseRequest(req) {
    const url = new URL(req.url);
    const path = url.pathname;
    return { path, query: url.searchParams };
}

// ========== 路由处理 ==========

// /api/health
async function handleHealth(request) {
    const { path } = parseRequest(request);
    return jsonResponse({
        status: typeof buildParseResponse === 'function' ? 'ok' : 'core_loading_error',
        runtime: 'edgeone-node-functions',
        path,
        ts: Date.now(),
        hasFetch: typeof fetch === 'function',
        nodeVersion: process.version,
        coreOK: typeof buildParseResponse === 'function',
        coreKeys: _core ? Object.keys(_core) : null
    });
}

// /api/douyin?url=...
// /api/parse  (POST)
async function handleParse(request) {
    let rawUrl;
    if (request.method === 'POST') {
        try {
            const body = await request.json();
            rawUrl = body?.url;
        } catch {
            const { query } = parseRequest(request);
            rawUrl = query.get('url');
        }
    } else {
        const { query } = parseRequest(request);
        rawUrl = query.get('url');
    }
    if (!rawUrl) return jsonResponse({ error: '缺少URL参数' }, 400);

    try {
        const { payload } = await buildParseResponse(rawUrl);
        return jsonResponse(payload);
    } catch (e) {
        console.error('[解析错误]', e && e.message, e && e.stack);
        return jsonResponse({ error: e.message || '解析失败' }, 500);
    }
}

// /api/video?url=...  (视频代理，直接 fetch 流式透传)
async function handleVideo(request) {
    const { query } = parseRequest(request);
    let videoUrl = query.get('url');
    const id = query.get('id');
    const download = query.get('download');

    if (id) {
        const c = await getCachedVideo(id);
        if (c) videoUrl = c.url;
        else return jsonResponse({ error: '视频缓存已过期，请重新解析' }, 404);
    }
    if (!videoUrl) return jsonResponse({ error: '缺少URL参数' }, 400);

    try {
        const fwdHeaders = {
            'User-Agent': MOBILE_UA,
            'Referer': 'https://www.douyin.com/',
            'Accept': '*/*',
            'Accept-Language': 'zh-CN,zh;q=0.9'
        };
        if (request.headers.get('range')) fwdHeaders['Range'] = request.headers.get('range');

        const resp = await fetch(videoUrl, {
            method: 'GET',
            headers: fwdHeaders,
            redirect: 'follow'
        });

        const headers = {
            'Access-Control-Allow-Origin': '*',
            'Content-Type': resp.headers.get('content-type') || 'video/mp4',
            'Accept-Ranges': 'bytes'
        };
        const cl = resp.headers.get('content-length');
        if (cl) headers['Content-Length'] = cl;
        const cr = resp.headers.get('content-range');
        if (cr) headers['Content-Range'] = cr;
        if (download) headers['Content-Disposition'] = 'attachment; filename="douyin_video.mp4"';

        return new Response(resp.body, { status: resp.status, headers });
    } catch (e) {
        console.error('[视频代理错误]', e && e.message);
        return jsonResponse({ error: '视频代理失败: ' + e.message }, 500);
    }
}

// /api/cover?url=...  (封面代理)
async function handleCover(request) {
    const { query } = parseRequest(request);
    const target = query.get('url');
    const download = query.get('download');
    if (!target) return jsonResponse({ error: '缺少URL参数' }, 400);

    try {
        const fwdHeaders = {
            'User-Agent': MOBILE_UA,
            'Referer': 'https://www.douyin.com/',
            'Accept': 'image/*,image/webp,image/apng,*/*;q=0.8',
            'Accept-Language': 'zh-CN,zh;q=0.9'
        };

        const resp = await fetch(target, {
            method: 'GET',
            headers: fwdHeaders,
            redirect: 'follow'
        });

        const headers = {
            'Access-Control-Allow-Origin': '*',
            'Content-Type': resp.headers.get('content-type') || 'image/jpeg'
        };
        const cl = resp.headers.get('content-length');
        if (cl) headers['Content-Length'] = cl;
        if (download) headers['Content-Disposition'] = 'attachment; filename="douyin_cover.jpg"';

        return new Response(resp.body, { status: resp.status, headers });
    } catch (e) {
        return jsonResponse({ error: '封面代理失败: ' + e.message }, 500);
    }
}

// ========== 主入口：onRequest ==========

export async function onRequest(context) {
    const request = context.request;
    const method = request.method;
    const { path } = parseRequest(request);

    console.log(`[EdgeOne] ${method} ${path}`);

    // CORS 预检
    if (method === 'OPTIONS') {
        return new Response(null, {
            status: 204,
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, HEAD',
                'Access-Control-Allow-Headers': 'Content-Type, Range'
            }
        });
    }

    try {
        // 路由分发（onRequest 模式下 EdgeOne 不剥离前缀，传入的是完整路径 /api/xxx）
        if (path === '/api/health') return await handleHealth(request);
        if (path === '/api/parse' || path === '/api/douyin' || path === '/api/douyin/self') {
            return await handleParse(request);
        }
        if (path === '/api/video') return await handleVideo(request);
        if (path === '/api/cover') return await handleCover(request);

        return jsonResponse({ error: 'API 路由不存在: ' + method + ' ' + path }, 404);
    } catch (e) {
        console.error('[onRequest 未捕获异常]', e && e.message, e && e.stack);
        return jsonResponse({ error: '服务器内部错误: ' + (e.message || e) }, 500);
    }
}

// 同时导出 default 以兼容可能的框架模式回退
export default { onRequest };
