# Talk — AI 聊天软件项目记忆

## 项目定位
React 核心的仿微信风格 AI 对话应用。用户"添加联系人"（通过问卷让对方自动生成人设+名字，一次性确认，之后不能再改人设），
与 DeepSeek 模型进行拟人化聊天，并随聊天积累记忆和关系。目标：安卓适配良好、PC 浏览器可直接调试、后续可选打包为原生 APK。

## 技术栈与关键决策
- **构建**: Vite + React + TypeScript。`vite.config.ts` 设置 `server.host: true`，方便手机在同一局域网通过 `http://<PC局域网IP>:5173` 直接访问调试。
- **样式**: Tailwind CSS v4（`@tailwindcss/vite` 插件，无需 tailwind.config.js，通过 `src/index.css` 里 `@import 'tailwindcss'` 引入）。整体白色简约风格。头像统一用圆角矩形（`Avatar` 组件默认 `rounded="lg"`）。
- **路由**: `react-router-dom`，使用 `HashRouter`（而非 BrowserRouter）—— 是为了以后 Capacitor 原生打包时用 `file://` 协议加载也不会有路由 404 问题。
- **状态管理**: Zustand，`useSettingsStore` 持久化到 localStorage（API Key、模型、说话风格提示词、用户昵称头像）。
- **本地数据库**: Dexie（IndexedDB 封装），`src/db/db.ts`。表：`contacts`（人设+记忆+关系字段）、`conversations`（会话，pinned+updatedAt 用于排序置顶）、`messages`（聊天记录）、`stickers`（表情包，name 唯一索引）。
- **安卓策略**: 当前只做响应式 Web（`.app-shell` 在 PC 端居中显示手机宽度的卡片，移动端全屏铺满）。Capacitor 依赖与 `capacitor.config.ts` 已装好占位。**用户本地已装好 Android Studio，路径 `C:\Projects\AndroidStudio`**——但用户表示打包 APK 不着急，先把功能做完，需要打包时再执行 `npx cap add android` 等步骤。
- **API Key 处理**: DeepSeek key 写在根目录 `.env`（`VITE_DEEPSEEK_API_KEY`），`.env` 已加入 `.gitignore`，不会被提交。`.env.example` 保留占位供参考。
- **独立路由页面的高度陷阱（踩过坑，别再犯）**：不在 `TabLayout` 里的整页路由（`ChatPage`、`ContactAddPage` 等，需要内容区滚动+底部按钮/输入框固定）**不能用 `min-h-full`**。`.app-shell` 只有 `min-height`，不是 `height`，导致子元素的百分比高度解析不确定，`flex-1` 拿不到真实剩余空间，底部固定栏会紧跟在内容后面而不是贴在可视区域底部——这正是用户反馈"输入框没有在最下面"的根因。正确写法：根容器用 `h-dvh flex flex-col overflow-hidden`，中间滚动区用 `flex-1 overflow-y-auto`，底部栏保持普通flow（不需要sticky也会自然贴底）。已修好 `ChatPage`/`ContactAddPage`；以后新增类似整页路由要照抄这个模式。

## 系统提示词分层（三层，不要合并）
`src/lib/prompt.ts`：
1. **`DEFAULT_STYLE_PROMPT`**——纯"说话方式"规则，是 `settings.globalSystemPrompt` 默认值，**用户可在设置页编辑**。
2. **`FIXED_PROTOCOL_PROMPT`**（模块内 const，未export）——JSON输出格式/分句/表情包与小程序占位符说明。**固定、不给用户看、不可编辑**——用户明确要求，改坏了JSON协议就解析不出来。
3. **人物设定 `persona`** + **记忆** + **关系维度**——每个联系人各自的部分，`persona` 现在也是完全不给用户看的（见下面"人设隐藏"）。

`buildSystemPrompt()` 拼接顺序：`stylePrompt + 固定协议 + 人物设定 + 记忆`。

## 添加联系人流程（问卷式，v2：生成后直接创建，无二次确认）
用户明确要求：名字必须TA自己起，交互要像"添加联系人"而不是"配置AI"，**创建后不允许用户再修改人设**，页面文案不能出现"AI"字眼。
- `ContactAddPage`（路由 `/contact/new`）：先选头像（`AvatarPicker`），性格标签多选 + **支持自定义输入一个标签** + **"🎲 随机词条"按钮**（`lib/randomTraits.ts` 里挑一个不重复的随机人设小彩蛋加进标签，增加随机性）、年龄段/性别/关系定位单选chip、补充说明文本框。
- 点"确认添加"→ `buildPersonaGenerationPrompt()` 一次性调用 DeepSeek 生成 `{name, persona}`（`parsePersonaGeneration` 解析）→ **直接** `db.contacts.add()` + `db.conversations.add()`（不再有确认/修改页）→ `navigate('/contacts')`（回联系人列表，不是名片页也不是创建页——这是用户明确要求的落点）。
- **`ContactEditPage` 已删除**，`/contact/new/confirm` 和 `/contact/:id/edit` 路由都不存在了。创建后 `name` 和 `systemPrompt`（人设）**完全不可再改、也不再展示给用户**（`ContactCardPage` 已移除"人物设定"展示区块）——"真人本来就不会给你看性格设定说明书"。唯一能后续改的是**头像**（在 `ContactCardPage` 直接点头像弹 `AvatarPicker`）和**备注**。

## 好友备注
`Contact.remark`（可选）。`src/lib/contact.ts` 的 `displayName(contact)` = `remark || name`，全应用统一用这个函数显示名字，新加显示联系人名字的地方也要用它而不是 `contact.name`。聊天气泡里：对方消息头像正上方显示 `displayName`（`MessageBubble` 新增 `contactName` prop），用户自己的消息不显示名字。

## AI记忆功能（`src/lib/memory.ts`）
两个独立轴，只影响语气不改人设：
- **`memoryFacts`**：客观事实摘要，≤200字。
- **`memoryStyle`**：相处状态/语气怎么调整，≤150字。

**省token的两个机制**：`CONTEXT_WINDOW_SIZE=30`（主聊天只发最近30条原文，更早的靠摘要代替）；`MEMORY_UPDATE_INTERVAL=10`（攒够10条新消息才触发一次整理，而不是每条都调用）。

触发时机：`ChatPage.tsx` 的 `revealBubbles()` 最后一个气泡落库后 fire-and-forget 调用 `maybeUpdateMemory`，不阻塞UI，失败静默。`ContactCardPage` 可查看/清空记忆（`resetMemory`，不影响关系分数）。

## 关系网功能（新增，`src/lib/relationship.ts`）
用户要求："像MBTI一样"用几个维度的数值判断AI与用户（以及未来AI与AI）的关系该怎么变。设计：
- 5个维度，0-100分：`familiarity熟悉度` `affection好感度` `trust信任度` `romance暧昧度` `friction摩擦感`。存在 `Contact.relationship`。
- **和记忆更新合并成同一次API调用**（`buildMemoryUpdatePrompt` 同时要求输出 `relationshipDelta`，每个维度给 -10~10 的**变化量**而不是绝对值，见 `parseMemoryResponse`）——两者读的是同一批新消息，拆成两次调用纯属浪费token，所以刻意合并。
- `applyRelationshipDelta` 增量式更新并clamp到0-100。`relationshipStageLabel(rel)` 把5个数值归纳成一个短标签（"热恋""挚友""关系紧张""刚认识"等），类似MBTI把多个轴归纳成一个类型码。
- 创建联系人时 `initialRelationshipFor(relationshipTag)` 会根据问卷里选的"关系定位"给一个有偏向的初始值（选"恋人"初始romance/affection更高等）。
- UI：`ContactCardPage` 新增"关系"区块（5条进度条+阶段标签）；新页面 `RelationshipsPage`（路由 `/relationships`，入口在 `DiscoverPage` 的"关系网"卡片）横向列出所有联系人的关系概览，按好感度排序。
- **AI与AI的关系目前没有数据来源**：现在没有群聊/多AI互动功能，两个AI角色之间不会产生任何交互，所以"AI与AI关系"这部分只是在设计上预留了可能性（`RelationshipDimensions`类型本身不绑定谁是谁，理论上可以扩展成任意两个参与者之间的关系），但没有实际功能触发它。等以后做群聊/多AI互动时，需要重新设计一个独立的"关系对"表（而不是像现在这样直接挂在 `Contact` 上，因为 `Contact` 上的 `relationship` 隐含"对用户的关系"这个单一语义），到时候再扩展，现在不要为此过度设计。

## AI输出JSON协议 / 空回复bug修复记录
- `src/lib/aiProtocol.ts` 的 `parseAiResponse` **曾经有bug**：解析失败或返回内容为空时会 fallback 成 `[{type:'text', content: raw.trim()}]`，如果 `raw` 本身是空字符串/纯空白（比如API偶尔返回空completion），就会生成一个内容为空字符串的气泡，表现为聊天里出现一个空白气泡——这就是用户反馈的"空回复"。**已修复**：现在解析失败/无有效气泡时统一返回 `[]`，不再有任何 fallback 塞入原始文本或空内容。`ChatPage.runAiTurn` 里如果拿到空数组，会走 `setError('对方这次没有正常回复 可以再发一条试试')` 显式提示，不会再静默出现空气泡或什么都不显示。以后如果再出现"空回复"类反馈，先检查是不是这个链路又有新的fallback漏洞。
- 气泡类型：`text`、`sticker`（引用表情包名字）、`link`（占位符 shop/map/todo，点击弹"开发中"提示）。
- 分句发送+打字延迟：`typingDelayMs()` 按长度算延迟，`revealBubbles()` 用多个 `setTimeout` 依次落库。
- 用户插话打断：`streamRef`+`timersRef`+`abortRef`，新消息一发就换新streamId、清旧定时器、abort旧请求。

## 目录结构速查
- `src/pages/`：MessagesPage / ContactsPage / ContactAddPage(问卷+直接创建) / ContactCardPage(名片：备注/关系/记忆展示+头像更换，无人设展示无编辑入口) / ChatPage / DiscoverPage(含"关系网"入口) / RelationshipsPage(关系总览) / MePage / SettingsPage / StickersPage。
- `src/components/`：TopBar / BottomNav / SearchOverlay / MessageBubble(assistant消息头像上方显示名字) / ActionSheet / Avatar(圆角矩形) / AvatarPicker / ImageCropper。
- `src/lib/`：deepseek.ts / aiProtocol.ts(解析+防空回复) / prompt.ts(三层提示词+人设生成) / memory.ts(记忆+关系增量，合并一次API调用) / relationship.ts(五维度/初始值/归纳标签) / randomTraits.ts(随机词条池) / contact.ts(displayName) / search.ts / time.ts / colors.ts / avatarEmojis.ts。

## 尚未实现 / 后续计划
- 发现页的小程序系统（虚拟网购/地图/TODO）仍是占位。
- 群聊 / AI与AI互动未实现——这也是关系网里"AI与AI关系"暂时没法真正使用的原因。
- Capacitor Android 原生打包：本地已有 Android Studio（`C:\Projects\AndroidStudio`），用户说不着急。
- `CONTEXT_WINDOW_SIZE`/`MEMORY_UPDATE_INTERVAL` 仍是代码常量，没有设置页UI。

## 开发命令
- `npm run dev` — 启动开发服务器（host: true，可用局域网 IP 在手机浏览器访问）
- `npm run build` — `tsc -b && vite build`
- `npm run lint` — oxlint
