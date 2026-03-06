// ==UserScript==
// @name        LINUXDO Read&heart pro plus max ultra
// @namespace   rongjiale_linuxdo_ReadBoost
// @match       https://linux.do/*
// @grant       GM_setValue
// @grant       GM_getValue
// @grant       GM_registerMenuCommand
// @version     1.2
// @author      rongjiale
// @description LINUXDO ReadBoost是一个LINUXDO刷取已读帖量脚本，理论上支持所有Discourse论坛（维护者：rongjiale）
// ==/UserScript==

(function () {
    'use strict'
    const hasAgreed = GM_getValue("hasAgreed", true)

    // ==================== 默认参数 ====================
    const DEFAULT_CONFIG = {
        baseDelay: 2500,
        randomDelayRange: 800,
        minReqSize: 8,
        maxReqSize: 2000,
        minReadTime: 800,
        maxReadTime: 3000,
        autoStart: true,
        startFromCurrent: false,
        autoLoop: false,

        // ==================== 自动点赞配置 ====================
        autoLike: true,           // 自动点赞开关
        likeLimit: 100,           // 点赞次数上限（默认100，达到上限后不再点赞）
        likeAllFloors: false,     // 点赞所有楼层（默认不勾选，仅点赞第一楼）
        likeFloorInterval: 30000  // 楼层间点赞间隔（默认30秒）
    }

    let config = { ...DEFAULT_CONFIG, ...getStoredConfig() }
    let isRunning = false
    let shouldStop = false
    let statusLabel = null
    let initTimeout = null
    let readTopicIds = new Set(getReadTopicIds())
    let isInAutoLoop = false
    let nightPauseResumeTimeout = null

    const NIGHT_PAUSE_STORAGE_KEY = "nightPauseWindow"
    const NIGHT_PAUSE_RULE = {
        startMinMinute: 0,
        startMaxMinute: 45,
        endMinMinute: 420,
        endMaxMinute: 480
    }

    // ==================== 新增：自动点赞状态存储 ====================
    // 说明：likeCount 为全局累计点赞次数；likedTopicIds 用于避免同一帖子重复点赞
    let likeCount = GM_getValue("likeCount", 0)
    let likedTopicIds = new Set(getLikedTopicIds())

    function getRandomInt(min, max) {
        const safeMin = Math.ceil(Math.min(min, max))
        const safeMax = Math.floor(Math.max(min, max))
        return Math.floor(Math.random() * (safeMax - safeMin + 1)) + safeMin
    }

    function getCurrentMinuteOfDay(date = new Date()) {
        return date.getHours() * 60 + date.getMinutes()
    }

    function getDateKey(date = new Date()) {
        const year = date.getFullYear()
        const month = String(date.getMonth() + 1).padStart(2, "0")
        const day = String(date.getDate()).padStart(2, "0")
        return `${year}-${month}-${day}`
    }

    function formatMinuteOfDay(totalMinutes) {
        const hours = Math.floor(totalMinutes / 60)
        const minutes = totalMinutes % 60
        return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`
    }

    function getStoredNightPauseWindow() {
        const stored = GM_getValue(NIGHT_PAUSE_STORAGE_KEY, "")
        if (!stored) return null

        try {
            const parsed = JSON.parse(stored)
            if (
                parsed &&
                typeof parsed.date === "string" &&
                Number.isInteger(parsed.startMinute) &&
                Number.isInteger(parsed.endMinute) &&
                parsed.startMinute >= 0 &&
                parsed.endMinute > parsed.startMinute
            ) {
                return parsed
            }
        } catch (error) {
            console.error("[NightPause] 解析夜间停机窗口失败:", error)
        }

        return null
    }

    function buildNightPauseWindow(date = new Date()) {
        const startMinute = getRandomInt(NIGHT_PAUSE_RULE.startMinMinute, NIGHT_PAUSE_RULE.startMaxMinute)
        const endMinute = getRandomInt(NIGHT_PAUSE_RULE.endMinMinute, NIGHT_PAUSE_RULE.endMaxMinute)
        const windowInfo = {
            date: getDateKey(date),
            startMinute,
            endMinute
        }

        GM_setValue(NIGHT_PAUSE_STORAGE_KEY, JSON.stringify(windowInfo))
        console.log(`[NightPause] 今日停机窗口: ${formatMinuteOfDay(startMinute)} - ${formatMinuteOfDay(endMinute)}`)
        return windowInfo
    }

    function getNightPauseWindow(date = new Date()) {
        const todayKey = getDateKey(date)
        const storedWindow = getStoredNightPauseWindow()
        if (storedWindow && storedWindow.date === todayKey) {
            return storedWindow
        }

        return buildNightPauseWindow(date)
    }

    function isInNightPauseWindow(date = new Date()) {
        const windowInfo = getNightPauseWindow(date)
        const currentMinute = getCurrentMinuteOfDay(date)
        return currentMinute >= windowInfo.startMinute && currentMinute < windowInfo.endMinute
    }

    function clearNightPauseResumeTimeout() {
        if (nightPauseResumeTimeout) {
            clearTimeout(nightPauseResumeTimeout)
            nightPauseResumeTimeout = null
        }
    }

    function scheduleResumeAfterNightPause(windowInfo = getNightPauseWindow()) {
        clearNightPauseResumeTimeout()

        const now = new Date()
        const endAt = new Date(now)
        endAt.setHours(0, 0, 0, 0)
        endAt.setMinutes(windowInfo.endMinute)
        const delay = endAt.getTime() - now.getTime()

        if (delay <= 0) return

        nightPauseResumeTimeout = setTimeout(() => {
            nightPauseResumeTimeout = null
            console.log("[NightPause] 夜间停机窗口结束，允许脚本恢复")

            if (config.autoStart) {
                shouldStop = false
                isRunning = false
                isInAutoLoop = false
                init()
            }
        }, delay + 1000)
    }

    function stopForNightPause(windowInfo = getNightPauseWindow()) {
        shouldStop = true
        isRunning = false
        isInAutoLoop = false
        updateStatus(`夜间暂停至 ${formatMinuteOfDay(windowInfo.endMinute)}`, "warning")
        scheduleResumeAfterNightPause(windowInfo)
    }

    function ensureNotInNightPause() {
        const windowInfo = getNightPauseWindow()
        if (!isInNightPauseWindow()) return

        stopForNightPause(windowInfo)
        throw new Error(`夜间停机窗口: ${formatMinuteOfDay(windowInfo.startMinute)}-${formatMinuteOfDay(windowInfo.endMinute)}`)
    }

    function isTopicPage() {
        return /^https:\/\/linux\.do\/t\/[^/]+\/\d+/.test(window.location.href)
    }

    async function getPageInfo(maxRetries = 10) {
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                if (!isTopicPage()) {
                    throw new Error("不在帖子页面，需要重新获取最新帖子")
                }
                const topicID = window.location.pathname.split("/")[3]
                const csrfElement = document.querySelector("meta[name=csrf-token]")
                const csrfToken = csrfElement ? csrfElement.getAttribute("content") : null

                if (!csrfToken) { await sleep(2000); continue }

                const repliesElement = document.querySelector("div[class=timeline-replies]")
                if (!repliesElement) { await sleep(2000); continue }

                const repliesInfo = repliesElement.textContent.trim()
                const [currentPosition, totalReplies] = repliesInfo.split("/").map(part => parseInt(part.trim(), 10))

                if (!topicID || isNaN(currentPosition) || isNaN(totalReplies)) { await sleep(2000); continue }
                return { topicID, currentPosition, totalReplies, csrfToken }
            } catch (error) {
                if (error.message.includes("需要重新获取最新帖子")) {
                    console.error("获取页面信息失败:", error.message)
                    await retryWithLatestTopic(error.message)
                    return null
                } else {
                    throw error
                }
            }
        }

        console.error(`[getPageInfo] ${maxRetries}次重试后仍未加载`)
        await retryWithLatestTopic("页面元素多次重试后仍未加载完成")
        return null
    }

    function getStoredConfig() {
        return {
            baseDelay: GM_getValue("baseDelay", DEFAULT_CONFIG.baseDelay),
            randomDelayRange: GM_getValue("randomDelayRange", DEFAULT_CONFIG.randomDelayRange),
            minReqSize: GM_getValue("minReqSize", DEFAULT_CONFIG.minReqSize),
            maxReqSize: GM_getValue("maxReqSize", DEFAULT_CONFIG.maxReqSize),
            minReadTime: GM_getValue("minReadTime", DEFAULT_CONFIG.minReadTime),
            maxReadTime: GM_getValue("maxReadTime", DEFAULT_CONFIG.maxReadTime),
            autoStart: GM_getValue("autoStart", DEFAULT_CONFIG.autoStart),
            startFromCurrent: GM_getValue("startFromCurrent", DEFAULT_CONFIG.startFromCurrent),
            autoLoop: GM_getValue("autoLoop", DEFAULT_CONFIG.autoLoop),

            // ==================== 自动点赞配置读取 ====================
            autoLike: GM_getValue("autoLike", DEFAULT_CONFIG.autoLike),
            likeLimit: GM_getValue("likeLimit", DEFAULT_CONFIG.likeLimit),
            likeAllFloors: GM_getValue("likeAllFloors", DEFAULT_CONFIG.likeAllFloors),
            likeFloorInterval: GM_getValue("likeFloorInterval", DEFAULT_CONFIG.likeFloorInterval)
        }
    }

    // 获取已读帖子ID列表
    function getReadTopicIds() {
        const stored = GM_getValue("readTopicIds", "[]")
        try {
            return JSON.parse(stored)
        } catch (e) {
            console.error("解析已读帖子ID失败:", e)
            return []
        }
    }

    // 保存已读帖子ID列表
    function saveReadTopicIds() {
        try {
            const idsArray = Array.from(readTopicIds)
            GM_setValue("readTopicIds", JSON.stringify(idsArray))
        } catch (e) {
            console.error("保存已读帖子ID失败:", e)
        }
    }

    // 添加已读帖子ID
    function addReadTopicId(topicId) {
        const idStr = String(topicId)
        console.log(`准备记录帖子ID: ${idStr}`)

        const sizeBefore = readTopicIds.size
        readTopicIds.add(idStr)
        const sizeAfter = readTopicIds.size

        saveReadTopicIds()
        console.log(`已记录帖子ID: ${idStr}, 记录前: ${sizeBefore}, 记录后: ${sizeAfter}`)

        // 验证保存是否成功
        const saved = getReadTopicIds()
        console.log(`验证保存: 内存中${readTopicIds.size}个, 存储中${saved.length}个`)
    }

    // 清理已读记录
    function clearReadTopicIds() {
        readTopicIds.clear()
        saveReadTopicIds()
        console.log("已清理所有已读记录")
    }

    // ==================== 新增：获取/保存已点赞帖子ID列表 ====================
    function getLikedTopicIds() {
        const stored = GM_getValue("likedTopicIds", "[]")
        try {
            return JSON.parse(stored)
        } catch (e) {
            console.error("解析已点赞帖子ID失败:", e)
            return []
        }
    }

    function saveLikedTopicIds() {
        try {
            const idsArray = Array.from(likedTopicIds)
            GM_setValue("likedTopicIds", JSON.stringify(idsArray))
        } catch (e) {
            console.error("保存已点赞帖子ID失败:", e)
        }
    }

    function addLikedTopicId(topicId) {
        const idStr = String(topicId)
        const sizeBefore = likedTopicIds.size
        likedTopicIds.add(idStr)
        const sizeAfter = likedTopicIds.size
        saveLikedTopicIds()
        console.log(`已记录点赞帖子ID: ${idStr}, 记录前: ${sizeBefore}, 记录后: ${sizeAfter}`)
    }

    // ==================== 自动点赞核心实现（接口方式） ====================
    // 从页面 #data-preloaded 元素中解析帖子 post ID 列表
    function getPostIdsFromPreloaded() {
        try {
            const preloadedEl = document.getElementById("data-preloaded")
            if (!preloadedEl) return []

            const preloadedData = preloadedEl.getAttribute("data-preloaded")
            if (!preloadedData) return []

            const parsed = JSON.parse(preloadedData)
            const topicKey = Object.keys(parsed).find(k => k.startsWith("topic_"))
            if (!topicKey) return []

            const topicData = JSON.parse(parsed[topicKey])
            if (topicData && topicData.post_stream && Array.isArray(topicData.post_stream.stream)) {
                return topicData.post_stream.stream
            }

            return []
        } catch (e) {
            console.error("[AutoLike] 解析 preloaded 失败:", e)
            return []
        }
    }

    async function waitForPostIdsFromPreloaded(maxRetries = 6, retryDelay = 800) {
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            if (shouldStop) throw new Error("用户停止执行")
            ensureNotInNightPause()

            const postIds = getPostIdsFromPreloaded()
            if (postIds.length > 0) return postIds

            await sleep(retryDelay)
        }

        return []
    }

    // 检查某个 post 是否已经被当前用户点赞（从 preloaded 数据判断）
    function isPostAlreadyLiked(postId) {
        try {
            const preloadedEl = document.getElementById("data-preloaded")
            if (!preloadedEl) return false

            const preloadedData = preloadedEl.getAttribute("data-preloaded")
            if (!preloadedData) return false

            const parsed = JSON.parse(preloadedData)
            const topicKey = Object.keys(parsed).find(k => k.startsWith("topic_"))
            if (!topicKey) return false

            const topicData = JSON.parse(parsed[topicKey])
            if (!topicData || !topicData.post_stream || !Array.isArray(topicData.post_stream.posts)) return false

            const post = topicData.post_stream.posts.find(p => p.id === postId)
            if (!post) return false

            // 检查 current_user_reaction 是否已有值（说明已点过赞）
            if (post.current_user_reaction) return true

            // 检查 current_user_used_main_reaction
            if (post.current_user_used_main_reaction) return true

            return false
        } catch (e) {
            return false
        }
    }

    async function verifyPostLiked(topicID, postId) {
        try {
            if (!isTopicPage()) return null

            const topicJsonUrl = `${window.location.origin}${window.location.pathname.replace(/\/$/, "")}.json`
            const response = await fetch(topicJsonUrl, {
                method: "GET",
                headers: {
                    "Accept": "application/json",
                    "X-Requested-With": "XMLHttpRequest"
                },
                credentials: "include"
            })

            if (!response.ok) {
                console.warn(`[AutoLike] 校验点赞状态失败: topic ${topicID}, HTTP ${response.status}`)
                return null
            }

            const data = await response.json()
            const posts = data && data.post_stream && Array.isArray(data.post_stream.posts)
                ? data.post_stream.posts
                : []

            const post = posts.find(item => Number(item.id) === Number(postId))
            if (!post) return null

            return Boolean(post.current_user_reaction || post.current_user_used_main_reaction)
        } catch (error) {
            console.warn(`[AutoLike] 校验点赞状态异常: topic ${topicID}, post ${postId}`, error)
            return null
        }
    }

    // 通过 API 接口对单个 post 点赞
    async function likePostByApi(topicID, postId, csrfToken, maxRetries = 3) {
        const url = `https://linux.do/discourse-reactions/posts/${postId}/custom-reactions/bili_057/toggle.json`

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                ensureNotInNightPause()

                const response = await fetch(url, {
                    method: "PUT",
                    headers: {
                        "X-CSRF-Token": csrfToken,
                        "X-Requested-With": "XMLHttpRequest",
                        "Accept": "application/json, text/plain, */*",
                        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8"
                    },
                    credentials: "include"
                })

                if (!response.ok) {
                    console.error(`[AutoLike] 点赞失败: post ${postId}, HTTP ${response.status}, attempt ${attempt}/${maxRetries}`)
                } else {
                    await sleep(500)

                    const verified = await verifyPostLiked(topicID, postId)
                    if (verified === true || isPostAlreadyLiked(postId)) {
                        console.log(`[AutoLike] 点赞成功: post ${postId}, attempt ${attempt}/${maxRetries}`)
                        return true
                    }

                    console.warn(`[AutoLike] 点赞后校验未通过: post ${postId}, attempt ${attempt}/${maxRetries}`)
                }
            } catch (e) {
                console.error(`[AutoLike] 点赞请求异常: POST ID=${postId}, attempt ${attempt}/${maxRetries}`, e)
            }

            if (attempt < maxRetries) {
                await sleep(1200 * attempt)
            }
        }

        return false
    }

    // 自动点赞入口函数
    async function autoLikeCurrentTopic(topicID, csrfToken) {
        try {
            // 开关关闭则不执行
            if (!config.autoLike) return
            ensureNotInNightPause()

            // 只在帖子页面执行
            if (!isTopicPage()) return

            // 达到上限则不执行
            const likeLimit = parseInt(config.likeLimit, 10)
            const effectiveLimit = Number.isFinite(likeLimit) ? likeLimit : DEFAULT_CONFIG.likeLimit
            if (likeCount >= effectiveLimit) {
                console.log(`[AutoLike] 已达到点赞上限 ${likeCount}/${effectiveLimit}`)
                return
            }

            // 已对该帖子点过赞则不重复执行
            if (likedTopicIds.has(String(topicID))) return

            const postIds = await waitForPostIdsFromPreloaded()
            if (postIds.length === 0) return

            const targetPostIds = (config.likeAllFloors ? postIds : [postIds[0]])
                .map(id => Number(id))
                .filter(Number.isFinite)

            if (targetPostIds.length === 0) return

            const interval = Math.max(1000, parseInt(config.likeFloorInterval, 10) || DEFAULT_CONFIG.likeFloorInterval)

            console.log(`[AutoLike] 帖子 ${topicID}，点赞 ${targetPostIds.length} 个楼层，间隔 ${interval / 1000}s`)

            let successCount = 0
            let completedCount = 0
            for (let i = 0; i < targetPostIds.length; i++) {
                if (shouldStop) break
                ensureNotInNightPause()
                if (likeCount >= effectiveLimit) break

                const postId = targetPostIds[i]
                const alreadyLiked = await verifyPostLiked(topicID, postId)
                if (alreadyLiked === true || isPostAlreadyLiked(postId)) {
                    completedCount++
                    continue
                }

                updateStatus(`点赞中 ${i + 1}/${targetPostIds.length}...`, "running")

                const success = await likePostByApi(topicID, postId, csrfToken)
                if (success) {
                    successCount++
                    completedCount++
                    likeCount += 1
                    GM_setValue("likeCount", likeCount)
                }

                // 楼层间等待（最后一个不用等）
                if (i < targetPostIds.length - 1) {
                    for (let w = 0; w < interval; w += 1000) {
                        if (shouldStop) break
                        const remaining = Math.ceil((interval - w) / 1000)
                        updateStatus(`点赞等待 ${remaining}s (${i + 1}/${targetPostIds.length})`, "running")
                        await sleep(Math.min(1000, interval - w))
                    }
                }
            }

            if (completedCount === targetPostIds.length) {
                addLikedTopicId(topicID)
            } else {
                console.warn(`[AutoLike] 帖子 ${topicID} 未全部点赞完成，保留后续重试机会 (${completedCount}/${targetPostIds.length})`)
            }

            console.log(`[AutoLike] 完成: 成功 ${successCount}个，累计 ${likeCount}/${effectiveLimit}`)
            updateStatus(`点赞完成 ${successCount}个，累计 ${likeCount}/${effectiveLimit}`, completedCount === targetPostIds.length ? "success" : "warning")

        } catch (e) {
            console.error("[AutoLike] 执行失败:", e)
        }
    }

    function sleep(ms) {
        return new Promise(r => setTimeout(r, ms))
    }

    // 重新获取最新帖子的通用函数
    async function retryWithLatestTopic(errorMessage, retryDelay = 3000) {
        ensureNotInNightPause()
        console.log(`遇到错误: ${errorMessage}, ${retryDelay / 1000}秒后重新获取最新帖子...`)
        updateStatus(`遇到错误，${retryDelay / 1000}秒后重新获取最新帖子...`, "warning")

        // 等待指定时间
        for (let i = 0; i < retryDelay; i += 100) {
            if (shouldStop) throw new Error("用户停止执行")
            await new Promise(r => setTimeout(r, 100))
        }

        try {
            updateStatus("正在重新获取最新帖子...", "running")
            isInAutoLoop = true
            await getNextTopicAndProcess()
        } catch (retryError) {
            console.error("重新获取帖子也失败:", retryError)
            if (retryError.message === "用户停止执行") {
                throw retryError
            }
            // 如果重试也失败，再次尝试重新获取（但增加延迟时间）
            if (retryDelay < 30000) {
                await retryWithLatestTopic(retryError.message, retryDelay * 2)
            } else {
                throw new Error("多次重试失败，脚本已停止")
            }
        }
    }

    function saveConfig(newConfig) {
        Object.keys(newConfig).forEach(key => {
            GM_setValue(key, newConfig[key])
            config[key] = newConfig[key]
        })
        location.reload()
    }

    function createStatusLabel() {
        // 移除已存在的状态标签
        const existingLabel = document.getElementById("readBoostStatusLabel")
        if (existingLabel) {
            existingLabel.remove()
        }

        const headerButtons = document.querySelector(".header-buttons")
        if (!headerButtons) return null

        const labelSpan = document.createElement("span")
        labelSpan.id = "readBoostStatusLabel"
        labelSpan.style.cssText = `
            margin-left: 10px;
            margin-right: 10px;
            padding: 5px 10px;
            border-radius: 4px;
            background: var(--primary-low);
            color: var(--primary);
            font-size: 12px;
            font-weight: bold;
            cursor: pointer;
        `
        labelSpan.textContent = "ReadBoost" + " ⚙️"
        labelSpan.addEventListener("click", showSettingsUI)

        headerButtons.appendChild(labelSpan)
        return labelSpan
    }

    // 更新状态
    function updateStatus(text, type = "info") {
        if (!statusLabel) return

        const colors = {
            info: "var(--primary)",
            success: "#2e8b57",
            warning: "#ff8c00",
            error: "#dc3545",
            running: "#007bff"
        }

        statusLabel.textContent = text + " ⚙️"
        statusLabel.style.color = colors[type] || colors.info
    }

    function showSettingsUI() {
        const settingsDiv = document.createElement("div")
        settingsDiv.style.cssText = `
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            padding: 25px;
            border-radius: 12px;
            z-index: 10000;
            background: var(--secondary);
            color: var(--primary);
            box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
            border: 1px solid var(--primary-low);
            min-width: 400px;
            max-width: 500px;
        `

        const autoStartChecked = config.autoStart ? "checked" : ""
        const startFromCurrentChecked = config.startFromCurrent ? "checked" : ""
        const autoLoopChecked = config.autoLoop ? "checked" : ""

        // ==================== 自动点赞 UI 绑定 ====================
        const autoLikeChecked = config.autoLike ? "checked" : ""
        const likeAllFloorsChecked = config.likeAllFloors ? "checked" : ""

        settingsDiv.innerHTML = `
            <h3 style="margin-top: 0; color: var(--primary); text-align: center;">ReadBoost 设置</h3>
            <div style="text-align: center; margin-bottom: 15px; padding: 10px; background: var(--primary-very-low); border-radius: 6px;">
                <span style="color: var(--primary-medium);">📊 已记录阅读帖子: ${readTopicIds.size} 个</span><br>
                <small style="color: var(--primary-medium); opacity: 0.8;">存储验证: ${getReadTopicIds().length} 个</small>
                <hr style="border: none; border-top: 1px solid var(--primary-low); margin: 10px 0;">
                <span style="color: var(--primary-medium);">❤️ 已累计点赞次数: ${likeCount} / ${config.likeLimit}</span><br>
                <small style="color: var(--primary-medium); opacity: 0.8;">已记录点赞帖子: ${likedTopicIds.size} 个</small>
            </div>
            <div style="display: grid; gap: 15px;">
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">
                    <label style="display: flex; flex-direction: column; gap: 5px;">
                        <span>基础延迟(ms):</span>
                        <input id="baseDelay" type="number" value="${config.baseDelay}"
                               style="padding: 8px; border: 1px solid var(--primary-low); border-radius: 4px; background: var(--secondary);">
                    </label>
                    <label style="display: flex; flex-direction: column; gap: 5px;">
                        <span>随机延迟范围(ms):</span>
                        <input id="randomDelayRange" type="number" value="${config.randomDelayRange}"
                               style="padding: 8px; border: 1px solid var(--primary-low); border-radius: 4px; background: var(--secondary);">
                    </label>
                </div>
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">
                    <label style="display: flex; flex-direction: column; gap: 5px;">
                        <span>最小每次请求量:</span>
                        <input id="minReqSize" type="number" value="${config.minReqSize}"
                               style="padding: 8px; border: 1px solid var(--primary-low); border-radius: 4px; background: var(--secondary);">
                    </label>
                    <label style="display: flex; flex-direction: column; gap: 5px;">
                        <span>最大每次请求量:</span>
                        <input id="maxReqSize" type="number" value="${config.maxReqSize}"
                               style="padding: 8px; border: 1px solid var(--primary-low); border-radius: 4px; background: var(--secondary);">
                    </label>
                </div>
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">
                    <label style="display: flex; flex-direction: column; gap: 5px;">
                        <span>最小阅读时间(ms):</span>
                        <input id="minReadTime" type="number" value="${config.minReadTime}"
                               style="padding: 8px; border: 1px solid var(--primary-low); border-radius: 4px; background: var(--secondary);">
                    </label>
                    <label style="display: flex; flex-direction: column; gap: 5px;">
                        <span>最大阅读时间(ms):</span>
                        <input id="maxReadTime" type="number" value="${config.maxReadTime}"
                               style="padding: 8px; border: 1px solid var(--primary-low); border-radius: 4px; background: var(--secondary);">
                    </label>
                </div>

                <!-- ==================== 自动点赞设置输入 ==================== -->
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">
                    <label style="display: flex; flex-direction: column; gap: 5px;">
                        <span>点赞上限(次):</span>
                        <input id="likeLimit" type="number" min="0" value="${config.likeLimit}"
                               style="padding: 8px; border: 1px solid var(--primary-low); border-radius: 4px; background: var(--secondary);">
                    </label>
                    <label style="display: flex; flex-direction: column; gap: 5px;">
                        <span>楼层间隔(ms):</span>
                        <input id="likeFloorInterval" type="number" min="1000" value="${config.likeFloorInterval}"
                               style="padding: 8px; border: 1px solid var(--primary-low); border-radius: 4px; background: var(--secondary);">
                    </label>
                </div>
                <div style="display: flex; gap: 15px; align-items: center; flex-wrap: wrap;">
                    <label style="display: flex; align-items: center; gap: 8px;">
                        <input type="checkbox" id="autoLike" ${autoLikeChecked} style="transform: scale(1.2);">
                        <span>自动点赞（接口方式）</span>
                    </label>
                    <label style="display: flex; align-items: center; gap: 8px;">
                        <input type="checkbox" id="likeAllFloors" ${likeAllFloorsChecked} style="transform: scale(1.2);">
                        <span>点赞所有楼层</span>
                    </label>
                </div>

                <div style="display: flex; gap: 15px; align-items: center; flex-wrap: wrap;">
                    <label style="display: flex; align-items: center; gap: 8px;">
                        <input type="checkbox" id="advancedMode" style="transform: scale(1.2);">
                        <span>高级设置模式</span>
                    </label>
                    <label style="display: flex; align-items: center; gap: 8px;">
                        <input type="checkbox" id="autoStart" ${autoStartChecked} style="transform: scale(1.2);">
                        <span>自动运行</span>
                    </label>
                    <label style="display: flex; align-items: center; gap: 8px;">
                        <input type="checkbox" id="startFromCurrent" ${startFromCurrentChecked} style="transform: scale(1.2);">
                        <span>从当前浏览位置开始</span>
                    </label>
                    <label style="display: flex; align-items: center; gap: 8px;">
                        <input type="checkbox" id="autoLoop" ${autoLoopChecked} style="transform: scale(1.2);">
                        <span>自动循环处理新帖</span>
                    </label>
                </div>
                <div style="display: flex; gap: 10px; justify-content: center; margin-top: 10px; flex-wrap: wrap;">
                    <button id="saveSettings" style="padding: 10px 20px; border: none; border-radius: 6px; background: #007bff; color: white; cursor: pointer;">保存设置</button>
                    <button id="resetDefaults" style="padding: 10px 20px; border: none; border-radius: 6px; background: #6c757d; color: white; cursor: pointer;">重置默认</button>
                    <button id="clearReadIds" style="padding: 10px 20px; border: none; border-radius: 6px; background: #ffc107; color: black; cursor: pointer;">清理阅读记录</button>
                    <button id="closeSettings" style="padding: 10px 20px; border: none; border-radius: 6px; background: #dc3545; color: white; cursor: pointer;">关闭</button>
                </div>
            </div>
        `

        document.body.appendChild(settingsDiv)

        toggleAdvancedInputs(false)

        document.getElementById("advancedMode").addEventListener("change", (e) => {
            if (e.target.checked) {
                const confirmed = confirm("高级设置可能增加账号风险，确定要启用吗？")
                if (!confirmed) {
                    e.target.checked = false
                    return
                }
            }
            toggleAdvancedInputs(e.target.checked)
        })

        document.getElementById("saveSettings").addEventListener("click", () => {
            const newConfig = {
                baseDelay: parseInt(document.getElementById("baseDelay").value, 10),
                randomDelayRange: parseInt(document.getElementById("randomDelayRange").value, 10),
                minReqSize: parseInt(document.getElementById("minReqSize").value, 10),
                maxReqSize: parseInt(document.getElementById("maxReqSize").value, 10),
                minReadTime: parseInt(document.getElementById("minReadTime").value, 10),
                maxReadTime: parseInt(document.getElementById("maxReadTime").value, 10),
                autoStart: document.getElementById("autoStart").checked,
                startFromCurrent: document.getElementById("startFromCurrent").checked,
                autoLoop: document.getElementById("autoLoop").checked,

                // ==================== 保存自动点赞配置 ====================
                autoLike: document.getElementById("autoLike").checked,
                likeLimit: Math.max(0, parseInt(document.getElementById("likeLimit").value, 10) || DEFAULT_CONFIG.likeLimit),
                likeAllFloors: document.getElementById("likeAllFloors").checked,
                likeFloorInterval: Math.max(1000, parseInt(document.getElementById("likeFloorInterval").value, 10) || DEFAULT_CONFIG.likeFloorInterval)
            }

            saveConfig(newConfig)
            settingsDiv.remove()
            updateStatus("设置已保存", "success")
        })

        document.getElementById("resetDefaults").addEventListener("click", () => {
            if (confirm("确定要重置为默认设置吗？")) {
                saveConfig(DEFAULT_CONFIG)
                settingsDiv.remove()
                updateStatus("已重置为默认设置", "info")
            }
        })

        document.getElementById("clearReadIds").addEventListener("click", () => {
            if (confirm(`确定要清理所有阅读记录吗？\n当前已记录 ${readTopicIds.size} 个帖子。`)) {
                clearReadTopicIds()
                settingsDiv.remove()
                updateStatus("阅读记录已清理", "success")
            }
        })

        document.getElementById("closeSettings").addEventListener("click", () => {
            settingsDiv.remove()
        })

        function toggleAdvancedInputs(enabled) {
            const inputs = ["baseDelay", "randomDelayRange", "minReqSize", "maxReqSize", "minReadTime", "maxReadTime"]
            inputs.forEach(id => {
                const input = document.getElementById(id)
                if (input) {
                    input.disabled = !enabled
                    input.style.opacity = enabled ? "1" : "0.6"
                }
            })
        }
    }

    async function startReading() {
        if (isRunning) {
            updateStatus("脚本正在运行中...", "warning")
            return
        }

        try {
            isRunning = true
            shouldStop = false
            clearNightPauseResumeTimeout()
            ensureNotInNightPause()

            updateStatus("正在启动...", "running")

            // 检查是否在帖子页面
            if (isTopicPage()) {
                // 如果在帖子页面，先处理当前帖子
                const pageInfo = await getPageInfo()
                if (pageInfo) {
                    console.log(`开始处理当前帖子: ${pageInfo.topicID}`)
                    // ==================== 在帖子页面自动点赞（接口方式） ====================
                    // 说明：通过解析 preloaded 数据获取 post ID 列表，调用 API 接口点赞
                    await autoLikeCurrentTopic(pageInfo.topicID, pageInfo.csrfToken)
                    await processReading(pageInfo)
                } else {
                    return // getPageInfo已经处理了重新获取逻辑
                }

                if (config.autoLoop) {
                    updateStatus("当前帖子处理完成，开始获取新帖子...", "running")
                    isInAutoLoop = true
                    await getNextTopicAndProcess()
                } else {
                    updateStatus("处理完成", "success")
                }
            } else {
                // 如果不在帖子页面，直接开始获取最新帖子
                isInAutoLoop = true
                await getNextTopicAndProcess()
            }

        } catch (error) {
            console.error("执行错误:", error)
            if (error.message === "用户停止执行") {
                updateStatus("ReadBoost", "info")
            } else if (error.message.includes("夜间停机窗口")) {
                console.log(error.message)
            } else if (error.message.includes("需要重新获取最新帖子")) {
                // 这种情况下retryWithLatestTopic已经处理了，不需要额外操作
                console.log("重新获取最新帖子逻辑已处理")
            } else if (error.message === "多次重试失败，脚本已停止") {
                updateStatus("多次重试失败，脚本已停止", "error")
            } else {
                // 遇到其他错误，尝试重新获取最新帖子
                console.log("遇到未知错误，尝试重新获取最新帖子...")
                try {
                    await retryWithLatestTopic(error.message)
                } catch (retryError) {
                    console.error("重新获取最新帖子也失败:", retryError)
                    updateStatus("执行失败: " + error.message, "error")
                }
            }
        } finally {
            // 只有在真正结束时才重置状态
            if (!isInAutoLoop || shouldStop) {
                isRunning = false
                isInAutoLoop = false
            }
        }
    }

    // 获取下一个帖子并处理
    async function getNextTopicAndProcess() {
        while (!shouldStop) {
            try {
                ensureNotInNightPause()
                updateStatus("正在获取最新帖子...", "running")

                // 请求最新帖子列表
                const response = await fetch("https://linux.do/latest.json?no_definitions=true&page=1", {
                    credentials: "include"
                })

                if (!response.ok) {
                    throw new Error(`获取帖子列表失败: HTTP ${response.status}，需要重新获取最新帖子`)
                }

                const data = await response.json()

                // 检查数据结构
                if (!data.topic_list || !data.topic_list.topics || data.topic_list.topics.length === 0) {
                    throw new Error("没有找到可用的帖子，需要重新获取最新帖子")
                }

                // 查找第一个未读的帖子
                let unreadTopic = null
                for (const topic of data.topic_list.topics) {
                    if (!readTopicIds.has(String(topic.id))) {
                        unreadTopic = topic
                        break
                    }
                }

                if (!unreadTopic) {
                    console.log(`当前页面的 ${data.topic_list.topics.length} 个帖子都已阅读过`)
                    updateStatus("所有帖子都已阅读过，等待新帖子...", "info")

                    // 等待30秒后重试，避免频繁请求
                    for (let i = 0; i < 30000; i += 1000) {
                        if (shouldStop) throw new Error("用户停止执行")
                        ensureNotInNightPause()
                        updateStatus(`等待新帖子... ${Math.ceil((30000 - i) / 1000)}s`, "info")
                        await new Promise(r => setTimeout(r, 1000))
                    }

                    // 继续循环重新获取
                    continue
                }

                const topicId = unreadTopic.id
                console.log(`找到未读帖子: ${topicId}, 标题: ${unreadTopic.title || '未知'}`)

                // 拼接URL
                const topicUrl = `https://linux.do/t/topic/${topicId}`
                updateStatus(`正在跳转到新帖子: ${topicId}`, "running")

                // 访问新帖子
                window.location.href = topicUrl

                // 等待页面跳转，后续处理会由路由监听自动触发
                return

            } catch (error) {
                console.error("获取新帖子失败:", error)
                if (shouldStop) {
                    throw new Error("用户停止执行")
                }

                // 如果错误消息包含"需要重新获取最新帖子"，使用重试逻辑
                if (error.message.includes("需要重新获取最新帖子")) {
                    await retryWithLatestTopic(error.message)
                    return // retryWithLatestTopic会处理跳转
                } else {
                    updateStatus(`获取新帖子失败: ${error.message}，3秒后重试...`, "warning")

                    // 等待3秒后重试
                    for (let i = 0; i < 3000; i += 100) {
                        if (shouldStop) throw new Error("用户停止执行")
                        await new Promise(r => setTimeout(r, 100))
                    }
                }
            }
        }
    }

    function stopReading() {
        shouldStop = true
        isInAutoLoop = false
        updateStatus("正在停止...", "warning")
    }

    // 处理阅读逻辑
    async function processReading(pageInfo) {
        const { topicID, currentPosition, totalReplies, csrfToken } = pageInfo
        const startPosition = config.startFromCurrent ? currentPosition : 1
        // 处理完成后记录帖子ID
        addReadTopicId(topicID)
        console.log(`帖子 ${topicID} 处理完成并已记录`)
        console.log(`开始处理帖子 ${topicID}，起始位置: ${startPosition}, 总回复: ${totalReplies}`)

        try {
            ensureNotInNightPause()

            async function sendBatch(startId, endId, retryCount = 3) {
                // 停止检查
                if (shouldStop) throw new Error("用户停止执行")
                ensureNotInNightPause()

                const params = new URLSearchParams()

                for (let i = startId; i <= endId; i++) {
                    params.append(`timings[${i}]`, getRandomInt(config.minReadTime, config.maxReadTime).toString())
                }

                const topicTime = getRandomInt(
                    config.minReadTime * (endId - startId + 1),
                    config.maxReadTime * (endId - startId + 1)
                ).toString()

                params.append('topic_time', topicTime)
                params.append('topic_id', topicID)

                try {
                    const response = await fetch("https://linux.do/topics/timings", {
                        method: "POST",
                        headers: {
                            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
                            "X-CSRF-Token": csrfToken,
                            "X-Requested-With": "XMLHttpRequest"
                        },
                        body: params,
                        credentials: "include"
                    })

                    if (!response.ok) {
                        throw new Error(`HTTP ${response.status}，需要重新获取最新帖子`)
                    }

                    // 再次检查是否应该停止
                    if (shouldStop) throw new Error("用户停止执行")

                    updateStatus(`处理回复 ${startId}-${endId} (${Math.round((endId / totalReplies) * 100)}%)`, "running")

                } catch (error) {
                    if (shouldStop) throw error // 如果是停止信号，直接抛出

                    // 如果是需要重新获取最新帖子的错误，直接抛出让上层处理
                    if (error.message.includes("需要重新获取最新帖子")) {
                        throw error
                    }

                    if (retryCount > 0) {
                        updateStatus(`重试 ${startId}-${endId} (剩余${retryCount}次)`, "warning")
                        await new Promise(r => setTimeout(r, 4000))
                        return await sendBatch(startId, endId, retryCount - 1)
                    }
                    throw error
                }

                // 延迟期间也检查停止信号
                const delay = config.baseDelay + getRandomInt(0, config.randomDelayRange)
                for (let i = 0; i < delay; i += 100) {
                    if (shouldStop) throw new Error("用户停止执行")
                    ensureNotInNightPause()
                    await new Promise(r => setTimeout(r, Math.min(100, delay - i)))
                }
            }

            // 批量处理
            for (let i = startPosition; i <= totalReplies;) {
                if (shouldStop) break
                ensureNotInNightPause()

                const batchSize = getRandomInt(config.minReqSize, config.maxReqSize)
                const startId = i
                const endId = Math.min(i + batchSize - 1, totalReplies)

                await sendBatch(startId, endId)
                i = endId + 1
            }


        } catch (error) {
            console.error(`处理帖子 ${topicID} 失败:`, error)

            // 如果是需要重新获取最新帖子的错误，重新获取
            if (error.message.includes("需要重新获取最新帖子")) {
                await retryWithLatestTopic(error.message)
                return // retryWithLatestTopic会处理跳转
            } else {
                // 其他错误直接抛出
                throw error
            }
        }
    }

    // 注册菜单命令
    GM_registerMenuCommand("🚀 开始执行", startReading)
    GM_registerMenuCommand("⏹️ 停止执行", stopReading)
    GM_registerMenuCommand("⚙️ 设置", showSettingsUI)
    GM_registerMenuCommand("🗑️ 清理阅读记录", () => {
        if (confirm(`确定要清理所有阅读记录吗？\n当前已记录 ${readTopicIds.size} 个帖子。`)) {
            clearReadTopicIds()
            updateStatus("阅读记录已清理", "success")
        }
    })

    async function init() {
        statusLabel = createStatusLabel()
        shouldStop = true

        if (isRunning) {
            setTimeout(init, 1000)
            return
        }

        isRunning = false
        shouldStop = false

        if (initTimeout) {
            clearTimeout(initTimeout)
        }
        if (!isTopicPage()) return

        if (isInNightPauseWindow()) {
            stopForNightPause()
            return
        }

        try {
            const pageInfo = await getPageInfo()
            if (pageInfo) {
                console.log("LINUXDO ReadBoost 已加载")
                console.log(`帖子ID: ${pageInfo.topicID}, 总回复: ${pageInfo.totalReplies}`)

                statusLabel = createStatusLabel()



                // 自动启动或在自动循环模式下启动
                if (config.autoStart || isInAutoLoop) {
                    initTimeout = setTimeout(startReading, 1000)
                }
            }
            // 如果pageInfo为null，说明getPageInfo已经处理了重新获取逻辑

        } catch (error) {
            console.error("初始化失败:", error)
            // 如果初始化失败，根据错误类型决定是否重新获取最新帖子
            if (error.message && error.message.includes("需要重新获取最新帖子")) {
                try {
                    await retryWithLatestTopic(error.message)
                } catch (retryError) {
                    console.error("重新获取最新帖子失败:", retryError)
                    initTimeout = setTimeout(init, 1000)
                }
            } else {
                initTimeout = setTimeout(init, 1000)
            }
        }
    }

    // 监听 URL 变化
    function setupRouteListener() {
        let lastUrl = location.href

        // 监听 pushState
        const originalPushState = history.pushState
        history.pushState = function () {
            originalPushState.apply(history, arguments)
            if (location.href !== lastUrl) {
                lastUrl = location.href
                setTimeout(init, 500)
            }
        }

        // 监听 replaceState
        const originalReplaceState = history.replaceState
        history.replaceState = function () {
            originalReplaceState.apply(history, arguments)
            if (location.href !== lastUrl) {
                lastUrl = location.href
                setTimeout(init, 500)
            }
        }

        // 监听 popstate 事件
        window.addEventListener('popstate', () => {
            if (location.href !== lastUrl) {
                lastUrl = location.href
                setTimeout(init, 500)
            }
        })

        // 监听 hashchange 事件
        window.addEventListener('hashchange', () => {
            if (location.href !== lastUrl) {
                lastUrl = location.href
                setTimeout(init, 500)
            }
        })

        // 定期检查URL变化（备用方案）
        setInterval(() => {
            if (location.href !== lastUrl) {
                lastUrl = location.href
                setTimeout(init, 500)
            }
        }, 1000)
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            init()
            setupRouteListener()
        })
    } else {
        init()
        setupRouteListener()
    }
})()