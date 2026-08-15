// functions/api/cover.js — Cloudflare Pages Function: /api/cover (封面代理)
import core from '../../lib/core.js';

const { MOBILE_UA } = core;

function pickFilename(disposition, fallback) {
    if (!disposition) return fallback;
    const m = disposition.match(/filename\*=UTF-8''([^;]+)/i);
    if (m) return decodeURIComponent(m[1]);
    const m2 = disposition.match(/filename="([^"]+)"/i);
    if (m2) return m2[1];
    return fallback;
}

export async function onRequest(context) {
    const { request } = context;
    const u = new URL(request.url);
    const target = u.searchParams.get('url');
    const download = u.searchParams.get('download');

    if (!target) return Response.json({ error: '缺少URL参数' }, { status: 400 });

    try {
        const fwdHeaders = new Headers({
            'User-Agent': MOBILE_UA,
            'Referer': 'https://www.douyin.com/',
            'Accept': 'image/*,image/webp,image/apng,*/*;q=0.8',
            'Accept-Language': 'zh-CN,zh;q=0.9',
            'Accept-Encoding': 'gzip, deflate, br'
        });
        // 透传 Range / If-None-Match / If-Modified-Since（提升 CDN 缓存命中率）
        for (const k of ['range', 'if-none-match', 'if-modified-since']) {
            const v = request.headers.get(k);
            if (v) fwdHeaders.set(k, v);
        }

        const resp = await fetch(target, {
            method: 'GET',
            headers: fwdHeaders,
            redirect: 'follow'
        });

        const outHeaders = new Headers(resp.headers);
        // 移除 CSP / X-Frame-Options 等防盗头
        outHeaders.delete('content-security-policy');
        outHeaders.delete('x-frame-options');
        outHeaders.delete('cross-origin-resource-policy');
        outHeaders.delete('cross-origin-embedder-policy');
        // 允许跨域读（前端 fetch 直连失败时 fallback 用到代理时也能拿到 blob）
        outHeaders.set('Access-Control-Allow-Origin', '*');
        outHeaders.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
        outHeaders.set('Accept-Ranges', outHeaders.get('accept-ranges') || 'bytes');

        const type = outHeaders.get('content-type') || 'image/jpeg';
        outHeaders.set('Content-Type', type);

        if (download) {
            const cd = outHeaders.get('content-disposition');
            const name = pickFilename(cd, 'douyin_cover.jpg');
            outHeaders.set('Content-Disposition', `attachment; filename="${name}"`);
        } else {
            outHeaders.delete('content-disposition');
        }

        return new Response(resp.body, { status: resp.status, headers: outHeaders });
    } catch (e) {
        return Response.json({ error: '封面代理失败: ' + e.message }, { status: 500 });
    }
}
