const express = require('express');
const path = require('path');
const http = require('http');
const https = require('https');
const zlib = require('zlib');

const app = express();
const PORT = process.env.PORT || 3001;

// 双模式缓存：优先 EdgeOne KV Storage，其次降级内存 Map
const memoryCache = new Map();
let cacheCounter = 0;
let kvStore = null;

function setKVStore(store) {
    kvStore = store;
}

async function cacheVideo(url) {
    const id = 'v' + (++cacheCounter);
    const payload = { url, time: Date.now() };
    if (kvStore && typeof kvStore.put === 'function') {
        try {
            await kvStore.put(id, JSON.stringify(payload), { expirationTtl: 30 * 60 });
        } catch(e) {
            memoryCache.set(id, payload);
        }
    } else {
        memoryCache.set(id, payload);
        setTimeout(() => memoryCache.delete(id), 30 * 60 * 1000);
    }
    return id;
}

async function getCachedVideo(id) {
    if (kvStore && typeof kvStore.get === 'function') {
        try {
            const raw = await kvStore.get(id);
            if (raw) {
                const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
                return obj;
            }
        } catch(e) {}
    }
    return memoryCache.get(id);
}

const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';

// ========== 工具函数 ==========

function extractDouyinUrl(text) {
    if (!text) return '';
    const shortMatch = text.match(/https?:\/\/v\.douyin\.com\/[A-Za-z0-9_-]+/);
    if (shortMatch) return shortMatch[0];
    const longMatch = text.match(/https?:\/\/(www\.)?(iesdouyin|douyin)\.com\/[^\s"'<>]+/);
    if (longMatch) return longMatch[0];
    return text.trim();
}

function extractItemId(text) {
    if (!text) return '';
    const m = text.match(/(\d{17,19})/);
    return m ? m[1] : '';
}

function extractBalancedJson(str, startIdx) {
    if (startIdx < 0) return null;
    let braceCount = 0, endIdx = startIdx, inStr = false, esc = false;
    for (let i = startIdx; i < str.length; i++) {
        const c = str[i];
        if (esc) { esc = false; continue; }
        if (c === '\\') { esc = true; continue; }
        if (c === '"') { inStr = !inStr; continue; }
        if (!inStr) {
            if (c === '{' || c === '[') braceCount++;
            else if (c === '}' || c === ']') {
                braceCount--;
                if (braceCount === 0) { endIdx = i; break; }
            }
        }
    }
    if (endIdx <= startIdx) return null;
    return str.substring(startIdx, endIdx + 1);
}

function extractWindowJson(html, varName) {
    const re = new RegExp(`window\\.${varName}\\s*=\\s*`);
    const m = html.match(re);
    if (!m) return null;
    const start = html.indexOf('{', m.index + m[0].length);
    if (start < 0) return null;
    const jsonStr = extractBalancedJson(html, start);
    if (!jsonStr) return null;
    try { return JSON.parse(jsonStr); } catch(e) { return null; }
}

function decodeUrl(u) {
    if (!u) return '';
    return u.replace(/\\u002F/gi, '/').replace(/\\u003F/gi, '?').replace(/\\u0026/gi, '&').replace(/\\u003D/gi, '=').replace(/\\"/g, '"').replace(/\\\//g, '/');
}

// ========== 网络请求 ==========

function nativeRequest(url, { headers = {}, method = 'GET', body = null, timeoutMs = 20000, redirectDepth = 0 } = {}) {
    return new Promise((resolve, reject) => {
        if (redirectDepth > 8) return reject(new Error('重定向次数过多'));
        const u = new URL(url);
        const lib = u.protocol === 'http:' ? http : https;
        const defaultHeaders = {
            'User-Agent': MOBILE_UA,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'zh-CN,zh-Hans;q=0.9,zh;q=0.8',
            'Accept-Encoding': 'gzip, deflate, br',
            'Connection': 'keep-alive',
            'Upgrade-Insecure-Requests': '1'
        };
        const mergedHeaders = { ...defaultHeaders, ...headers };
        const options = {
            hostname: u.hostname,
            port: u.port || (u.protocol === 'http:' ? 80 : 443),
            path: u.pathname + u.search + (u.hash || ''),
            method,
            rejectUnauthorized: false,
            headers: mergedHeaders
        };
        if (body) options.headers['Content-Length'] = Buffer.byteLength(body);

        const timer = setTimeout(() => { try { req.destroy(new Error('timeout')); } catch(e) {} }, timeoutMs);
        const req = lib.request(options, (res) => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => {
                clearTimeout(timer);
                let buf = Buffer.concat(chunks);
                const enc = res.headers['content-encoding'];
                try {
                    if (enc === 'gzip') buf = zlib.gunzipSync(buf);
                    else if (enc === 'br') buf = zlib.brotliDecompressSync(buf);
                    else if (enc === 'deflate') buf = zlib.inflateSync(buf);
                } catch(e) {}
                if (res.statusCode >= 301 && res.statusCode <= 308 && res.headers.location) {
                    let loc = res.headers.location;
                    if (loc.startsWith('/')) loc = u.protocol + '//' + u.hostname + loc;
                    return resolve(nativeRequest(loc, { headers, method, body, timeoutMs, redirectDepth: redirectDepth + 1 }));
                }
                resolve({ status: res.statusCode, headers: res.headers, body: buf.toString('utf-8') });
            });
        });
        req.on('error', (e) => { clearTimeout(timer); reject(e); });
        if (body) req.write(body);
        req.end();
    });
}

function getCookies(headers) {
    return (headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');
}
function mergeCookies(old, add) {
    if (!add) return old || '';
    if (!old) return add;
    const m = {};
    for (const s of [old, add]) {
        for (const p of s.split(';')) {
            const x = p.trim(); if (!x) continue;
            const e = x.indexOf('='); if (e < 0) continue;
            m[x.substring(0, e)] = x.substring(e + 1);
        }
    }
    return Object.entries(m).map(([k,v]) => k+'='+v).join('; ');
}

// ========== 核心解析 ==========

function extractFromApiItem(item) {
    const r = { title: '', author: '', cover: '', playUrl: '', images: [] };
    if (!item) return r;
    r.title = item.desc || item.share_info?.share_title || '';
    r.author = item.author?.nickname || item.author?.unique_id || '';
    if (item.video) {
        if (item.video.cover?.url_list?.[0]) r.cover = item.video.cover.url_list[0];
        if (!r.cover && item.video.dynamic_cover?.url_list?.[0]) r.cover = item.video.dynamic_cover.url_list[0];
        const candidates = [
            item.video.play_addr?.url_list,
            item.video.download_addr?.url_list,
            item.video.play_addr_h264?.url_list,
            item.video.bit_rate?.[0]?.play_addr?.url_list
        ];
        for (const arr of candidates) {
            if (Array.isArray(arr) && arr.length) {
                r.playUrl = (arr[0] || '').toString().replace(/playwm/g, 'play');
                if (r.playUrl.startsWith('http')) break;
            }
        }
    }
    const imgs = item.images || item.image_list;
    if (Array.isArray(imgs) && imgs.length) {
        r.images = imgs.map(i => ({
            url: (i.url_list?.[0] || i.url || i || '').toString(),
            width: Number(i.width || 0), height: Number(i.height || 0), uri: i.uri || ''
        })).filter(x => x.url && x.url.startsWith('http'));
        if (r.images.length) r.playUrl = '';
    }
    return r;
}

function parseFromEmbeddedData(html) {
    const result = { title: '', author: '', cover: '', playUrl: '', images: [] };
    const rd = extractWindowJson(html, '_ROUTER_DATA');
    if (!rd) return result;
    function findMedia(node, depth = 0) {
        if (depth > 20 || !node || typeof node !== 'object') return null;
        if (node.video?.play_addr?.url_list?.length || (Array.isArray(node.images) && node.images.length) || (Array.isArray(node.image_list) && node.image_list.length)) {
            return node;
        }
        for (const k of Object.keys(node)) {
            const r = findMedia(node[k], depth + 1);
            if (r) return r;
        }
        if (Array.isArray(node)) {
            for (let i = 0; i < node.length; i++) {
                const r = findMedia(node[i], depth + 1);
                if (r) return r;
            }
        }
        return null;
    }
    const hit = findMedia(rd);
    if (hit) Object.assign(result, extractFromApiItem(hit));
    return result;
}

function parseMetaInfo(html) {
    const r = { title: '', image: '', videoUrl: '' };
    if (!html) return r;
    const m1 = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']*)["']/i);
    if (m1) r.title = m1[1];
    else {
        const t = html.match(/<title>([^<]*?)<\/title>/i);
        if (t) r.title = t[1];
    }
    const m2 = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']*)["']/i);
    if (m2) r.image = m2[1];
    const m3 = html.match(/<meta[^>]+property=["']og:video["'][^>]+content=["']([^"']*)["']/i);
    if (m3) r.videoUrl = m3[1];
    return r;
}

async function fetchApiWithCookie(itemId, cookieStr) {
    const shareRef = `https://www.iesdouyin.com/share/video/${itemId}`;
    const paramSets = [
        `item_ids=${itemId}`,
        `item_ids=${itemId}&aid=1128&app_name=aweme`,
    ];
    const endpoints = [
        'https://www.iesdouyin.com/web/api/v2/aweme/iteminfo/?',
        'https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=' + itemId + '&'
    ];
    for (const ep of endpoints) {
        for (const p of paramSets) {
            try {
                const fullUrl = ep + p;
                const ra = await nativeRequest(fullUrl, {
                    headers: {
                        'Accept': 'application/json, text/plain, */*',
                        'Cookie': cookieStr,
                        'Referer': shareRef,
                        'X-Requested-With': 'XMLHttpRequest'
                    },
                    timeoutMs: 12000
                });
                if (ra.body.length === 0) continue;
                try {
                    const j = JSON.parse(ra.body);
                    const item = j.item_list?.[0] || j.aweme_detail || j.aweme_list?.[0] || j.data?.aweme_detail;
                    if (!item) continue;
                    const extracted = extractFromApiItem(item);
                    if (extracted.playUrl || extracted.images.length) {
                        console.log(`[API] 命中! play=${!!extracted.playUrl} imgs=${extracted.images.length}`);
                        return extracted;
                    }
                } catch(e) {}
            } catch(e) {}
        }
    }
    return null;
}

async function performParse(rawUrl) {
    const cleanUrl = extractDouyinUrl(String(rawUrl || ''));
    if (!cleanUrl.startsWith('http')) throw new Error('无法识别有效链接');
    console.log('\n' + '='.repeat(50));
    console.log('[解析] URL:', cleanUrl);

    // Step1: 短链重定向，提取 itemId
    let itemId = extractItemId(cleanUrl);
    let contentType = 'video';
    if (!itemId) {
        const step1 = await nativeRequest(cleanUrl, { timeoutMs: 12000 }).catch(() => ({ body: '' }));
        itemId = extractItemId(step1.body || '');
        if (/\/note\//.test(step1.body || '')) contentType = 'note';
    }
    if (!itemId) throw new Error('无法提取内容ID，请确认链接正确');
    console.log(`[解析] itemId: ${itemId}, type: ${contentType}`);
    const shareUrl = `https://www.iesdouyin.com/share/video/${itemId}`;

    // Step2: 请求分享页（标准 UA 即可拿到 ttwid + 38KB SSR 页面）
    let workingCookie = '';
    let result = { title: '', author: '', cover: '', playUrl: '', images: [] };
    let sourceUsed = '';

    try {
        const htmlResp = await nativeRequest(shareUrl, { timeoutMs: 15000 });
        workingCookie = getCookies(htmlResp.headers);

        const meta = parseMetaInfo(htmlResp.body);
        if (meta.title) result.title = meta.title;
        if (meta.image) result.cover = meta.image;
        if (meta.videoUrl) result.playUrl = meta.videoUrl;

        const embedded = parseFromEmbeddedData(htmlResp.body);
        if (embedded.playUrl || embedded.images.length) {
            Object.assign(result, embedded);
            sourceUsed = 'embedded';
            console.log('[策略A] 嵌入数据解析成功');
        } else {
            if (embedded.title) result.title = embedded.title;
            if (embedded.author) result.author = embedded.author;
            if (embedded.cover && !result.cover) result.cover = embedded.cover;
        }
    } catch(e) {
        console.warn('[策略A] 异常:', e.message);
    }

    // Step3: 嵌入数据没拿到媒体，带 cookie 调 API
    if (!result.playUrl && result.images.length === 0 && workingCookie) {
        console.log('[策略B] 调用官方 API...');
        const apiRes = await fetchApiWithCookie(itemId, workingCookie);
        if (apiRes && (apiRes.playUrl || apiRes.images.length)) {
            result.title = apiRes.title || result.title;
            result.author = apiRes.author || result.author;
            result.cover = apiRes.cover || result.cover;
            result.playUrl = apiRes.playUrl;
            result.images = apiRes.images;
            sourceUsed = 'api';
            console.log('[策略B] API 成功');
        }
    }

    if (!result.playUrl && result.images.length === 0) {
        throw new Error('无法获取媒体资源，请稍后重试');
    }

    return { itemId, result, sourceUsed };
}

// ========== 路由 ==========

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

async function handleParse(rawUrl, res) {
    try {
        const { itemId, result, sourceUsed } = await performParse(rawUrl);
        const isImage = result.images.length > 0;

        if (!isImage && result.playUrl) {
            result.playUrl = decodeUrl(result.playUrl).replace(/playwm/g, 'play');
            const videoKey = await cacheVideo(result.playUrl);
            return res.json({
                success: true,
                type: 'video',
                title: result.title || '抖音视频',
                author: result.author || '未知作者',
                play_url: result.playUrl,
                video_key: videoKey,
                item_id: itemId,
                cover: result.cover,
                platform: 'douyin',
                source: sourceUsed || 'self'
            });
        }

        if (isImage) {
            return res.json({
                success: true,
                type: 'image',
                title: result.title || '抖音图文',
                author: result.author || '未知作者',
                images: result.images,
                item_id: itemId,
                cover: result.cover,
                image_count: result.images.length,
                platform: 'douyin',
                source: sourceUsed || 'self'
            });
        }

        throw new Error('解析失败');
    } catch(e) {
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

// ========== 封面代理 ==========
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

// ========== 视频代理 ==========
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

// 本地运行时直接启动监听；EdgeOne 导入模块时不启动
if (require.main === module) {
    app.listen(PORT, () => {
        console.log(`抖音解析服务已启动: http://localhost:${PORT}`);
    });
}

module.exports = { app, setKVStore };
