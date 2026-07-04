# Talk — AI 聊天软件项目记忆

## 项目定位
React 核心的仿微信风格 AI 对话应用。用户创建"AI联系人"（自定义人设+系统提示词），
与 DeepSeek 模型进行拟人化聊天。目标：安卓适配良好、PC 浏览器可直接调试、后续可选打包为原生 APK。

## 技术栈与关键决策
- **构建**: Vite + React + TypeScript。`vite.config.ts` 设置 `server.host: true`，方便手机在同一局域网通过 `http://<PC局域网IP>:5173` 直接访问调试。
- **样式**: Tailwind CSS v4（`@tailwindcss/vite` 插件，无需 tailwind.config.js，通过 `src/index.css` 里 `@import 'tailwindcss'` 引入）。整体白色简约风格。
- **路由**: `react-router-dom`，使用 `HashRouter`（而非 BrowserRouter）—— 是为了以后 Capacitor 原生打包时用 `file://` 协议加载也不会有路由 404 问题。
- **状态管理**: Zustand，`useSettingsStore` 持久化到 localStorage（API Key、模型、统一系统提示词、用户昵称头像）。
- **本地数据库**: Dexie（IndexedDB 封装），`src/db/db.ts`。表：`contacts`（AI人设）、`conversations`（会话，pinned+updatedAt 用于排序置顶）、`messages`（聊天记录）、`stickers`（表情包，name 唯一索引）。
- **安卓策略（已与用户确认）**: 当前只做响应式 Web（`.app-shell` 在 PC 端居中显示手机宽度的卡片，移动端全屏铺满）。Capacitor 依赖与 `capacitor.config.ts` 已装好占位，但**尚未** `npx cap add android` / 构建 APK —— 因为这台机器上装 Android Studio + SDK 体积大且需要图形界面，不适合在这个自动化命令行环境里做。等用户本地装好 Android Studio 后再执行 Capacitor 打包步骤。
- **API Key 处理（已与用户确认）**: DeepSeek key 写在根目录 `.env`（`VITE_DEEPSEEK_API_KEY`），`.env` 已加入 `.gitignore`，不会被提交。`.env.example` 保留占位供参考。运行时通过 `import.meta.env` 读取作为默认值，用户可在"我-设置"页面里覆盖，覆盖值存 localStorage（zustand persist）。

## 核心数据流 / AI 协议
- 每个 AI 联系人 = 一个 `Contact` + 一个 `Conversation`（1:1，暂不支持群聊，用户需求里群聊留到以后）。
- 发送给模型的 system prompt = `buildSystemPrompt()`（`src/lib/prompt.ts`）：全局提示词模板（设置页可编辑，`{{STICKERS}}` `{{LINKS}}` `{{PERSONA}}` 三个占位符会被替换）+ 每个联系人自己的人设文本。
- 全局模板核心规则：禁止用括号描述动作/心理，标点符号用空格代替（保留 ! ?），必须输出**纯 JSON**（`{"messages": [...]}`），每条 messages 数组元素是一个独立发送的"气泡"。
- AI 输出的 JSON 由 `src/lib/aiProtocol.ts` 的 `parseAiResponse` 解析（容错：会剥离 ```json 代码块包裹，解析失败则整体当纯文本兜底）。
- 气泡类型：`text`（普通文字）、`sticker`（引用表情包名字，需在 `stickers` 表里存在）、`link`（应用内小程序卡片，`app` 字段目前只是占位符 shop/map/todo，具体小程序功能未实现，点击只弹提示"开发中"）。
- **逐条发送 + 打字延迟**: `typingDelayMs()` 按气泡文字长度算延迟（越长延迟越久，模拟真人打字），`ChatPage.tsx` 里 `revealBubbles()` 用多个 `setTimeout` 依次把气泡写入数据库。
- **用户插话打断**: `ChatPage.tsx` 用 `streamRef`（当前活跃的对话轮次 id）+ `timersRef`（待触发的气泡定时器）+ `abortRef`（fetch 的 AbortController）。用户一旦发新消息，会立刻生成新的 streamId、清掉旧定时器、abort 掉旧请求，之前"还没显示出来"的气泡就直接被丢弃，不会插入数据库 —— 这是打断机制的核心，不需要额外删除逻辑。

## 目录结构速查
- `src/pages/`：MessagesPage(消息列表) / ContactsPage(联系人列表) / ContactCardPage(联系人名片) / ContactEditPage(新建/编辑AI人设) / ChatPage(聊天界面) / DiscoverPage(发现，占位) / MePage(我) / SettingsPage(API+全局提示词设置) / StickersPage(表情包管理)。
- `src/components/`：TopBar(顶部居中标题+右侧搜索)、BottomNav(底部四tab)、SearchOverlay(全局搜索，联系人+聊天记录两栏高亮)、MessageBubble、ActionSheet(长按操作菜单，用于置顶/删除)、Avatar。
- `src/lib/`：deepseek.ts(API调用：listModels/testConnection/chatCompletion) / aiProtocol.ts(JSON解析+打字延迟) / prompt.ts(系统提示词模板与拼装) / search.ts(高亮/摘要工具) / time.ts(消息时间格式化) / colors.ts(头像随机配色)。

## 尚未实现 / 后续计划
- 发现页的小程序系统（虚拟网购/地图/TODO）目前只是占位，用户说"剩下的部分以后再说"。
- 群聊功能未实现（数据模型预留了扩展空间，但当前 UI 只支持 1:1）。
- Capacitor Android 原生打包（`npx cap add android` 等）需要用户本地有 Android Studio/SDK 后再执行。
- 用户头像/昵称目前用 emoji，没做真实图片上传（表情包已支持图片上传，用户头像可以后续对齐同样做法）。

## 开发命令
- `npm run dev` — 启动开发服务器（host: true，可用局域网 IP 在手机浏览器访问）
- `npm run build` — `tsc -b && vite build`
- `npm run lint` — oxlint
