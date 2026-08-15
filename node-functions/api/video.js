// node-functions/api/video.js — EdgeOne Pages Node Function: /api/video
import core from '../../lib/core.js';
import { createRequire } from 'module';

const _core = (core && core.default && !core.buildParseResponse) ? core.default : core;
const { MOBILE_UA, setKVStore, setUseNodeHttp, getCachedVideo } = _core || {};

if (setUseNodeHttp) setUseNodeHttp(true);

const _require = createRequire(import.meta.url);

export async function onRequest(context) {
    const request = context.request;
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

    const u = new URL(request.url);
    let videoUrl = u.searchParams.get('url');
    const id = u.searchParams.get('id');
    const download = u.searchParams.get('download');

    if (id) {
        const c = await getCachedVideo(id);
        if (c) videoUrl = c.url;
        else return new Response(JSON.stringify({ error: '视频缓存已过期，请重新解析' }), {
            status: 404,
            headers: { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' }
        });
    }
    if (!videoUrl) return new Response(JSON.stringify({ error: '缺少URL参数' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' }
    });

    const https = _require('https');
    const http = _require('http');

    function proxyVideo(targetUrl, redirectCount) {
        return new Promise((resolve, reject) => {
            if (redirectCount > 5) return reject(new Error('重定向次数过多'));
            const tu = new URL(targetUrl);
            const client = tu.protocol === 'https:' ? https : http;
            const reqHeaders = {
                'User-Agent': MOBILE_UA,
                'Referer': 'https://www.douyin.com/',
                'Accept': '*/*',
                'Accept-Language': 'zh-CN,zh;q=0.9'
            };
            if (request.headers.get('range')) reqHeaders['Range'] = request.headers.get('range');

            const req = client.request({
                hostname: tu.hostname,
                port: tu.port || (tu.protocol === 'https:' ? 443 : 80),
                path: tu.pathname + tu.search,
                method: 'GET',
                rejectUnauthorized: false,
                headers: reqHeaders
            }, (pres) => {
                if (pres.statusCode >= 301 && pres.statusCode <= 308 && pres.headers.location) {
                    let loc = pres.headers.location;
                    if (loc.startsWith('/')) loc = tu.protocol + '//' + tu.hostname + loc;
                    pres.resume();
                    return resolve(proxyVideo(loc, redirectCount + 1));
                }
                if (pres.statusCode >= 400) {
                    pres.resume();
                    return resolve(new Response(JSON.stringify({ error: `视频请求失败: ${pres.statusCode}` }), {
                        status: pres.statusCode,
                        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' }
                    }));
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
        return new Response(JSON.stringify({ error: '视频代理失败: ' + e.message }), {
            status: 500,
            headers: { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' }
        });
    }
}
