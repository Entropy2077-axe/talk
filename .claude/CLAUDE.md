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

## 关系网功能（`src/lib/relationship.ts`，v2：对用户完全隐藏数值，只在关系网页面展示）
用户明确要求：5个关系维度不给用户在联系人名片里看到，**只在"关系网"页面展示**。设计：
- 5个维度，0-100分：`familiarity熟悉度` `affection好感度` `trust信任度` `romance暧昧度` `friction摩擦感`。存在 `Contact.relationship`。每个维度现在还带了一句 `description` 用于关系网页面的说明。
- **和记忆更新合并成同一次API调用**（`buildMemoryUpdatePrompt` 同时要求输出 `relationshipDelta`，每个维度给 -10~10 的**变化量**而不是绝对值，见 `parseMemoryResponse`）——两者读的是同一批新消息，拆成两次调用纯属浪费token，所以刻意合并。
- `applyRelationshipDelta` 增量式更新并clamp到0-100。`relationshipStageLabel(rel)` 把5个数值归纳成一个短标签（"热恋""挚友""关系紧张""刚认识"等），类似MBTI把多个轴归纳成一个类型码。`dimensionQualifier(value)` 给数值一个模糊描述（"较高""中等"等）。
- 创建联系人时 `initialRelationshipFor(relationshipTag)` 会根据问卷里选的"关系定位"给一个有偏向的初始值。
- **UI 只有一处**：`RelationshipsPage`（路由 `/relationships`，入口在 `DiscoverPage`）——列表按好感度/熟悉度/暧昧度/摩擦感排序（tab切换），右上角info按钮展开5个维度的说明文字（因为这是唯一展示的地方，首次接触需要解释），点卡片展开显示数值+定性描述，可以跳转到联系人名片。**`ContactCardPage` 不再显示任何关系维度**，只留了一个"日程与约会"入口显示"现在可能在哪"这类位置信息（这个不算关系维度，是日程系统的一部分，用户没说要隐藏这个）。
- **AI与AI的关系目前没有数据来源**：没有群聊/多AI互动功能，两个AI角色不会产生交互。`RelationshipDimensions`类型本身不绑定谁是谁，理论上能扩展成任意两个参与者之间的关系，但没有触发路径。等以后做群聊时要重新设计成独立的"关系对"表而不是继续挂在 `Contact` 上，现在不要为此过度设计。

## 强制删除联系人的限制（重要，别再被问到时懵）
用户曾要求"强制删除所有联系人"处理一个坏数据的联系人。**我没有办法直接从命令行/文件系统清掉这份数据**——所有联系人、聊天记录都存在用户浏览器的 IndexedDB 里（`talk-db`），是浏览器沙箱内的存储，这个Bash/PowerShell环境访问不到用户正在跑的浏览器会话。已经在 `SettingsPage` 加了"危险操作 → 清空所有联系人与聊天记录"按钮（`handleWipeContacts`，清空 `contacts`/`conversations`/`messages`/`tasks` 四张表），**用户需要自己在跑起来的应用里点这个按钮**，或者手动在浏览器devtools console执行 `indexedDB.deleteDatabase('talk-db')` 并刷新页面。以后再遇到"帮我清空/删除xx数据"这种要求，同样要意识到数据在客户端本地，只能加功能让用户自己触发，不能假装我直接办到了。

## 个人资料（用户自己的），全屏页面 `ProfileEditPage`
用户要求编辑资料改成全屏（不要小弹窗），并加性别/生日等字段。`/profile/edit` 替代了原来 MePage 里的居中小modal。`AppSettings` 新增 `userGender` `userBirthday`("YYYY-MM-DD") `userBio` `userLocationId`。生日只用来算年龄（`lib/time.ts` 的 `ageFromBirthday`），没有做星座之类的花活，避免过度设计。这些资料会作为"【关于对方(用户)】"注入到发给模型的系统提示词里（见下面时间/资料注入）。

## 系统提示词里的实时上下文注入
`ChatPage.runAiTurn` 每次发请求都会**现算**（不是缓存）:
- `describeCurrentTime(now)`（`lib/time.ts`）—— "2026年7月4日 周六 22:31" 这种格式，让AI能感知时间做出合理反应（熬夜、饭点之类），对应 `buildSystemPrompt` 里的【当前时间】。
- `buildUserProfileText()`（内联在 ChatPage 里）—— 昵称/性别/年龄(从生日算)/简介/用户当前所在位置，拼成一行，对应【关于对方(用户)】。这是用户**声明**的静态资料，和AI自己"学到的" `memoryFacts`是两回事，两者都会出现在prompt里但语义不同。
- `buildScheduleContextText()`（`lib/schedule.ts`）—— 见下面日程系统，对应【你的日程情况】。

## 地图 / 地点系统（`src/lib/locations.ts` + `MapPage`）
用户的需求是"能不能不做真实地理坐标的地图"——采纳了简化方案：**没有做经纬度/像素坐标的真实地图**，而是做了一个地点卡片板（`MapPage`，路由`/map`，入口在发现页），视觉上用了柔和的径向渐变背景模拟"地图感"，但本质是一组地点卡片的网格。
- `Location { id, name, icon(emoji), isPreset }` 存在 Dexie `locations` 表。`PRESET_LOCATIONS`（家里/公司学校/咖啡厅/餐厅/电影院/公园/酒吧/健身房/图书馆/商场/海边/KTV）在App启动时 `ensurePresetLocations()` 播种一次（`App.tsx` 的 useEffect）。
- 用户可以在地图页新增自定义地点（emoji+名字），点地点卡片="传送"自己过去（`settings.userLocationId`）。首次启动会自动把用户位置设成"家里"。
- **AI角色的地点是自动生成的**：创建联系人时，人设生成的同一次API调用（见下面日程系统）会让模型给出地点名字（字符串），`resolveOrCreateLocation(name)` 按名字查找已有地点、找不到就自动创建一个自定义地点（图标默认📍）——所以AI很可能会发明一些预设列表之外的地名，这是有意为之的涌现效果，不是bug。**注意**：如果同一批日程里出现重复地名（比如"家里"出现两次），解析时是**顺序 await 而不是 Promise.all**处理的（`ContactAddPage.handleGenerate` 里用 for 循环+本地 Map 缓存），因为并行调用会导致 Dexie 的 `&name` 唯一索引冲突（两个并发请求都查到"不存在"然后都尝试 create）。以后如果哪里还要批量按名字解析/创建 location，记得抄这个顺序处理的写法，别用 Promise.all。

## 日程系统（`src/lib/schedule.ts` + `Contact.dailySchedule` + `tasks`表）
用户需求最复杂的一块，分两层：
1. **每日routine（`ScheduleBlock[]`，存在 `Contact.dailySchedule`）**：创建联系人时，**复用同一次persona生成API调用**（没有另开一次请求，省token）——`buildPersonaGenerationPrompt` 现在同时要求模型输出 `dailySchedule` 数组（3-6个时间段，dayType是`weekday`/`weekend`/`daily`三选一，配合 startTime/endTime/locationName/label），`parsePersonaGeneration` 解析，如果模型没给或格式不对就退回 `DEFAULT_GENERATED_SCHEDULE`（早9-18公司、18-23在家、周末在家、23-9睡觉的兜底模板），保证每个联系人一定有日程。
2. **一次性任务/约定（`ScheduleTask`，存 `tasks`表，会覆盖当天当时段的routine）**：比如用户例子"7月4号22点在酒吧"。两条创建路径：
   - 用户在 `ContactSchedulePage`（路由`/contact/:id/schedule`，入口在联系人名片"日程与约会"）手动添加。
   - AI在对话里可以主动创建：AI输出协议新增了 `schedule_task` 气泡类型（见下面协议扩展），解析后自动 `db.tasks.add(..., source:'ai')`。
   `lib/schedule.ts` 的 `resolveExpectedLocation(schedule, tasks, date)` 是核心计算：先看有没有命中当前时间的task（**task优先级高于routine**），没有再退回daily schedule匹配（当天类型的block优先于'daily'兜底block）。`findScheduleBlock`/`findActiveTask` 都支持跨零点的时间段（比如23:00-07:00）。
   **"AI自己判断要不要切换地点"这个要求的实现方式**：我们不会用代码强制覆盖AI当前的位置——`resolveExpectedLocation`算出来的只是**建议**，通过 `buildScheduleContextText` 塞进prompt告诉AI"你现在通常应该在哪、你上次说的位置是哪、要不要提一下切换"，最终是否输出`location`气泡、什么时候输出，完全是模型自己决定的。`Contact.currentLocationId`只有在AI真的输出了`location`类型气泡时才会被代码更新（`ChatPage.revealBubbles`里处理），不会被日程计算静默覆盖。

## AI输出JSON协议（`src/lib/aiProtocol.ts` + `src/types/index.ts`）
气泡类型：`text`、`sticker`（引用表情包名字）、`link`（占位符 shop/map/todo，点击弹"开发中"提示）、`location`（`{locationId,label}`，AI宣布自己位置变化，处理时会更新`Contact.currentLocationId`）、`schedule_task`（`{date,startTime,endTime,locationId,label}`，AI主动约定一次性安排，处理时会写入`tasks`表，`source:'ai'`）。协议相关的输出格式说明全部在 `FIXED_PROTOCOL_PROMPT` 里（隐藏、不可编辑，见上面"系统提示词分层"）。

**空回复bug修复记录**：`parseAiResponse` 曾经在解析失败/返回内容为空时 fallback 成 `[{type:'text', content: raw.trim()}]`，如果 `raw` 本身是空/空白就会产生内容为空字符串的气泡——这是用户反馈"空回复"的根因。**已修复**：解析失败/无有效气泡统一返回 `[]`，`ChatPage.runAiTurn` 拿到空数组会走 `setError(...)` 显式提示，不会再静默出现空气泡。以后再有"空回复"类反馈，先查这条链路是不是又长出新的fallback漏洞。

分句发送+打字延迟：`typingDelayMs()` 按长度算延迟，`revealBubbles()` 用多个 `setTimeout` 依次落库。用户插话打断：`streamRef`+`timersRef`+`abortRef`，新消息一发就换新streamId、清旧定时器、abort旧请求。

**"第二次及以后回复都不对/经常没有回复"—— 两轮排查记录，都用临时Node脚本直接打真实API验证过，不是猜的**

*第一轮排查*：发现每一轮AI回复在数据库里是拆成好几条独立的 `role:'assistant'` 消息（分句气泡）存的，历史记录1:1映射会导致连续好几条`assistant`角色消息、中间没有穿插`user`消息，破坏user/assistant交替结构。加了 `coalesceConsecutiveRoles()`（`src/lib/deepseek.ts`）合并连续同角色消息。**这个问题确实存在也确实修了，但后来发现它不是"经常没有回复"的主因**——即使修好交替结构，问题依然频繁出现，所以继续排查。

*第二轮排查（真正的根因）*：写了个临时脚本（不在仓库里，跑在系统临时目录）直接打 `https://api.deepseek.com/v1/chat/completions`，完整复现我们的system prompt结构，跑了好几组多轮对话做对照实验，结果非常一致：
- **第1轮**：无论加不加 `response_format:{type:"json_object"}`，模型都规规矩矩输出合法JSON。
- **第2轮及以后，只要开着 `response_format:json_object`**：`finish_reason` 是正常的 `"stop"`，`completion_tokens` 也不是0（比如16、37、28），但 `content` 解码出来是**纯空格字符串**——模型在花token但只吐空白，这是本地代码逻辑之外的、DeepSeek这个json_object约束解码器在"复杂系统提示词+已有assistant历史"组合下的实际服务端行为（对照实验里关掉`response_format`、只靠prompt里的文字说明来要求JSON，同样的历史结构下模型完全不会出现空白，只是偶尔会不严格遵守JSON格式改成纯文本回复）。
- 这才是真正的"经常没有回复"根因——`response_format:json_object` 用在**带着assistant历史的多轮请求**上会触发这个空白bug，而我们的主聊天请求恰好每次都带着历史。

**修复（已用真实API反复验证，10轮对话0次空回复）**：
1. `chatCompletion()`（`src/lib/deepseek.ts`）新增可选参数 `jsonMode`，只有显式传 `true` 才带 `response_format:json_object`，默认不带。**主聊天请求（`ChatPage.runAiTurn`）不传这个参数**——这是关键。人设生成（`ContactAddPage`）和记忆整理（`lib/memory.ts`）这两个调用**永远是单轮请求（system+user两条消息，不会累积assistant历史）**，不受这个bug影响，所以保留 `jsonMode:true` 换取更稳的JSON。
2. `buildSystemPrompt()` 里把 `FIXED_PROTOCOL_PROMPT`（JSON格式说明）挪到拼接顺序的**最后**（离生成位置最近），实测对"模型愿不愿意乖乖按JSON格式回复"有正面帮助（但不是100%保证——不开json_object模式下模型偶尔还是会从第2轮开始不遵守JSON、改用纯文本自然聊天，这是可接受的降级）。
3. `parseAiResponse()`（`src/lib/aiProtocol.ts`）重构：先尝试当成JSON解析（`tryParseJson`），失败或结果为空时，**不再直接返回`[]`丢弃这条回复**，而是把原始文本按换行切分、每个非空行当成一个独立的text气泡兜底显示（`sticker`/`link`/`location`/`schedule_task`这些高级类型只有模型真正输出合法JSON时才会出现，纯文本兜底模式下就是普通文字气泡，这是能接受的功能降级）。只有原始回复本身是空/空白时才真正返回`[]`（这种情况在去掉json_object模式后已经基本不会再出现）。

**如果以后又有人反馈"经常没回复"**：先怀疑是不是哪里又不小心给主聊天请求加上了 `jsonMode:true`（比如复制粘贴代码时带过去），这是最容易复发的地方。不要一上来就怀疑prompt内容或网络问题。

## 目录结构速查
- `src/pages/`：MessagesPage / ContactsPage / ContactAddPage(问卷+直接创建，含头像+性格标签+随机词条) / ContactCardPage(名片：备注/日程入口/记忆展示+头像更换，无人设无关系维度展示) / ContactSchedulePage(日程routine+一次性约定，可手动添加) / ChatPage / DiscoverPage(地图+关系网入口) / RelationshipsPage(关系总览，唯一展示关系维度的地方) / MapPage(地点网格+切换/自定义) / MePage / ProfileEditPage(全屏个人资料) / SettingsPage(含清空数据危险操作) / StickersPage。
- `src/components/`：TopBar / BottomNav / SearchOverlay / MessageBubble(assistant消息头像上方显示名字，含location/schedule_task渲染) / ActionSheet / Avatar(圆角矩形) / AvatarPicker / ImageCropper。
- `src/lib/`：deepseek.ts / aiProtocol.ts(解析+防空回复+location/schedule_task) / prompt.ts(三层提示词+人设与日程生成) / memory.ts(记忆+关系增量，合并一次API调用) / relationship.ts(五维度/初始值/归纳标签，UI只在RelationshipsPage用) / schedule.ts(日程解析/当前位置推断/日程文案) / locations.ts(预设地点种子+按名字解析或创建) / randomTraits.ts(随机词条池) / contact.ts(displayName) / search.ts / time.ts(含当前时间描述+年龄计算) / colors.ts / avatarEmojis.ts。

## 尚未实现 / 后续计划
- 发现页的小程序系统里只有"地图"和"关系网"是真的，虚拟网购/TODO仍是占位。
- 群聊 / AI与AI互动未实现——这也是关系网里"AI与AI关系"、地图里"多个AI互相协调日程"暂时没法真正使用的原因。
- 地图是"地点卡片板"不是真实经纬度地图，这是和用户对齐过的简化方案，不是缺陷。
- 一次性任务(`ScheduleTask`)目前没有做重叠检测/合并——如果用户和AI各自约了同一时间段不同地点，后创建的那条会在`resolveExpectedLocation`里生效（数组`find`顺序），没有冲突提示，量不大暂时够用。
- Capacitor Android 原生打包：本地已有 Android Studio（`C:\Projects\AndroidStudio`），用户说不着急。
- `CONTEXT_WINDOW_SIZE`/`MEMORY_UPDATE_INTERVAL` 仍是代码常量，没有设置页UI。

## 开发命令
- `npm run dev` — 启动开发服务器（host: true，可用局域网 IP 在手机浏览器访问）
- `npm run build` — `tsc -b && vite build`
- `npm run lint` — oxlint
