// node-functions/api/parse.js — EdgeOne Pages Node Function: /api/parse
import core from '../../lib/core.js';
import { createRequire } from 'module';

const _core = (core && core.default && !core.buildParseResponse) ? core.default : core;
const { setKVStore, setUseNodeHttp, buildParseResponse } = _core || {};

if (setUseNodeHttp) setUseNodeHttp(true);

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

    let rawUrl = '';
    if (request.method === 'POST') {
        try {
            const body = await request.json();
            rawUrl = body?.url || '';
        } catch {}
    }
    if (!rawUrl) {
        rawUrl = new URL(request.url).searchParams.get('url') || '';
    }
    if (!rawUrl) {
        return new Response(JSON.stringify({ error: '缺少URL参数' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' }
        });
    }

    try {
        const result = await buildParseResponse(rawUrl);
        const payload = result.payload || result;
        return new Response(JSON.stringify(payload), {
            status: 200,
            headers: {
                'Content-Type': 'application/json; charset=utf-8',
                'Access-Control-Allow-Origin': '*'
            }
        });
    } catch (e) {
        return new Response(JSON.stringify({ error: e.message || '解析失败' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' }
        });
    }
}
