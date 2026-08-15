// server.js — 本地运行模式（Express + Node.js 原生代理）
// Cloudflare Pages 部署不走这里，走 functions/api/* Pages Functions

const express = require('express');
const path = require('path');
const http = require('http');
const https = require('https');

const {
    MOBILE_UA,
    setKVStore,
    getCachedVideo,
    buildParseResponse
} = require('./lib/core.js');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ========== 解析路由 ==========

async function handleParse(rawUrl, res) {
    try {
        const { payload } = await buildParseResponse(rawUrl);
        return res.json(payload);
    } catch (e) {
        console.error('[解析错误]', e.message);
        return res.status(500).json({ error: e.message || '解析失败' });
    }
}

app.post('/api/parse', async (req, res) => {
    const rawUrl = req.body?.url || req.query?.url;
    if (!rawUrl) return res.status(400).json({ error: '缺少URL参数' });
    await handleParse(rawUrl, res);
});

app.get('/api/douyin/self', async (req, res) => {
    const rawUrl = req.query.url;
    if (!rawUrl) return res.status(400).json({ error: '缺少URL参数' });
    await handleParse(rawUrl, res);
});

app.get('/api/douyin', async (req, res) => {
    const rawUrl = req.query.url;
    if (!rawUrl) return res.status(400).json({ error: '缺少URL参数' });
    await handleParse(rawUrl, res);
});

// ========== 封面代理（Node.js 原生流） ==========
app.get('/api/cover', (req, res) => {
    const { url } = req.query;
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
                if (pres.headers['cache-control']) res.setHeader('Cache-Control', pres.headers['cache-control']);
                if (req.query.download) res.setHeader('Content-Disposition', 'attachment; filename=douyin_cover.jpg');
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

// ========== 视频代理（Node.js 原生流） ==========
app.get('/api/video', async (req, res) => {
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
                if (pres.headers['cache-control']) res.setHeader('Cache-Control', pres.headers['cache-control']);
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

if (require.main === module) {
    app.listen(PORT, () => {
        console.log(`抖音解析服务已启动: http://localhost:${PORT}`);
    });
}

module.exports = { app, setKVStore };
