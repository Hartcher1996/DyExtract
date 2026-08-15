// node-functions/api/entry.js — 全新路径，避免 /api/parse 的平台缓存污染
// 使用 action 查询参数路由：?action=parse|douyin|video|cover (默认 parse)
import core from '../../lib/core.js';
import { createRequire } from 'module';

const _core = (core && core.default && !core.buildParseResponse) ? core.default : core;
const {
    MOBILE_UA,
    setKVStore,
    setUseNodeHttp,
    getCachedVideo,
    buildParseResponse
} = _core || {};

if (setUseNodeHttp) setUseNodeHttp(true);

const _require = createRequire(import.meta.url);
try {
    const sdk = _require('@edgeone/cloudfunctions-sdk');
    if (sdk?.KVNamespace?.getBinding) {
        const ns = sdk.KVNamespace.getBinding('VIDEO_CACHE');
        if (ns && typeof ns.put === 'function') setKVStore(ns);
    }
} catch (e) { /* 降级使用内存缓存 */ }

function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, HEAD',
            'Access-Control-Allow-Headers': 'Content-Type, Range'
        }
    });
}

function proxyMedia(targetUrl, kind, request, downloadFlag) {
    return new Promise((resolve, reject) => {
        const https = _require('https');
        const http = _require('http');
        function doProxy(url, depth) {
            if (depth > 5) return reject(new Error('重定向过多'));
            const u = new URL(url);
            const client = u.protocol === 'https:' ? https : http;
            const reqHeaders = {
                'User-Agent': MOBILE_UA,
                'Referer': 'https://www.douyin.com/',
                'Accept': kind === 'video' ? '*/*' : 'image/*,image/webp,image/apng,*/*;q=0.8',
                'Accept-Language': 'zh-CN,zh;q=0.9'
            };
            if (kind === 'video' && request.headers.get('range')) {
                reqHeaders['Range'] = request.headers.get('range');
            }
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
                    doProxy(loc, depth + 1);
                    return;
                }
                if (pres.statusCode >= 400) {
                    pres.resume();
                    return resolve(jsonResponse({ error: `${kind}请求失败: ${pres.statusCode}` }, pres.statusCode));
                }
                // —— 流式传输：用 ReadableStream 边读边发，避免 413 Entity Too Large ——
                const ct = kind === 'video'
                    ? (pres.headers['content-type'] || 'video/mp4')
                    : (pres.headers['content-type'] || 'image/jpeg');
                const outHeaders = {
                    'Access-Control-Allow-Origin': '*',
                    'Content-Type': ct
                };
                if (kind === 'video') outHeaders['Accept-Ranges'] = 'bytes';
                if (pres.headers['content-length']) outHeaders['Content-Length'] = pres.headers['content-length'];
                if (pres.headers['content-range']) outHeaders['Content-Range'] = pres.headers['content-range'];
                if (pres.headers['cache-control']) outHeaders['Cache-Control'] = pres.headers['cache-control'];
                if (pres.headers['last-modified']) outHeaders['Last-Modified'] = pres.headers['last-modified'];
                if (pres.headers['etag']) outHeaders['ETag'] = pres.headers['etag'];
                if (downloadFlag) {
                    const filename = kind === 'video' ? 'douyin_video.mp4' : 'douyin_cover.jpg';
                    outHeaders['Content-Disposition'] = `attachment; filename="${filename}"`;
                }

                // 用 Web ReadableStream 包装 Node 可读流，支持流式回传
                let closed = false;
                const stream = new ReadableStream({
                    start(controller) {
                        pres.on('data', (chunk) => {
                            if (closed) return;
                            controller.enqueue(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
                        });
                        pres.on('end', () => {
                            if (closed) return;
                            closed = true;
                            try { controller.close(); } catch (e) {}
                        });
                        pres.on('error', (err) => {
                            if (closed) return;
                            closed = true;
                            try { controller.error(err); } catch (e) {}
                        });
                    },
                    cancel() {
                        closed = true;
                        try { pres.destroy(); } catch (e) {}
                    }
                });

                resolve(new Response(stream, { status: pres.statusCode, headers: outHeaders }));
            });
            req.on('error', reject);
            req.setTimeout(kind === 'video' ? 28000 : 15000, () => {
                req.destroy();
                reject(new Error(`${kind}请求超时`));
            });
            req.end();
        }
        doProxy(targetUrl, 0);
    });
}

export async function onRequest(context) {
    const request = context.request;
    const url = new URL(request.url);
    const search = url.search;
    console.log(`[entry.js] REQUEST: ${request.method} /api/entry${search}`);

    if (request.method === 'OPTIONS') {
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
        const action = url.searchParams.get('action') || 'parse';

        if (action === 'health') {
            return jsonResponse({
                ok: true,
                ts: Date.now(),
                coreOK: typeof buildParseResponse === 'function'
            });
        }

        if (action === 'video' || action === 'cover') {
            let mediaUrl = url.searchParams.get('url');
            const id = url.searchParams.get('id');
            const download = url.searchParams.get('download');
            if (id && action === 'video') {
                const c = await getCachedVideo(id);
                if (c) mediaUrl = c.url;
                else return jsonResponse({ error: '视频缓存已过期' }, 404);
            }
            if (!mediaUrl) return jsonResponse({ error: '缺少URL参数' }, 400);
            return await proxyMedia(mediaUrl, action, request, !!download);
        }

        // 默认 parse / douyin
        let rawUrl = '';
        if (request.method === 'POST') {
            try {
                const body = await request.json();
                rawUrl = body?.url || '';
            } catch {}
        }
        if (!rawUrl) rawUrl = url.searchParams.get('url') || '';
        if (!rawUrl) return jsonResponse({ error: '缺少URL参数' }, 400);

        const result = await buildParseResponse(rawUrl);
        const payload = result.payload || result;
        return jsonResponse(payload);
    } catch (e) {
        console.error('[entry.js] ERROR:', e && e.message);
        return jsonResponse({ error: e.message || '解析失败' }, 500);
    }
}
