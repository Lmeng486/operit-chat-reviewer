/*
 * chat_reviewer — ToolPkg 入口（com.operit.chat_reviewer）
 *
 * 职责：
 *   1. 注册 ChatMessage Hook：被审查者 AI 输出结束后触发审查（逻辑在 core.js）
 *   2. 注册侧栏 UI route + 导航入口：审查面板
 *
 * 注意：
 *   - registerToolPkg() 内只做声明注册，禁止调用 readResource / wasm.call。
 *   - registerUiRoute 的 screen 必须传「可序列化的字符串路径」，不能传函数对象。
 */
"use strict";

var core = require("./core.js");

var ROUTE_ID = "chat_reviewer_panel";
var SCREEN_PATH = "ui/chat_reviewer_panel/index.ui.js";

function registerToolPkg() {
    ToolPkg.registerUiRoute({
        id: ROUTE_ID,
        runtime: "compose_dsl",
        screen: SCREEN_PATH,
        params: {},
        title: {
            zh: "聊天审查",
            en: "Chat Reviewer"
        }
    });

    ToolPkg.registerNavigationEntry({
        id: "chat_reviewer_sidebar_entry",
        route: "toolpkg:com.operit.chat_reviewer:ui:" + ROUTE_ID,
        surface: "main_sidebar_plugins",
        title: {
            zh: "聊天审查",
            en: "Chat Reviewer"
        },
        order: 10
    });

    ToolPkg.registerChatMessageHook({
        id: "chat_reviewer_message_hook",
        function: onChatMessage
    });

    return true;
}

/**
 * ChatMessage Hook：只在被审查者窗口有 AI 消息落盘时进入 core 的防抖流程。
 * core.handleAiMessage 内部会做窗口/发送者过滤、防抖、忙判定与冷却。
 */
function onChatMessage(event) {
    var payload = (event && event.eventPayload) || {};
    if (String(payload.sender || "") !== "ai") {
        return { handled: false };
    }
    try {
        return core.handleAiMessage(payload).then(function () {
            return { handled: true };
        }).catch(function (error) {
            core.log("hook_error", (error && error.message) ? error.message : String(error));
            return { handled: false };
        });
    } catch (e) {
        core.log("hook_throw", (e && e.message) ? e.message : String(e));
        return { handled: false };
    }
}

exports.registerToolPkg = registerToolPkg;
exports.onChatMessage = onChatMessage;