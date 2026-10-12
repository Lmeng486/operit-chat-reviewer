/*
 * chat_reviewer — 侧栏面板（com.operit.chat_reviewer）
 *
 * 架构：ToolPkg Compose DSL 外壳 + WebView 内嵌 HTML（参考 gentle_guardian 的成熟做法）。
 * 桥接：ctx.createWebViewController + addJavascriptInterface("Reviewer", {...})
 *       每个桥方法返回 JSON 字符串，HTML 侧 JSON.parse 消费。
 *
 * 三个 Tab：配置 / 预览 / 历史
 */
"use strict";

var core = require("../../core.js");

function esc(s) {
    var t = String(s === undefined || s === null ? "" : s);
    return t.split("&").join("&amp;")
        .split("<").join("&lt;")
        .split(">").join("&gt;")
        .split(String.fromCharCode(34)).join("&quot;");
}

function json(obj) {
    try {
        return JSON.stringify(obj);
    } catch (e) {
        return "{}";
    }
}

/* ------------------------------------------------------------------ */
/* 桥接对象                                                            */
/* ------------------------------------------------------------------ */

function buildBridge() {
    return {
        // 面板初始化：一次拉全所有数据
        loadAll: async function () {
            try {
                var cfg = await core.readConfig();
                var chats = await core.listCandidateChats();
                var cards = await core.listCards();
                var history = await core.readHistory();
                var status = await core.getStatus();
                return json({
                    success: true,
                    config: cfg,
                    chats: chats,
                    cards: cards,
                    presets: core.PRESET_TEMPLATES,
                    history: history,
                    status: status,
                    configDir: core.configDir()
                });
            } catch (e) {
                return json({ success: false, message: (e && e.message) ? e.message : String(e) });
            }
        },

        // 保存配置（传 JSON 字符串）
        saveConfig: async function (patchJson) {
            try {
                var patch = JSON.parse(patchJson);
                var cfg = await core.saveConfig(patch);
                return json({ success: true, config: cfg });
            } catch (e) {
                return json({ success: false, message: (e && e.message) ? e.message : String(e) });
            }
        },

        // 手动触发一次审查
        runReviewNow: async function () {
            try {
                var r = await core.runReviewNow();
                return json(r);
            } catch (e) {
                return json({ success: false, message: (e && e.message) ? e.message : String(e) });
            }
        },

        // 预览将要发送的提示词
        previewPrompt: async function () {
            try {
                var r = await core.previewPrompt();
                return json({ success: true, text: r.text, count: r.count });
            } catch (e) {
                return json({ success: false, message: (e && e.message) ? e.message : String(e) });
            }
        },

        // 刷新忙状态
        refreshStatus: async function () {
            try {
                var s = await core.getStatus();
                return json({ success: true, status: s });
            } catch (e) {
                return json({ success: false, message: (e && e.message) ? e.message : String(e) });
            }
        },

        // 重置水位线（下次审查从当前时刻起算）
        resetWatermark: async function () {
            try {
                var cfg = await core.resetWatermark();
                return json({ success: true, config: cfg });
            } catch (e) {
                return json({ success: false, message: (e && e.message) ? e.message : String(e) });
            }
        },

        // 历史操作
        deleteHistory: async function (id) {
            try {
                var list = await core.deleteHistory(id);
                return json({ success: true, history: list });
            } catch (e) {
                return json({ success: false, message: (e && e.message) ? e.message : String(e) });
            }
        },
        clearHistory: async function () {
            try {
                var list = await core.clearHistory();
                return json({ success: true, history: list });
            } catch (e) {
                return json({ success: false, message: (e && e.message) ? e.message : String(e) });
            }
        },

        // 新建角色卡
        createCard: async function (name, description) {
            try {
                var r = await core.createCard(name, description);
                return json(r);
            } catch (e) {
                return json({ success: false, message: (e && e.message) ? e.message : String(e) });
            }
        },

        // 读取调试日志
        loadLog: async function () {
            try {
                var res = await Tools.Files.read(core.configDir() + "debug.log");
                var content = res && res.content;
                if (Array.isArray(content)) content = content[0];
                return json({ success: true, text: typeof content === "string" ? content : "" });
            } catch (e) {
                return json({ success: true, text: "" });
            }
        }
    };
}

/* ------------------------------------------------------------------ */
/* HTML                                                                */
/* ------------------------------------------------------------------ */

function buildPanelHtml() {
    return [
        '<!DOCTYPE html>',
        '<html lang="zh">',
        '<head>',
        '<meta charset="utf-8">',
        '<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">',
        '<style>',
        ':root{--bg:#f6f7f9;--card:#fff;--line:#e3e6ea;--fg:#1c1f23;--mut:#6b7280;--pri:#3b6ef5;--ok:#1f9d55;--warn:#d97706;--err:#dc2626}',
        '@media (prefers-color-scheme:dark){:root{--bg:#14161a;--card:#1d2025;--line:#2c3138;--fg:#e8eaed;--mut:#9aa2ad;--pri:#6f97ff}}',
        '*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}',
        'body{margin:0;padding:12px;background:var(--bg);color:var(--fg);font:14px/1.5 -apple-system,system-ui,"PingFang SC","Microsoft YaHei",sans-serif}',
        '.tabs{display:flex;gap:6px;margin-bottom:12px}',
        '.tabs button{flex:1;padding:9px 0;border:1px solid var(--line);background:var(--card);color:var(--mut);border-radius:9px;font-size:14px;font-weight:600}',
        '.tabs button.on{background:var(--pri);color:#fff;border-color:var(--pri)}',
        '.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px;margin-bottom:12px}',
        '.card h3{margin:0 0 10px;font-size:14px;font-weight:700}',
        '.row{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px}',
        'label.f{display:block;font-size:12px;color:var(--mut);margin:10px 0 4px}',
        'select,input,textarea{width:100%;padding:9px;border:1px solid var(--line);border-radius:9px;background:var(--bg);color:var(--fg);font-size:14px;font-family:inherit}',
        'textarea{min-height:90px;resize:vertical}',
        'button.act{padding:9px 14px;border:none;border-radius:9px;background:var(--pri);color:#fff;font-size:13px;font-weight:600}',
        'button.act.sec{background:var(--card);color:var(--fg);border:1px solid var(--line)}',
        'button.act:disabled{opacity:.5}',
        '.sw{display:flex;align-items:center;gap:8px;font-size:13px}',
        '.sw input{width:auto}',
        '.badge{display:inline-block;padding:2px 8px;border-radius:20px;font-size:11px;font-weight:700}',
        '.b-ok{background:rgba(31,157,85,.15);color:var(--ok)}',
        '.b-warn{background:rgba(217,119,6,.15);color:var(--warn)}',
        '.b-off{background:rgba(107,114,128,.15);color:var(--mut)}',
        '.hint{font-size:11px;color:var(--mut);margin-top:6px;line-height:1.5}',
        'pre{white-space:pre-wrap;word-break:break-word;background:var(--bg);border:1px solid var(--line);border-radius:9px;padding:10px;font-size:12px;max-height:320px;overflow:auto;margin:0}',
        '.hist{border-bottom:1px solid var(--line);padding:10px 0}',
        '.hist:last-child{border-bottom:none}',
        '.hist .t{font-size:12px;color:var(--mut);display:flex;justify-content:space-between;gap:8px}',
        '.hist .s{font-size:12px;margin:6px 0 2px}',
        '.hist .r{font-size:12px;color:var(--mut)}',
        '.hist .ops{display:flex;gap:8px;margin-top:6px}',
        '.hist .ops button{padding:4px 10px;font-size:12px;border:1px solid var(--line);background:var(--bg);color:var(--fg);border-radius:7px}',
        '.empty{color:var(--mut);font-size:13px;text-align:center;padding:20px 0}',
        '#toast{position:fixed;left:50%;bottom:20px;transform:translateX(-50%);background:rgba(0,0,0,.82);color:#fff;padding:9px 16px;border-radius:20px;font-size:13px;opacity:0;transition:opacity .25s;pointer-events:none;max-width:86%}',
        '#toast.on{opacity:1}',
        '.hidden{display:none}',
        '</style>',
        '</head>',
        '<body>',
        '<div class="tabs">',
        '<button id="tab-cfg" class="on" onclick="showTab(\'cfg\')">配置</button>',
        '<button id="tab-prev" onclick="showTab(\'prev\')">预览</button>',
        '<button id="tab-hist" onclick="showTab(\'hist\')">历史</button>',
        '</div>',

        // ---------- 配置 Tab ----------
        '<div id="page-cfg">',
        '<div class="card">',
        '<div class="row"><h3 style="margin:0">总开关</h3><div class="sw"><input type="checkbox" id="enabled"><label for="enabled">审查已开启</label></div></div>',
        '<div class="hint" id="statusLine">状态加载中…</div>',
        '</div>',

        '<div class="card">',
        '<h3>① 绑定窗口</h3>',
        '<label class="f">被审查窗口（谁被审）</label>',
        '<select id="reviewedChat"></select>',
        '<label class="f">审查者窗口（谁来审）</label>',
        '<select id="reviewerChat"></select>',
        '<div class="hint">一对一硬绑定：一个被审查窗口只对应一个审查者窗口。</div>',
        '</div>',

        '<div class="card">',
        '<h3>② 角色卡</h3>',
        '<label class="f">被审查者角色卡</label>',
        '<select id="reviewedCard"></select>',
        '<label class="f">审查者角色卡</label>',
        '<select id="reviewerCard"></select>',
        '<label class="f">新建角色卡（审查者专用）</label>',
        '<div class="row"><input id="newCardName" placeholder="角色卡名称" style="flex:1"><button class="act" onclick="createCard()">新建</button></div>',
        '<div class="hint">审查输出会以「审查者角色卡」的人格生成。</div>',
        '</div>',

        '<div class="card">',
        '<h3>③ 审查要求</h3>',
        '<label class="f">预设模板</label>',
        '<select id="preset" onchange="applyPreset()"></select>',
        '<label class="f">审查要求文本</label>',
        '<textarea id="requirement" placeholder="例如：请检查人设一致性、逻辑漏洞与表达问题"></textarea>',
        '</div>',

        '<div class="card">',
        '<h3>④ 行为设置</h3>',
        '<label class="f">审查者忙时（忙②）</label>',
        '<select id="mode">',
        '<option value="queue">排队（只留最新）— 推荐</option>',
        '<option value="skip">跳过 — 忙时直接丢弃</option>',
        '</select>',
        '<label class="f">附加上下文条数（0-20）</label>',
        '<input id="contextCount" type="number" min="0" max="20" value="5">',
        '<div class="row" style="margin-top:12px"><div class="sw"><input type="checkbox" id="hideUserMsg"><label for="hideUserMsg">隐藏触发消息（审查窗口看不到喂进去的提示词）</label></div></div>',
        '</div>',

        '<div class="row">',
        '<button class="act" onclick="saveAll()">保存设置</button>',
        '<button class="act sec" onclick="resetWm()">重置水位线</button>',
        '</div>',
        '</div>',

        // ---------- 预览 Tab ----------
        '<div id="page-prev" class="hidden">',
        '<div class="card">',
        '<div class="row"><h3 style="margin:0">提示词预览</h3><span class="badge b-off" id="prevCount">-</span></div>',
        '<div class="hint">下面是下次审查将要发送给审查者窗口的完整提示词（基于当前水位线）。</div>',
        '<div class="row" style="margin-top:10px"><button class="act" onclick="doPreview()">重新生成</button></div>',
        '<pre id="prevText">点击「重新生成」查看。</pre>',
        '</div>',
        '<div class="card">',
        '<h3>手动触发</h3>',
        '<div class="hint">不等 AI 输出，立刻按当前配置审查一次（用于测试）。</div>',
        '<div class="row" style="margin-top:10px"><button class="act" onclick="doRun()">立即审查一次</button></div>',
        '</div>',
        '</div>',

        // ---------- 历史 Tab ----------
        '<div id="page-hist" class="hidden">',
        '<div class="card">',
        '<div class="row"><h3 style="margin:0">审查历史</h3><span class="badge b-off" id="histCount">0</span></div>',
        '<div class="hint">最多保留最近 50 条。</div>',
        '<div class="row" style="margin-top:8px"><button class="act sec" onclick="doClearHist()">清空全部</button></div>',
        '</div>',
        '<div class="card" id="histList"><div class="empty">暂无记录</div></div>',
        '</div>',

        '<div id="toast"></div>',

        '<script>',
        'var S={config:null,chats:[],cards:[],presets:[],history:[],status:null};',
        'function toast(m){var t=document.getElementById("toast");t.textContent=m;t.classList.add("on");setTimeout(function(){t.classList.remove("on")},2200);}',
        'function P(s){try{return JSON.parse(s);}catch(e){return {success:false,message:"解析失败"};}}',
        'function showTab(k){',
        '  ["cfg","prev","hist"].forEach(function(x){',
        '    document.getElementById("page-"+x).classList.toggle("hidden",x!==k);',
        '    document.getElementById("tab-"+x).classList.toggle("on",x===k);',
        '  });',
        '  if(k==="prev")doPreview();',
        '  if(k==="hist")loadAll();',
        '}',
        'function opt(v,t,sel){return "<option value=\\""+v+"\\""+(sel?" selected":"")+">"+t+"</option>";}',
        'function fillSelects(){',
        '  var c=document.getElementById("reviewedChat"),r=document.getElementById("reviewerChat");',
        '  var o=opt("","— 未选择 —",!S.config.reviewedChatId);',
        '  S.chats.forEach(function(x){o+=opt(x.id,x.title+(x.cardName?"（"+x.cardName+"）":""),x.id===S.config.reviewedChatId);});',
        '  c.innerHTML=o;',
        '  var o2=opt("","— 未选择 —",!S.config.reviewerChatId);',
        '  S.chats.forEach(function(x){o2+=opt(x.id,x.title+(x.cardName?"（"+x.cardName+"）":""),x.id===S.config.reviewerChatId);});',
        '  r.innerHTML=o2;',
        '  var rc=document.getElementById("reviewedCard");',
        '  var o3=opt("","— 不指定 —",!S.config.reviewedCardId);',
        '  S.cards.forEach(function(x){o3+=opt(x.id,x.name,x.id===S.config.reviewedCardId);});',
        '  rc.innerHTML=o3;',
        '  var vc=document.getElementById("reviewerCard");',
        '  var o4=opt("","— 不指定 —",!S.config.reviewerCardId);',
        '  S.cards.forEach(function(x){o4+=opt(x.id,x.name,x.id===S.config.reviewerCardId);});',
        '  vc.innerHTML=o4;',
        '  var p=document.getElementById("preset");',
        '  var o5=opt("","— 选择预设 —",true);',
        '  S.presets.forEach(function(x){o5+=opt(x.id,x.name,false);});',
        '  p.innerHTML=o5;',
        '}',
        'function applyPreset(){',
        '  var id=document.getElementById("preset").value;if(!id)return;',
        '  var t=S.presets.filter(function(x){return x.id===id;})[0];',
        '  if(t)document.getElementById("requirement").value=t.text;',
        '}',
        'function renderStatus(){',
        '  var st=S.status||{},cfg=S.config||{};',
        '  var parts=[];',
        '  parts.push(cfg.enabled?"<span class=\\"badge b-ok\\">已开启</span>":"<span class=\\"badge b-off\\">已关闭</span>");',
        '  parts.push(st.reviewing?"<span class=\\"badge b-warn\\">审查中</span>":"<span class=\\"badge b-off\\">空闲</span>");',
        '  if(st.pending)parts.push("<span class=\\"badge b-warn\\">有排队</span>");',
        '  if(st.reviewedBusy)parts.push("<span class=\\"badge b-warn\\">被审查者忙</span>");',
        '  if(st.reviewerBusy)parts.push("<span class=\\"badge b-warn\\">审查者忙</span>");',
        '  document.getElementById("statusLine").innerHTML=parts.join(" ");',
        '}',
        'function renderHist(){',
        '  var box=document.getElementById("histList");',
        '  document.getElementById("histCount").textContent=S.history.length;',
        '  if(!S.history.length){box.innerHTML="<div class=\\"empty\\">暂无记录</div>";return;}',
        '  var h="";',
        '  S.history.forEach(function(e){',
        '    var badge=e.error?"<span class=\\"badge b-warn\\">失败</span>":(e.skipped?"<span class=\\"badge b-off\\">跳过</span>":"<span class=\\"badge b-ok\\">完成</span>");',
        '    h+="<div class=\\"hist\\"><div class=\\"t\\"><span>"+(e.timeText||"")+"</span><span>"+badge+"</span></div>";',
        '    h+="<div class=\\"s\\">"+(e.reviewedChatName||"被审查")+" → "+(e.reviewerChatName||"审查者")+"　共 "+((e.itemCount||0))+" 条</div>";',
        '    if(e.sourceExcerpt)h+="<div class=\\"r\\">原文："+e.sourceExcerpt+"</div>";',
        '    if(e.reviewExcerpt)h+="<div class=\\"r\\">结论："+e.reviewExcerpt+"</div>";',
        '    if(e.error)h+="<div class=\\"r\\">错误："+e.error+"</div>";',
        '    if(e.reason)h+="<div class=\\"r\\">说明："+e.reason+"</div>";',
        '    h+="<div class=\\"ops\\"><button onclick=\\"delHist(\'"+e.id+"\')\\">删除</button></div></div>";',
        '  });',
        '  box.innerHTML=h;',
        '}',
        'async function loadAll(){',
        '  var r=P(await Reviewer.loadAll());',
        '  if(!r.success){toast(r.message||"加载失败");return;}',
        '  S.config=r.config;S.chats=r.chats||[];S.cards=r.cards||[];S.presets=r.presets||[];S.history=r.history||[];S.status=r.status||null;',
        '  document.getElementById("enabled").checked=!!S.config.enabled;',
        '  document.getElementById("mode").value=S.config.mode||"queue";',
        '  document.getElementById("contextCount").value=(S.config.contextCount===undefined?5:S.config.contextCount);',
        '  document.getElementById("hideUserMsg").checked=S.config.hideUserMsg!==false;',
        '  document.getElementById("requirement").value=S.config.requirement||"";',
        '  fillSelects();renderStatus();renderHist();',
        '}',
        'function collect(){',
        '  return {',
        '    enabled:document.getElementById("enabled").checked,',
        '    reviewedChatId:document.getElementById("reviewedChat").value,',
        '    reviewerChatId:document.getElementById("reviewerChat").value,',
        '    reviewedCardId:document.getElementById("reviewedCard").value,',
        '    reviewerCardId:document.getElementById("reviewerCard").value,',
        '    requirement:document.getElementById("requirement").value,',
        '    mode:document.getElementById("mode").value,',
        '    contextCount:parseInt(document.getElementById("contextCount").value||"5",10),',
        '    hideUserMsg:document.getElementById("hideUserMsg").checked',
        '  };',
        '}',
        'function nameOf(arr,id,key){var f=arr.filter(function(x){return x.id===id;})[0];return f?(f[key||"title"]||f.name||""):"";}',
        'async function saveAll(){',
        '  var p=collect();',
        '  p.reviewedChatName=nameOf(S.chats,p.reviewedChatId,"title");',
        '  p.reviewerChatName=nameOf(S.chats,p.reviewerChatId,"title");',
        '  p.reviewedCardName=nameOf(S.cards,p.reviewedCardId,"name");',
        '  p.reviewerCardName=nameOf(S.cards,p.reviewerCardId,"name");',
        '  var r=P(await Reviewer.saveConfig(JSON.stringify(p)));',
        '  if(r.success){S.config=r.config;toast("已保存");await refresh();}else{toast(r.message||"保存失败");}',
        '}',
        'async function refresh(){var r=P(await Reviewer.refreshStatus());if(r.success){S.status=r.status;renderStatus();}}',
        'async function resetWm(){var r=P(await Reviewer.resetWatermark());if(r.success){S.config=r.config;toast("水位线已重置");}else{toast(r.message||"失败");}}',
        'async function doPreview(){',
        '  var r=P(await Reviewer.previewPrompt());',
        '  if(!r.success){toast(r.message||"生成失败");return;}',
        '  document.getElementById("prevText").textContent=r.text||"（空）";',
        '  document.getElementById("prevCount").textContent=(r.count||0)+" 条";',
        '}',
        'async function doRun(){',
        '  toast("审查中…");',
        '  var r=P(await Reviewer.runReviewNow());',
        '  toast(r.message||(r.success?"完成":"失败"));',
        '  await loadAll();',
        '}',
        'async function createCard(){',
        '  var n=document.getElementById("newCardName").value.trim();',
        '  if(!n){toast("请填角色卡名称");return;}',
        '  var r=P(await Reviewer.createCard(n,"由聊天审查插件创建"));',
        '  if(r.success){toast("已创建："+r.name);document.getElementById("newCardName").value="";await loadAll();}else{toast(r.message||"创建失败");}',
        '}',
        'async function delHist(id){var r=P(await Reviewer.deleteHistory(id));if(r.success){S.history=r.history;renderHist();}}',
        'async function doClearHist(){var r=P(await Reviewer.clearHistory());if(r.success){S.history=r.history;renderHist();toast("已清空");}}',
        'loadAll();',
        'setInterval(refresh,5000);',
        '</script>',
        '</body>',
        '</html>'
    ].join("");
}

/* ------------------------------------------------------------------ */
/* Screen                                                              */
/* ------------------------------------------------------------------ */

function Screen(ctx) {
    var controller = ctx.createWebViewController("chat_reviewer_panel_webview");
    controller.addJavascriptInterface("Reviewer", buildBridge());

    return ctx.UI.WebView({
        html: buildPanelHtml(),
        baseUrl: "about:blank",
        javaScriptEnabled: true,
        domStorageEnabled: true,
        controller: controller
    });
}

exports.default = Screen;