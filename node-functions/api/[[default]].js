// node-functions/api/[[default]].js — EdgeOne Pages Node Functions 入口
//
// EdgeOne Pages Node Functions 规范：
//   1. 目录：/node-functions/api/[[default]].js → 匹配 /api/* 所有子路径
//   2. 框架模式：import express + export default app（不调用 app.listen）
//   3. Runtime：Node.js v20.x，有原生 fetch，支持完整 npm 生态
//   4. esbuild 打包时会内联 ESM import 的模块
// ————————————————————————————————————————————————————————————————————

import express from 'express';
import http from 'http';
import https from 'https';
import { createRequire } from 'module';
import core from '../../lib/core.js';

const require = createRequire(import.meta.url);

const {
    MOBILE_UA,
    setKVStore,
    getCachedVideo,
    buildParseResponse
} = core;

const app = express();
app.use(express.json());

// CORS
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, HEAD');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range, If-None-Match, If-Modified-Since');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Content-Length, Accept-Ranges');
    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
});

// 健康检查
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        runtime: 'edgeone-node-functions',
        path: req.url,
        ts: Date.now(),
        hasFetch: typeof fetch === 'function',
        nodeVersion: process.version
    });
});

// 解析路由
async function handleParse(rawUrl, res) {
    try {
        const { payload } = await buildParseResponse(rawUrl);
        return res.json(payload);
    } catch (e) {
        console.error('[解析错误]', e.message);
        return res.status(500).json({ error: e.message || '解析失败' });
    }
}

app.post('/parse', async (req, res) => {
    const rawUrl = req.body?.url || req.query?.url;
    if (!rawUrl) return res.status(400).json({ error: '缺少URL参数' });
    await handleParse(rawUrl, res);
});

app.get('/douyin', async (req, res) => {
    const rawUrl = req.query.url;
    if (!rawUrl) return res.status(400).json({ error: '缺少URL参数' });
    await handleParse(rawUrl, res);
});

app.get('/douyin/self', async (req, res) => {
    const rawUrl = req.query.url;
    if (!rawUrl) return res.status(400).json({ error: '缺少URL参数' });
    await handleParse(rawUrl, res);
});

// 视频代理（Node.js 原生 http，因为 EdgeOne fetch 流式传输可能有限制）
app.get('/video', async (req, res) => {
    const { url, id, download } = req.query;
    let videoUrl = url;
    if (id) {
        const c = await getCachedVideo(id);
        if (c) videoUrl = c.url;
        else return res.status(404).json({ error: '视频缓存已过期，请重新解析' });
    }
    if (!videoUrl) return res.status(400).json({ error: '缺少URL参数' });

    function proxyVideo(targetUrl, redirectCount) {
        if (redirectCount > 5) return res.status(500).json({ error: '重定向次数过多' });
        const client = targetUrl.startsWith('https') ? https : http;
        const u = new URL(targetUrl);
        const options = {
            hostname: u.hostname,
            port: u.port || (targetUrl.startsWith('https') ? 443 : 80),
            path: u.pathname + u.search,
            method: 'GET',
            rejectUnauthorized: false,
            headers: {
                'User-Agent': MOBILE_UA,
                'Referer': 'https://www.douyin.com/',
                'Accept': '*/*',
                'Accept-Language': 'zh-CN,zh;q=0.9'
            }
        };
        if (req.headers.range) options.headers['Range'] = req.headers.range;

        const req2 = client.request(options, (pres) => {
            if (pres.statusCode >= 301 && pres.statusCode <= 308 && pres.headers.location) {
                let loc = pres.headers.location;
                if (loc.startsWith('/')) loc = u.protocol + '//' + u.hostname + loc;
                pres.resume();
                return proxyVideo(loc, redirectCount + 1);
            }
            if (pres.statusCode >= 400) {
                let body = '';
                pres.on('data', c => body += c);
                pres.on('end', () => { if (!res.headersSent) res.status(pres.statusCode).json({ error: `视频请求失败: ${pres.statusCode}` }); });
                return;
            }
            if (!res.headersSent) {
                res.status(pres.statusCode);
                res.setHeader('Content-Type', pres.headers['content-type'] || 'video/mp4');
                res.setHeader('Accept-Ranges', 'bytes');
                if (pres.headers['content-length']) res.setHeader('Content-Length', pres.headers['content-length']);
                if (pres.headers['content-range']) res.setHeader('Content-Range', pres.headers['content-range']);
                if (download) res.setHeader('Content-Disposition', 'attachment; filename=douyin_video.mp4');
            }
            pres.on('error', () => { if (!res.headersSent) res.status(500).json({ error: '视频流传输失败' }); });
            pres.pipe(res);
        });
        req2.on('error', (err) => { if (!res.headersSent) res.status(500).json({ error: '视频代理失败: ' + err.message }); });
        req2.setTimeout(30000, () => { req2.destroy(); if (!res.headersSent) res.status(504).json({ error: '视频请求超时' }); });
        req2.end();
    }
    proxyVideo(videoUrl, 0);
});

// 封面代理
app.get('/cover', (req, res) => {
    const { url, download } = req.query;
    if (!url) return res.status(400).json({ error: '缺少URL参数' });

    function proxyCover(targetUrl, redirectCount) {
        if (redirectCount > 5) return res.status(500).json({ error: '重定向次数过多' });
        const client = targetUrl.startsWith('https') ? https : http;
        const u = new URL(targetUrl);
        const req2 = client.request({
            hostname: u.hostname,
            port: u.port || (targetUrl.startsWith('https') ? 443 : 80),
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
                return proxyCover(loc, redirectCount + 1);
            }
            if (pres.statusCode >= 400) {
                pres.resume();
                if (!res.headersSent) res.status(pres.statusCode).json({ error: `封面请求失败: ${pres.statusCode}` });
                return;
            }
            if (!res.headersSent) {
                res.status(pres.statusCode);
                res.setHeader('Content-Type', pres.headers['content-type'] || 'image/jpeg');
                if (pres.headers['content-length']) res.setHeader('Content-Length', pres.headers['content-length']);
                if (download) res.setHeader('Content-Disposition', 'attachment; filename=douyin_cover.jpg');
            }
            pres.on('error', () => { if (!res.headersSent) res.status(500).json({ error: '封面流传输失败' }); });
            pres.pipe(res);
        });
        req2.on('error', (err) => { if (!res.headersSent) res.status(500).json({ error: '封面代理失败: ' + err.message }); });
        req2.setTimeout(30000, () => { req2.destroy(); if (!res.headersSent) res.status(504).json({ error: '封面请求超时' }); });
        req2.end();
    }
    proxyCover(url, 0);
});

// 404 兜底（EdgeOne 传入的是剥离了 /api 前缀的路径）
app.use((req, res) => {
    if (!res.headersSent) {
        res.status(404).json({ error: 'API 路由不存在: ' + req.method + ' ' + req.path, note: '函数收到的是剥离前缀后的路径' });
    }
});

// 全局错误处理
app.use((err, req, res, next) => {
    console.error('[未捕获异常]', err && err.message, err && err.stack);
    if (res.headersSent) return next(err);
    const code = err && err.status ? err.status : 500;
    const msg = err && err.message ? err.message : '服务器内部错误';
    res.status(code).json({ error: msg });
});

// KV 绑定（可选，不能用 top-level await，esbuild target 可能是 node14）
try {
    const sdk = require('@edgeone/cloudfunctions-sdk');
    if (sdk?.KVNamespace?.getBinding) {
        const ns = sdk.KVNamespace.getBinding('VIDEO_CACHE');
        if (ns && typeof ns.put === 'function' && typeof ns.get === 'function') {
            setKVStore(ns);
            console.log('[EdgeOne] KV 绑定成功');
        }
    }
} catch (e) {
    console.log('[EdgeOne] KV 不可用，使用内存缓存');
}

// 导出 Express 实例
export default app;
