// functions/__dy__/[[default]].js — Cloudflare Pages Function: /__dy__/*
// 全新路径前缀，与 EdgeOne node-functions 绝对不冲突。
//
// 为什么不用 /api/*：
//   EdgeOne Pages 同时处理 functions/（Edge Function V8）和 node-functions/（Node.js）。
//   /api/* 下精确匹配文件（如 functions/api/entry.js）优先于 node-functions catch-all，
//   但 Edge Function 的 fetch() 无法访问外网 → 545。
//   /__dy__/* 是全新路径，functions/ 下之前没有任何文件 → 两边都按 catch-all 走，永远不抢。
//
// 前端统一用：
//   /__dy__/entry?action=parse&url=...
//   /__dy__/entry?action=video&url=...
//   /__dy__/entry?action=cover&url=...

import core from '../../lib/core.js';

const { buildParseResponse, getCachedVideo, setKVStore, MOBILE_UA } = core;

function pickFilename(disposition, fallback) {
    if (!disposition) return fallback;
    const m = disposition.match(/filename\*=UTF-8''([^;]+)/i);
    if (m) return decodeURIComponent(m[1]);
    const m2 = disposition.match(/filename="([^"]+)"/i);
    if (m2) return m2[1];
    return fallback;
}

function jsonErr(msg, status = 400) {
    return Response.json({ error: msg }, {
        status,
        headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
            'Cache-Control': 'no-store',
        }
    });
}

async function handleParse(request, env) {
    if (env && env.VIDEO_CACHE) setKVStore(env.VIDEO_CACHE);
    let url = '';
    const method = request.method;

    if (method === 'POST') {
        const ct = (request.headers.get('content-type') || '').toLowerCase();
        try {
            if (ct.includes('application/json')) {
                const body = await request.json();
                url = body?.url || '';
            } else if (ct.includes('multipart/form-data') || ct.includes('application/x-www-form-urlencoded')) {
                const fd = await request.formData();
                url = fd?.get('url') || '';
            }
        } catch (e) {}
    }

    if (!url) {
        url = new URL(request.url).searchParams.get('url') || '';
    }
    if (!url) return jsonErr('缺少URL参数', 400);

    try {
        const { payload } = await buildParseResponse(url);
        return Response.json(payload, {
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Cache-Control': 'no-store',
            }
        });
    } catch (e) {
        return jsonErr(e.message || '解析失败', 500);
    }
}

async function handleVideo(request, env) {
    if (env && env.VIDEO_CACHE) setKVStore(env.VIDEO_CACHE);
    const u = new URL(request.url);
    let videoUrl = u.searchParams.get('url');
    const id = u.searchParams.get('id');
    const download = u.searchParams.get('download');

    if (id) {
        const c = await getCachedVideo(id);
        if (c) videoUrl = c.url;
        else return jsonErr('视频缓存已过期，请重新解析', 404);
    }
    if (!videoUrl) return jsonErr('缺少URL参数', 400);

    try {
        const fwdHeaders = new Headers({
            'User-Agent': MOBILE_UA,
            'Referer': 'https://www.douyin.com/',
            'Accept': '*/*',
            'Accept-Language': 'zh-CN,zh;q=0.9',
            'Accept-Encoding': 'identity'
        });
        for (const k of ['range', 'if-none-match', 'if-modified-since']) {
            const v = request.headers.get(k);
            if (v) fwdHeaders.set(k, v);
        }

        const resp = await fetch(videoUrl, { method: 'GET', headers: fwdHeaders, redirect: 'follow' });
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
        return jsonErr('视频代理失败: ' + e.message, 500);
    }
}

async function handleCover(request) {
    const u = new URL(request.url);
    const target = u.searchParams.get('url');
    const download = u.searchParams.get('download');

    if (!target) return jsonErr('缺少URL参数', 400);

    try {
        const fwdHeaders = new Headers({
            'User-Agent': MOBILE_UA,
            'Referer': 'https://www.douyin.com/',
            'Accept': 'image/*,image/webp,image/apng,*/*;q=0.8',
            'Accept-Language': 'zh-CN,zh;q=0.9',
            'Accept-Encoding': 'gzip, deflate, br'
        });
        for (const k of ['range', 'if-none-match', 'if-modified-since']) {
            const v = request.headers.get(k);
            if (v) fwdHeaders.set(k, v);
        }

        const resp = await fetch(target, { method: 'GET', headers: fwdHeaders, redirect: 'follow' });
        const outHeaders = new Headers(resp.headers);
        outHeaders.delete('content-security-policy');
        outHeaders.delete('x-frame-options');
        outHeaders.delete('cross-origin-resource-policy');
        outHeaders.delete('cross-origin-embedder-policy');
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
        return jsonErr('封面代理失败: ' + e.message, 500);
    }
}

async function handleRequest(context) {
    const { request, env } = context;
    const method = request.method;

    if (method === 'OPTIONS') {
        return new Response(null, {
            status: 204,
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type',
                'Access-Control-Max-Age': '86400',
            }
        });
    }

    const u = new URL(request.url);
    const action = (u.searchParams.get('action') || 'parse').toLowerCase();

    switch (action) {
        case 'parse':
            return handleParse(request, env);
        case 'video':
            return handleVideo(request, env);
        case 'cover':
            return handleCover(request);
        case 'health':
            return Response.json({ status: 'ok', ts: Date.now(), from: 'cfpages-dy' }, {
                headers: { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' }
            });
        default:
            return jsonErr('未知 action: ' + action, 400);
    }
}

export async function onRequest(context)        { return handleRequest(context); }
export async function onRequestGet(context)    { return handleRequest(context); }
export async function onRequestPost(context)   { return handleRequest(context); }
export async function onRequestOptions(context){ return handleRequest(context); }
