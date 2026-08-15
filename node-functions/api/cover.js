// node-functions/api/cover.js — EdgeOne Pages Node Function: /api/cover
import core from '../../lib/core.js';
import { createRequire } from 'module';

const _core = (core && core.default && !core.MOBILE_UA) ? core.default : core;
const { MOBILE_UA, setUseNodeHttp } = _core || {};

if (setUseNodeHttp) setUseNodeHttp(true);
console.log('[cover.js] 已强制使用 Node.js 原生 http 模块');

const _require = createRequire(import.meta.url);

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
    console.log(`[cover.js] onRequest: ${request.method}${url.search}`);

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

    const target = url.searchParams.get('url');
    const download = url.searchParams.get('download');
    if (!target) return jsonResponse({ error: '缺少URL参数' }, 400);

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
