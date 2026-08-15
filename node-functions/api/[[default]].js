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
    setUseNodeHttp,
    getCachedVideo,
    buildParseResponse
} = _core || {};

// EdgeOne Cloud Functions 的全局 fetch() 无法发起外网请求，强制使用 Node.js 原生 http/https
if (setUseNodeHttp) setUseNodeHttp(true);

// KV 绑定（可选，不用 top-level await）
const _require = createRequire(import.meta.url);
try {
    const sdk = _require('@edgeone/cloudfunctions-sdk');
    if (sdk?.KVNamespace?.getBinding) {
        const ns = sdk.KVNamespace.getBinding('VIDEO_CACHE');
        if (ns && typeof ns.put === 'function') setKVStore(ns);
    }
} catch (e) { /* 降级使用内存缓存 */ }

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
        useNodeHttp: true,
        nodeVersion: process.version,
        coreOK: typeof buildParseResponse === 'function'
    });
}

// /api/debug — 逐步测试 performParse 各阶段
async function handleDebug(request) {
    const { query } = parseRequest(request);
    const rawUrl = query.get('url') || 'https://v.douyin.com/pbgLvxVWHoo/';
    const results = { steps: [], ts: Date.now() };

    if (!_core) return jsonResponse({ error: 'core not loaded' });

    // Step 1: 提取 URL + itemId
    const cleanUrl = _core.extractDouyinUrl(rawUrl);
    results.steps.push({ step: '1-extract-url', cleanUrl });

    let itemId = _core.extractItemId(cleanUrl);
    results.steps.push({ step: '1b-itemId-from-url', itemId: itemId || '(none)' });

    // Step 2: 如果没有 itemId，fetch 短链接
    if (!itemId) {
        try {
            const t0 = Date.now();
            const r = await _core.nativeRequest(cleanUrl, { timeoutMs: 10000 });
            itemId = _core.extractItemId(r.body || '');
            results.steps.push({
                step: '2-fetch-short-url',
                status: r.status,
                timeMs: Date.now() - t0,
                itemId: itemId || '(none)',
                bodyLen: (r.body || '').length,
                hasRouterData: (r.body || '').includes('_ROUTER_DATA'),
                hasRenderData: (r.body || '').includes('RENDER_DATA'),
                titleMatch: ((r.body || '').match(/<title>([^<]{0,80})<\/title>/i) || [])[1] || ''
            });
        } catch (e) {
            results.steps.push({ step: '2-fetch-short-url', error: e.message });
        }
    }

    if (!itemId) {
        results.steps.push({ step: 'error', message: '无法提取 itemId' });
        return jsonResponse(results);
    }

    // Step 3: fetch iesdouyin share page
    const shareUrl = `https://www.iesdouyin.com/share/video/${itemId}`;
    results.steps.push({ step: '3-share-url', url: shareUrl });
    let workingCookie = '';
    try {
        const t0 = Date.now();
        const r = await _core.nativeRequest(shareUrl, { timeoutMs: 10000 });
        workingCookie = _core.getCookiesFromHeaders(r.headers);
        const meta = _core.parseMetaInfo(r.body);
        const embedded = _core.parseFromEmbeddedData(r.body);
        const body = r.body || '';
        results.steps.push({
            step: '3-share-url',
            status: r.status,
            timeMs: Date.now() - t0,
            bodyLen: body.length,
            hasCookie: !!workingCookie,
            cookieLen: workingCookie.length,
            cookiePreview: workingCookie.substring(0, 80),
            metaTitle: meta.title ? meta.title.substring(0, 50) : '',
            metaImage: meta.image ? 'yes' : 'no',
            metaVideoUrl: meta.videoUrl ? 'yes' : 'no',
            embeddedPlayUrl: embedded.playUrl ? 'yes' : 'no',
            embeddedImages: embedded.images ? embedded.images.length : 0,
            embeddedTitle: embedded.title ? embedded.title.substring(0, 50) : '',
            hasRouterData: body.includes('_ROUTER_DATA'),
            hasRenderData: body.includes('RENDER_DATA'),
            hasPlayAddr: body.includes('play_addr'),
            hasVideoId: body.includes('video_id'),
            titleMatch: (body.match(/<title>([^<]{0,80})<\/title>/i) || [])[1] || '',
            bodyPreview: body.substring(0, 500)
        });
    } catch (e) {
        results.steps.push({ step: '3-share-url', error: e.message });
    }

    // Step 3b: 测试抖音新版详情页（www.douyin.com/video/）
    const detailUrl = `https://www.douyin.com/video/${itemId}`;
    results.steps.push({ step: '3b-douyin-detail', url: detailUrl });
    try {
        const t0 = Date.now();
        const r = await _core.nativeRequest(detailUrl, {
            headers: {
                'Cookie': workingCookie,
                'Referer': 'https://www.douyin.com/'
            },
            timeoutMs: 10000
        });
        const body = r.body || '';
        const meta = _core.parseMetaInfo(body);
        const embedded = _core.parseFromEmbeddedData(body);
        results.steps.push({
            step: '3b-douyin-detail',
            status: r.status,
            timeMs: Date.now() - t0,
            bodyLen: body.length,
            metaTitle: meta.title ? meta.title.substring(0, 50) : '',
            metaImage: meta.image ? 'yes' : 'no',
            metaVideoUrl: meta.videoUrl ? 'yes' : 'no',
            embeddedPlayUrl: embedded.playUrl ? 'yes' : 'no',
            hasRouterData: body.includes('_ROUTER_DATA'),
            hasRenderData: body.includes('RENDER_DATA'),
            hasPlayAddr: body.includes('play_addr'),
            hasPlaywm: body.includes('playwm'),
            titleMatch: (body.match(/<title>([^<]{0,80})<\/title>/i) || [])[1] || '',
            bodyPreview: body.substring(0, 500)
        });
    } catch (e) {
        results.steps.push({ step: '3b-douyin-detail', error: e.message });
    }

    // Step 3c: 测试 API 端点
    const apiUrl = `https://www.iesdouyin.com/web/api/v2/aweme/iteminfo/?item_ids=${itemId}`;
    results.steps.push({ step: '3c-api-test', url: apiUrl });
    try {
        const t0 = Date.now();
        const r = await _core.nativeRequest(apiUrl, {
            headers: {
                'Accept': 'application/json, text/plain, */*',
                'Cookie': workingCookie,
                'Referer': shareUrl,
                'X-Requested-With': 'XMLHttpRequest'
            },
            timeoutMs: 8000
        });
        const body = r.body || '';
        let parsed = null;
        if (body && body.trim().charCodeAt(0) === 123 /* '{' */) {
            try { parsed = JSON.parse(body); } catch (e) {}
        }
        results.steps.push({
            step: '3c-api-test',
            status: r.status,
            timeMs: Date.now() - t0,
            bodyLen: body.length,
            bodyPreview: body.substring(0, 300),
            isJson: !!parsed,
            hasItem: parsed ? !!(parsed.item_list?.[0] || parsed.aweme_detail) : false
        });
    } catch (e) {
        results.steps.push({ step: '3c-api-test', error: e.message });
    }

    // Step 4: 完整 buildParseResponse 测试
    results.steps.push({ step: '4-build-parse-response', url: rawUrl });
    try {
        const t0 = Date.now();
        const result = await _core.buildParseResponse(rawUrl);
        results.steps.push({
            step: '4-build-parse-response',
            success: true,
            timeMs: Date.now() - t0,
            isVideo: result.__isVideo,
            payloadKeys: result.payload ? Object.keys(result.payload) : []
        });
    } catch (e) {
        results.steps.push({
            step: '4-build-parse-response',
            success: false,
            error: e.message
        });
    }

    return jsonResponse(results);
}

// /api/test — 诊断端点：测试 Node.js 原生 http 模块的网络连通性
async function handleTest(request) {
    const { query } = parseRequest(request);
    const testUrl = query.get('url') || 'https://httpbin.org/get';
    const results = { steps: [], ts: Date.now(), useNodeHttp: true };

    // Step 1: 直接用 Node.js 原生 http 测试（带 8s 超时）
    results.steps.push({ step: '1-node-http', url: testUrl });
    try {
        const _require = createRequire(import.meta.url);
        const https = _require('https');
        const http = _require('http');
        const u = new URL(testUrl);
        const client = u.protocol === 'https:' ? https : http;

        const r = await new Promise((resolve, reject) => {
            const t0 = Date.now();
            const testAgent = new client.Agent({ keepAlive: false });
            const req = client.request({
                hostname: u.hostname,
                port: u.port || (u.protocol === 'https:' ? 443 : 80),
                path: u.pathname + u.search,
                method: 'GET',
                rejectUnauthorized: false,
                agent: testAgent,
                headers: { 'User-Agent': MOBILE_UA, 'Connection': 'close' }
            }, (res) => {
                const chunks = [];
                res.on('data', c => chunks.push(c));
                res.on('end', () => {
                    try { testAgent.destroy(); } catch (e) {}
                    resolve({
                        status: res.statusCode,
                        timeMs: Date.now() - t0,
                        body: Buffer.concat(chunks).toString('utf-8')
                    });
                });
            });
            req.on('error', (e) => { try { testAgent.destroy(); } catch (_) {} reject(e); });
            req.setTimeout(8000, () => { try { req.destroy(); } catch (_) {} try { testAgent.destroy(); } catch (_) {} reject(new Error('Node http 超时(8s)')); });
            req.end();
        });

        results.steps.push({
            step: '1-node-http',
            status: r.status,
            timeMs: r.timeMs,
            bodyLen: r.body.length,
            bodyPreview: r.body.substring(0, 200)
        });
    } catch (e) {
        results.steps.push({ step: '1-node-http', error: e.message });
    }

    // Step 2: nativeRequest 测试（已强制走 Node http 路径）
    if (_core && _core.nativeRequest) {
        results.steps.push({ step: '2-native-request', url: testUrl });
        try {
            const t0 = Date.now();
            const r = await _core.nativeRequest(testUrl, { timeoutMs: 8000 });
            results.steps.push({
                step: '2-native-request',
                status: r.status,
                timeMs: Date.now() - t0,
                bodyLen: (r.body || '').length,
                bodyPreview: (r.body || '').substring(0, 200)
            });
        } catch (e) {
            results.steps.push({ step: '2-native-request', error: e.message });
        }
    }

    // Step 3: 抖音短链接测试
    const douyinUrl = 'https://v.douyin.com/pbgLvxVWHoo/';
    results.steps.push({ step: '3-douyin-short', url: douyinUrl });
    try {
        const t0 = Date.now();
        const r = await _core.nativeRequest(douyinUrl, { timeoutMs: 10000 });
        results.steps.push({
            step: '3-douyin-short',
            status: r.status,
            timeMs: Date.now() - t0,
            bodyLen: (r.body || '').length,
            hasItemId: /(\d{17,19})/.test(r.body || ''),
            bodyPreview: (r.body || '').substring(0, 300)
        });
    } catch (e) {
        results.steps.push({ step: '3-douyin-short', error: e.message });
    }

    return jsonResponse(results);
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
        const result = await buildParseResponse(rawUrl);
        const payload = result.payload || result;
        return jsonResponse(payload);
    } catch (e) {
        return jsonResponse({ error: e.message || '解析失败' }, 500);
    }
}

// /api/video?url=...  (视频代理，Node.js 原生 http 流式透传)
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

    const _require = createRequire(import.meta.url);
    const https = _require('https');
    const http = _require('http');

    function proxyVideo(targetUrl, redirectCount) {
        return new Promise((resolve, reject) => {
            if (redirectCount > 5) return reject(new Error('重定向次数过多'));
            const u = new URL(targetUrl);
            const client = u.protocol === 'https:' ? https : http;
            const reqHeaders = {
                'User-Agent': MOBILE_UA,
                'Referer': 'https://www.douyin.com/',
                'Accept': '*/*',
                'Accept-Language': 'zh-CN,zh;q=0.9'
            };
            if (request.headers.get('range')) reqHeaders['Range'] = request.headers.get('range');

            const videoAgent = new client.Agent({ keepAlive: false });
            const req = client.request({
                hostname: u.hostname,
                port: u.port || (u.protocol === 'https:' ? 443 : 80),
                path: u.pathname + u.search,
                method: 'GET',
                rejectUnauthorized: false,
                agent: videoAgent,
                headers: { ...reqHeaders, 'Connection': 'close' }
            }, (pres) => {
                if (pres.statusCode >= 301 && pres.statusCode <= 308 && pres.headers.location) {
                    let loc = pres.headers.location;
                    if (loc.startsWith('/')) loc = u.protocol + '//' + u.hostname + loc;
                    pres.resume();
                    try { videoAgent.destroy(); } catch (e) {}
                    proxyVideo(loc, redirectCount + 1).then(resolve).catch(reject);
                    return;
                }
                if (pres.statusCode >= 400) {
                    pres.resume();
                    return resolve(jsonResponse({ error: `视频请求失败: ${pres.statusCode}` }, pres.statusCode));
                }
                // 流式传输，避免 413 Entity Too Large
                const headers = {
                    'Access-Control-Allow-Origin': '*',
                    'Content-Type': pres.headers['content-type'] || 'video/mp4',
                    'Accept-Ranges': 'bytes'
                };
                if (pres.headers['content-length']) headers['Content-Length'] = pres.headers['content-length'];
                if (pres.headers['content-range']) headers['Content-Range'] = pres.headers['content-range'];
                if (pres.headers['cache-control']) headers['Cache-Control'] = pres.headers['cache-control'];
                if (pres.headers['etag']) headers['ETag'] = pres.headers['etag'];
                if (download) headers['Content-Disposition'] = 'attachment; filename="douyin_video.mp4"';

                let closed = false;
                const stream = new ReadableStream({
                    start(ctrl) {
                        pres.on('data', (c) => {
                            if (closed) return;
                            ctrl.enqueue(new Uint8Array(c.buffer, c.byteOffset, c.byteLength));
                        });
                        pres.on('end', () => {
                            if (closed) return;
                            closed = true;
                            try { ctrl.close(); } catch (e) {}
                            try { videoAgent.destroy(); } catch (e) {}
                        });
                        pres.on('error', (err) => {
                            if (closed) return;
                            closed = true;
                            try { ctrl.error(err); } catch (e) {}
                            try { videoAgent.destroy(); } catch (e) {}
                        });
                    },
                    cancel() {
                        closed = true;
                        try { pres.destroy(); } catch (e) {}
                        try { videoAgent.destroy(); } catch (e) {}
                    }
                });
                resolve(new Response(stream, { status: pres.statusCode, headers }));
            });
            req.on('error', (e) => { try { videoAgent.destroy(); } catch (_) {} reject(e); });
            req.setTimeout(28000, () => { try { req.destroy(); } catch (_) {} try { videoAgent.destroy(); } catch (_) {} reject(new Error('视频请求超时')); });
            req.end();
        });
    }

    try {
        return await proxyVideo(videoUrl, 0);
    } catch (e) {
        console.error('[视频代理错误]', e && e.message);
        return jsonResponse({ error: '视频代理失败: ' + e.message }, 500);
    }
}

// /api/cover?url=...  (封面代理，Node.js 原生 http)
async function handleCover(request) {
    const { query } = parseRequest(request);
    const target = query.get('url');
    const download = query.get('download');
    if (!target) return jsonResponse({ error: '缺少URL参数' }, 400);

    const _require = createRequire(import.meta.url);
    const https = _require('https');
    const http = _require('http');

    function proxyCover(targetUrl, redirectCount) {
        return new Promise((resolve, reject) => {
            if (redirectCount > 5) return reject(new Error('重定向次数过多'));
            const u = new URL(targetUrl);
            const client = u.protocol === 'https:' ? https : http;

            const coverAgent = new client.Agent({ keepAlive: false });
            const req = client.request({
                hostname: u.hostname,
                port: u.port || (u.protocol === 'https:' ? 443 : 80),
                path: u.pathname + u.search,
                method: 'GET',
                rejectUnauthorized: false,
                agent: coverAgent,
                headers: {
                    'User-Agent': MOBILE_UA,
                    'Referer': 'https://www.douyin.com/',
                    'Accept': 'image/*,image/webp,image/apng,*/*;q=0.8',
                    'Accept-Language': 'zh-CN,zh;q=0.9',
                    'Connection': 'close'
                }
            }, (pres) => {
                if (pres.statusCode >= 301 && pres.statusCode <= 308 && pres.headers.location) {
                    let loc = pres.headers.location;
                    if (loc.startsWith('/')) loc = u.protocol + '//' + u.hostname + loc;
                    pres.resume();
                    try { coverAgent.destroy(); } catch (e) {}
                    proxyCover(loc, redirectCount + 1).then(resolve).catch(reject);
                    return;
                }
                if (pres.statusCode >= 400) {
                    pres.resume();
                    return resolve(jsonResponse({ error: `封面请求失败: ${pres.statusCode}` }, pres.statusCode));
                }
                // 封面一般较小，流式传输保险起见
                const headers = {
                    'Access-Control-Allow-Origin': '*',
                    'Content-Type': pres.headers['content-type'] || 'image/jpeg'
                };
                if (pres.headers['content-length']) headers['Content-Length'] = pres.headers['content-length'];
                if (pres.headers['cache-control']) headers['Cache-Control'] = pres.headers['cache-control'];
                if (pres.headers['etag']) headers['ETag'] = pres.headers['etag'];
                if (download) headers['Content-Disposition'] = 'attachment; filename="douyin_cover.jpg"';

                let closed = false;
                const stream = new ReadableStream({
                    start(ctrl) {
                        pres.on('data', (c) => {
                            if (closed) return;
                            ctrl.enqueue(new Uint8Array(c.buffer, c.byteOffset, c.byteLength));
                        });
                        pres.on('end', () => {
                            if (closed) return;
                            closed = true;
                            try { ctrl.close(); } catch (e) {}
                            try { coverAgent.destroy(); } catch (e) {}
                        });
                        pres.on('error', (err) => {
                            if (closed) return;
                            closed = true;
                            try { ctrl.error(err); } catch (e) {}
                            try { coverAgent.destroy(); } catch (e) {}
                        });
                    },
                    cancel() {
                        closed = true;
                        try { pres.destroy(); } catch (e) {}
                        try { coverAgent.destroy(); } catch (e) {}
                    }
                });
                resolve(new Response(stream, { status: pres.statusCode, headers }));
            });
            req.on('error', (e) => { try { coverAgent.destroy(); } catch (_) {} reject(e); });
            req.setTimeout(15000, () => { try { req.destroy(); } catch (_) {} try { coverAgent.destroy(); } catch (_) {} reject(new Error('封面请求超时')); });
            req.end();
        });
    }

    try {
        return await proxyCover(target, 0);
    } catch (e) {
        return jsonResponse({ error: '封面代理失败: ' + e.message }, 500);
    }
}

// ========== 主入口：onRequest ==========

export async function onRequest(context) {
    const request = context.request;
    const method = request.method;
    const url = new URL(request.url);
    const path = url.pathname;

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
        if (path === '/api/health') return await handleHealth(request);
        if (path === '/api/test') return await handleTest(request);
        if (path === '/api/debug') return await handleDebug(request);
        if (path === '/api/video') return await handleVideo(request);
        if (path === '/api/cover') return await handleCover(request);
        // 兜底：其余路径（/api/parse, /api/douyin, /api/douyin/self, /api/entry 等）只要带 url 参数就尝试解析
        return await handleParse(request);
    } catch (e) {
        console.error('[EdgeOne] ERROR:', e && e.message);
        return jsonResponse({ error: e.message || '服务器内部错误' }, 500);
    }
}

// 同时导出 default 以兼容可能的框架模式回退
export default { onRequest };
