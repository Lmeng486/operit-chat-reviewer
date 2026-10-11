# chat_reviewer · 聊天审查

> 一个 Operit ToolPkg：把**一个窗口（被审查者）**绑定到**另一个窗口（审查者）**。
> 被审查者 AI 输出结束后，自动触发审查者窗口按其**自己的角色卡**与你的**审查要求**产出一份审查意见。

作者：Lmeng486 · ToolPkg ID：`com.operit.chat_reviewer` · 版本：0.1.0

---

## 它解决什么问题

多角色 / 多窗口的玩法里，你常常希望「A 写，B 挑刺」：
让某个角色的输出被另一个角色实时盯着，发现逻辑漏洞、事实错误、崩人设的地方。

原生 Operit 没有这种「跨窗口联动」能力，本插件用 ToolPkg 的 **ChatMessage Hook** 补上这一环。

## 特性

- **自动触发**：被审查窗口每完成一轮 AI 输出，自动把新增内容送进审查窗口。
- **角色卡隔离**：审查者用自己的角色卡与人格输出，不会串味到被审查者。
- **严格单向**：Hook 只对「被审查窗口」的 AI 消息响应，审查者窗口天然不在白名单内 → **审查输出不可能再触发审查，不会死循环**。
- **两种忙策略**：审查者还在忙时，`queue`（只留最新一条）/ `skip`（直接丢弃）。
- **一轮只审一次**：防抖 + 状态二次确认 + 冷却，避免把半截话当成品审。
- **水位线机制**：以时间戳记录「审到哪了」，重装/重启不丢进度，可手动回退补审。
- **独立侧栏面板**：绑定窗口 / 角色卡 / 审查要求 / 提示词预览 / 历史记录，全程可视化。
- **AI 可调用**：附带子包工具，AI 自己也能查配置、改配置、触发审查、读历史。

## 目录结构

```
chat_reviewer/
├── manifest.json                    # ToolPkg 清单（id / 版本 / 子包声明）
├── main.js                          # 入口：注册 Hook + 侧栏 UI + 导航入口
├── core.js                          # 核心逻辑（约 640 行）
├── packages/
│   └── chat_reviewer_tools.js       # 暴露给 AI 的 4 个工具
├── ui/
│   └── chat_reviewer_panel/
│       └── index.ui.js              # 侧栏面板（Compose DSL 外壳 + WebView 内嵌 HTML）
├── resources/                       # 额外资源（本包为空）
└── build.sh                         # 一键打包成 .toolpkg
```

## 安装

### 方式一：直接安装 `.toolpkg`

1. 从 [Releases](../../releases) 下载 `chat_reviewer.toolpkg`。
2. 在 Operit 中打开该文件导入，或放入设备后通过插件管理页安装。
3. 安装后在 **设置 → 插件** 中确认 `com.operit.chat_reviewer` 已出现。

### 方式二：源码打包

```bash
cd chat_reviewer
bash build.sh          # 产出 chat_reviewer.toolpkg
```

## 使用

1. 打开侧栏 **插件 → 聊天审查** 面板。
2. **配置页**：
   - 选择「被审查窗口」（例如 *梦可的守护日志*）
   - 选择「审查者窗口」（例如 *闲聊交流*）
   - 填写「审查要求」，或直接套用内置模板（通用审查 / 人设一致性 / 代码审查 / 写作润色）
   - 打开「启用自动审查」开关
3. 之后被审查窗口每完成一轮输出，审查者窗口就会自动产出意见。
4. **预览页** 可以先看拼好的提示词长什么样；**历史页** 能看到每次审查的原文摘要与结论摘要。

> 提示：切换「被审查窗口」会自动重置水位线（不追溯历史）。若想补审旧内容，可在面板里手动回退水位线，或用工具手动触发一次审查。

## 配置字段

| 字段 | 说明 |
| --- | --- |
| `enabled` | 是否开启自动审查 |
| `reviewedChatId` / `reviewedChatName` | 被审查窗口 |
| `reviewerChatId` / `reviewerChatName` | 审查者窗口 |
| `reviewedCardId` / `reviewerCardId` | 绑定角色卡（可空 = 用窗口默认） |
| `requirement` | 审查要求文本 |
| `mode` | 审查者忙时策略：`queue` / `skip` |
| `hideUserMsg` | 在审查窗口隐藏触发的提示词 |
| `contextCount` | 随审查附带的上下文条数 |
| `lastReviewedTimestamp` | 水位线（毫秒时间戳） |

运行时数据保存在 Operit 插件配置目录下：

```
<sdcard>/Download/Operit/plugins/com.operit.chat_reviewer/
├── config.json
├── history.json
└── debug.log
```

## 子包工具（供 AI 调用）

| 工具 | 作用 |
| --- | --- |
| `get_review_config` | 读取当前审查配置 |
| `set_review_config` | 修改配置（窗口可用标题或 ID） |
| `run_review_now` | 立即执行一次审查并写入历史 |
| `get_review_history` | 读取最近的审查历史 |

## 实现要点

- **Hook 只在声明期注册**：`registerToolPkg()` 内不调用 `readResource` / `wasm.call`。
- **UI screen 传字符串路径**：`registerUiRoute` 的 `screen` 必须可序列化，不能传函数。
- **超时保护**：宿主服务未就绪时部分 `Tools.*` 会永久挂起，所有关键调用都套了超时，避免锁死。
- **think 块剥离**：审查结论摘录前会剥离 `think` / `details` 推理块，保证历史里看到的是结论正文而非思考过程。

## License

MIT
