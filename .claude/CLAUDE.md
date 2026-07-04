# Talk — AI 聊天软件项目记忆

## 项目定位
React 核心的仿微信风格 AI 对话应用。用户"添加联系人"（通过问卷让AI自动生成人设+名字），
与 DeepSeek 模型进行拟人化聊天，并随聊天积累对用户的记忆。目标：安卓适配良好、PC 浏览器可直接调试、后续可选打包为原生 APK。

## 技术栈与关键决策
- **构建**: Vite + React + TypeScript。`vite.config.ts` 设置 `server.host: true`，方便手机在同一局域网通过 `http://<PC局域网IP>:5173` 直接访问调试。
- **样式**: Tailwind CSS v4（`@tailwindcss/vite` 插件，无需 tailwind.config.js，通过 `src/index.css` 里 `@import 'tailwindcss'` 引入）。整体白色简约风格。头像统一用圆角矩形（`Avatar` 组件默认 `rounded="lg"`）。
- **路由**: `react-router-dom`，使用 `HashRouter`（而非 BrowserRouter）—— 是为了以后 Capacitor 原生打包时用 `file://` 协议加载也不会有路由 404 问题。
- **状态管理**: Zustand，`useSettingsStore` 持久化到 localStorage（API Key、模型、说话风格提示词、用户昵称头像）。
- **本地数据库**: Dexie（IndexedDB 封装），`src/db/db.ts`。表：`contacts`（AI人设+记忆字段）、`conversations`（会话，pinned+updatedAt 用于排序置顶）、`messages`（聊天记录）、`stickers`（表情包，name 唯一索引）。
- **安卓策略**: 当前只做响应式 Web（`.app-shell` 在 PC 端居中显示手机宽度的卡片，移动端全屏铺满）。Capacitor 依赖与 `capacitor.config.ts` 已装好占位。**用户本地已装好 Android Studio，路径 `C:\Projects\AndroidStudio`**——但用户表示打包 APK 不着急，先把功能做完，需要打包时再执行 `npx cap add android` 等步骤（届时可以指定该 Android Studio/SDK 路径）。
- **API Key 处理**: DeepSeek key 写在根目录 `.env`（`VITE_DEEPSEEK_API_KEY`），`.env` 已加入 `.gitignore`，不会被提交。`.env.example` 保留占位供参考。运行时通过 `import.meta.env` 读取作为默认值，用户可在"我-设置"页面里覆盖，覆盖值存 localStorage（zustand persist）。

## 系统提示词分层（重要，改动过一次）
`src/lib/prompt.ts` 里明确拆成三层，不要再合并：
1. **`DEFAULT_STYLE_PROMPT`**——纯"说话方式"规则（禁止括号、标点用空格、别打官方腔等），是 `settings.globalSystemPrompt` 的默认值，**用户可在设置页查看和编辑**。
2. **`FIXED_PROTOCOL_PROMPT`**（模块内 const，未 export）——JSON 输出格式/分句发送/表情包与小程序占位符说明。这部分是**固定的、不给用户看、也不可编辑**——这是用户明确要求的，因为它一旦被用户改坏 JSON 协议就解析不出来了。设置页的文案已经改为不再提及 `{{STICKERS}}` 等占位符。
3. **人物设定 `persona`** + **记忆 `memoryFacts`/`memoryStyle`**——每个联系人各自的部分。

`buildSystemPrompt()` 把这四块拼起来：`stylePrompt + 固定协议(含表情包/小程序替换) + 人物设定 + 记忆`。如果以后还要加新的全局规则，先想清楚它该进第1层（用户可编辑的语气规则）还是第2层（不可变的协议细节），不要混在一起。

## 添加联系人流程（已从"新建AI直接填名字"改为拟真问卷）
用户明确要求：不能自己指定AI的名字，要让AI自己起，且交互要像"添加一个联系人"而不是"配置一个AI"。流程：
1. `ContactAddPage`（路由 `/contact/new`）：问卷式选择——性格标签（多选）、年龄段、性别、关系定位（都是单选 chip）+ 补充说明文本框。
2. 点"生成联系人"→ `buildPersonaGenerationPrompt()` 组装一个一次性 meta-prompt，调用 `chatCompletion` 让模型输出 `{"name":..., "persona":...}`（`parsePersonaGeneration` 解析，带 ```json 围栏容错）。
3. 生成结果通过 `navigate('/contact/new/confirm', { state: {name, persona} })` 传给 `ContactEditPage`（复用同一个组件，靠有没有 `:contactId` 参数区分"确认新建"还是"编辑已有"）。确认页可以再调整名字/人设/头像，确认后才真正写入 `contacts` + `conversations` 表。
4. **名字锁定规则**：编辑*已有*联系人时，`name` 字段只读（不能改，因为那是"TA自己的名字"），想换称呼只能设置 `remark`（备注，在 `ContactCardPage` 里编辑）。只有"确认新建"阶段（还没保存）名字才可编辑。

## 好友备注
`Contact.remark`（可选字段）。`src/lib/contact.ts` 的 `displayName(contact)` = `remark || name`，全应用统一用这个函数显示名字（消息列表、联系人列表、聊天标题、搜索结果/高亮都已经切过来了，以后新加显示联系人名字的地方也要用这个而不是直接读 `contact.name`）。

## AI记忆功能设计（`src/lib/memory.ts`，花了心思设计，改动前先读这段）
目标：尽量不浪费 token、让 AI 在不改核心人设的前提下逐渐"适配"用户，模拟真实社交关系的熟悉过程。设计成两个独立轴：
- **`memoryFacts`**：关于用户的客观事实摘要（名字/职业/喜好/重要的事等），控制在约200字。
- **`memoryStyle`**：相处状态/语气怎么调整（"关系变熟了可以更随便""对方喜欢简短回复"之类），控制在约150字。这个字段就是"适配"的落地方式——只影响语气不影响人设。

**省 token 的两个机制**：
1. `CONTEXT_WINDOW_SIZE = 30`——主聊天请求只把最近 30 条消息原文发给模型，更早的上下文完全靠 `memoryFacts`/`memoryStyle` 摘要代替，不管聊天多长，主请求的 token 消耗都有上限。
2. `MEMORY_UPDATE_INTERVAL = 10`——不是每条消息都调用一次记忆整理，而是攒够 10 条新消息（`Contact.memoryMessageCursor` 记录已经处理到第几条）才触发一次单独的"记忆整理"API调用（`maybeUpdateMemory`，读旧记忆+这批新消息，输出更新后的 facts/style JSON，合并式更新而不是全量重算）。

触发时机：`ChatPage.tsx` 的 `revealBubbles()` 在最后一个气泡落库后，fire-and-forget 调用 `maybeUpdateMemory(contact.id, conversationId, settings)`（不 await，不阻塞 UI，失败也静默吞掉——记忆是增强功能，绝不能拖垮或搞崩聊天本身）。
用户可在 `ContactCardPage` 查看当前记忆内容，也有"清空记忆"按钮（`resetMemory`，把两个字段和 cursor 都清零）。

如果以后要调参数（比如觉得10条太频繁或30条上下文太短），改 `src/lib/memory.ts` 顶部两个常量即可，暂时没有对应的设置页 UI（有意保持简单，等用户反馈需要再加）。

## 核心数据流 / AI 输出协议
- 每个联系人 = 一个 `Contact` + 一个 `Conversation`（1:1，暂不支持群聊）。
- AI 输出的 JSON 由 `src/lib/aiProtocol.ts` 的 `parseAiResponse` 解析（容错：剥离```json围栏，解析失败则整体当纯文本兜底）。
- 气泡类型：`text`、`sticker`（引用表情包名字，需在 `stickers` 表里存在）、`link`（应用内小程序卡片，`app` 字段目前只是占位符 shop/map/todo，点击只弹提示"开发中"）。
- **逐条发送 + 打字延迟**：`typingDelayMs()` 按气泡文字长度算延迟，`ChatPage.tsx` 的 `revealBubbles()` 用多个 `setTimeout` 依次把气泡写入数据库。
- **用户插话打断**：`streamRef`（当前活跃对话轮次id）+ `timersRef`（待触发气泡定时器）+ `abortRef`（fetch的AbortController）。用户一发新消息就换新streamId、清掉旧定时器、abort旧请求，还没显示出来的气泡直接被丢弃、不会插入数据库——这是打断机制的核心。

## 目录结构速查
- `src/pages/`：MessagesPage / ContactsPage / ContactAddPage(添加联系人问卷) / ContactCardPage(名片，含备注编辑+记忆展示) / ContactEditPage(确认新建 或 编辑已有，靠路由区分) / ChatPage / DiscoverPage(占位) / MePage / SettingsPage / StickersPage。
- `src/components/`：TopBar / BottomNav / SearchOverlay / MessageBubble / ActionSheet / Avatar(圆角矩形) / AvatarPicker(emoji网格+图片导入入口) / ImageCropper(拖拽+缩放裁剪成正方形dataURL)。
- `src/lib/`：deepseek.ts / aiProtocol.ts / prompt.ts(三层提示词+人设生成) / memory.ts(记忆摘要+滑动窗口) / contact.ts(displayName) / search.ts / time.ts / colors.ts / avatarEmojis.ts。

## 尚未实现 / 后续计划
- 发现页的小程序系统（虚拟网购/地图/TODO）目前只是占位。
- 群聊功能未实现（数据模型预留了扩展空间，当前UI只支持1:1）。
- Capacitor Android 原生打包：用户本地已有 Android Studio（`C:\Projects\AndroidStudio`），但明确说不着急，等后面功能做得差不多了再一起弄。
- 记忆的 `CONTEXT_WINDOW_SIZE`/`MEMORY_UPDATE_INTERVAL` 目前是代码里的常量，没有暴露到设置页。

## 开发命令
- `npm run dev` — 启动开发服务器（host: true，可用局域网 IP 在手机浏览器访问）
- `npm run build` — `tsc -b && vite build`
- `npm run lint` — oxlint
