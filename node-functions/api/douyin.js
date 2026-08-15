// node-functions/api/douyin.js — EdgeOne Pages Node Function: /api/douyin
import core from '../../lib/core.js';
import { createRequire } from 'module';

const _core = (core && core.default && !core.buildParseResponse) ? core.default : core;
const { setKVStore, setUseNodeHttp, buildParseResponse } = _core || {};

// 强制使用 Node.js 原生 http（EdgeOne fetch 无法访问外网）
if (setUseNodeHttp) setUseNodeHttp(true);

// KV 绑定（可选）
try {
    const _require = createRequire(import.meta.url);
    const sdk = _require('@edgeone/cloudfunctions-sdk');
    if (sdk?.KVNamespace?.getBinding) {
        const ns = sdk.KVNamespace.getBinding('VIDEO_CACHE');
        if (ns && typeof ns.put === 'function') setKVStore(ns);
    }
} catch (e) {}

export async function onRequest(context) {
    const request = context.request;

    console.log('[douyin.js] onRequest start');

    // CORS 预检
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

    const url = new URL(request.url);
    const rawUrl = url.searchParams.get('url');
    if (!rawUrl) {
        return new Response(JSON.stringify({ error: '缺少URL参数' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' }
        });
    }

    console.log('[douyin.js] parsing:', rawUrl);

    try {
        const result = await buildParseResponse(rawUrl);
        console.log('[douyin.js] success');
        const payload = result.payload || result;
        return new Response(JSON.stringify(payload), {
            status: 200,
            headers: {
                'Content-Type': 'application/json; charset=utf-8',
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, HEAD',
                'Access-Control-Allow-Headers': 'Content-Type, Range'
            }
        });
    } catch (e) {
        console.error('[douyin.js] error:', e && e.message);
        return new Response(JSON.stringify({ error: e.message || '解析失败' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' }
        });
    }
}
