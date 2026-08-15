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
console.log('[EdgeOne] 已强制使用 Node.js 原生 http 模块');

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
        hasAbortController: typeof AbortController !== 'undefined',
        useNodeHttp: true,
        nodeVersion: process.version,
        coreOK: typeof buildParseResponse === 'function',
        coreKeys: _core ? Object.keys(_core) : null
    });
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
            const req = client.request({
                hostname: u.hostname,
                port: u.port || (u.protocol === 'https:' ? 443 : 80),
                path: u.pathname + u.search,
                method: 'GET',
                rejectUnauthorized: false,
                headers: { 'User-Agent': MOBILE_UA }
            }, (res) => {
                const chunks = [];
                res.on('data', c => chunks.push(c));
                res.on('end', () => {
                    resolve({
                        status: res.statusCode,
                        timeMs: Date.now() - t0,
                        body: Buffer.concat(chunks).toString('utf-8')
                    });
                });
            });
            req.on('error', reject);
            req.setTimeout(8000, () => { req.destroy(); reject(new Error('Node http 超时(8s)')); });
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

    console.log('[handleParse] URL:', rawUrl);
    const t0 = Date.now();

    // 全局超时保护：EdgeOne 函数 30s 限制，25s 超时留 5s 余量返回响应
    const GLOBAL_TIMEOUT = 25000;

    try {
        const result = await Promise.race([
            buildParseResponse(rawUrl),
            new Promise((_, reject) =>
                setTimeout(() => reject(new Error('解析全局超时(' + GLOBAL_TIMEOUT + 'ms)')), GLOBAL_TIMEOUT)
            )
        ]);
        console.log('[handleParse] 解析成功, 耗时:', Date.now() - t0, 'ms');
        return jsonResponse(result.payload || result);
    } catch (e) {
        console.error('[解析错误] 耗时:', Date.now() - t0, 'ms,', e && e.message, e && e.stack);
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

            const req = client.request({
                hostname: u.hostname,
                port: u.port || (u.protocol === 'https:' ? 443 : 80),
                path: u.pathname + u.search,
                method: 'GET',
                rejectUnauthorized: false,
                headers: reqHeaders
            }, (pres) => {
                if (pres.statusCode >= 301 && pres.statusCode <= 308 && pres.headers.location) {
                    let loc = pres.headers.location;
                    if (loc.startsWith('/')) loc = u.protocol + '//' + u.hostname + loc;
                    pres.resume();
                    return resolve(proxyVideo(loc, redirectCount + 1));
                }
                if (pres.statusCode >= 400) {
                    pres.resume();
                    return resolve(jsonResponse({ error: `视频请求失败: ${pres.statusCode}` }, pres.statusCode));
                }

                const chunks = [];
                pres.on('data', c => chunks.push(c));
                pres.on('end', () => {
                    const body = Buffer.concat(chunks);
                    const headers = {
                        'Access-Control-Allow-Origin': '*',
                        'Content-Type': pres.headers['content-type'] || 'video/mp4',
                        'Accept-Ranges': 'bytes'
                    };
                    if (pres.headers['content-length']) headers['Content-Length'] = pres.headers['content-length'];
                    if (pres.headers['content-range']) headers['Content-Range'] = pres.headers['content-range'];
                    if (download) headers['Content-Disposition'] = 'attachment; filename="douyin_video.mp4"';
                    resolve(new Response(body, { status: pres.statusCode, headers }));
                });
                pres.on('error', reject);
            });
            req.on('error', reject);
            req.setTimeout(28000, () => { req.destroy(); reject(new Error('视频请求超时')); });
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

            const req = client.request({
                hostname: u.hostname,
                port: u.port || (u.protocol === 'https:' ? 443 : 80),
                path: u.pathname + u.search,
                method: 'GET',
                rejectUnauthorized: false,
                headers: {
                    'User-Agent': MOBILE_UA,
                    'Referer': 'https://www.douyin.com/',
                    'Accept': 'image/*,image/webp,image/apng,*/*;q=0.8',
                    'Accept-Language': 'zh-CN,zh;q=0.9'
                }
            }, (pres) => {
                if (pres.statusCode >= 301 && pres.statusCode <= 308 && pres.headers.location) {
                    let loc = pres.headers.location;
                    if (loc.startsWith('/')) loc = u.protocol + '//' + u.hostname + loc;
                    pres.resume();
                    return resolve(proxyCover(loc, redirectCount + 1));
                }
                if (pres.statusCode >= 400) {
                    pres.resume();
                    return resolve(jsonResponse({ error: `封面请求失败: ${pres.statusCode}` }, pres.statusCode));
                }

                const chunks = [];
                pres.on('data', c => chunks.push(c));
                pres.on('end', () => {
                    const body = Buffer.concat(chunks);
                    const headers = {
                        'Access-Control-Allow-Origin': '*',
                        'Content-Type': pres.headers['content-type'] || 'image/jpeg'
                    };
                    if (pres.headers['content-length']) headers['Content-Length'] = pres.headers['content-length'];
                    if (download) headers['Content-Disposition'] = 'attachment; filename="douyin_cover.jpg"';
                    resolve(new Response(body, { status: pres.statusCode, headers }));
                });
                pres.on('error', reject);
            });
            req.on('error', reject);
            req.setTimeout(15000, () => { req.destroy(); reject(new Error('封面请求超时')); });
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
        if (path === '/api/test') return await handleTest(request);
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
