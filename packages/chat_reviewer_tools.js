/*
METADATA
{
  "name": "chat_reviewer_tools",
  "display_name": {
    "zh": "聊天审查工具",
    "en": "Chat Reviewer Tools"
  },
  "description": {
    "zh": "查询/修改聊天审查绑定与设置、查看审查历史、手动触发一次审查。",
    "en": "Inspect/modify chat-review binding and settings, read review history, and trigger a review manually."
  },
  "enabledByDefault": true,
  "category": "PRODUCTIVITY",
  "tools": [
    {
      "name": "get_review_config",
      "description": {
        "zh": "读取当前聊天审查配置：是否启用、被审查窗口、审查者窗口、角色卡、审查要求、忙时策略、水位线等。",
        "en": "Read the current chat-review config: enabled, reviewee/reviewer chats, character cards, requirement, busy mode, watermark, etc."
      },
      "parameters": []
    },
    {
      "name": "set_review_config",
      "description": {
        "zh": "修改聊天审查配置。只需传要改的字段。可用 chat 标题或 ID 绑定窗口；切换被审查窗口会自动重置水位线。",
        "en": "Update chat-review config. Only pass the fields you want to change. Bind chats by title or ID; switching the reviewee resets the watermark."
      },
      "parameters": [
        {
          "name": "enabled",
          "description": { "zh": "是否开启自动审查", "en": "Enable automatic review" },
          "type": "boolean",
          "required": false
        },
        {
          "name": "reviewed_chat",
          "description": { "zh": "被审查窗口（标题或 chatId）", "en": "Reviewee chat (title or chatId)" },
          "type": "string",
          "required": false
        },
        {
          "name": "reviewer_chat",
          "description": { "zh": "审查者窗口（标题或 chatId）", "en": "Reviewer chat (title or chatId)" },
          "type": "string",
          "required": false
        },
        {
          "name": "reviewer_card",
          "description": { "zh": "审查者角色卡（名称或 ID）", "en": "Reviewer character card (name or ID)" },
          "type": "string",
          "required": false
        },
        {
          "name": "reviewed_card",
          "description": { "zh": "被审查者角色卡（名称或 ID）", "en": "Reviewee character card (name or ID)" },
          "type": "string",
          "required": false
        },
        {
          "name": "requirement",
          "description": { "zh": "审查要求文本", "en": "Review requirement text" },
          "type": "string",
          "required": false
        },
        {
          "name": "mode",
          "description": { "zh": "审查者忙时的策略：queue（排队只留最新）或 skip（跳过）", "en": "Strategy when reviewer is busy: queue (keep latest) or skip" },
          "type": "string",
          "required": false
        },
        {
          "name": "hide_user_msg",
          "description": { "zh": "是否在审查窗口隐藏触发的提示词", "en": "Hide the triggering prompt in the reviewer chat" },
          "type": "boolean",
          "required": false
        }
      ]
    },
    {
      "name": "run_review_now",
      "description": {
        "zh": "立即按当前配置执行一次审查（不等 AI 输出），并把结果写入历史。",
        "en": "Run a review immediately with the current config (without waiting for AI output) and record it to history."
      },
      "parameters": []
    },
    {
      "name": "get_review_history",
      "description": {
        "zh": "读取最近的审查历史记录（时间、被审查→审查、原文摘要、审查结论摘要）。",
        "en": "Read recent review history (time, reviewee→reviewer, source excerpt, review excerpt)."
      },
      "parameters": [
        {
          "name": "limit",
          "description": { "zh": "最多返回多少条，默认 10", "en": "Max entries, default 10" },
          "type": "number",
          "required": false
        }
      ]
    }
  ]
}
*/

"use strict";

var core = require("../core.js");

async function resolveChatId(value) {
    var v = String(value || "").trim();
    if (!v) return "";
    var chats = await core.listCandidateChats();
    for (var i = 0; i < chats.length; i++) {
        if (chats[i].id === v) return chats[i].id;
    }
    for (var j = 0; j < chats.length; j++) {
        if (String(chats[j].title).indexOf(v) >= 0) return chats[j].id;
    }
    return "";
}

async function resolveCardId(value) {
    var v = String(value || "").trim();
    if (!v) return "";
    var cards = await core.listCards();
    for (var i = 0; i < cards.length; i++) {
        if (cards[i].id === v) return cards[i].id;
    }
    for (var j = 0; j < cards.length; j++) {
        if (String(cards[j].name).indexOf(v) >= 0) return cards[j].id;
    }
    return "";
}

exports.get_review_config = async function () {
    try {
        var cfg = await core.readConfig();
        complete({
            success: true,
            message: "当前审查配置",
            data: cfg
        });
    } catch (e) {
        complete({ success: false, message: "读取失败：" + ((e && e.message) || e) });
    }
};

exports.set_review_config = async function (params) {
    try {
        var p = params || {};
        var patch = {};

        if (p.enabled !== undefined) patch.enabled = !!p.enabled;
        if (p.requirement !== undefined) patch.requirement = String(p.requirement);
        if (p.mode !== undefined) patch.mode = (String(p.mode) === "skip") ? "skip" : "queue";
        if (p.hide_user_msg !== undefined) patch.hideUserMsg = !!p.hide_user_msg;

        if (p.reviewed_chat !== undefined) {
            var rid = await resolveChatId(p.reviewed_chat);
            if (!rid) {
                complete({ success: false, message: "找不到被审查窗口：" + p.reviewed_chat });
                return;
            }
            var rchats = await core.listCandidateChats();
            patch.reviewedChatId = rid;
            for (var a = 0; a < rchats.length; a++) {
                if (rchats[a].id === rid) patch.reviewedChatName = rchats[a].title;
            }
        }

        if (p.reviewer_chat !== undefined) {
            var vid = await resolveChatId(p.reviewer_chat);
            if (!vid) {
                complete({ success: false, message: "找不到审查者窗口：" + p.reviewer_chat });
                return;
            }
            var vchats = await core.listCandidateChats();
            patch.reviewerChatId = vid;
            for (var b = 0; b < vchats.length; b++) {
                if (vchats[b].id === vid) patch.reviewerChatName = vchats[b].title;
            }
        }

        if (p.reviewer_card !== undefined) {
            var cid = await resolveCardId(p.reviewer_card);
            if (!cid) {
                complete({ success: false, message: "找不到审查者角色卡：" + p.reviewer_card });
                return;
            }
            var cards = await core.listCards();
            patch.reviewerCardId = cid;
            for (var c = 0; c < cards.length; c++) {
                if (cards[c].id === cid) patch.reviewerCardName = cards[c].name;
            }
        }

        if (p.reviewed_card !== undefined) {
            var did = await resolveCardId(p.reviewed_card);
            if (!did) {
                complete({ success: false, message: "找不到被审查者角色卡：" + p.reviewed_card });
                return;
            }
            var cards2 = await core.listCards();
            patch.reviewedCardId = did;
            for (var d = 0; d < cards2.length; d++) {
                if (cards2[d].id === did) patch.reviewedCardName = cards2[d].name;
            }
        }

        var cfg = await core.saveConfig(patch);
        complete({
            success: true,
            message: "已更新审查配置",
            data: cfg
        });
    } catch (e) {
        complete({ success: false, message: "更新失败：" + ((e && e.message) || e) });
    }
};

exports.run_review_now = async function () {
    try {
        var r = await core.runReviewNow();
        complete({
            success: !!r.success,
            message: r.message || (r.success ? "审查完成" : "审查失败"),
            data: r
        });
    } catch (e) {
        complete({ success: false, message: "执行失败：" + ((e && e.message) || e) });
    }
};

exports.get_review_history = async function (params) {
    try {
        var limit = parseInt((params && params.limit) || 10, 10);
        if (isNaN(limit) || limit <= 0) limit = 10;
        var list = await core.readHistory();
        complete({
            success: true,
            message: "共 " + list.length + " 条历史，返回最近 " + Math.min(limit, list.length) + " 条",
            data: list.slice(0, limit)
        });
    } catch (e) {
        complete({ success: false, message: "读取失败：" + ((e && e.message) || e) });
    }
};

exports.main = function () {
    exports.get_review_config({});
};