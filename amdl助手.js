// ==UserScript==
// @name         AMDL sky8282 版助手
// @namespace    http://tampermonkey.net/
// @version      7.0
// @description  Apple Music 全能助手 - 集成下载、音质检测、封面搜索等功能
// @match        https://music.apple.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @grant        GM_log
// @connect      localhost
// @connect      127.0.0.1
// @connect      *
// @run-at       document-end
// @noframes
// ==/UserScript==

(function() {
    'use strict';

    // --- 1. 配置管理 ---
    let serverAddr = "http://localhost:3000";
    try {
        const saved = GM_getValue("AM_SERVER_ADDR");
        if (saved) {
            serverAddr = saved;
        }
    } catch (e) {
        console.log('[AMDL] 无法读取存储配置，使用默认地址');
    }
    let lastLogIndex = 0;

    // 全局状态
    let currentAlbumTraits = [];
    let qualityDataCache = [];
    let sidebarInjected = false;

    function openServerConfig() {
        const newAddr = prompt("请输入后端地址 (需包含 http/https 和端口):\n当前：" + serverAddr, serverAddr);
        if (newAddr !== null && newAddr.trim() !== "") {
            const cleanAddr = newAddr.trim().replace(/\/$/, "");
            try {
                GM_setValue("AM_SERVER_ADDR", cleanAddr);
            } catch (e) {
                console.log('[AMDL] 无法保存配置');
            }
            alert("配置已更新！页面即将刷新...");
            location.reload();
        }
    }

    // 注册 Tampermonkey 右键菜单（如果支持）
    try {
        if (typeof GM_registerMenuCommand !== 'undefined') {
            GM_registerMenuCommand("⚙️ 配置后端服务器地址", openServerConfig);
            GM_registerMenuCommand("🔄 重新连接", () => {
                restartLogPolling();
                alert("已重新连接，正在同步最新信息...");
            });
            GM_registerMenuCommand("📊 连接状态", () => {
                const status = logPollingInterval ? 'HTTP 轮询模式工作中' : '未连接';
                const pollActive = logPollingInterval ? '✓ 活跃' : '✗ 未启动';
                alert(`连接状态：${status}\n轮询：${pollActive}\n错误计数：${pollErrorCount}`);
            });
            GM_registerMenuCommand("⏹️ 断开连接", closeConnection);
            GM_registerMenuCommand("▶️ 重新启动连接", startLogPolling);
        }
    } catch (e) {
        console.log('[AMDL] 脚本管理器不支持菜单命令，将使用面板内按钮');
    }

    // --- 2. 注入样式 ---
    const style = document.createElement('style');
    style.innerHTML = `
        #am-log-panel {
            position: fixed; bottom: 25px; right: 25px; width: 450px;
            max-width: calc(100vw - 20px); max-height: 70vh;
            background: rgba(15, 15, 15, 0.98); border: 1px solid #333;
            border-radius: 12px; box-shadow: 0 20px 60px rgba(0,0,0,0.8);
            z-index: 2147483647; display: flex; flex-direction: column;
            font-family: 'Consolas', 'Monaco', monospace; pointer-events: auto;
            transition: width .2s ease, height .2s ease, border-radius .2s ease, bottom .2s ease, right .2s ease;
            overflow: hidden;
        }
        #am-log-panel.am-minimized {
            width: 50px !important; height: 50px !important;
            min-width: 0 !important; min-height: 0 !important;
            border-radius: 50% !important; padding: 0 !important;
            right: 20px !important; bottom: 20px !important;
        }
        #am-log-panel.am-minimized .log-header,
        #am-log-panel.am-minimized #am-progress-panel,
        #am-log-panel.am-minimized #am-log-box {
            display: none !important;
        }
        #am-log-panel.am-minimized #am-miniball {
            display: flex !important;
        }
        .log-header {
            background: #222; padding: 10px 15px; font-size: 11px; color: #888;
            border-bottom: 1px solid #333; display: flex; justify-content: space-between;
            border-radius: 12px 12px 0 0;
        }
        #am-progress-panel {
            padding: 12px 15px 10px; display: none; flex-direction: column;
            gap: 8px; background: #111; border-bottom: 1px solid #333;
        }
        @media screen and (max-width: 720px) {
            #am-log-panel {
                width: calc(100% - 20px) !important;
                bottom: 10px; right: 10px; left: 10px;
                max-height: 60vh; border-radius: 14px;
            }
            #am-log-panel .log-header {
                flex-wrap: wrap; gap: 6px;
            }
            #am-progress-panel { padding: 10px 12px 10px; }
            #am-log-box { height: 180px; font-size: 11px; }
            .custom-dl-btn { min-width: 100px !important; }
        }
        #am-progress-title { font-size: 13px; font-weight: 700; color: #fff; }
        #am-progress-message { font-size: 12px; color: #aaa; }
        .am-progress-bar { position: relative; height: 10px; background: #333; border-radius: 999px; overflow: hidden; }
        .am-progress-fill { width: 0%; height: 100%; background: linear-gradient(90deg,#1DB954,#00d084); }
        .am-progress-meta { display:flex; justify-content:space-between; font-size:11px; color:#888; }
        #am-progress-list { display:flex; flex-direction:column; gap: 6px; max-height: 220px; overflow-y: auto; }
        .am-progress-item { display:flex; flex-direction:column; gap: 4px; padding: 6px 0; border-bottom: 1px solid rgba(255,255,255,0.05); }
        .am-progress-item-header { display:flex; justify-content:space-between; gap: 8px; align-items:center; font-size:12px; color:#fff; }
        .am-progress-item-message { font-size:10px; color:#aaa; min-height:14px; }
        .am-progress-item-percentage { color:#7ef9ff; }
        .am-progress-item-detail { color:#999; font-size:10px; }
        .am-progress-item-speed { color:#999; font-size:10px; }
        #am-log-box { height: 200px; padding: 12px; overflow-y: auto; font-size: 12px; color: #00ff41; line-height: 1.5; }
        .log-line { margin-bottom: 4px; border-bottom: 1px solid rgba(255,255,255,0.05); white-space: pre-wrap; word-break: break-all; }
        .log-time { color: #444; margin-right: 8px; font-size: 9px; }
        .log-err { color: #fa243c !important; }

        /* 下载按钮样式 */
        .custom-button-container { display: inline-flex; align-items: center; gap: 10px; margin-left: 10px; vertical-align: middle; flex-shrink: 0; }
        .custom-dl-btn {
            border: none !important; border-radius: 50px !important; font-weight: bold !important;
            cursor: pointer !important; display: inline-flex !important; align-items: center;
            justify-content: center; white-space: nowrap !important; flex-shrink: 0 !important;
            background-color: #1DB954 !important; color: #000 !important; transition: transform 0.2s;
        }
        .custom-dl-btn:hover { transform: scale(1.05); }
        .dl-btn-green { background-color: #1DB954 !important; color: black !important; }
        .dl-btn-green:hover { background-color: #25d865 !important; }
        .dl-btn-green svg { fill: black; }
        .dl-btn-red { background-color: #e74c3c !important; color: white !important; }
        .dl-btn-red:hover { background-color: #f95f51 !important; }
        .dl-btn-red svg { fill: white; }
        .main-dl-btn { padding: 0 25px !important; height: 40px !important; margin-left: 15px !important; min-width: 140px !important; }
        .track-dl-btn { width: 32px !important; height: 32px !important; border-radius: 50% !important; margin-left: 10px !important; flex: 0 0 32px !important; padding: 6px !important; gap: 0 !important; }
        .track-dl-btn svg { width: 16px; height: 16px; fill: currentColor; margin: 2px; }
        .track-dl-btn span { display: none; }

        /* 卡片下载容器 */
        .card-dl-container {
            opacity: 1 !important;
            display: flex;
            justify-content: center;
            pointer-events: none;
            padding: 8px;
            z-index: 99;
        }
        .card-dl-container .custom-dl-btn {
            pointer-events: auto !important;
            padding: 6px !important;
            gap: 0 !important;
            border-radius: 50% !important;
            margin-left: 0 !important;
            border: 2px solid black !important;
        }
        .card-dl-container .custom-dl-btn svg {
            width: 16px !important;
            height: 16px !important;
            margin: 2px !important;
        }
        .card-dl-container .custom-dl-btn span {
            display: none !important;
        }

        /* 音质标签 */
        .ame-track-quality {
            font-size: 10px;
            color: var(--systemSecondary);
            margin-left: 8px;
            line-height: 1.4;
            text-align: left;
            white-space: pre-wrap;
            font-family: monospace;
        }
        .songs-list-row__song-wrapper {
             display: flex;
             align-items: center;
        }

        /* 侧边栏样式 */
        .navigation-items__header[data-ame]{border-radius:6px;font-size:10px;font-weight:600;letter-spacing:0;line-height:1.3;margin:0 20px -3px;padding:4px 6px;color:var(--systemSecondary)}
        .navigation-items__list[data-ame]{font-size:15px;padding:0 25px 9px;font-weight:400;letter-spacing:0}
        .navigation-item[data-ame]{margin-bottom:1px;height:32px;padding:4px;position:relative;border-radius:6px;--linkHoverTextDecoration: none}
        .navigation-item__link[data-ame]{align-items:center;border-radius:6px;box-sizing:content-box;-moz-column-gap:8px;column-gap:8px;display:flex;height:100%;margin:-3px;padding:3px;width:100%;font-size:.8rem}
        .navigation-item__link[data-ame] svg{width:24px;height:24px;fill:var(--systemSecondary);background-color:transparent;display:inline-block;flex-shrink:0}

        /* 专辑徽章 */
        .ame-album-badges-container {
            display: flex;
            flex-wrap: wrap;
            gap: 8px;
            margin-top: 1em;
            margin-bottom: 0.5em;
        }

        .ame-badge-text {
            display: inline-block;
            font-size: 10px;
            font-weight: 600;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
            padding: 3px 7px;
            border-radius: 4px;
            background-color: transparent;
            color: var(--systemSecondary);
            border: 1px solid var(--systemSecondary);
            text-transform: uppercase;
            letter-spacing: 0.5px;
            line-height: 1.2;
        }

        .ame-album-badges-container > svg {
            margin: 0;
            fill: var(--systemSecondary);
            height: 18px;
        }

        #am-manual-send { display:flex; gap:8px; padding: 10px 15px 15px; border-top: 1px solid rgba(255,255,255,0.06); background: #111; }
        #am-manual-url { width: 100%; min-width:0; padding: 8px 10px; border: 1px solid #333; border-radius: 999px; background: #121212; color:#fff; }
        #am-manual-send-btn { padding: 8px 14px; border:none; border-radius: 999px; background:#1DB954; color:#000; cursor:pointer; font-weight:700; }
        #am-manual-send-btn:hover { opacity:0.9; }
    `;
    document.head.appendChild(style);

    // --- 3. UI 构建 ---
    const panel = document.createElement('div');
    panel.id = 'am-log-panel';
    panel.innerHTML = `
        <div class="log-header">
            <span>TERMINAL[${serverAddr.replace(/^https?:\/\//, '')}] <span id="am-conn-status" style="color:#888; margin-left:8px;">&#9679;</span></span>
            <div style="display:flex; gap:8px; align-items:center;">
                <span id="am-clear-btn" style="cursor:pointer; color:#55aaff;">[清屏]</span>
                <span id="am-scroll-btn" style="cursor:pointer; color:#55aaff;">[滚动]</span>
                <span id="am-config-btn" style="cursor:pointer; color:#55aaff;">[配置]</span>
                <span id="am-minimize-btn" style="cursor:pointer; color:#55aaff;">[最小化]</span>
            </div>
        </div>
        <div id="am-progress-panel">
            <div id="am-progress-title">等待下载任务</div>
            <div id="am-progress-message">点击下载按钮后开始任务。</div>
            <div id="am-progress-controls" style="display:flex; justify-content:space-between; gap:8px; align-items:center;">
                <div id="am-progress-detail" style="font-size:11px; color:#777;">等待更新</div>
                <span id="am-refresh-btn" style="cursor:pointer; color:#55aaff; font-size:11px;">刷新</span>
            </div>
            <div id="am-progress-list"></div>
        </div>
        <div id="am-miniball" style="display:none; width:100%; height:100%; align-items:center; justify-content:center; cursor:pointer;">
            <span style="font-size:18px; color:#fff;">&#9679;</span>
        </div>
        <div id="am-log-box"></div>
        <div id="am-manual-send">
            <input id="am-manual-url" type="text" placeholder="手动输入下载链接或页面地址" />
            <button id="am-manual-send-btn">发送</button>
        </div>
    `;
    document.body.appendChild(panel);
    
    // 页面加载时直接显示面板，无需等待连接后端
    // panel.style.display = 'flex'; // 已在 CSS 中设置为 flex
    const configBtn = panel.querySelector('#am-config-btn');
    if (configBtn) configBtn.onclick = openServerConfig;
    const clearBtn = panel.querySelector('#am-clear-btn');
    const scrollBtn = panel.querySelector('#am-scroll-btn');
    const minimizeBtn = panel.querySelector('#am-minimize-btn');
    const miniBall = panel.querySelector('#am-miniball');
    if (clearBtn) clearBtn.onclick = clearLogBox;
    if (scrollBtn) scrollBtn.onclick = scrollLogBoxToBottom;
    if (minimizeBtn) minimizeBtn.onclick = () => { setPanelMinimized(true); };
    if (miniBall) miniBall.onclick = () => { setPanelMinimized(false); };
    const refreshBtn = panel.querySelector('#am-refresh-btn');
    if (refreshBtn) refreshBtn.onclick = () => { pollLogs(); };
    const manualUrlInput = panel.querySelector('#am-manual-url');
    const manualSendBtn = panel.querySelector('#am-manual-send-btn');
    function sendManualUrl() {
        const url = manualUrlInput?.value.trim();
        if (!url) return alert('请输入要发送的链接');
        GM_xmlhttpRequest({
            method: 'POST',
            url: `${serverAddr}/api/download`,
            headers: { 'Content-Type': 'application/json' },
            data: JSON.stringify({ url, details: { name: '手动链接' } }),
            onload: function() {
                panel.style.display = 'flex';
                appendRawLog(`[INFO] 已手动发送链接：${url}`, new Date().toLocaleTimeString());
            },
            onerror: function() {
                appendRawLog(`[ERROR] 手动发送失败：${url}`, new Date().toLocaleTimeString());
            }
        });
    }
    if (manualSendBtn) manualSendBtn.onclick = sendManualUrl;
    if (manualUrlInput) manualUrlInput.addEventListener('keydown', function(e) {
        if (e.key === 'Enter') { sendManualUrl(); }
    });

    function clearLogBox() {
        const box = document.getElementById('am-log-box');
        if (box) box.innerHTML = '';

        // 清理进度条
        const progressList = document.getElementById('am-progress-list');
        if (progressList) {
            progressList.innerHTML = '';
        }

        // 清空进度条数据
        for (let id in progressItems) {
            delete progressItems[id];
        }
        progressOrder.length = 0;

        // 隐藏进度条面板并重置文本
        const panelBox = document.getElementById('am-progress-panel');
        const title = document.getElementById('am-progress-title');
        const message = document.getElementById('am-progress-message');
        const summary = document.getElementById('am-progress-detail');
        if (panelBox) panelBox.style.display = 'none';
        if (title) title.textContent = '等待下载任务';
        if (message) message.textContent = '点击下载按钮后开始任务。';
        if (summary) summary.textContent = '等待更新';
    }

    function scrollLogBoxToBottom() {
        const box = document.getElementById('am-log-box');
        if (box) box.scrollTop = box.scrollHeight;
    }

    function updateConnectionStatus() {
        const statusEl = document.getElementById('am-conn-status');
        if (!statusEl) return;
            
        // 轮询模式状态
        if (logPollingInterval) {
            statusEl.textContent = '●';
            statusEl.style.color = '#1DB954';
            statusEl.title = 'HTTP 轮询模式 - 实时同步中';
        } else {
            statusEl.textContent = '○';
            statusEl.style.color = '#f44336';
            statusEl.title = '连接已断开';
        }
        
        // 更新最后成功时间提示
        if (lastSuccessfulPoll > 0) {
            const secondsAgo = Math.round((Date.now() - lastSuccessfulPoll) / 1000);
            statusEl.title += `\n最后更新: ${secondsAgo}秒前`;
        }
    }

    function setPanelMinimized(minimize) {
        if (minimize) {
            panel.classList.add('am-minimized');
            panel.style.display = 'flex';
        } else {
            panel.classList.remove('am-minimized');
        }
    }

    function appendRawLog(content, time) {
        const box = document.getElementById('am-log-box');
        const line = document.createElement('div');
        line.className = 'log-line';
        if (/Errors:|\u2716|错误 | 失败/.test(content)) line.className += ' log-err';
        line.innerHTML = `<span class="log-time">${time}</span>${content}`;
        box.appendChild(line);
        box.scrollTop = box.scrollHeight;
    }

    function formatBytes(bytes) {
        if (typeof bytes !== 'number' || isNaN(bytes)) return '';
        const units = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
        let idx = 0;
        let value = bytes;
        while (value >= 1024 && idx < units.length - 1) {
            value /= 1024;
            idx += 1;
        }
        return `${value.toFixed(1)} ${units[idx]}`;
    }

    const progressItems = {};
    const progressOrder = [];

    function createProgressItem(id) {
        const progressList = document.getElementById('am-progress-list');
        const item = document.createElement('div');
        item.className = 'am-progress-item';
        item.dataset.id = id;
        item.innerHTML = `
            <div class="am-progress-item-header">
                <span class="am-progress-item-title"></span>
                <span class="am-progress-item-percentage"></span>
            </div>
            <div class="am-progress-item-message"></div>
            <div class="am-progress-bar"><div class="am-progress-fill"></div></div>
            <div class="am-progress-meta"><span class="am-progress-item-detail"></span><span class="am-progress-item-speed"></span></div>
        `;
        progressList.appendChild(item);
        return {
            container: item,
            title: item.querySelector('.am-progress-item-title'),
            message: item.querySelector('.am-progress-item-message'),
            detail: item.querySelector('.am-progress-item-detail'),
            fill: item.querySelector('.am-progress-fill'),
            percent: item.querySelector('.am-progress-item-percentage'),
            speed: item.querySelector('.am-progress-item-speed')
        };
    }

    function removeProgressItem(id) {
        const item = progressItems[id];
        if (!item) return;
        item.container.remove();
        delete progressItems[id];
        const index = progressOrder.indexOf(id);
        if (index !== -1) progressOrder.splice(index, 1);

        if (progressOrder.length === 0) {
            const panelBox = document.getElementById('am-progress-panel');
            const title = document.getElementById('am-progress-title');
            const message = document.getElementById('am-progress-message');
            const summary = document.getElementById('am-progress-detail');
            if (panelBox) panelBox.style.display = 'none';
            if (title) title.textContent = '等待下载任务';
            if (message) message.textContent = '点击下载按钮后开始任务。';
            if (summary) summary.textContent = '等待更新';
        }
    }

    function pruneProgressItems() {
        while (progressOrder.length > 5) {
            const oldestId = progressOrder.shift();
            removeProgressItem(oldestId);
        }
    }

    function updateProgress(data) {
        const panelBox = document.getElementById('am-progress-panel');
        const title = document.getElementById('am-progress-title');
        const message = document.getElementById('am-progress-message');
        const summary = document.getElementById('am-progress-detail');
        const progressList = document.getElementById('am-progress-list');

        panelBox.style.display = 'flex';
        progressList.style.display = 'flex';

        // 优先使用 trackId，其次使用 trackName，再者使用 AlbumID-TrackNum 组合，避免重复创建
        const trackName = data.trackName || data.TrackName || data.name || '';
        const albumName = data.albumName || data.AlbumName || data.album || '';
        const taskLabel = data.taskName || data.task || '';

        // 生成稳定的 ID：优先级依次为 trackId > AlbumID-TrackNum > trackName > albumName-trackName
        let stableId = data.trackId || data.id || data.taskId;
        if (!stableId && data.AlbumID && data.TrackNum) {
            stableId = `${data.AlbumID}-${data.TrackNum}`;
        }
        if (!stableId && trackName) {
            stableId = trackName; // 使用歌曲名作为 ID
        }
        if (!stableId && albumName && trackName) {
            stableId = `${albumName}___${trackName}`; // 使用专辑名 + 歌曲名作为 ID
        }

        const itemId = stableId || `progress-${Date.now()}-${Math.random()}`;
        let item = progressItems[itemId];
        const isNew = !item;
        if (isNew) {
            item = createProgressItem(itemId);
            progressItems[itemId] = item;
            progressOrder.push(itemId);
        }

        const label = trackName ? `${trackName} \u00B7 ${albumName || taskLabel}` : albumName || taskLabel || `任务 ${itemId}`;
        const status = String(data.status || data.Status || '').toLowerCase();
        const text = data.message || data.Message || data.detail || data.statusText || '';
        const percentValue = Number(data.percentage ?? data.Percentage ?? data.progress ?? data.percent ?? 0);
        const totalCount = Number(data.total || data.totalThreads || data.threadTotal || data.filesTotal || 0);
        const currentCount = Number(data.current || data.threadIndex || data.filesDone || 0);
        const rawSpeed = data.speed || data.Speed || '';
        const speedText = typeof rawSpeed === 'number' ? formatBytes(rawSpeed) : rawSpeed;
        const threadLabel = totalCount > 0 ? `${currentCount}/${totalCount}` : (data.thread ? String(data.thread) : '');
        const isComplete = status === 'complete' || status === 'error';

        item.title.textContent = label;
        item.message.textContent = status === 'start' ? `开始下载：${text}` : status === 'progress' ? (text || '下载进行中...') : status === 'decrypt' ? '解密中...' : status === 'complete' ? '已完成' : status === 'error' ? `错误：${text}` : (text || '正在更新...');
        item.detail.textContent = totalCount > 0 ? `线程 ${threadLabel}` : (data.threadStatus || data.phase || '');

        const displayPercent = status === 'complete' ? 100 : Math.max(0, Math.min(100, percentValue));
        item.fill.style.width = `${displayPercent}%`;
        item.percent.textContent = `${displayPercent}%`;
        item.speed.textContent = speedText || (status === 'progress' || status === 'decrypt' ? '...' : '');
        item.fill.style.background = status === 'error'
            ? 'linear-gradient(90deg, #ff4d4f, #ff7875)'
            : 'linear-gradient(90deg,#1DB954,#00d084)';

        if (isComplete) {
            removeProgressItem(itemId);
        }

        pruneProgressItems();

        const activeCount = progressOrder.length;
        title.textContent = activeCount > 1 ? `下载任务 (${activeCount})` : label;
        message.textContent = activeCount > 1 ? `当前展示 ${activeCount} 条未完成任务` : item.message.textContent;
        summary.textContent = activeCount > 1 ? `最多显示 5 条未完成进度` : item.detail.textContent;
    }

    function parseLogContent(content, time) {
        let parsed;
        try {
            parsed = JSON.parse(content);
        } catch (e) {
            return false;
        }
        if (!parsed || !parsed.status) {
            return false;
        }

        updateProgress(parsed);

        const status = String(parsed.status).toLowerCase();
        if (status === 'error' || status === 'complete' || status === 'start') {
            appendRawLog(`[${status.toUpperCase()}] ${parsed.message || parsed.Message || content}`, time);
        } else if (status === 'log' && (parsed.message || parsed.Message)) {
            appendRawLog(parsed.message || parsed.Message, time);
        }
        return true;
    }

    function appendLog(content, time) {
        if (!parseLogContent(content, time)) {
            appendRawLog(content, time);
        }
    }

    // --- 4. 核心通信 ---
    let logPollingInterval = null;
    let pollErrorCount = 0;
    let lastSuccessfulPoll = 0; // 上次成功轮询时间戳

    // --- 4. 核心通信 - 仅使用 HTTP 轮询模式 ---
    // 移除 WebSocket 支持，专注于稳定的 HTTP 轮询

    function pollLogs() {
        const startTime = Date.now();
        console.log(`[轮询] 请求日志... lastIndex=${lastLogIndex}`);
        
        GM_xmlhttpRequest({
            method: "GET",
            url: `${serverAddr}/api/logs?lastIndex=${lastLogIndex}`,
            timeout: 5000,
            onload: function(res) {
                lastSuccessfulPoll = Date.now();
                try {
                    if (res.status === 200) {
                        const data = JSON.parse(res.responseText);
                        console.log(`[轮询] 收到响应：${data.logs ? data.logs.length : 0} 条，nextIndex=${data.nextIndex || 'undefined'}`);
                        
                        if (data.logs && data.logs.length > 0) {
                            console.log(`[轮询] ✓ 收到 ${data.logs.length} 条新日志`);
                            data.logs.forEach(log => appendLog(log.content, log.time));
                            lastLogIndex = data.nextIndex;
                            pollErrorCount = 0;
                        } else {
                            // 没有新日志，这是正常情况
                            console.log(`[轮询] ○ 无新日志 (lastIndex=${lastLogIndex}, nextIndex=${data.nextIndex})`);
                            // 如果后端返回的 nextIndex 是 0，说明后端也重置了
                            if (data.nextIndex === 0) {
                                console.log('[轮询] 检测到后端已重置，同步索引');
                                lastLogIndex = 0;
                            }
                            // 如果 lastIndex 达到或超过 500（后端缓冲区上限），重置以继续接收新日志
                            if (lastLogIndex >= 500) {
                                console.log('[轮询] 已达到缓冲区上限，重置索引以继续接收新日志');
                                lastLogIndex = 450; // 保留最近50条，避免完全重复
                            }
                        }
                    } else {
                        console.warn(`[轮询] ⚠ HTTP ${res.status}`);
                        pollErrorCount++;
                    }
                } catch (e) {
                    console.warn('[轮询] ✗ 解析错误:', e);
                    pollErrorCount++;
                }
                
                // 错误过多时重启
                if (pollErrorCount > 10) {
                    console.log('[轮询] 错误过多，重启连接...');
                    restartLogPolling();
                }
            },
            onerror: function(err) {
                console.error('[轮询] ✗ 请求失败');
                pollErrorCount++;
                if (pollErrorCount > 10) {
                    restartLogPolling();
                }
            },
            ontimeout: function() {
                console.warn('[轮询] ⏱ 超时');
                pollErrorCount++;
                if (pollErrorCount > 10) {
                    restartLogPolling();
                }
            }
        });
    }

    // 监控轮询健康状态
    function monitorPollingHealth() {
        setInterval(() => {
            if (logPollingInterval) {
                const timeSinceLastSuccess = Date.now() - lastSuccessfulPoll;
                if (timeSinceLastSuccess > 10000) { // 超过 10 秒没有成功
                    console.warn(`[轮询] ⚠️ 长时间未更新 (${Math.round(timeSinceLastSuccess/1000)}s)，尝试重置索引`);
                    lastLogIndex = 0; // 重置索引
                    pollErrorCount = 0;
                    console.log('[轮询] ✓ 已重置 lastIndex = 0');
                }
            }
        }, 5000);
    }

    function startLogPolling() {
        console.log('\n=== [启动] HTTP 轮询模式 ===');
        console.log(`[启动] 当前 lastIndex = ${lastLogIndex}`);
        
        pollErrorCount = 0;
        lastSuccessfulPoll = Date.now(); // 初始化时间戳
        
        // 立即执行一次
        pollLogs();
        
        // 每 500ms 轮询一次
        if (logPollingInterval) {
            clearInterval(logPollingInterval);
        }
        logPollingInterval = setInterval(pollLogs, 500);
        
        updateConnectionStatus();
        
        // 启动健康监控
        monitorPollingHealth();
        
        console.log('[轮询] ✓ 已启动，间隔 500ms');
    }

    function restartLogPolling() {
        console.warn('\n=== [重启] 重新建立连接 ===');
        
        // 清理定时器
        if (logPollingInterval) {
            clearInterval(logPollingInterval);
            logPollingInterval = null;
        }
        
        pollErrorCount = 0;
        updateConnectionStatus();
        
        // 延迟 2 秒后重新启动
        setTimeout(() => {
            startLogPolling();
        }, 2000);
    }

    function closeConnection() {
        if (logPollingInterval) {
            clearInterval(logPollingInterval);
            logPollingInterval = null;
        }
        pollErrorCount = 0;
        updateConnectionStatus();
        console.log('[断开] 已停止轮询');
    }

    const dlAction = (url, name, extraArgs = '') => {
        GM_xmlhttpRequest({
            method: "POST",
            url: `${serverAddr}/api/download`,
            headers: { "Content-Type": "application/json" },
            data: JSON.stringify({ url, details: { name }, extraArgs }),
            onload: () => {
                appendRawLog(`[INFO] 已发送下载请求：${name || url}`, new Date().toLocaleTimeString());
            }
        });
    };

    // --- 5. 高级功能 - 来自 injector.js ---

    // 辅助函数
    function kn(t){const e=document.createElement("template");return e.innerHTML=t,e.content.firstElementChild}
    function gl(t,e){return new Promise(n=>{const r=e==null?void 0:e.waitSelector,i=(e==null?void 0:e.timeout)??3e3;if(i!==0){const a=document.querySelector(t);if(a){n(a);return}}const o=setTimeout(()=>{i!==0&&(s.disconnect(),n(null))},i),s=new MutationObserver(a=>{for(const l of a)for(const c of Array.from(l.addedNodes))if(c instanceof Element&&c.matches(r??t)){i!==0&&(s.disconnect(),clearTimeout(o)),n(r?document.querySelector(t):c);return}});s.observe(document.body,{childList:!0,subtree:!0})})}
    function ko(t,e){return kn(`
		<li class="ame-sidebar-button navigation-item" data-ame>
			<a class="navigation-item__link" tabindex="0" data-ame>
				${e}
				<span>${t}</span>
			</a>
		</li>
    `)}
    function e0(t){return t.addMenuItem=(e,n)=>{let r=t;for(let i=0;i<100;i++){const o=r.nextElementSibling;if(!o||Number(o.getAttribute("data-index"))>n)break;r=o}return e.setAttribute("data-index",n.toString()),r.after(e),e},t}
    function tT(t,e){let n=document.querySelector(t);if(n)return e0(n);try{e()}catch{console.error(`Could not create menu reference element for selector "${t}".`)}if(n=document.querySelector(t),n)return e0(n);throw new Error(`Could not find menu reference element by selector "${t}".`)}
    async function Po(t,e){await gl("amp-chrome-player"),tT("#ame-sidebar",()=>{const r=document.querySelector(".navigation__scrollable-container");r==null||r.appendChild(kn(`
			<div class="navigation-items" data-ame>
				<div class="navigation-items__header" data-ame>
					<span>Ame</span>
				</div>
				<ul class="navigation-items__list" data-ame>
					<li id="ame-sidebar" style="display: none;"></li>
				</ul>
			</div>
		`))}).addMenuItem(t,e)}

    const Gp="[a-z]{2}/album/(.+/)?.+";
    const Au={};
    function qp(){for(const t of Object.values(Au)){const e=t.pattern.test(location.pathname)?t.onCallbacks:t.offCallbacks;for(const n of e)n()}}
    function Yp(t){const e=new RegExp(`^/${t.replaceAll("/","\\/")}$`);let n=Au[t];return n||(n={pattern:e,onCallbacks:[],offCallbacks:[]},Au[t]=n,n)}
    function ZE(t,e){const n=Yp(t),r=n.pattern.test(location.pathname);n.onCallbacks.push(e),r&&e()}
    function XE(t,e){const n=Yp(t),r=n.pattern.test(location.pathname);n.offCallbacks.push(e),r||e()}
    function ji(t){ZE(Gp,t)}
    function Ps(t){XE(Gp,t)}

    // 音质徽章常量
    const LE = `<span class="ame-badge-text">AAC</span>`;
    const FE = `<span class="ame-badge-text">Master</span>`;
    const VE = `<span class="ame-badge-text">Atmos</span>`;
    const WE = `<span class="ame-badge-text">Hi-Res</span>`;
    const BE = `<span class="ame-badge-text">Lossless</span>`;
    const jE = `<span class="ame-badge-text">Spatial</span>`;

    // SVG 图标
    const downloadIconSVG = `<svg viewBox="0 0 24 24"><path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM17 13l-5 5-5-5h3V9h4v4h3z"></path></svg>`;
    const checkQualityIcon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" slot="app-icon">
	<path d="M29.75 33.4h2.5v-3.25h2.05q.7 0 1.2-.475T36 28.5v-8.95q0-.7-.5-1.2t-1.2-.5H28q-.7 0-1.35.5-.65.5-.65 1.2v8.95q0 .7.65 1.175.65.475 1.35.475h1.75ZM12 30.15h2.5V25.7h5v4.45H22v-12.3h-2.5v5.35h-5v-5.35H12Zm16.5-2.5v-7.3h5v7.3ZM7 40q-1.2 0-2.1-.9Q4 38.2 4 37V11q0-1.2.9-2.1Q5.8 8 7 8h34q1.2 0 2.1.9.9.9.9 2.1v26q0 1.2-.9 2.1-.9.9-2.1.9Zm0-3h34V11H7v26Zm0 0V11v26Z" />
    </svg>`;
    const searchCoversIcon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" slot="app-icon">
	<path d="M24 44q-4.1 0-7.75-1.575-3.65-1.575-6.375-4.3-2.725-2.725-4.3-6.375Q4 28.1 4 24q0-4.25 1.6-7.9 1.6-3.65 4.375-6.35 2.775-2.7 6.5-4.225Q20.2 4 24.45 4q3.95 0 7.5 1.325T38.175 9q2.675 2.35 4.25 5.575Q44 17.8 44 21.65q0 5.4-3.15 8.525T32.5 33.3h-3.75q-.9 0-1.55.7t-.65 1.55q0 1.35.725 2.3.725.95.725 2.2 0 1.9-1.05 2.925T24 44Zm0-20Zm-11.65 1.3q1 0 1.75-.75t.75-1.75q0-1-.75-1.75t-1.75-.75q-1 0-1.75.75t-.75 1.75q0 1 .75 1.75t1.75.75Zm6.3-8.5q1 0 1.75-.75t.75-1.75q0-1-.75-1.75t-1.75-.75q-1 0-1.75.75t-.75 1.75q0 1 .75 1.75t1.75.75Zm10.7 0q1 0 1.75-.75t.75-1.75q0-1-.75-1.75t-1.75-.75q-1 0-1.75.75t-.75 1.75q0 1 .75 1.75t1.75.75Zm6.55 8.5q1 0 1.75-.75t.75-1.75q0-1-.75-1.75t-1.75-.75q-1 0-1.75.75t-.75 1.75q0 1 .75 1.75t1.75.75ZM24 41q.55 0 .775-.225.225-.225.225-.725 0-.7-.725-1.3-.725-.6-.725-2.65 0-2.3 1.5-4.05t3.8-1.75h3.65q3.8 0 6.15-2.225Q41 25.85 41 21.65q0-6.6-5-10.625T24.45 7q-7.3 0-12.375 4.925T7 24q0 7.05 4.975 12.025Q16.95 41 24 41Z" />
    </svg>`;
    const seedMusicBrainzIcon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -960 960 960" slot="app-icon">
	<path d="M440-120v-319q-64 0-123-24.5T213-533q-45-45-69-104t-24-123v-80h80q63 0 122 24.5T426-746q31 31 51.5 68t31.5 79q5-7 11-13.5t13-13.5q45-45 104-69.5T760-720h80v80q0 64-24.5 123T746-413q-45 45-103.5 69T520-320v200h-80Zm0-400q0-48-18.5-91.5T369-689q-34-34-77.5-52.5T200-760q0 48 18 92t52 78q34 34 78 52t92 18Zm80 120q48 0 91.5-18t77.5-52q34-34 52.5-78t18.5-92q-48 0-92 18.5T590-569q-34 34-52 77.5T520-400Zm0 0Zm-80-120Z" />
    </svg>`;

    // 创建侧边栏按钮
    const Hu = ko("Search Covers", searchCoversIcon);
    const Wp = ko("Seed MusicBrainz", seedMusicBrainzIcon);
    const ku = ko("检查曲目音质", checkQualityIcon);

    // 注入侧边栏按钮
    function injectSidebarButtons() {
        Hu.addEventListener("click",()=>{const t=document.querySelector(".headings__subtitles > a"),e=document.querySelector(".headings__title");if(!e)return;const n=t==null?void 0:t.innerText.trim(),r=e.innerText.trim().replace(/ - Single$/i,"").replace(/ - EP$/i,""),i=new URLSearchParams;n&&i.set("artist",n),i.set("album",r),open(`https://covers.musichoarders.xyz?${i}`,"_blank")});
        Wp.addEventListener("click",()=>{open(`https://seed.musichoarders.xyz?identifier=${encodeURIComponent(location.href)}`,"_blank")});
        ku.addEventListener("click", () => {
            const trackList = document.querySelector('[data-testid="track-list-item"]');
            if (trackList) {
                const pathParts = window.location.pathname.split('/');
                const albumId = pathParts.pop();
                if (albumId && pathParts.includes('album')) {
                    qualityDataCache = [];
                    document.querySelectorAll('.ame-track-quality').forEach(el => el.remove());
                    if (window.desktopApp && typeof window.desktopApp.requestAlbumTracksQuality === 'function') {
                        window.desktopApp.requestAlbumTracksQuality(albumId);
                    }
                }
            }
        });

        ji(()=>{
            Po(Hu,400);
            Po(Wp,500);
            Po(ku,200);
        });
        Ps(()=>{
            document.querySelectorAll('.ame-sidebar-button').forEach(el => el.remove());
        });
        qp();
    }

    // 注入专辑徽章
    function injectAlbumBadges() {
        if (window.desktopApp && typeof window.desktopApp.onAlbumInfoResult === 'function') {
            window.desktopApp.onAlbumInfoResult((data) => {
                if (!data) return;

                gl(".headings__metadata-bottom").then(e => {
                    if (!e) return;

                    document.querySelector('.ame-album-badges-container')?.remove();

                    const n = data.audioTraits || [];
                    if (data.isMasteredForItunes) {
                        n.push("adm");
                    }
                    currentAlbumTraits = [...n];

                    if (n.length === 0) return;

                    const r = kn('<p class="ame-album-badges-container"></p>');

                    if (n.includes("lossy-stereo")) r.insertAdjacentHTML("beforeend", LE);
                    if (n.includes("lossless")) r.insertAdjacentHTML("beforeend", BE);
                    if (n.includes("hi-res-lossless")) r.insertAdjacentHTML("beforeend", WE);
                    if (n.includes("atmos")) r.insertAdjacentHTML("beforeend", VE);
                    if (n.includes("adm")) r.insertAdjacentHTML("beforeend", FE);
                    if (n.includes("spatial")) r.insertAdjacentHTML("beforeend", jE);

                    e.after(r);
                });
            });
        }

        ji(() => {
            const pathParts = window.location.pathname.split('/');
            const albumId = pathParts.pop();

            if (albumId && pathParts.includes('album')) {
                document.querySelector('.ame-album-badges-container')?.remove();
                currentAlbumTraits = [];
                if (window.desktopApp && typeof window.desktopApp.requestAlbumInfo === 'function') {
                    window.desktopApp.requestAlbumInfo(albumId);
                }
            }
        });

        Ps(() => {
            document.querySelector('.ame-album-badges-container')?.remove();
            currentAlbumTraits = [];
        });
    }

    // 创建下载按钮
    function createButtons(url, details, isSmall = false, downloadType = 'normal') {
        const btnSizeClass = isSmall ? 'track-dl-btn' : 'main-dl-btn';
        const textSpan = isSmall ? '' : '<span>下载</span>';
        const button = document.createElement('button');
        button.className = `custom-dl-btn dl-btn-green ${btnSizeClass}`;
        button.title = "下载";
        button.innerHTML = `${downloadIconSVG} ${textSpan}`;
        const stopAllClicks = (e) => {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
        };
        button.addEventListener('pointerdown', (e) => {
            stopAllClicks(e);
            // 使用 AMDL 的下载方式
            const extraArgs = downloadType === 'all-album' ? '--all-album' : '';
            dlAction(url, details.name, extraArgs);
        }, { capture: true });
        button.addEventListener('pointerup', stopAllClicks, { capture: true });
        button.addEventListener('click', stopAllClicks, { capture: true });
        return button;
    }

    // 注入专辑头部按钮
    const MAIN_BTN_CONTAINER_ID = 'custom-main-button-container';
    function injectAlbumHeaderButton(container) {
        if (container.querySelector(`#${MAIN_BTN_CONTAINER_ID}`)) return;
        const details = { name: document.querySelector('h1')?.textContent.trim() || document.title, artist: document.querySelector('.product-header__identity a')?.textContent.trim() || '未知歌手' };
        const url = new URL(window.location.href).href;

        const buttonContainer = document.createElement('div');
        buttonContainer.className = 'custom-button-container';
        buttonContainer.id = MAIN_BTN_CONTAINER_ID;

        const buttonEl = createButtons(url, details, false, 'normal');
        buttonContainer.appendChild(buttonEl);

        container.appendChild(buttonContainer);
        container.classList.add('custom-buttons-added');
    }

    // 注入艺术家头部按钮
    function injectArtistHeaderButton(playButtonSpan) {
        const nameEl = document.querySelector('h1[data-testid="artist-header-name"]');
        const name = nameEl?.textContent.trim();
        if (!name) return;
        const details = { name: name, artist: name };
        const url = new URL(window.location.href).href;
        const buttonEl = createButtons(url, details, false, 'all-album');
        const buttonContainer = document.createElement('div');
        buttonContainer.className = 'custom-button-container';
        buttonContainer.id = MAIN_BTN_CONTAINER_ID;
        buttonContainer.appendChild(buttonEl);
        playButtonSpan.parentNode.insertBefore(buttonContainer, playButtonSpan.nextSibling);
        playButtonSpan.classList.add('custom-buttons-added');
    }

    // 注入单曲行按钮
    function injectTrackButton(row) {
        const controlsContainer = row.querySelector('.songs-list-row__controls');
        if (!controlsContainer) return;
        const allLinks = Array.from(row.querySelectorAll('a[data-testid="click-action"]'));
        const artistLinks = Array.from(row.querySelectorAll('[data-testid="track-title-by-line"] a'));
        const songLink = allLinks.find(link => !artistLinks.includes(link));
        if (!songLink) return;

        const url = new URL(songLink.href, window.location.origin).href;
        const trackTitleEl = row.querySelector('[data-testid="track-title"]');
        const trackArtistEl = row.querySelector('[data-testid="track-title-by-line"]');
        const trackName = trackTitleEl ? trackTitleEl.textContent.trim() : '未知曲目';
        const trackArtist = trackArtistEl ? trackArtistEl.textContent.trim() : '未知歌手';
        const details = { name: trackName, artist: trackArtist };
        const buttonEl = createButtons(url, details, true, 'normal');
        const buttonContainer = document.createElement('div');
        buttonContainer.className = 'custom-button-container';
        buttonContainer.appendChild(buttonEl);
        controlsContainer.appendChild(buttonContainer);
        row.classList.add('custom-buttons-added');
    }

    // 注入卡片封面按钮
    function injectCardButton(artworkElement) {
        const cardRoot = artworkElement.closest('li[class*="grid-item"], div[class*="product-card"], div[class*="product-lockup"]');
        if (!cardRoot) return;
        if (artworkElement.classList.contains('custom-buttons-added')) return;
        let link = cardRoot.querySelector('a[data-testid="product-lockup-link"]') || cardRoot.querySelector('div[class*="lockup__title"] > a');
        if (!link || !link.href) return;
        const url = new URL(link.href, window.location.origin).href;
        const name = link.textContent.trim();
        let artist = '未知歌手';
        const artistEl = cardRoot.querySelector('div[class*="lockup__subtitle"]');
        if (artistEl) artist = artistEl.textContent.trim();
        const details = { name, artist };
        const buttonEl = createButtons(url, details, true, 'normal');
        const bottomContainer = document.createElement('div');
        bottomContainer.className = 'card-dl-container';
        bottomContainer.style.position = 'absolute';
        bottomContainer.style.bottom = '0';
        bottomContainer.style.left = '50%';
        bottomContainer.style.transform = 'translateX(-50%)';
        bottomContainer.style.pointerEvents = 'auto';
        bottomContainer.style.zIndex = '100';
        bottomContainer.appendChild(buttonEl);
        cardRoot.style.position = 'relative';
        cardRoot.appendChild(bottomContainer);
        artworkElement.classList.add('custom-buttons-added');
    }

    // 注入视频封面按钮
    function injectVideoButton(videoWrapper) {
        if (videoWrapper.classList.contains('custom-buttons-added')) return;
        const linkEl = videoWrapper.querySelector('a[data-testid="click-action"]');
        const artworkEl = videoWrapper.querySelector('[data-testid="artwork-component"]');
        if (!linkEl || !linkEl.href || !artworkEl) return;

        const urlObj = new URL(linkEl.href, window.location.origin);
        const url = urlObj.href;

        const cardRoot = videoWrapper.closest('li[class*="grid-item"], div[class*="product-card"], div[class*="product-lockup"]');
        let name = '未知视频';
        let artist = '未知歌手';

        if (cardRoot) {
            const nameEl = cardRoot.querySelector('div[class*="lockup__title"]') || cardRoot.querySelector('a[data-testid="product-lockup-link"]');
            const artistEl = cardRoot.querySelector('div[class*="lockup__subtitle"]');
            if (nameEl) name = nameEl.textContent.trim();
            if (artistEl) artist = artistEl.textContent.trim();
        }

        if (name === '未知视频' || (cardRoot && !cardRoot.querySelector('div[class*="lockup__title"]'))) {
            const pathParts = urlObj.pathname.split('/');
            const videoIndex = pathParts.indexOf('music-video');
            if (videoIndex > -1 && videoIndex + 1 < pathParts.length) {
                const potentialSlug = pathParts[videoIndex + 1];
                if (isNaN(Number(potentialSlug)) && potentialSlug.trim() !== '') {
                    name = potentialSlug;
                }
            }
        }

        if (name === '未知视频') {
             name = url.split('/').pop() || '未知视频';
        }

        const details = { name: name, artist: artist };
        const buttonEl = createButtons(url, details, true, 'normal');
        const buttonContainer = document.createElement('div');
        buttonContainer.className = 'card-dl-container';
        buttonContainer.style.position = 'absolute';
        buttonContainer.style.bottom = '0';
        buttonContainer.style.left = '50%';
        buttonContainer.style.transform = 'translateX(-50%)';
        buttonContainer.style.pointerEvents = 'auto';
        buttonContainer.style.zIndex = '100';
        buttonContainer.appendChild(buttonEl);
        videoWrapper.style.position = 'relative';
        videoWrapper.appendChild(buttonContainer);
        videoWrapper.classList.add('custom-buttons-added');
        if (artworkEl) artworkEl.classList.add('custom-buttons-added');
    }

    // 监听音质结果
    if (window.desktopApp && typeof window.desktopApp.onAlbumQualityResult === 'function') {
        window.desktopApp.onAlbumQualityResult((qualities) => {
            qualityDataCache = qualities;
            const trackRows = document.querySelectorAll('.songs-list-row__song-wrapper');
            trackRows.forEach((wrapper, index) => {
                if (qualities[index] && !wrapper.querySelector('.ame-track-quality')) {
                    const qualityEl = document.createElement('span');
                    qualityEl.className = 'ame-track-quality';
                    qualityEl.innerHTML = qualities[index];
                    wrapper.appendChild(qualityEl);
                }
            });
        });
    }

    // 主注入观察器
    const observer = new MutationObserver(() => {
        try {
            if (!document.getElementById(MAIN_BTN_CONTAINER_ID)) {
                const albumHeader = document.querySelector('.primary-actions:not(.custom-buttons-added)');
                if (albumHeader) injectAlbumHeaderButton(albumHeader);
                const artistHeaderBtn = document.querySelector('span.artist-header__play-button:not(.custom-buttons-added)');
                if (artistHeaderBtn) injectArtistHeaderButton(artistHeaderBtn);
            }

            const trackRows = document.querySelectorAll('[data-testid="track-list-item"]:not(.custom-buttons-added)');
            trackRows.forEach(injectTrackButton);

            const cardArtworkSelector = 'div[data-testid="artwork-component"]:not(.custom-buttons-added)';
            document.querySelectorAll(cardArtworkSelector).forEach(injectCardButton);
            document.querySelectorAll('div[data-testid="vertical-video-artwork-wrapper"]:not(.custom-buttons-added)').forEach(injectVideoButton);

            if (!sidebarInjected && document.querySelector(".navigation__scrollable-container")) {
                 injectSidebarButtons();
                 injectAlbumBadges();
                 sidebarInjected = true;
            }

            const trackList = document.querySelector('[data-testid="track-list-item"]');
            if (trackList && qualityDataCache.length > 0) {
                 const trackWrappers = document.querySelectorAll('.songs-list-row__song-wrapper');
                 trackWrappers.forEach((wrapper, index) => {
                    if (qualityDataCache[index] && !wrapper.querySelector('.ame-track-quality')) {
                        const qualityEl = document.createElement('span');
                        qualityEl.className = 'ame-track-quality';
                        qualityEl.innerHTML = qualityDataCache[index];
                        wrapper.appendChild(qualityEl);
                    }
                });
            }

        } catch (err) {
            console.error('[AMDL] 注入时发生错误:', err);
        }
    });
    observer.observe(document.body, { childList: true, subtree: true });

    // 路由变化监听
    let oldPath = location.pathname;
    const pathObserver = new MutationObserver(() => {
        if (oldPath !== location.pathname) {
            oldPath = location.pathname;
            sidebarInjected = false;
            qualityDataCache = [];
            currentAlbumTraits = [];
            qp();
        }
    });
    pathObserver.observe(document.body, { childList: true, subtree: true });

    // 注入导航控制按钮
    function injectNavControls() {
        if (document.getElementById('custom-nav-container')) return;

        const searchWrapper = document.querySelector('[data-testid="search-input"]');
        if (!searchWrapper) return;

        const navContainer = document.createElement('div');
        navContainer.id = 'custom-nav-container';
        navContainer.style.cssText = `
            display: flex;
            width: 100%;
            box-sizing: border-box;
            align-items: center;
            justify-content: flex-start;
            gap: 8px;
            padding: 0 0 8px 20px;
            -webkit-app-region: no-drag;
        `;

        const btnStyle = `
            background: transparent;
            border: none;
            color: #aaa;
            cursor: pointer;
            padding: 4px;
            border-radius: 4px;
            display: flex;
            align-items: center;
            justify-content: center;
            transition: color 0.2s, background-color 0.2s;
        `;

        const iconBack = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>`;
        const iconFwd = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>`;
        const iconRefresh = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 4v6h-6"></path><path d="M1 20v-6h6"></path><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path></svg>`;

        function createNavBtn(html, title, onClick) {
            const btn = document.createElement('button');
            btn.innerHTML = html;
            btn.title = title;
            btn.style.cssText = btnStyle;
            btn.onmouseenter = () => { btn.style.color = '#fff'; btn.style.backgroundColor = 'rgba(255,255,255,0.1)'; };
            btn.onmouseleave = () => { btn.style.color = '#aaa'; btn.style.backgroundColor = 'transparent'; };
            btn.onclick = (e) => {
                e.preventDefault();
                onClick();
            };
            return btn;
        }

        const btnBack = createNavBtn(iconBack, '后退', () => {
            if (window.desktopApp && typeof window.desktopApp.navigateBack === 'function') {
                window.desktopApp.navigateBack();
            } else {
                history.back();
            }
        });
        const btnFwd = createNavBtn(iconFwd, '前进', () => {
            if (window.desktopApp && typeof window.desktopApp.navigateFwd === 'function') {
                window.desktopApp.navigateFwd();
            } else {
                history.forward();
            }
        });
        const btnRefresh = createNavBtn(iconRefresh, '刷新', () => {
            if (window.desktopApp && typeof window.desktopApp.refreshPage === 'function') {
                window.desktopApp.refreshPage();
            } else {
                location.reload();
            }
        });

        navContainer.appendChild(btnBack);
        navContainer.appendChild(btnFwd);
        navContainer.appendChild(btnRefresh);
        searchWrapper.parentElement.insertBefore(navContainer, searchWrapper);
    }

    // --- 6. 执行 ---
    console.log('[AMDL] Apple Music 全能助手初始化...');
    
    // 延迟启动，确保页面完全加载
    setTimeout(() => {
        console.log('[AMDL] 后端地址:', serverAddr);
        startLogPolling();
        setInterval(updateConnectionStatus, 1000);
        setInterval(injectNavControls, 1000); // 注入导航控制按钮
        console.log('[AMDL] ✓ 助手已就绪 - 集成下载、音质检测、封面搜索等功能');
    }, 500);
})();
