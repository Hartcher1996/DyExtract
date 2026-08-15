// functions/api/douyin/self.js — Cloudflare Pages Function: /api/douyin/self
import core from '../../../lib/core.js';

const { buildParseResponse, setKVStore } = core;

export async function onRequest(context) {
    const { request, env } = context;
    if (env && env.VIDEO_CACHE) setKVStore(env.VIDEO_CACHE);

    const url = new URL(request.url).searchParams.get('url') || '';
    if (!url) return Response.json({ error: '缺少URL参数' }, { status: 400 });

    try {
        const { payload } = await buildParseResponse(url);
        return Response.json(payload);
    } catch (e) {
        return Response.json({ error: e.message || '解析失败' }, { status: 500 });
    }
}
