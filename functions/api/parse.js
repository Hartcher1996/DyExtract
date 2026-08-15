// functions/api/parse.js — Cloudflare Pages Function: /api/parse
import core from '../../lib/core.js';

const { buildParseResponse, setKVStore } = core;

async function handleRequest(request, env) {
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
    if (!url) return Response.json({ error: '缺少URL参数' }, { status: 400 });

    try {
        const { payload } = await buildParseResponse(url);
        return Response.json(payload);
    } catch (e) {
        return Response.json({ error: e.message || '解析失败' }, { status: 500 });
    }
}

export async function onRequest(context) {
    return handleRequest(context.request, context.env);
}
export async function onRequestGet(context) {
    return handleRequest(context.request, context.env);
}
export async function onRequestPost(context) {
    return handleRequest(context.request, context.env);
}
