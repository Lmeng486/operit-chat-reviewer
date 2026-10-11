/*
 * chat_reviewer — 核心逻辑层（ToolPkg: com.operit.chat_reviewer）
 *
 * 一份逻辑，两个入口：
 *   1) main.js 注册的 ChatMessage Hook —— 被审查者 AI 输出结束后自动触发审查
 *   2) ui/chat_reviewer_panel/index.ui.js —— 侧栏面板（配置 / 手动触发 / 历史）
 *
 * 存储：优先 ToolPkg.getConfigDir()，失败时回退到固定路径。
 *
 * 两个「忙」：
 *   忙① 被审查者还在写（一轮回复会被拆成多条落盘）→ 防抖 800ms + agentStatus 二次确认 + 3s 冷却
 *        保证「一轮只审一次」，绝不审到半截话。
 *   忙② 审查者还在审 → 新任务进 pending；默认 mode=queue「只留最新」，可选 mode=skip「直接跳过」。
 *
 * 严格单向：hook 只对 cfg.reviewedChatId 的 ai 消息响应，审查者窗口天然不在白名单内，
 *           所以审查输出不可能再触发任何角色的输出。
 */
"use strict";

var FALLBACK_DIR = "/sdcard/Download/Operit/plugins/chat_reviewer/";
var CONFIG_FILE = "config.json";
var HISTORY_FILE = "history.json";
var LOG_FILE = "debug.log";
var HISTORY_LIMIT = 50;
var LOG_LINE_LIMIT = 200;
var DEBOUNCE_MS = 800;
var COOLDOWN_MS = 3000;
var FETCH_LIMIT = 200;
var STATUS_TIMEOUT_MS = 3000;

var DEFAULT_CONFIG = {
    enabled: false,
    reviewedChatId: "",
    reviewedChatName: "",
    reviewerChatId: "",
    reviewerChatName: "",
    reviewedCardId: "",
    reviewedCardName: "",
    reviewerCardId: "",
    reviewerCardName: "",
    requirement: "",
    mode: "queue",
    hideUserMsg: true,
    contextCount: 5,
    lastReviewedTimestamp: 0
};

var PRESET_TEMPLATES = [
    {
        id: "default",
        name: "通用审查",
        text: "请以你的人格与专长，对下方新增内容做一次严格审查：指出逻辑漏洞、事实错误、表达问题与可改进之处。"
    },
    {
        id: "roleplay",
        name: "人设一致性",
        text: "请检查下方新增内容是否保持了角色设定的一致性（语气、称呼、性格、知识边界），指出任何出戏或崩人设的地方。"
    },
    {
        id: "code",
        name: "代码审查",
        text: "请审查下方新增内容中的代码：正确性、边界条件、异常处理、性能与可读性，并给出具体修改建议。"
    },
    {
        id: "writing",
        name: "写作润色",
        text: "请从文笔、结构、节奏、用词四个方面审查下方新增内容，并给出可直接替换的改写示例。"
    }
];

var _dirCache = "";
var _debounceSeq = 0;
var _lastTriggerAt = 0;
var _reviewing = false;
var _pendingFlag = false;

/* ------------------------------------------------------------------ */
/* 目录与 IO                                                           */
/* ------------------------------------------------------------------ */

function configDir() {
    if (_dirCache) return _dirCache;
    var d = "";
    try { d = ToolPkg.getConfigDir(); } catch (e) { d = ""; }
    if (!d || typeof d !== "string") d = FALLBACK_DIR;
    if (d.charAt(d.length - 1) !== "/") d += "/";
    _dirCache = d;
    return d;
}

function pathOf(name) {
    return configDir() + name;
}

async function ensureDir() {
    try { await Tools.Files.createDirectory(configDir()); } catch (e) { /* 已存在 */ }
}

async function readJson(name, fallback) {
    try {
        var res = await Tools.Files.read(pathOf(name));
        var content = res && res.content;
        // 兼容 content 被包成单元素数组的怪癖
        if (Array.isArray(content)) content = content[0];
        if (typeof content !== "string" || !content.trim()) return fallback;
        return JSON.parse(content);
    } catch (e) {
        return fallback;
    }
}

async function writeJson(name, obj) {
    await ensureDir();
    await Tools.Files.write(pathOf(name), JSON.stringify(obj, null, 2));
}

async function readText(name) {
    try {
        var res = await Tools.Files.read(pathOf(name));
        var content = res && res.content;
        if (Array.isArray(content)) content = content[0];
        return typeof content === "string" ? content : "";
    } catch (e) {
        return "";
    }
}

async function log(name, message) {
    try {
        var line = "[" + formatTime(Date.now()) + "] " + name + " | " + message;
        var old = await readText(LOG_FILE);
        var lines = old ? old.split("\n") : [];
        lines.push(line);
        if (lines.length > LOG_LINE_LIMIT) lines = lines.slice(lines.length - LOG_LINE_LIMIT);
        await ensureDir();
        await Tools.Files.write(pathOf(LOG_FILE), lines.join("\n"));
    } catch (e) { /* 日志失败不影响主流程 */ }
}

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

function pad2(n) {
    return n < 10 ? "0" + n : "" + n;
}

function formatTime(ms) {
    if (!ms) return "";
    var d = new Date(ms);
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()) +
        " " + pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":" + pad2(d.getSeconds());
}

function mergeInto(target, patch) {
    if (!patch) return target;
    for (var k in patch) {
        if (Object.prototype.hasOwnProperty.call(patch, k)) target[k] = patch[k];
    }
    return target;
}

function cloneConfig(cfg) {
    var out = {};
    mergeInto(out, DEFAULT_CONFIG);
    mergeInto(out, cfg || {});
    return out;
}

async function sleepMs(ms) {
    try {
        await Tools.System.sleep(ms);
        return;
    } catch (e) { /* 回退到 setTimeout */ }
    await new Promise(function (resolve) { setTimeout(resolve, ms); });
}

function excerptOf(text, len) {
    var s = String(text || "").replace(/\s+/g, " ").trim();
    if (s.length <= len) return s;
    return s.slice(0, len) + "…";
}

/**
 * 剥离思考（CoT）块，让摘录优先呈现真正的结论正文。
 * 支持 <think> / <thinking> / <details>，含未闭合（被截断）的情况。
 */
function stripThinkBlocks(text) {
    var s = String(text || "");
    if (!s) return "";
    s = s.replace(/<\s*think(?:ing)?\s*>[\s\S]*?<\s*\/\s*think(?:ing)?\s*>/gi, " ");
    s = s.replace(/<\s*details\s*>[\s\S]*?<\s*\/\s*details\s*>/gi, " ");
    // 未闭合的 CoT 块：从开标签一直吞到结尾（摘要宁可不要这段思考）
    s = s.replace(/<\s*think(?:ing)?\s*>[\s\S]*$/i, " ");
    s = s.replace(/<\s*details\s*>[\s\S]*$/i, " ");
    return s.replace(/\s+/g, " ").trim();
}

/**
 * 通用超时包装：某些 Tools.* 调用在宿主服务未就绪时会「永久挂起」，
 * 必须加超时，否则会把 reviewing 锁卡死。
 */
function withTimeout(promise, ms, label) {
    return Promise.race([
        promise,
        new Promise(function (resolve, reject) {
            setTimeout(function () {
                reject(new Error("timeout after " + ms + "ms: " + (label || "call")));
            }, ms);
        })
    ]);
}

/* ------------------------------------------------------------------ */
/* 配置                                                                */
/* ------------------------------------------------------------------ */

async function readConfig() {
    var raw = await readJson(CONFIG_FILE, null);
    return cloneConfig(raw);
}

async function saveConfig(patch) {
    var cfg = await readConfig();
    var prevReviewed = cfg.reviewedChatId;
    var explicitWatermark = patch && Object.prototype.hasOwnProperty.call(patch, "lastReviewedTimestamp");
    mergeInto(cfg, patch || {});
    // 被审查窗口变了 → 重置水位线，不追溯历史（除非调用方显式指定）
    if (!explicitWatermark && cfg.reviewedChatId !== prevReviewed) {
        cfg.lastReviewedTimestamp = Date.now();
    }
    await writeJson(CONFIG_FILE, cfg);
    return cfg;
}

async function resetWatermark() {
    var cfg = await readConfig();
    cfg.lastReviewedTimestamp = Date.now();
    await writeJson(CONFIG_FILE, cfg);
    return cfg;
}

/* ------------------------------------------------------------------ */
/* 历史                                                                */
/* ------------------------------------------------------------------ */

async function readHistory() {
    var raw = await readJson(HISTORY_FILE, []);
    return Array.isArray(raw) ? raw : [];
}

async function appendHistory(entry) {
    var list = await readHistory();
    list.unshift(entry);
    if (list.length > HISTORY_LIMIT) list = list.slice(0, HISTORY_LIMIT);
    await writeJson(HISTORY_FILE, list);
    return list;
}

async function deleteHistory(id) {
    var list = await readHistory();
    var out = [];
    for (var i = 0; i < list.length; i++) {
        if (String(list[i].id) !== String(id)) out.push(list[i]);
    }
    await writeJson(HISTORY_FILE, out);
    return out;
}

async function clearHistory() {
    await writeJson(HISTORY_FILE, []);
    return [];
}

/* ------------------------------------------------------------------ */
/* 忙判定                                                              */
/* ------------------------------------------------------------------ */

async function isChatBusy(chatId) {
    if (!chatId) return false;
    try {
        var st = await Promise.race([
            Tools.Chat.agentStatus(chatId),
            new Promise(function (resolve) {
                setTimeout(function () { resolve(null); }, STATUS_TIMEOUT_MS);
            })
        ]);
        if (!st) return false;
        if (st.isProcessing === true) return true;
        if (st.isIdle === false) return true;
        return false;
    } catch (e) {
        return false;
    }
}

/* ------------------------------------------------------------------ */
/* 消息收集与提示词拼装                                                */
/* ------------------------------------------------------------------ */

async function fetchMessages(chatId) {
    if (!chatId) return [];
    try {
        // 关键：order:'asc' + limit 返回的是「最旧的 N 条」，新消息永远看不到。
        // 必须用 desc 取最新 N 条，再反转为时间正序。
        var res = await Tools.Chat.getMessages(chatId, { order: "desc", limit: FETCH_LIMIT });
        var msgs = (res && res.messages) || [];
        return msgs.slice().reverse();
    } catch (e) {
        return [];
    }
}

// 返回 { items, newCount }：
//   items    = 上下文若干条 + 新增若干条（用于拼提示词）
//   newCount = 真正的「新增」条数（用于判定是否值得审查）
// 注意：绝不能把 items.length 当作新增数，否则「无新增」会被误判成有内容。
async function collectNewMessages(cfg) {
    var msgs = await fetchMessages(cfg.reviewedChatId);
    if (!msgs.length) return { items: [], newCount: 0 };
    var since = cfg.lastReviewedTimestamp || 0;
    var newOnes = [];
    for (var i = 0; i < msgs.length; i++) {
        var m = msgs[i];
        if (!m) continue;
        if ((m.timestamp || 0) > since) newOnes.push(m);
    }
    var newCount = newOnes.length;
    if (newCount === 0) return { items: [], newCount: 0 };

    var ctxCount = parseInt(cfg.contextCount, 10);
    if (isNaN(ctxCount) || ctxCount < 0) ctxCount = 0;
    var items = newOnes;
    if (ctxCount > 0 && newCount < msgs.length) {
        var startIdx = msgs.length - newCount - ctxCount;
        if (startIdx < 0) startIdx = 0;
        var pre = msgs.slice(startIdx, msgs.length - newCount);
        items = pre.concat(newOnes);
    }
    return { items: items, newCount: newCount };
}

function formatMessageLine(m) {
    var who = String(m.sender) === "user" ? "用户" : (m.roleName || "AI");
    return "[" + formatTime(m.timestamp) + "] " + who + "：" + String(m.content || "").trim();
}

function buildPromptText(cfg, items) {
    var lines = [];
    lines.push("┌─ 审查任务 ─────────────────────────────");
    lines.push("【审查者】" + (cfg.reviewerCardName || "（未指定角色卡）"));
    lines.push("【被审查】" + (cfg.reviewedCardName || "（未指定角色卡）") +
        " 在窗口《" + (cfg.reviewedChatName || cfg.reviewedChatId) + "》中的输出");
    lines.push("【审查要求】" + (cfg.requirement || "请按你的人格与专长，对下方内容进行审查并给出结论。"));
    lines.push("");
    lines.push("┌─ 待审查内容（自上次审查以来的新增）──────────");
    if (!items.length) {
        lines.push("（本次没有新增内容）");
    } else {
        for (var i = 0; i < items.length; i++) {
            lines.push(formatMessageLine(items[i]));
        }
    }
    lines.push("");
    lines.push("┌─ 输出格式要求 ─────────────────────────");
    lines.push("请严格按以下三段输出，不要添加额外开场白：");
    lines.push("1.【总评】一句话结论。");
    lines.push("2.【问题】逐条列出发现的问题（没有就写「无」）。");
    lines.push("3.【建议】给出可执行的修改建议。");
    return lines.join("\n");
}

/* ------------------------------------------------------------------ */
/* 审查执行                                                            */
/* ------------------------------------------------------------------ */

function extractReviewText(result) {
    if (result === null || result === undefined) return "";
    if (typeof result === "string") return result;
    if (Array.isArray(result)) {
        // 有些实现返回消息数组，取最后一条有内容的
        for (var i = result.length - 1; i >= 0; i--) {
            var t = extractReviewText(result[i]);
            if (t) return t;
        }
        return "";
    }
    if (typeof result === "object") {
        // 关键：MessageSendResultData.message 是「我们自己发出的内容」，
        // 真正的 AI 回复在 aiResponse 字段，必须优先取它，否则会抓到提示词本身。
        var keys = ["aiResponse", "ai_response", "aiMessage", "reply", "answer", "response", "output", "content", "text", "result", "data"];
        for (var k = 0; k < keys.length; k++) {
            var v = result[keys[k]];
            if (typeof v === "string" && v) return v;
        }
        for (var k2 = 0; k2 < keys.length; k2++) {
            var v2 = result[keys[k2]];
            if (v2 && typeof v2 === "object") {
                var t2 = extractReviewText(v2);
                if (t2) return t2;
            }
        }
        // 兜底：常见包装 { message: { content } } / { message: "..." }
        // 但若对象带发送结果签名（chatId/sentAt），说明 message 只是我们自己发的提示词，
        // 此时宁可返回空（触发 review_raw_result 日志），也不要误抓提示词。
        var isSendResult = (result.sentAt !== undefined || result.chatId !== undefined);
        if (result.message && !isSendResult) {
            if (typeof result.message === "string") return result.message;
            if (typeof result.message.content === "string") return result.message.content;
            var t1 = extractReviewText(result.message);
            if (t1) return t1;
        }
    }
    return "";
}

async function executeReview(cfg) {
    var collected = await collectNewMessages(cfg);
    var items = (collected && collected.items) || [];
    var newCount = (collected && collected.newCount) || 0;
    // 关键：用 newCount 判定，而不是 items.length（items 里含上下文）
    if (newCount === 0) {
        return {
            id: String(Date.now()),
            time: Date.now(),
            timeText: formatTime(Date.now()),
            reviewedChatId: cfg.reviewedChatId,
            reviewedChatName: cfg.reviewedChatName,
            reviewerChatId: cfg.reviewerChatId,
            reviewerChatName: cfg.reviewerChatName,
            itemCount: 0,
            sourceExcerpt: "",
            reviewExcerpt: "",
            skipped: true,
            reason: "没有新增内容"
        };
    }

    var prompt = buildPromptText(cfg, items);
    var lastTs = items[items.length - 1].timestamp || 0;

    var options = {
        hide_user_message: cfg.hideUserMsg !== false,
        notify_reply: false
    };
    var result = await withTimeout(
        Tools.Chat.sendMessage(
            prompt,
            cfg.reviewerChatId,
            cfg.reviewerCardId || undefined,
            undefined,
            options
        ),
        180000,
        "sendMessage"
    );

    // 推进水位线
    if (lastTs > 0) {
        var cur = await readConfig();
        if (lastTs > (cur.lastReviewedTimestamp || 0)) {
            cur.lastReviewedTimestamp = lastTs;
            await writeJson(CONFIG_FILE, cur);
        }
    }

    var reviewText = extractReviewText(result);
    if (!reviewText) {
        var raw = "";
        try { raw = JSON.stringify(result); } catch (e) { raw = String(result); }
        try { await log("review_raw_result", String(raw).slice(0, 800)); } catch (e) { /* ignore */ }
    }
    // 摘要只取「真正新增」的那几条，不含上下文
    var newItems = (newCount > 0 && newCount <= items.length)
        ? items.slice(items.length - newCount)
        : items;
    var srcExcerpt = "";
    for (var i = 0; i < newItems.length; i++) {
        srcExcerpt += formatMessageLine(newItems[i]) + " / ";
    }

    var reviewBody = stripThinkBlocks(reviewText);
    if (!reviewBody) reviewBody = reviewText;

    return {
        id: String(Date.now()),
        time: Date.now(),
        timeText: formatTime(Date.now()),
        reviewedChatId: cfg.reviewedChatId,
        reviewedChatName: cfg.reviewedChatName,
        reviewerChatId: cfg.reviewerChatId,
        reviewerChatName: cfg.reviewerChatName,
        itemCount: newCount,
        sourceExcerpt: excerptOf(srcExcerpt, 100),
        reviewExcerpt: excerptOf(reviewBody, 200),
        skipped: false,
        reason: ""
    };
}

async function runReview(cfg) {
    _reviewing = true;
    var entry = null;
    try {
        entry = await executeReview(cfg);
    } catch (e) {
        var msg = (e && e.message) ? e.message : String(e);
        await log("review_error", msg);
        entry = {
            id: String(Date.now()),
            time: Date.now(),
            timeText: formatTime(Date.now()),
            reviewedChatId: cfg.reviewedChatId,
            reviewedChatName: cfg.reviewedChatName,
            reviewerChatId: cfg.reviewerChatId,
            reviewerChatName: cfg.reviewerChatName,
            itemCount: 0,
            sourceExcerpt: "",
            reviewExcerpt: "",
            skipped: false,
            error: msg,
            reason: ""
        };
    } finally {
        _reviewing = false;
    }

    if (entry) {
        try { await appendHistory(entry); } catch (e) { /* ignore */ }
    }

    // 忙②：审查期间累积的 pending，空闲后立刻执行（只留最新 → 用标记即可）
    if (_pendingFlag) {
        _pendingFlag = false;
        var fresh = await readConfig();
        if (fresh.enabled) {
            await runReview(fresh);
        }
    }
    return entry;
}

async function enqueueReview(cfg) {
    if (_reviewing) {
        if (String(cfg.mode) === "skip") {
            await appendHistory({
                id: String(Date.now()),
                time: Date.now(),
                timeText: formatTime(Date.now()),
                reviewedChatId: cfg.reviewedChatId,
                reviewedChatName: cfg.reviewedChatName,
                reviewerChatId: cfg.reviewerChatId,
                reviewerChatName: cfg.reviewerChatName,
                itemCount: 0,
                sourceExcerpt: "",
                reviewExcerpt: "",
                skipped: true,
                reason: "审查者忙，按设置跳过"
            });
            return null;
        }
        _pendingFlag = true;
        return null;
    }
    return await runReview(cfg);
}

/* ------------------------------------------------------------------ */
/* Hook 入口：被审查者 AI 输出结束                                     */
/* ------------------------------------------------------------------ */

async function handleAiMessage(payload) {
    var cfg = await readConfig();
    if (!cfg.enabled) return;
    if (!cfg.reviewedChatId || !cfg.reviewerChatId) return;
    if (String(payload.chatId || "") !== String(cfg.reviewedChatId)) return;
    if (String(payload.sender || "") !== "ai") return;

    // 忙①：防抖——AI 一轮回复可能被拆成多条落盘，只认最后一条
    var seq = ++_debounceSeq;
    await sleepMs(DEBOUNCE_MS);
    if (seq !== _debounceSeq) return;              // 期间又来新消息，本轮作废
    if (await isChatBusy(cfg.reviewedChatId)) return; // 整轮还没结束

    var now = Date.now();
    if (now - _lastTriggerAt < COOLDOWN_MS) return;   // 冷却，防连环
    _lastTriggerAt = now;

    await enqueueReview(cfg);
}

/* ------------------------------------------------------------------ */
/* 手动入口（面板按钮）                                                */
/* ------------------------------------------------------------------ */

async function runReviewNow() {
    var cfg = await readConfig();
    if (!cfg.reviewedChatId || !cfg.reviewerChatId) {
        return { success: false, message: "请先绑定被审查窗口与审查者窗口" };
    }
    var entry = await enqueueReview(cfg);
    if (!entry) {
        return { success: true, message: "审查者正忙，已排入队列（只留最新）" };
    }
    if (entry.skipped) {
        return { success: true, message: entry.reason || "已跳过" };
    }
    if (entry.error) {
        return { success: false, message: "审查失败：" + entry.error };
    }
    return { success: true, message: "审查完成" };
}

/* ------------------------------------------------------------------ */
/* 面板辅助数据                                                        */
/* ------------------------------------------------------------------ */

async function listCandidateChats() {
    try {
        var res = await Tools.Chat.listChats({});
        var chats = (res && res.chats) || [];
        var out = [];
        for (var i = 0; i < chats.length; i++) {
            var c = chats[i];
            out.push({
                id: c.id,
                title: c.title || "(未命名)",
                isCurrent: !!c.isCurrent,
                cardName: c.characterCardName || "",
                updatedAt: c.updatedAt || 0
            });
        }
        return out;
    } catch (e) {
        return [];
    }
}

async function listCards() {
    try {
        var res = await Tools.Chat.listCharacterCards();
        var cards = (res && res.cards) || [];
        var out = [];
        for (var i = 0; i < cards.length; i++) {
            out.push({ id: cards[i].id, name: cards[i].name || "(未命名)" });
        }
        return out;
    } catch (e) {
        return [];
    }
}

async function createCard(name, description) {
    try {
        var res = await Tools.SoftwareSettings.createCharacterCard({
            name: name,
            description: description || ""
        });
        var card = (res && (res.card || res)) || {};
        return { success: true, id: card.id || "", name: card.name || name };
    } catch (e) {
        return { success: false, message: (e && e.message) ? e.message : String(e) };
    }
}

async function getStatus() {
    var cfg = await readConfig();
    var reviewedBusy = false;
    var reviewerBusy = false;
    if (cfg.reviewedChatId) reviewedBusy = await isChatBusy(cfg.reviewedChatId);
    if (cfg.reviewerChatId) reviewerBusy = await isChatBusy(cfg.reviewerChatId);
    return {
        config: cfg,
        reviewing: _reviewing,
        pending: _pendingFlag,
        reviewedBusy: reviewedBusy,
        reviewerBusy: reviewerBusy,
        configDir: configDir()
    };
}

async function previewPrompt() {
    var cfg = await readConfig();
    var collected = await collectNewMessages(cfg);
    var items = (collected && collected.items) || [];
    var newCount = (collected && collected.newCount) || 0;
    return { text: buildPromptText(cfg, items), count: newCount, contextCount: items.length };
}

/* ------------------------------------------------------------------ */
/* 导出                                                                */
/* ------------------------------------------------------------------ */

exports.configDir = configDir;
exports.readConfig = readConfig;
exports.saveConfig = saveConfig;
exports.resetWatermark = resetWatermark;
exports.readHistory = readHistory;
exports.appendHistory = appendHistory;
exports.deleteHistory = deleteHistory;
exports.clearHistory = clearHistory;
exports.handleAiMessage = handleAiMessage;
exports.runReviewNow = runReviewNow;
exports.listCandidateChats = listCandidateChats;
exports.listCards = listCards;
exports.createCard = createCard;
exports.getStatus = getStatus;
exports.previewPrompt = previewPrompt;
exports.isChatBusy = isChatBusy;
exports.log = log;
exports.formatTime = formatTime;
exports.PRESET_TEMPLATES = PRESET_TEMPLATES;
exports.DEFAULT_CONFIG = DEFAULT_CONFIG;
