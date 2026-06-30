const express = require('express');
const path = require('path');
const http = require('http');
const https = require('https');

const app = express();
const PORT = 3001;

const videoCache = new Map();
let cacheCounter = 0;

function cacheVideo(url) {
    const id = 'v' + (++cacheCounter);
    videoCache.set(id, { url, time: Date.now() });
    setTimeout(() => videoCache.delete(id), 30 * 60 * 1000);
    return id;
}

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/api/douyin/self', async (req, res) => {
    const { url } = req.query;

    if (!url) {
        return res.status(400).json({ error: '缺少URL参数' });
    }

    try {
        // 1. 首先访问短链接获取重定向后的真实URL
        const mobileAgent = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

        const initResponse = await fetch(url, {
            headers: {
                'User-Agent': mobileAgent,
                'Referer': 'https://www.douyin.com/'
            },
            redirect: 'follow'
        });

        const finalUrl = initResponse.url;
        console.log('重定向后的URL:', finalUrl);

        // 判断类型：视频还是图文
        let contentType = 'video';
        let itemId = '';
        
        // 匹配 /note/xxx - 图文
        const noteIdMatch = finalUrl.match(/\/note\/(\d+)/);
        // 匹配 /video/xxx - 视频
        const videoIdMatch = finalUrl.match(/\/video\/(\d+)/);
        
        if (noteIdMatch) {
            contentType = 'note';
            itemId = noteIdMatch[1];
        } else if (videoIdMatch) {
            contentType = 'video';
            itemId = videoIdMatch[1];
        } else {
            // 尝试从分享链接中提取ID
            const idMatch = url.match(/(\d{17,19})/);
            if (idMatch) {
                itemId = idMatch[1];
            }
        }

        if (!itemId) {
            throw new Error('无法提取内容ID');
        }

        console.log('内容类型:', contentType);
        console.log('内容ID:', itemId);

        // 2. 访问移动端分享页面获取信息
        const sharePath = contentType === 'note' ? 'note' : 'video';
        const shareUrl = `https://www.iesdouyin.com/share/${sharePath}/${itemId}`;
        const pageResponse = await fetch(shareUrl, {
            headers: {
                'User-Agent': mobileAgent,
                'Referer': 'https://www.douyin.com/',
                'Accept': 'text/html,application/xhtml+xml',
                'Accept-Language': 'zh-CN,zh;q=0.9'
            }
        });

        const html = await pageResponse.text();

        // 3. 从HTML中提取JSON数据 (优先 _ROUTER_DATA)
        let jsonData = null;
        
        // 先尝试提取 _ROUTER_DATA (图文/视频都可能有)
        const routerDataMatch = html.match(/window\._ROUTER_DATA\s*=\s*/);
        if (routerDataMatch) {
            const startIdx = html.indexOf('{', routerDataMatch.index + routerDataMatch[0].length);
            if (startIdx >= 0) {
                let braceCount = 0;
                let endIdx = startIdx;
                let inString = false;
                let escapeNext = false;
                
                for (let i = startIdx; i < html.length; i++) {
                    const char = html[i];
                    
                    if (escapeNext) { escapeNext = false; continue; }
                    if (char === '\\') { escapeNext = true; continue; }
                    if (char === '"') { inString = !inString; continue; }
                    
                    if (!inString) {
                        if (char === '{') braceCount++;
                        else if (char === '}') {
                            braceCount--;
                            if (braceCount === 0) {
                                endIdx = i;
                                break;
                            }
                        }
                    }
                }
                
                try {
                    jsonData = JSON.parse(html.substring(startIdx, endIdx + 1));
                    console.log('成功提取 _ROUTER_DATA');
                } catch (e) {
                    console.log('_ROUTER_DATA 解析失败:', e.message);
                }
            }
        }
        
        // 如果 _ROUTER_DATA 失败，尝试其他模式
        if (!jsonData) {
            const patterns = [
                /window\.__NEXT_DATA__\s*=\s*({.*?})\s*<\/script>/s,
                /id="__NEXT_DATA__"[^>]*>(.*?)<\/script>/s
            ];

            for (const pattern of patterns) {
                const match = html.match(pattern);
                if (match && match[1]) {
                    try {
                        jsonData = JSON.parse(match[1].trim());
                        console.log('成功提取JSON数据');
                        break;
                    } catch (e) {
                        console.log('JSON解析失败，尝试下一个模式');
                    }
                }
            }
        }

        let playUrl = '';
        let title = '抖音';
        let author = '未知作者';
        let cover = '';
        let images = [];

        if (jsonData) {
            const jsonStr = JSON.stringify(jsonData);
            
            // 提取标题
            const descMatch = jsonStr.match(/"desc"\s*:\s*"([^"]+)"/);
            if (descMatch) {
                try { title = JSON.parse('"' + descMatch[1] + '"'); } catch(e) { title = descMatch[1]; }
            }
            
            // 提取作者
            const authorMatch = jsonStr.match(/"nickname"\s*:\s*"([^"]+)"/);
            if (authorMatch) {
                try { author = JSON.parse('"' + authorMatch[1] + '"'); } catch(e) { author = authorMatch[1]; }
            }
            
            if (contentType === 'note') {
                // 图文类型：提取图片数组
                console.log('正在提取图片列表...');
                
                const imagesIdx = jsonStr.indexOf('"images":[');
                if (imagesIdx >= 0) {
                    const arrStart = jsonStr.indexOf('[', imagesIdx);
                    let arrBraceCount = 0;
                    let arrEnd = arrStart;
                    let inStr = false;
                    let escNext = false;
                    
                    for (let i = arrStart; i < jsonStr.length; i++) {
                        const c = jsonStr[i];
                        if (escNext) { escNext = false; continue; }
                        if (c === '\\') { escNext = true; continue; }
                        if (c === '"') { inStr = !inStr; continue; }
                        
                        if (!inStr) {
                            if (c === '[') arrBraceCount++;
                            else if (c === ']') {
                                arrBraceCount--;
                                if (arrBraceCount === 0) {
                                    arrEnd = i;
                                    break;
                                }
                            }
                        }
                    }
                    
                    try {
                        const imagesArr = JSON.parse(jsonStr.substring(arrStart, arrEnd + 1));
                        images = imagesArr.map(img => {
                            let imgUrl = '';
                            if (img.url_list && img.url_list.length > 0) {
                                imgUrl = img.url_list[0];
                                try { imgUrl = JSON.parse('"' + imgUrl + '"'); } catch(e) {}
                            }
                            return {
                                url: imgUrl,
                                width: img.width || 0,
                                height: img.height || 0,
                                uri: img.uri || ''
                            };
                        }).filter(img => img.url);
                        
                        console.log('提取到图片数量:', images.length);
                        
                        if (images.length > 0) {
                            cover = images[0].url;
                        }
                    } catch (e) {
                        console.log('解析图片数组失败:', e.message);
                    }
                }
            } else {
                // 视频类型：提取视频URL
                console.log('正在提取视频地址...');
                
                const paths = [
                    "loaderData.video_(id)/page.videoInfoRes.item_list[0]",
                    "loaderData.note_(id)/page.noteInfoRes.item_list[0]",
                    'props.pageProps.videoData.item_list[0]',
                    'props.pageProps.awemeDetail',
                    'items[0]',
                    'item_list[0]'
                ];

                function getNestedValue(obj, path) {
                    const parts = path.split('.');
                    let result = obj;
                    for (const part of parts) {
                        if (result == null) return undefined;
                        const arrMatch = part.match(/^(\w+)\[(\d+)\]$/);
                        if (arrMatch) {
                            result = result[arrMatch[1]]?.[parseInt(arrMatch[2])];
                        } else {
                            result = result[part];
                        }
                    }
                    return result;
                }

                for (const p of paths) {
                    const obj = getNestedValue(jsonData, p);
                    if (obj) {
                        const urlList = obj.video?.play_addr?.url_list || obj.video?.download_addr?.url_list || [];
                        if (urlList.length > 0) {
                            playUrl = urlList[0].replace('playwm', 'play');
                        }
                        title = obj.desc || title;
                        author = obj.author?.nickname || obj.author?.unique_id || author;
                        cover = obj.video?.cover?.url_list?.[0] || obj.video?.thumbnail?.url_list?.[0] || '';
                        if (cover) {
                            try { cover = JSON.parse('"' + cover + '"'); } catch(e) {}
                        }
                        break;
                    }
                }
                
                // 正则匹配兜底
                if (!playUrl) {
                    const videoPatterns = [
                        /"play_addr":\s*{[^}]*"url_list":\s*\["([^"]+)"/,
                        /"download_addr":\s*{[^}]*"url_list":\s*\["([^"]+)"/
                    ];
                    
                    for (const pattern of videoPatterns) {
                        const match = html.match(pattern);
                        if (match && match[1]) {
                            playUrl = match[1].replace('playwm', 'play');
                            break;
                        }
                    }
                }
            }
        }
        
        // 视频类型：获取真实视频地址
        if (contentType === 'video' && playUrl) {
            // 解码URL中的转义字符
            playUrl = playUrl.replace(/\\u002F/g, '/').replace(/\\u003F/g, '?').replace(/\\/g, '/');

            console.log('正在获取真实视频地址...');
            try {
                const videoResponse = await fetch(playUrl, {
                    headers: {
                        'User-Agent': mobileAgent,
                        'Referer': 'https://www.iesdouyin.com/',
                        'Accept': '*/*',
                        'Accept-Language': 'zh-CN,zh;q=0.9',
                    },
                    redirect: 'follow'
                });
                
                const realUrl = videoResponse.url;
                console.log('真实视频URL:', realUrl);
                
                if (realUrl && (realUrl.includes('douyinvod') || realUrl.includes('365yg') || realUrl.includes('byted') || realUrl.includes('amemv'))) {
                    playUrl = realUrl;
                }
            } catch (e) {
                console.log('获取真实URL失败，使用原始URL:', e.message);
            }
            
            const videoKey = cacheVideo(playUrl);
            
            return res.json({
                success: true,
                type: 'video',
                title: title,
                author: author,
                play_url: playUrl,
                video_key: videoKey,
                item_id: itemId,
                cover: cover,
                platform: 'douyin',
                source: 'self'
            });
        }
        
        // 图文类型
        if (contentType === 'note' && images.length > 0) {
            return res.json({
                success: true,
                type: 'image',
                title: title,
                author: author,
                images: images,
                item_id: itemId,
                cover: cover,
                image_count: images.length,
                platform: 'douyin',
                source: 'self'
            });
        }

        // 都没找到
        throw new Error('无法解析内容，可能需要登录或内容不存在');

    } catch (error) {
        console.error('自建API解析错误:', error);
        return res.status(500).json({ error: error.message || '解析失败' });
    }
});

app.get('/api/douyin', async (req, res) => {
    const { url } = req.query;

    if (!url) {
        return res.status(400).json({ error: '缺少URL参数' });
    }

    try {
        // 完全使用自建API
        const selfResponse = await fetch(`http://localhost:${PORT}/api/douyin/self?url=${encodeURIComponent(url)}`);
        const selfData = await selfResponse.json();
        
        if (selfData.success && (selfData.play_url || (selfData.images && selfData.images.length > 0))) {
            return res.json(selfData);
        }
        
        // 自建API失败则返回错误
        throw new Error(selfData.error || '解析失败');

    } catch (error) {
        console.error('解析错误:', error);
        return res.status(500).json({ error: error.message || '解析失败，请检查链接是否正确' });
    }
});

app.get('/api/cover', (req, res) => {
    const { url } = req.query;

    if (!url) {
        return res.status(400).json({ error: '缺少URL参数' });
    }

    console.log('封面代理请求:', url.substring(0, 80) + '...');

    function proxyCover(targetUrl, redirectCount) {
        if (redirectCount > 5) {
            return res.status(500).json({ error: '重定向次数过多' });
        }

        const client = targetUrl.startsWith('https') ? https : http;

        const parsedUrl = new URL(targetUrl);
        const options = {
            hostname: parsedUrl.hostname,
            port: parsedUrl.port || (targetUrl.startsWith('https') ? 443 : 80),
            path: parsedUrl.pathname + parsedUrl.search,
            method: 'GET',
            headers: {
                'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
                'Referer': 'https://www.douyin.com/',
                'Accept': 'image/*,image/webp,image/apng,*/*;q=0.8',
                'Accept-Language': 'zh-CN,zh;q=0.9'
            }
        };

        const proxyReq = client.request(options, (proxyRes) => {
            console.log('封面源响应状态:', proxyRes.statusCode);

            if (proxyRes.statusCode >= 301 && proxyRes.statusCode <= 308 && proxyRes.headers.location) {
                let redirectUrl = proxyRes.headers.location;
                if (redirectUrl.startsWith('/')) {
                    redirectUrl = parsedUrl.protocol + '//' + parsedUrl.hostname + redirectUrl;
                }
                console.log('跟随重定向:', redirectUrl.substring(0, 80) + '...');
                proxyRes.resume();
                proxyCover(redirectUrl, redirectCount + 1);
                return;
            }

            if (proxyRes.statusCode >= 400) {
                console.log('封面源返回错误:', proxyRes.statusCode);
                proxyRes.resume();
                if (!res.headersSent) {
                    res.status(proxyRes.statusCode).json({ error: `封面请求失败: ${proxyRes.statusCode}` });
                }
                return;
            }

            if (!res.headersSent) {
                res.status(proxyRes.statusCode);
                res.setHeader('Content-Type', proxyRes.headers['content-type'] || 'image/jpeg');
                
                if (proxyRes.headers['content-length']) {
                    res.setHeader('Content-Length', proxyRes.headers['content-length']);
                }
                if (proxyRes.headers['cache-control']) {
                    res.setHeader('Cache-Control', proxyRes.headers['cache-control']);
                }
                
                if (req.query.download) {
                    res.setHeader('Content-Disposition', 'attachment; filename=douyin_cover.jpg');
                }
            }

            proxyRes.on('error', (err) => {
                console.error('封面流错误:', err.message);
                if (!res.headersSent) {
                    res.status(500).json({ error: '封面流传输失败' });
                }
            });

            proxyRes.pipe(res);
        });

        proxyReq.on('error', (err) => {
            console.error('封面代理请求错误:', err.message);
            if (!res.headersSent) {
                res.status(500).json({ error: '封面代理失败: ' + err.message });
            }
        });

        proxyReq.on('timeout', () => {
            console.error('封面代理请求超时');
            proxyReq.destroy();
            if (!res.headersSent) {
                res.status(504).json({ error: '封面请求超时' });
            }
        });

        proxyReq.setTimeout(30000);
        proxyReq.end();
    }

    proxyCover(url, 0);
});

app.get('/api/video', (req, res) => {
    const { url, id, download } = req.query;

    let videoUrl = url;
    
    if (id) {
        const cached = videoCache.get(id);
        if (cached) {
            videoUrl = cached.url;
        } else {
            return res.status(404).json({ error: '视频缓存已过期，请重新解析' });
        }
    }

    if (!videoUrl) {
        return res.status(400).json({ error: '缺少URL参数' });
    }

    console.log('视频代理请求:', videoUrl.substring(0, 80) + '...');

    function proxyVideo(targetUrl, redirectCount) {
        if (redirectCount > 5) {
            return res.status(500).json({ error: '重定向次数过多' });
        }

        const client = targetUrl.startsWith('https') ? https : http;

        const parsedUrl = new URL(targetUrl);
        const options = {
            hostname: parsedUrl.hostname,
            port: parsedUrl.port || (targetUrl.startsWith('https') ? 443 : 80),
            path: parsedUrl.pathname + parsedUrl.search,
            method: 'GET',
            headers: {
                'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
                'Referer': 'https://www.douyin.com/',
                'Accept': '*/*',
                'Accept-Language': 'zh-CN,zh;q=0.9'
            }
        };

        if (req.headers.range) {
            options.headers['Range'] = req.headers.range;
        }

        const proxyReq = client.request(options, (proxyRes) => {
            console.log('视频源响应状态:', proxyRes.statusCode);

            if (proxyRes.statusCode >= 301 && proxyRes.statusCode <= 308 && proxyRes.headers.location) {
                let redirectUrl = proxyRes.headers.location;
                if (redirectUrl.startsWith('/')) {
                    redirectUrl = parsedUrl.protocol + '//' + parsedUrl.hostname + redirectUrl;
                }
                console.log('跟随重定向:', redirectUrl.substring(0, 80) + '...');
                proxyRes.resume();
                proxyVideo(redirectUrl, redirectCount + 1);
                return;
            }

            if (proxyRes.statusCode >= 400) {
                console.log('视频源返回错误:', proxyRes.statusCode);
                let body = '';
                proxyRes.on('data', (chunk) => { body += chunk; });
                proxyRes.on('end', () => {
                    console.log('错误响应体:', body.substring(0, 200));
                    if (!res.headersSent) {
                        res.status(proxyRes.statusCode).json({ error: `视频请求失败: ${proxyRes.statusCode}` });
                    }
                });
                return;
            }

            if (!res.headersSent) {
                res.status(proxyRes.statusCode);
                res.setHeader('Content-Type', proxyRes.headers['content-type'] || 'video/mp4');
                res.setHeader('Accept-Ranges', 'bytes');
                
                if (proxyRes.headers['content-length']) {
                    res.setHeader('Content-Length', proxyRes.headers['content-length']);
                }
                if (proxyRes.headers['content-range']) {
                    res.setHeader('Content-Range', proxyRes.headers['content-range']);
                }
                if (proxyRes.headers['cache-control']) {
                    res.setHeader('Cache-Control', proxyRes.headers['cache-control']);
                }
                
                if (download) {
                    res.setHeader('Content-Disposition', 'attachment; filename=douyin_video.mp4');
                }
            }

            proxyRes.on('error', (err) => {
                console.error('视频流错误:', err.message);
                if (!res.headersSent) {
                    res.status(500).json({ error: '视频流传输失败' });
                }
            });

            proxyRes.pipe(res);
        });

        proxyReq.on('error', (err) => {
            console.error('视频代理请求错误:', err.message);
            if (!res.headersSent) {
                res.status(500).json({ error: '视频代理失败: ' + err.message });
            }
        });

        proxyReq.on('timeout', () => {
            console.error('视频代理请求超时');
            proxyReq.destroy();
            if (!res.headersSent) {
                res.status(504).json({ error: '视频请求超时' });
            }
        });

        proxyReq.setTimeout(30000);
        proxyReq.end();
    }

    proxyVideo(videoUrl, 0);
});

app.listen(PORT, () => {
    console.log(`抖音解析服务已启动: http://localhost:${PORT}`);
    console.log(`直接访问: http://localhost:${PORT}`);
});
