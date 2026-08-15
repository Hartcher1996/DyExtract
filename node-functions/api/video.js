// node-functions/api/video.js — EdgeOne Pages Node Function: /api/video
import core from '../../lib/core.js';
import { createRequire } from 'module';

const _core = (core && core.default && !core.MOBILE_UA) ? core.default : core;
const { MOBILE_UA, setKVStore, setUseNodeHttp, getCachedVideo } = _core || {};

if (setUseNodeHttp) setUseNodeHttp(true);
console.log('[video.js] 已强制使用 Node.js 原生 http 模块');

const _require = createRequire(import.meta.url);
try {
    const sdk = _require('@edgeone/cloudfunctions-sdk');
    if (sdk?.KVNamespace?.getBinding) {
        const ns = sdk.KVNamespace.getBinding('VIDEO_CACHE');
        if (ns && typeof ns.put === 'function') setKVStore(ns);
    }
} catch (e) {}

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

export async function onRequest(context) {
    const request = context.request;
    const url = new URL(request.url);
    console.log(`[video.js] onRequest: ${request.method}${url.search}`);

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

    let videoUrl = url.searchParams.get('url');
    const id = url.searchParams.get('id');
    const download = url.searchParams.get('download');

    if (id) {
        const c = await getCachedVideo(id);
        if (c) videoUrl = c.url;
        else return jsonResponse({ error: '视频缓存已过期，请重新解析' }, 404);
    }
    if (!videoUrl) return jsonResponse({ error: '缺少URL参数' }, 400);

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
        console.error('[video.js] ERROR:', e && e.message);
        return jsonResponse({ error: '视频代理失败: ' + e.message }, 500);
    }
}
