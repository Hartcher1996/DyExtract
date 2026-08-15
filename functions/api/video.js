// functions/api/video.js — Cloudflare Pages Function: /api/video (视频代理)
import core from '../../lib/core.js';

const { getCachedVideo, setKVStore, MOBILE_UA } = core;

function pickFilename(disposition, fallback) {
    if (!disposition) return fallback;
    const m = disposition.match(/filename\*=UTF-8''([^;]+)/i);
    if (m) return decodeURIComponent(m[1]);
    const m2 = disposition.match(/filename="([^"]+)"/i);
    if (m2) return m2[1];
    return fallback;
}

export async function onRequest(context) {
    const { request, env } = context;
    if (env && env.VIDEO_CACHE) setKVStore(env.VIDEO_CACHE);

    const u = new URL(request.url);
    let videoUrl = u.searchParams.get('url');
    const id = u.searchParams.get('id');
    const download = u.searchParams.get('download');

    if (id) {
        const c = await getCachedVideo(id);
        if (c) videoUrl = c.url;
        else return Response.json({ error: '视频缓存已过期，请重新解析' }, { status: 404 });
    }
    if (!videoUrl) return Response.json({ error: '缺少URL参数' }, { status: 400 });

    try {
        const fwdHeaders = new Headers({
            'User-Agent': MOBILE_UA,
            'Referer': 'https://www.douyin.com/',
            'Accept': '*/*',
            'Accept-Language': 'zh-CN,zh;q=0.9',
            'Accept-Encoding': 'identity' // 视频不要压缩，省 CPU
        });
        // 透传 Range / If-None-Match / If-Modified-Since
        for (const k of ['range', 'if-none-match', 'if-modified-since']) {
            const v = request.headers.get(k);
            if (v) fwdHeaders.set(k, v);
        }

        const resp = await fetch(videoUrl, {
            method: 'GET',
            headers: fwdHeaders,
            redirect: 'follow'
        });

        const outHeaders = new Headers(resp.headers);
        outHeaders.delete('content-security-policy');
        outHeaders.delete('x-frame-options');
        outHeaders.delete('cross-origin-resource-policy');
        outHeaders.delete('cross-origin-embedder-policy');
        outHeaders.set('Access-Control-Allow-Origin', '*');
        outHeaders.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
        outHeaders.set('Accept-Ranges', outHeaders.get('accept-ranges') || 'bytes');

        const type = outHeaders.get('content-type') || 'video/mp4';
        outHeaders.set('Content-Type', type);

        if (download) {
            const cd = outHeaders.get('content-disposition');
            const name = pickFilename(cd, 'douyin_video.mp4');
            outHeaders.set('Content-Disposition', `attachment; filename="${name}"`);
        } else {
            outHeaders.delete('content-disposition');
        }

        return new Response(resp.body, { status: resp.status, headers: outHeaders });
    } catch (e) {
        return Response.json({ error: '视频代理失败: ' + e.message }, { status: 500 });
    }
}
