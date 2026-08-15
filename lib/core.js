// lib/core.js — 通用核心逻辑（Node.js CJS + Cloudflare Workers ESM 双兼容）
// 网络层自动适配：
//   - 有全局 fetch（Workers / Node 18+）→ 用 fetch
//   - 无 fetch（EdgeOne Node14/16）→ 动态 require('http'/'https') 用 Node 原生模块
//   - 不依赖任何第三方 polyfill（undici/node-fetch），避免冷启动超时

const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';

// ========== X-Bogus / a_bogus 签名算法（抖音 Web API 通用）=====================
// 基于公开开源版本的精简实现，兼容 Node.js CJS / CF Workers ESM 双运行时
// 依赖：Web Standard crypto.subtle（Node.js 19+ / CF Workers）都自带
// 参考来源：https://github.com/HHao1997/tt-sha256
(function registerXBogus(root) {
    // —— 查表（CRC-32 变种）——
    const BYTE_TABLE = new Uint8Array(256);
    (function build() {
        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++) {
                c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
            }
            BYTE_TABLE[n] = c & 0xFF;
        }
    })();

    function _byv(arr, start, len) {
        let a = 0x9E3779B9;
        let b = a;
        let c = 0x9E3779B9;
        let d = 0xE150A28B;
        const n = Math.floor(len / 12) * 3;
        let p = start + len;
        const rounds = Math.floor(len / 12);
        for (let i = 0; i < rounds; i++) {
            a = (a + (arr[start + i*3 + 1] | 0)) | 0;
            b = (b + (arr[start + i*3 + 2] | 0)) | 0;
            c = (c + (arr[start + i*3 + 3] | 0)) | 0;
            d = (d + (arr[start + i*3 + 0] | 0)) | 0;
            a ^= d; a = (a - 1) | 0; a ^= 0x271742A2; d = (d + (a | 0)) | 0;
            b ^= a; b = (b - 1) | 0; b ^= 0x4AD649FB; a = (a + (b | 0)) | 0;
            c ^= b; c = (c - 1) | 0; c ^= 0x3E3C7A11; b = (b + (c | 0)) | 0;
            d ^= c; d = (d - 1) | 0; d ^= 0x557F9086; c = (c + (d | 0)) | 0;
        }
        let rem = len - rounds * 12;
        let end = start + rounds * 12;
        while (rem > 0) {
            switch (rem) {
                case 11: d = (d + ((arr[end + 10] & 0xFF) << 24)) | 0; break;
                case 10: d = (d + ((arr[end + 9] & 0xFF) << 16)) | 0; break;
                case 9:  d = (d + ((arr[end + 8] & 0xFF) << 8)) | 0; break;
                case 8:  c = (c + ((arr[end + 7] & 0xFF) << 24)) | 0; break;
                case 7:  c = (c + ((arr[end + 6] & 0xFF) << 16)) | 0; break;
                case 6:  c = (c + ((arr[end + 5] & 0xFF) << 8)) | 0; break;
                case 5:  b = (b + ((arr[end + 4] & 0xFF) << 24)) | 0; break;
                case 4:  b = (b + ((arr[end + 3] & 0xFF) << 16)) | 0; break;
                case 3:  b = (b + ((arr[end + 2] & 0xFF) << 8)) | 0; break;
                case 2:  a = (a + ((arr[end + 1] & 0xFF) << 24)) | 0; break;
                case 1:  a = (a + ((arr[end + 0] & 0xFF) << 16)) | 0; break;
            }
            rem--;
            if (rem === 0) break;
        }
        return [a, b, c, d];
    }

    function _hashToBytes(str) {
        const out = new Uint8Array(str.length * 4);
        for (let i = 0; i < str.length; i++) {
            const code = str.charCodeAt(i);
            out[i*4 + 0] = (code & 0x000000FF) >>> 0;
            out[i*4 + 1] = (code & 0x0000FF00) >>> 8;
            out[i*4 + 2] = (code & 0x00FF0000) >>> 16;
            out[i*4 + 3] = (code & 0xFF000000) >>> 24;
        }
        return out;
    }

    function b64Encode(bytes) {
        // 自定义 base64（含 URL-safe 字符），与抖音 X-Bogus 表一致
        const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
        let out = '';
        let i = 0;
        for (; i + 2 < bytes.length; i += 3) {
            const n = ((bytes[i] << 16) | (bytes[i+1] << 8) | bytes[i+2]) >>> 0;
            out += CHARS[(n >>> 18) & 63] + CHARS[(n >>> 12) & 63] + CHARS[(n >>> 6) & 63] + CHARS[n & 63];
        }
        if (i < bytes.length) {
            const remain = bytes.length - i;
            if (remain === 1) {
                const n = bytes[i] << 16;
                out += CHARS[(n >>> 18) & 63] + CHARS[(n >>> 12) & 63] + '==';
            } else {
                const n = (bytes[i] << 16) | (bytes[i+1] << 8);
                out += CHARS[(n >>> 18) & 63] + CHARS[(n >>> 12) & 63] + CHARS[(n >>> 6) & 63] + '=';
            }
        }
        return out;
    }

    /**
     * 生成 a_bogus 签名（对应抖音 web API 参数 a_bogus）
     * @param {string} query  URL 中 ? 之后的查询串（不含前缀 ?）
     * @param {string} ua     请求 User-Agent（必须与实际请求的 UA 一致，否则服务端校验失败）
     * @returns {Promise<string>} 24 位的 a_bogus 字符串
     */
    async function generateABogus(query, ua) {
        // 与 web 端一致的 salting：query + ua + 两个固定字符串
        const q = String(query || '');
        const u = String(ua || MOBILE_UA);
        const salted = q + u + 'W8hD8o3b2wXvQx8n5Gz7a1jY' + 'Kz9x2p1f4vJ8t6sD';

        // Step 1: SHA-256 of UTF-8 encoded salted string
        const enc = new TextEncoder();
        const data = enc.encode(salted);
        let digest;
        if (root.crypto && root.crypto.subtle && root.crypto.subtle.digest) {
            digest = new Uint8Array(await root.crypto.subtle.digest('SHA-256', data));
        } else if (typeof require === 'function') {
            const nodeCrypto = require('crypto');
            digest = new Uint8Array(nodeCrypto.createHash('sha256').update(data).digest());
        } else {
            throw new Error('No crypto available for a_bogus');
        }

        // Step 2: byv (by-value) 4-word mixer 两次，输入是 digest 16 字节（SHA-256 的前一半）
        const ab1 = _byv(digest, 0, 16);
        const mixed = new Uint8Array(16);
        for (let i = 0; i < 4; i++) {
            mixed[i*4+0] = ab1[i] & 0xFF;
            mixed[i*4+1] = (ab1[i] >>> 8) & 0xFF;
            mixed[i*4+2] = (ab1[i] >>> 16) & 0xFF;
            mixed[i*4+3] = (ab1[i] >>> 24) & 0xFF;
        }
        const ab2 = _byv(mixed, 0, 16);
        const finalBytes = new Uint8Array(16);
        for (let i = 0; i < 4; i++) {
            finalBytes[i*4+0] = ab2[i] & 0xFF;
            finalBytes[i*4+1] = (ab2[i] >>> 8) & 0xFF;
            finalBytes[i*4+2] = (ab2[i] >>> 16) & 0xFF;
            finalBytes[i*4+3] = (ab2[i] >>> 24) & 0xFF;
        }
        // Step 3: 取前 16B base64 编码，得 24 字符
        return b64Encode(finalBytes.subarray(0, 16));
    }

    root.__dyextract_generateABogus = generateABogus;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof global !== 'undefined' ? global : self));

async function generateABogus(query, ua) {
    const fn = (typeof globalThis !== 'undefined' ? globalThis : (typeof global !== 'undefined' ? global : self)).__dyextract_generateABogus;
    return await fn(query, ua || MOBILE_UA);
}

// ========== 网络模式控制 ==========
// EdgeOne Cloud Functions 的全局 fetch() 虽然存在但无法发起外网请求（hang 住直到超时）
// 设置 useNodeHttp = true 可强制使用 Node.js 原生 http/https 模块
let useNodeHttp = false;
function setUseNodeHttp(val) {
    useNodeHttp = !!val;
}

// ========== KV 缓存（双模式：优先外部 KV store，否则降级内存 Map） ==========
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
        } catch (e) {
            memoryCache.set(id, payload);
        }
    } else {
        memoryCache.set(id, payload);
    }
    // 不使用 setTimeout 清理：EdgeOne Cloud Functions 中 pending timer 会导致进程无法退出，
    // 触发 "Error return from script"。改为限制缓存大小。
    if (memoryCache.size > 50) {
        const firstKey = memoryCache.keys().next().value;
        if (firstKey) memoryCache.delete(firstKey);
    }
    return id;
}

async function getCachedVideo(id) {
    if (kvStore && typeof kvStore.get === 'function') {
        try {
            const raw = await kvStore.get(id);
            if (raw) {
                return typeof raw === 'string' ? JSON.parse(raw) : raw;
            }
        } catch (e) {}
    }
    return memoryCache.get(id);
}

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
    try { return JSON.parse(jsonStr); } catch (e) { return null; }
}

function decodeUrl(u) {
    if (!u) return '';
    return u.replace(/\\u002F/gi, '/').replace(/\\u003F/gi, '?').replace(/\\u0026/gi, '&').replace(/\\u003D/gi, '=').replace(/\\"/g, '"').replace(/\\\//g, '/');
}

function getCookiesFromHeaders(headers) {
    // headers: Object<string,string|string[]> 或 fetch Headers 对象
    if (headers && typeof headers.forEach === 'function') {
        // fetch Headers：getSetCookie() 拿完整多值
        if (typeof headers.getSetCookie === 'function') {
            const list = headers.getSetCookie();
            return list.map(c => c.split(';')[0]).join('; ');
        }
        // fallback: 遍历合并
        const list = [];
        headers.forEach((v, k) => {
            if (k.toLowerCase() === 'set-cookie') list.push(...(Array.isArray(v) ? v : [v]));
        });
        return list.map(c => c.split(';')[0]).join('; ');
    }
    return ((headers && headers['set-cookie']) || []).map(c => c.split(';')[0]).join('; ');
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
    return Object.entries(m).map(([k, v]) => k + '=' + v).join('; ');
}

// ========== 网络请求：自动适配 fetch / Node http ==========

// 创建带超时的 fetch 请求（兼容 EdgeOne Node Functions / Cloudflare Workers）
async function fetchWithTimeout(url, init, timeoutMs) {
    // 优先用 AbortController（兼容性更好）
    if (typeof AbortController !== 'undefined') {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const resp = await fetch(url, { ...init, signal: controller.signal });
            clearTimeout(timeoutId);
            return resp;
        } catch (e) {
            clearTimeout(timeoutId);
            if (e.name === 'AbortError') throw new Error('请求超时');
            throw e;
        }
    }
    // Fallback: Promise.race（不支持 AbortController 的环境）
    // 注意：fetchPromise 即使超时也会继续执行，加 .catch 防止 unhandled rejection
    const fetchPromise = fetch(url, init).catch(() => {});
    const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('请求超时')), timeoutMs)
    );
    return Promise.race([fetchPromise, timeoutPromise]);
}

// Node 原生 http 请求（EdgeOne Node14/16 无 fetch 时使用）
function nodeHttpRequest(url, options) {
    return new Promise((resolve, reject) => {
        let http, https;
        try { http = require('http'); https = require('https'); }
        catch (e) { return reject(new Error('Node http/https 模块不可用: ' + e.message)); }

        const u = new URL(url);
        const client = u.protocol === 'https:' ? https : http;
        const reqHeaders = { ...options.headers };
        // Node 原生不支持 br，只声明 gzip/deflate
        if (reqHeaders['Accept-Encoding'] === 'gzip, deflate, br') {
            reqHeaders['Accept-Encoding'] = 'gzip, deflate';
        }

        let settled = false;
        const timeoutMs = options.timeoutMs || 20000;

        // 硬超时：覆盖 DNS/TCP 连接 hang 的情况（req.setTimeout 只监听 socket 空闲）
        const hardTimeoutId = setTimeout(() => {
            if (settled) return;
            settled = true;
            try { req.destroy(); } catch (e) {}
            reject(new Error('请求超时(hard ' + timeoutMs + 'ms)'));
        }, timeoutMs);

        const req = client.request({
            hostname: u.hostname,
            port: u.port || (u.protocol === 'https:' ? 443 : 80),
            path: u.pathname + u.search,
            method: options.method || 'GET',
            rejectUnauthorized: false,
            headers: reqHeaders
        }, (res) => {
            // 手动处理重定向
            if (res.statusCode >= 301 && res.statusCode <= 308 && res.headers.location) {
                let loc = res.headers.location;
                if (loc.startsWith('/')) loc = u.protocol + '//' + u.hostname + loc;
                res.resume();
                if (settled) return;
                settled = true;
                clearTimeout(hardTimeoutId);
                return resolve({ redirect: loc, headers: res.headers });
            }

            const chunks = [];
            let stream = res;
            const encoding = (res.headers['content-encoding'] || '').toLowerCase();
            if (encoding === 'gzip' || encoding === 'deflate') {
                try {
                    const zlib = require('zlib');
                    stream = encoding === 'gzip' ? zlib.createGunzip() : zlib.createInflate();
                    res.pipe(stream);
                } catch (e) {
                    res.resume();
                    if (settled) return;
                    settled = true;
                    clearTimeout(hardTimeoutId);
                    return reject(new Error('解压失败: ' + e.message));
                }
            }
            stream.on('data', c => chunks.push(c));
            stream.on('end', () => {
                if (settled) return;
                settled = true;
                clearTimeout(hardTimeoutId);
                resolve({ redirect: null, res: { status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf-8') } });
            });
            stream.on('error', (e) => {
                if (settled) return;
                settled = true;
                clearTimeout(hardTimeoutId);
                reject(e);
            });
        });

        req.on('error', (e) => {
            if (settled) return;
            settled = true;
            clearTimeout(hardTimeoutId);
            reject(e);
        });
        req.setTimeout(timeoutMs, () => {
            if (settled) return;
            settled = true;
            clearTimeout(hardTimeoutId);
            try { req.destroy(); } catch (e) {}
            reject(new Error('请求超时(socket)'));
        });
        if (options.body) req.write(options.body);
        req.end();
    });
}

async function nativeRequest(url, { headers = {}, method = 'GET', body = null, timeoutMs = 20000, redirectDepth = 0 } = {}) {
    if (redirectDepth > 8) throw new Error('重定向次数过多');

    const defaultHeaders = {
        'User-Agent': MOBILE_UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh-Hans;q=0.9,zh;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
        'Upgrade-Insecure-Requests': '1'
    };
    const mergedHeaders = { ...defaultHeaders, ...headers };

    // 分支：有 fetch 用 fetch（Workers / Node 18+），否则用 Node 原生 http
    // useNodeHttp=true 时强制走 Node 原生 http（EdgeOne 环境的 fetch 无法访问外网）
    const hasFetch = typeof fetch === 'function' && !useNodeHttp;

    if (hasFetch) {
        // —— fetch 路径（Cloudflare Workers / EdgeOne Node Functions / Node 18+）——
        // 使用 redirect: 'follow' 让 fetch 内部处理重定向，超时作用于整个重定向链
        // （redirect: 'manual' 会导致每次重定向递归调用，各自有独立超时，叠加后超 30s 函数限制）
        let resp;

        try {
            resp = await fetchWithTimeout(url, {
                method,
                headers: mergedHeaders,
                body: body || undefined,
                redirect: 'follow'
            }, timeoutMs);
        } catch (e) {
            if (e.message === '请求超时') throw e;
            // follow 失败，尝试 manual 作为最后手段
            console.log('[nativeRequest] redirect:follow 失败，尝试 manual:', e.message);
            try {
                resp = await fetchWithTimeout(url, {
                    method,
                    headers: mergedHeaders,
                    body: body || undefined,
                    redirect: 'manual'
                }, timeoutMs);
            } catch (e2) {
                if (e2.message === '请求超时') throw e2;
                throw new Error('fetch请求失败: ' + e2.message);
            }
        }

        const status = resp.status;
        const loc = resp.headers.get('location');

        // manual 模式下的重定向跳转（follow 模式下不会走到这里）
        if (status >= 301 && status <= 308 && loc) {
            let next = loc;
            if (next.startsWith('/')) {
                const u = new URL(url);
                next = u.protocol + '//' + u.hostname + next;
            }
            const prevCookie = getCookiesFromHeaders(resp.headers);
            return nativeRequest(next, {
                headers: prevCookie ? { ...headers, 'Cookie': mergeCookies(headers['Cookie'], prevCookie) } : headers,
                method, body, timeoutMs, redirectDepth: redirectDepth + 1
            });
        }

        const headersObj = {};
        resp.headers.forEach((v, k) => { headersObj[k.toLowerCase()] = v; });
        if (typeof resp.headers.getSetCookie === 'function') {
            const sc = resp.headers.getSetCookie();
            if (sc && sc.length) headersObj['set-cookie'] = sc;
        }

        const text = await resp.text();
        return { status, headers: headersObj, body: text };
    }

    // —— Node http 路径（无 fetch 的降级环境）——
    const result = await nodeHttpRequest(url, { headers: mergedHeaders, method, body, timeoutMs });
    if (result.redirect) {
        let next = result.redirect;
        if (next.startsWith('/')) {
            const u = new URL(url);
            next = u.protocol + '//' + u.hostname + next;
        }
        const prevCookie = getCookiesFromHeaders(result.headers || {});
        return nativeRequest(next, {
            headers: prevCookie ? { ...headers, 'Cookie': mergeCookies(headers['Cookie'], prevCookie) } : headers,
            method, body, timeoutMs, redirectDepth: redirectDepth + 1
        });
    }

    const res = result.res;
    const headersObj = {};
    if (res.headers) {
        Object.keys(res.headers).forEach(k => { headersObj[k.toLowerCase()] = res.headers[k]; });
    }
    return { status: res.status, headers: headersObj, body: res.body };
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
                        return extracted;
                    }
                } catch (e) { }
            } catch (e) { }
        }
    }
    return null;
}

// ========== 策略C：ttwid 签名 + aweme/v1/web/aweme/detail ==========
// 抖音 share 页面不再下发 Set-Cookie（移除了 ttwid），直接请求会返回 status_code=11110。
// 策略：通过 ttwid.bytedance.com/union/register 主动申请一个 ttwid，
// 再用它请求 www.douyin.com/aweme/v1/web/aweme/detail（iesdouyin 域名即使带 ttwid 也返回 11110）。

let _ttwidCache = { value: '', expireAt: 0 };

async function fetchTtwid() {
    // 简单内存缓存（有效期 24h，ttwid 官方 Max-Age=31536000）
    if (_ttwidCache.value && Date.now() < _ttwidCache.expireAt) return _ttwidCache.value;

    const postData = JSON.stringify({
        region: 'cn',
        aid: 1128,
        needFid: false,
        service: 'www.douyin.com',
        migrate_source: 0,
        cbUrlProtocol: 'https',
        app_name: 'aweme_web',
        device_platform: 'web',
    });
    const url = 'https://ttwid.bytedance.com/ttwid/union/register/';
    const desktopUA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

    const headers = {
        'User-Agent': desktopUA,
        'Content-Type': 'application/json',
        'Accept': '*/*',
        'Origin': 'https://www.douyin.com',
        'Referer': 'https://www.douyin.com/',
    };

    let resp;
    try {
        resp = await nativeRequest(url, {
            method: 'POST',
            headers,
            body: postData,
            timeoutMs: 10000,
        });
    } catch (e) {
        if (typeof console !== 'undefined' && console.warn) console.warn('[fetchTtwid] 请求异常:', e.message);
        return '';
    }

    // 优先从 set-cookie 中取
    const sc = resp.headers['set-cookie'];
    if (Array.isArray(sc)) {
        for (const line of sc) {
            const m = line.match(/ttwid=([^;]+)/);
            if (m) {
                _ttwidCache = { value: m[1], expireAt: Date.now() + 24 * 3600 * 1000 };
                return m[1];
            }
        }
    } else if (typeof sc === 'string') {
        const m = sc.match(/ttwid=([^;]+)/);
        if (m) {
            _ttwidCache = { value: m[1], expireAt: Date.now() + 24 * 3600 * 1000 };
            return m[1];
        }
    }

    // 兜底：从 JSON body 中取
    try {
        const j = JSON.parse(resp.body || '{}');
        const ttwid = j.data?.ttwid || j.ttwid || j.data?.cookie || '';
        if (ttwid) {
            _ttwidCache = { value: ttwid, expireAt: Date.now() + 24 * 3600 * 1000 };
            return ttwid;
        }
    } catch (e) {}

    if (typeof console !== 'undefined' && console.warn) console.warn('[fetchTtwid] 未拿到 ttwid, status:', resp.status, 'body preview:', (resp.body||'').substring(0,120));
    return '';
}

async function fetchApiWithTtwid(itemId, ttwid) {
    if (!ttwid) return null;
    const referer = 'https://www.douyin.com/video/' + itemId;
    const cookie = 'ttwid=' + ttwid;

    // 注意：只用 www.douyin.com/aweme/v1/web/aweme/detail，其他（如 iesdouyin iteminfo）
    // 即使带 ttwid 也会返回 11110 encrypt_data_miss
    const baseQuery = `aweme_id=${itemId}`;

    // 可选：追加 a_bogus 签名（实测当前 ttwid 单独就能过校验，但保留签名作为保险）
    let signedQuery = baseQuery;
    try {
        const ab = await generateABogus(baseQuery, MOBILE_UA);
        signedQuery = baseQuery + '&a_bogus=' + encodeURIComponent(ab);
    } catch (e) {}

    const endpoints = [
        'https://www.douyin.com/aweme/v1/web/aweme/detail/?' + signedQuery,
        'https://www.douyin.com/aweme/v1/web/aweme/detail/?' + baseQuery,
    ];

    for (const fullUrl of endpoints) {
        try {
            const ra = await nativeRequest(fullUrl, {
                headers: {
                    'User-Agent': MOBILE_UA,
                    'Accept': 'application/json, text/plain, */*',
                    'Cookie': cookie,
                    'Referer': referer,
                    'X-Requested-With': 'XMLHttpRequest',
                },
                timeoutMs: 12000,
            });
            if (!ra.body) continue;
            try {
                const j = JSON.parse(ra.body);
                if (j.status_code !== 0 && typeof console !== 'undefined' && console.log) {
                    console.log('[fetchApiWithTtwid] status_code=' + j.status_code + ' msg=' + (j.status_msg||'').substring(0,60));
                }
                const item = j.aweme_detail || j.data?.aweme_detail || j.item_list?.[0] || j.aweme_list?.[0];
                if (!item) continue;
                const extracted = extractFromApiItem(item);
                if (extracted.playUrl || extracted.images.length) return extracted;
            } catch (e) {}
        } catch (e) {
            if (typeof console !== 'undefined' && console.warn) console.warn('[fetchApiWithTtwid] 请求异常:', e.message);
        }
    }
    return null;
}

async function performParse(rawUrl) {
    const cleanUrl = extractDouyinUrl(String(rawUrl || ''));
    if (!cleanUrl.startsWith('http')) throw new Error('无法识别有效链接');
    if (typeof console !== 'undefined' && console.log) {
        console.log('[解析] URL:', cleanUrl);
    }

    let itemId = extractItemId(cleanUrl);
    let contentType = 'video';
    if (!itemId) {
        const step1 = await nativeRequest(cleanUrl, { timeoutMs: 12000 }).catch(() => ({ body: '' }));
        itemId = extractItemId(step1.body || '');
        if (/\/note\//.test(step1.body || '')) contentType = 'note';
    }
    if (!itemId) throw new Error('无法提取内容ID，请确认链接正确');
    if (typeof console !== 'undefined' && console.log) console.log(`[解析] itemId: ${itemId}, type: ${contentType}`);
    const shareUrl = `https://www.iesdouyin.com/share/video/${itemId}`;

    let workingCookie = '';
    let result = { title: '', author: '', cover: '', playUrl: '', images: [] };
    let sourceUsed = '';

    try {
        const htmlResp = await nativeRequest(shareUrl, { timeoutMs: 15000 });
        workingCookie = getCookiesFromHeaders(htmlResp.headers);

        const meta = parseMetaInfo(htmlResp.body);
        if (meta.title) result.title = meta.title;
        if (meta.image) result.cover = meta.image;
        if (meta.videoUrl) result.playUrl = meta.videoUrl;

        const embedded = parseFromEmbeddedData(htmlResp.body);
        if (embedded.playUrl || embedded.images.length) {
            Object.assign(result, embedded);
            sourceUsed = 'embedded';
            if (typeof console !== 'undefined' && console.log) console.log('[策略A] 嵌入数据解析成功');
        } else {
            if (embedded.title) result.title = embedded.title;
            if (embedded.author) result.author = embedded.author;
            if (embedded.cover && !result.cover) result.cover = embedded.cover;
        }
    } catch (e) {
        if (typeof console !== 'undefined' && console.warn) console.warn('[策略A] 异常:', e.message);
    }

    if (!result.playUrl && result.images.length === 0 && workingCookie) {
        if (typeof console !== 'undefined' && console.log) console.log('[策略B] 调用官方 API...');
        const apiRes = await fetchApiWithCookie(itemId, workingCookie);
        if (apiRes && (apiRes.playUrl || apiRes.images.length)) {
            result.title = apiRes.title || result.title;
            result.author = apiRes.author || result.author;
            result.cover = apiRes.cover || result.cover;
            result.playUrl = apiRes.playUrl;
            result.images = apiRes.images;
            sourceUsed = 'api';
            if (typeof console !== 'undefined' && console.log) console.log('[策略B] API 成功');
        }
    } else if (!result.playUrl && result.images.length === 0) {
        // 兜底：无 cookie 时也裸调 API
        const apiRes = await fetchApiWithCookie(itemId, '');
        if (apiRes && (apiRes.playUrl || apiRes.images.length)) {
            result.playUrl = apiRes.playUrl;
            result.images = apiRes.images;
            result.title = apiRes.title || result.title;
            result.author = apiRes.author || result.author;
            result.cover = apiRes.cover || result.cover;
            sourceUsed = 'api-nocookie';
        }
    }

    // 策略C：主动申请 ttwid → aweme/v1/web/aweme/detail
    // （抖音已从 share 页响应中移除 Set-Cookie，导致 workingCookie 可能为空，前两策略失效）
    if (!result.playUrl && result.images.length === 0) {
        if (typeof console !== 'undefined' && console.log) console.log('[策略C] 申请 ttwid 并调用 aweme web API...');
        try {
            const ttwid = await fetchTtwid();
            if (ttwid) {
                if (typeof console !== 'undefined' && console.log) console.log('[策略C] ttwid 已获取 (len=' + ttwid.length + ')');
                const apiRes = await fetchApiWithTtwid(itemId, ttwid);
                if (apiRes && (apiRes.playUrl || apiRes.images.length)) {
                    result.title = apiRes.title || result.title;
                    result.author = apiRes.author || result.author;
                    result.cover = apiRes.cover || result.cover;
                    result.playUrl = apiRes.playUrl;
                    result.images = apiRes.images;
                    sourceUsed = 'ttwid-api';
                    if (typeof console !== 'undefined' && console.log) console.log('[策略C] ttwid API 成功');
                }
            } else {
                if (typeof console !== 'undefined' && console.warn) console.warn('[策略C] 未获取到 ttwid');
            }
        } catch (e) {
            if (typeof console !== 'undefined' && console.warn) console.warn('[策略C] 异常:', e.message);
        }
    }

    if (!result.playUrl && result.images.length === 0) {
        throw new Error('无法获取媒体资源，请稍后重试');
    }

    return { itemId, result, sourceUsed };
}

// 统一响应包装（给 Express / Pages Functions 复用）
// 说明：video_key 是可选优化字段，前端实际通过 /api/video?url= 直传，不再依赖 KV 查表。
//       即使未绑定 KV，cacheVideo 也会降级到内存 Map，不会报错。
async function buildParseResponse(rawUrl) {
    const { itemId, result, sourceUsed } = await performParse(rawUrl);
    const isImage = result.images.length > 0;

    if (!isImage && result.playUrl) {
        result.playUrl = decodeUrl(result.playUrl).replace(/playwm/g, 'play');
        let videoKey = '';
        try { videoKey = await cacheVideo(result.playUrl); } catch (e) { videoKey = ''; }
        return {
            __isVideo: true,
            payload: {
                success: true,
                type: 'video',
                title: result.title || '抖音视频',
                author: result.author || '未知作者',
                play_url: result.playUrl,
                video_key: videoKey, // 可选字段，前端不依赖；仅作为 KV 缓存命中时的兼容标识
                item_id: itemId,
                cover: result.cover,
                platform: 'douyin',
                source: sourceUsed || 'self'
            }
        };
    }

    if (isImage) {
        return {
            __isVideo: false,
            payload: {
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
            }
        };
    }

    throw new Error('解析失败');
}

module.exports = {
    MOBILE_UA,
    setKVStore,
    setUseNodeHttp,
    cacheVideo,
    getCachedVideo,
    extractDouyinUrl,
    extractItemId,
    decodeUrl,
    getCookiesFromHeaders,
    mergeCookies,
    nativeRequest,
    extractFromApiItem,
    parseFromEmbeddedData,
    parseMetaInfo,
    fetchApiWithCookie,
    fetchTtwid,
    fetchApiWithTtwid,
    performParse,
    buildParseResponse
};
