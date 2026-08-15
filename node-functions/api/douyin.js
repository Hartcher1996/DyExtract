// node-functions/api/douyin.js — EdgeOne Pages Node Function: /api/douyin
import core from '../../lib/core.js';
import { createRequire } from 'module';

const _core = (core && core.default && !core.buildParseResponse) ? core.default : core;
const { setKVStore, setUseNodeHttp, buildParseResponse } = _core || {};

if (setUseNodeHttp) setUseNodeHttp(true);
console.log('[douyin.js] 已强制使用 Node.js 原生 http 模块');

const _require = createRequire(import.meta.url);
try {
    const sdk = _require('@edgeone/cloudfunctions-sdk');
    if (sdk?.KVNamespace?.getBinding) {
        const ns = sdk.KVNamespace.getBinding('VIDEO_CACHE');
        if (ns && typeof ns.put === 'function') {
            setKVStore(ns);
            console.log('[douyin.js] KV 绑定成功');
        }
    }
} catch (e) {
    console.log('[douyin.js] KV 不可用，使用内存缓存');
}

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
    const search = url.search;
    console.log(`[douyin.js] onRequest start: ${request.method} /api/douyin${search}`);

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
        let rawUrl = '';
        if (request.method === 'POST') {
            try {
                const body = await request.json();
                rawUrl = body?.url || '';
            } catch {}
        }
        if (!rawUrl) rawUrl = url.searchParams.get('url') || '';
        if (!rawUrl) return jsonResponse({ error: '缺少URL参数' }, 400);

        console.log('[douyin.js] buildParseResponse start, URL:', rawUrl);
        const t0 = Date.now();
        const result = await buildParseResponse(rawUrl);
        console.log('[douyin.js] buildParseResponse success, ms:', Date.now() - t0);
        const payload = result.payload || result;
        return jsonResponse(payload);
    } catch (e) {
        console.error('[douyin.js] ERROR:', e && e.message, e && e.stack);
        return jsonResponse({ error: e.message || '解析失败' }, 500);
    }
}
