# Talk — AI 聊天软件项目记忆

## 项目定位
React 核心的仿微信风格 AI 对话应用。用户"添加联系人"（通过问卷让对方自动生成人设+名字，一次性确认，之后不能再改人设），
与 DeepSeek 模型进行拟人化聊天，并随聊天积累记忆和关系。内置待办/委托/货币/商城/仓库这套小游戏化系统（AI会发委托、给奖金，奖金能在AI生成的虚拟商城买东西送朋友）。目标：安卓适配良好、PC 浏览器可直接调试、后续可选打包为原生 APK。

## 技术栈与关键决策
- **构建**: Vite + React + TypeScript。`vite.config.ts` 设置 `server.host: true`，方便手机在同一局域网通过 `http://<PC局域网IP>:5173` 直接访问调试。
- **样式**: Tailwind CSS v4（`@tailwindcss/vite` 插件，无需 tailwind.config.js，通过 `src/index.css` 里 `@import 'tailwindcss'` 引入）。整体白色简约风格。头像统一用圆角矩形（`Avatar` 组件默认 `rounded="lg"`）。
- **路由**: `react-router-dom`，使用 `HashRouter`（而非 BrowserRouter）—— 是为了以后 Capacitor 原生打包时用 `file://` 协议加载也不会有路由 404 问题。
- **状态管理**: Zustand，`useSettingsStore` 持久化到 localStorage（API Key、模型、说话风格提示词、用户昵称头像等资料）。
- **本地数据库**: Dexie（IndexedDB 封装），`src/db/db.ts`。表：`contacts`（人设+记忆+关系字段）、`conversations`（会话，pinned+updatedAt 用于排序置顶）、`messages`（聊天记录）、`stickers`（表情包，name 唯一索引）。**`locations`/`tasks` 两张表在 version(2) 加过、又在 version(3) 里用 `null` 显式删除了**（Dexie删表的正确写法就是在新版本 `.stores()` 里把该表设为 `null`，不是直接不写它）——这是地图/日程功能被整体移除留下的痕迹，以后如果看到db.ts里version(3)那段null赋值不要奇怪。
- **安卓策略**: 当前只做响应式 Web（`.app-shell` 在 PC 端居中显示手机宽度的卡片，移动端全屏铺满）。Capacitor 依赖与 `capacitor.config.ts` 已装好占位。**用户本地已装好 Android Studio，路径 `C:\Projects\AndroidStudio`**——但用户表示打包 APK 不着急，先把功能做完，需要打包时再执行 `npx cap add android` 等步骤。
- **API Key 处理**: DeepSeek key 写在根目录 `.env`（`VITE_DEEPSEEK_API_KEY`），`.env` 已加入 `.gitignore`，不会被提交。`.env.example` 保留占位供参考。
- **独立路由页面的高度陷阱（踩过坑，别再犯）**：不在 `TabLayout` 里的整页路由（`ChatPage`、`ContactAddPage`、`ProfileEditPage` 等，需要内容区滚动+底部按钮/输入框固定）**不能用 `min-h-full`**。`.app-shell` 只有 `min-height`，不是 `height`，导致子元素的百分比高度解析不确定，`flex-1` 拿不到真实剩余空间，底部固定栏会紧跟在内容后面而不是贴在可视区域底部。正确写法：根容器用 `h-dvh flex flex-col overflow-hidden`，中间滚动区用 `flex-1 overflow-y-auto`，底部栏保持普通flow。以后新增类似整页路由要照抄这个模式。

## 系统提示词分层（三层，不要合并）
`src/lib/prompt.ts`：
1. **`DEFAULT_STYLE_PROMPT`**——纯"说话方式"规则，是 `settings.globalSystemPrompt` 默认值，**用户可在设置页编辑**。
2. **`FIXED_PROTOCOL_PROMPT`**（模块内 const，未export）——JSON输出格式/分句/表情包与小程序占位符说明。**固定、不给用户看、不可编辑**——用户明确要求，改坏了JSON协议就解析不出来。协议指令放在拼接顺序的**最后**（离生成位置最近），实测对模型遵守JSON格式有帮助。
3. **人物设定 `persona`** + **记忆** + **关系维度**——每个联系人各自的部分，`persona` 完全不给用户看（见下面"人设隐藏"）。

`buildSystemPrompt()` 拼接顺序：`stylePrompt + 人物设定 + 记忆 + 实时上下文(当前时间/用户资料) + 固定协议`。

## 添加联系人流程（问卷式，生成后直接创建，无二次确认）
用户明确要求：名字必须TA自己起，交互要像"添加联系人"而不是"配置AI"，**创建后不允许用户再修改人设**，页面文案不能出现"AI"字眼。
- `ContactAddPage`（路由 `/contact/new`）：先选头像（`AvatarPicker`），性格标签多选 + **支持自定义输入一个标签** + **"🎲 随机词条"按钮**（`lib/randomTraits.ts` 里挑一个不重复的随机人设小彩蛋加进标签，增加随机性）、年龄段/性别/关系定位单选chip、补充说明文本框。
- 点"确认添加"→ `buildPersonaGenerationPrompt()` 一次性调用 DeepSeek 生成 `{name, persona}`（`parsePersonaGeneration` 解析，`jsonMode:true`，因为这是单轮请求不受下面提到的json_object多轮bug影响）→ **直接** `db.contacts.add()` + `db.conversations.add()`（不再有确认/修改页）→ `navigate('/contacts')`（回联系人列表）。
- 创建后 `name` 和 `systemPrompt`（人设）**完全不可再改、也不再展示给用户**（`ContactCardPage` 没有"人物设定"展示区块）——"真人本来就不会给你看性格设定说明书"。唯一能后续改的是**头像**（在 `ContactCardPage` 直接点头像弹 `AvatarPicker`）和**备注**。

## 好友备注
`Contact.remark`（可选）。`src/lib/contact.ts` 的 `displayName(contact)` = `remark || name`，全应用统一用这个函数显示名字。聊天气泡里：对方消息头像正上方显示 `displayName`（`MessageBubble` 的 `contactName` prop），用户自己的消息不显示名字。

## AI记忆功能（`src/lib/memory.ts`）
两个独立轴，只影响语气不改人设：
- **`memoryFacts`**：客观事实摘要，≤200字。
- **`memoryStyle`**：相处状态/语气怎么调整，≤150字。

**省token的两个机制**：`CONTEXT_WINDOW_SIZE=30`（主聊天只发最近30条原文，更早的靠摘要代替）；`MEMORY_UPDATE_INTERVAL=10`（攒够10条新消息才触发一次整理，而不是每条都调用）。

触发时机：`ChatPage.tsx` 的 `revealBubbles()` 最后一个气泡落库后 fire-and-forget 调用 `maybeUpdateMemory`（`jsonMode:true`，单轮请求不受影响），不阻塞UI，失败静默。`ContactCardPage` 可查看/清空记忆（`resetMemory`，不影响关系分数）。

## 关系网功能（`src/lib/relationship.ts`，对用户完全隐藏数值，只在关系网页面展示）
用户明确要求：5个关系维度不给用户在联系人名片里看到，**只在"关系网"页面展示**。设计：
- 5个维度，0-100分：`familiarity熟悉度` `affection好感度` `trust信任度` `romance暧昧度` `friction摩擦感`。存在 `Contact.relationship`，每个维度带一句 `description` 用于关系网页面的说明。
- **和记忆更新合并成同一次API调用**（`buildMemoryUpdatePrompt` 同时要求输出 `relationshipDelta`，每个维度给 -10~10 的**变化量**而不是绝对值，见 `parseMemoryResponse`）——两者读的是同一批新消息，拆成两次调用纯属浪费token。
- `applyRelationshipDelta` 增量式更新并clamp到0-100。`relationshipStageLabel(rel)` 把5个数值归纳成一个短标签（"热恋""挚友""关系紧张""刚认识"等），类似MBTI把多个轴归纳成一个类型码。`dimensionQualifier(value)` 给数值一个模糊描述（"较高""中等"等）。
- 创建联系人时 `initialRelationshipFor(relationshipTag)` 会根据问卷里选的"关系定位"给一个有偏向的初始值。
- **UI 只有一处**：`RelationshipsPage`（路由 `/relationships`，入口在 `DiscoverPage`）——列表按好感度/熟悉度/暧昧度/摩擦感排序（tab切换），右上角info按钮展开5个维度的说明文字，点卡片展开显示数值+定性描述，可以跳转到联系人名片。`ContactCardPage` 不显示任何关系维度。
- **AI与AI的关系目前没有数据来源**：没有群聊/多AI互动功能，两个AI角色不会产生交互。`RelationshipDimensions`类型本身不绑定谁是谁，理论上能扩展成任意两个参与者之间的关系，但没有触发路径，等以后做群聊时再重新设计，现在不要为此过度设计。

## 强制删除联系人的限制（重要，别再被问到时懵）
用户曾要求"强制删除所有联系人"处理一个坏数据的联系人。**我没有办法直接从命令行/文件系统清掉这份数据**——所有联系人、聊天记录都存在用户浏览器的 IndexedDB 里（`talk-db`），这个Bash/PowerShell环境访问不到用户正在跑的浏览器会话。已经在 `SettingsPage` 加了"危险操作 → 清空所有联系人与聊天记录"按钮（`handleWipeContacts`，清空 `contacts`/`conversations`/`messages`），**用户需要自己在跑起来的应用里点这个按钮**，或者手动在浏览器devtools console执行 `indexedDB.deleteDatabase('talk-db')` 并刷新页面。以后再遇到"帮我清空/删除xx数据"这种要求，同样要意识到数据在客户端本地，只能加功能让用户自己触发，不能假装我直接办到了。

## 个人资料（用户自己的），全屏页面 `ProfileEditPage`
用户要求编辑资料改成全屏（不要小弹窗），并加性别/生日等字段。`/profile/edit` 替代了原来 MePage 里的居中小modal。`AppSettings` 有 `userGender` `userBirthday`("YYYY-MM-DD") `userBio`。生日只用来算年龄（`lib/time.ts` 的 `ageFromBirthday`），没有做星座之类的花活。这些资料会作为"【关于对方(用户)】"注入到发给模型的系统提示词里。

## 系统提示词里的实时上下文注入
`ChatPage.runAiTurn` 每次发请求都会**现算**（不是缓存）:
- `describeCurrentTime(now)`（`lib/time.ts`）—— "2026年7月4日 周六 22:31" 这种格式，让AI能感知时间做出合理反应，对应 `buildSystemPrompt` 里的【当前时间】。
- `buildUserProfileText()`（内联在 ChatPage 里）—— 昵称/性别/年龄(从生日算)/简介，拼成一行，对应【关于对方(用户)】。这是用户**声明**的静态资料，和AI自己"学到的" `memoryFacts` 是两回事，两者都会出现在prompt里但语义不同。

## 地图/日程/任务系统 —— 已整体移除，别再往这个方向排查
v1 曾做过一套完整的地图+日程+一次性任务系统（`lib/locations.ts`、`lib/schedule.ts`、`MapPage`、`ContactSchedulePage`、`Contact.dailySchedule`/`currentLocationId`、AI协议的`location`/`schedule_task`气泡类型），后来**用户明确反馈"感觉不是很有用"，要求全删**。已经彻底清干净：这些文件都删了，`types/index.ts`、`db.ts`（Dexie version(3)里把两张表设为null）、`aiProtocol.ts`、`prompt.ts`（`buildSystemPrompt`不再要地点/日程参数，人设生成prompt不再要dailySchedule）、`ChatPage`/`ContactCardPage`/`ContactAddPage`/`DiscoverPage`/`App.tsx` 里所有相关引用都清掉了。如果以后又想做"AI有自己的位置/日程"这类功能，等于是重新设计，不要指望能复用已删除的代码，也不要在没有明确需求的情况下再主动提议做这个方向的功能——已经被否决过一次。

## AI输出JSON协议（`src/lib/aiProtocol.ts` + `src/types/index.ts`）
气泡类型：`text`、`sticker`（引用表情包名字）、`link`（占位符 shop/todo，点击弹"开发中"提示，`map`这个占位app类型也随地图功能一起删掉了）。协议相关的输出格式说明全部在 `FIXED_PROTOCOL_PROMPT` 里（隐藏、不可编辑）。

分句发送+打字延迟：`typingDelayMs()` 按长度算延迟，`revealBubbles()` 用多个 `setTimeout` 依次落库。用户插话打断：`streamRef`+`timersRef`+`abortRef`，新消息一发就换新streamId、清旧定时器、abort旧请求。

**"经常没有回复/回复有毛病"—— 排查记录，用临时Node脚本直接打真实API验证过，不是猜的，别重蹈覆辙**

*第一轮排查*：每一轮AI回复在数据库里是拆成好几条独立的 `role:'assistant'` 消息（分句气泡）存的，历史记录1:1映射会导致连续好几条`assistant`角色消息、中间没有穿插`user`消息，破坏user/assistant交替结构。加了 `coalesceConsecutiveRoles()`（`src/lib/deepseek.ts`）合并连续同角色消息。这个问题确实存在也确实修了，但不是"经常没有回复"的主因。

*第二轮排查（真正的根因）*：直接打 `https://api.deepseek.com/v1/chat/completions`，完整复现system prompt结构，跑多轮对话对照实验：**开着 `response_format:{type:"json_object"}` 时，第1轮永远输出合法JSON，但第2轮及以后，`finish_reason`正常是`"stop"`、`completion_tokens`不是0，但`content`解码出来是纯空格字符串**——模型在花token但只吐空白。这是DeepSeek这个json_object约束解码器在"复杂系统提示词+已有assistant历史"组合下的服务端行为，关掉`response_format`、只靠prompt文字要求JSON，同样的历史结构下模型完全不会吐空白。

**修复（已用真实API反复验证，10轮对话0次空回复）**：
1. `chatCompletion()` 的 `jsonMode` 参数默认不开。**主聊天请求（`ChatPage.runAiTurn`）不传这个参数**——这是关键。人设生成（`ContactAddPage`）和记忆整理（`lib/memory.ts`）**永远是单轮请求**，不受这个bug影响，继续传 `jsonMode:true`。
2. `FIXED_PROTOCOL_PROMPT` 放在拼接顺序最后，帮助模型更愿意遵守JSON格式（但不是100%保证）。
3. `parseAiResponse()` 解析JSON失败时不再直接返回`[]`丢弃回复，而是把原始文本按换行切分成一个个text气泡兜底显示（`sticker`/`link`这些高级类型只有模型真正输出合法JSON才会出现，纯文本兜底模式下就是普通文字气泡）。只有原始回复本身是空/空白时才真正返回`[]`。

**如果以后又有人反馈"经常没回复"**：先怀疑是不是哪里又不小心给主聊天请求加上了 `jsonMode:true`，这是最容易复发的地方。

**追加修复：commission等非text气泡"没渲染成功、直接把原始JSON文字发出来了"**。用户反馈过一次，联系人发的委托没变成卡片，而是把`{"messages":[{"type":"commission",...}]}`这坨JSON原文当成文字气泡发了出来。排查：单独喂那段JSON字符串给解析逻辑是能正常解析成commission气泡的，所以问题出在**模型真实吐出来的原始文本，大概率在JSON前后还夹了点别的文字**（比如"好的\n{...}"，或者reward字段偶尔给成字符串"30"而不是数字30，导致那条entry被过滤掉、bubbles变成空数组，于是整个`parseAiResponse`退回到"按行拆文本"的兜底路径，把整段原始JSON当成一整行文字气泡显示）。**已修复**（`src/lib/aiProtocol.ts`）：
1. 新增 `extractJsonObject()`：在整段文本里做括号配对扫描（会跳过字符串内部的花括号），找出第一个完整的`{...}`对象子串。`tryParseJson()`现在是"整体直接parse失败 → 再从文本里挖出这个子串试一次"，能顶住模型在JSON前后加了几句闲聊的情况。
2. commission的`reward`字段解析改成先尝试`typeof m.reward === 'number'`，不是的话用`Number(m.reward)`兜底转换（比如模型给了字符串"30"），只要转换出来是有限数字就认，不再因为类型不严格匹配就把整条commission过滤掉。
这两个都是防御性加固，不确定当时具体是哪一种触发的，但两个口子都补上了。以后再遇到"某个特殊气泡类型没渲染、变成裸JSON文字"这种反馈，先怀疑是不是又出现了parseAiResponse在整体parse失败后retreat到逐行文本兜底的情况。

## 待办/委托/货币/商城/仓库系统（新增，五个子模块一起设计的）
用户想法：内置一个TODO软件，独立设一个底部tab；AI能给用户发"委托"卡片（可接取/不接取），接取会变成一条待办，完成后拿到AI设定的奖金；有货币系统；网购商城用**另一个独立的模型和提示词**生成商品（支持浏览和搜索）；买到的东西进仓库，可以送给联系人。

**底部导航从4个变成5个**：`消息 / 联系人 / 待办 / 发现 / 我`——这是本次用户明确要求"独立设一个在下方菜单栏"，之前"四个选项"的说法已经被这次需求覆盖，以后不要再假设底部固定只有4个tab。

**范围裁剪（重要，别自己加回去）**：用户原话是"接取或不接取都发给联系人 联系人会有反应"——这句话只覆盖**接取/拒绝那一刻**，没有要求"完成委托时AI必须立刻反应"或者"赠送礼物时AI必须立刻反应"。所以：
- 接取/拒绝委托：发生在**已经打开的ChatPage里**（用户点卡片按钮），直接复用聊天已有的实时发送+AI回复流程，天然会有AI反应。
- **完成委托**（在待办页勾选完成）和**赠送礼物**（在仓库页选联系人）都发生在**不在聊天页面**的上下文里：只是把一条消息写进对应会话的数据库（`role:'user'`），**不会主动触发API调用**去实时生成AI反应——用户下次自己点开那个聊天时，这条消息已经在历史记录里，AI下一次回复自然会看到并做出反应。这是刻意的简化：如果要在这些场景也做到"立刻收到AI反应"，需要把 ChatPage 里"发消息+调API+展示气泡"的整套逻辑抽成一个不依赖UI的共享模块，这次评估了一下觉得为了这两个场景做这个复杂度不值得，没有做。以后如果用户明确要求"完成委托/送礼物之后想马上看到TA的反应"，才需要考虑抽这个共享模块。

**数据模型**（`types/index.ts`，Dexie version(4)）:
- `Commission { id, contactId, title, description, reward, status: pending|accepted|declined|completed, createdAt, respondedAt?, completedAt? }`——AI发布的委托，reward由AI在协议里给，`aiProtocol.ts`的`clampReward()`强制clamp到10-200之间，防止AI随口给个离谱数字破坏经济平衡。
- `Todo { id, title, note?, done, createdAt, completedAt?, source: 'user'|'commission', commissionId? }`——个人待办和"接取的委托"用同一张表，靠`source`区分。
- `InventoryItem { id, name, description, icon, price, acquiredAt }`——仓库物品，直接存AI生成商品的快照（没有单独的商品目录表，因为商品是即时生成的，逛了没买的商品根本不落库，只在`ShopPage`组件state里）。
- `AppSettings.walletBalance`——全局货币(`lib/wallet.ts`里定的"金币"🪙)，新用户默认`INITIAL_WALLET_BALANCE=100`。`AppSettings.shopModel`——商城独立的模型选择，默认也是`deepseek-chat`，但用户可以在设置页单独改，不跟聊天用的`model`混用。

**委托的完整生命周期**：
1. AI在聊天里输出`{"type":"commission", title, description, reward}`（协议在`FIXED_PROTOCOL_PROMPT`里，明确要求"只有场景合适时偶尔发一次 不要每条都发"）。`ChatPage.revealBubbles`处理这个bubble类型时**先创建`Commission`行**(status:pending)，再把`message.commission={commissionId}`存进消息里，`MessageBubble`里的`CommissionCard`子组件用`useLiveQuery`实时读这个commission的状态来决定渲染按钮还是状态文字。
2. 用户点"接取"或"不接取"——`ChatPage.handleCommissionRespond`更新commission状态，接取的话额外创建一条`Todo`(source:'commission')，然后调用`sendMessage()`（就是原来`handleSend`抽出来的部分，现在输入框和委托按钮共用同一个函数）发一条"好 这个我接了"之类的话，走正常的AI回复流程。
3. 用户在`TodoPage`把这条委托类待办勾选完成——`completeCommissionTodo()`：更新commission状态为completed、`walletBalance += reward`、直接写一条`role:'user'`的完成消息到对应会话（不触发API，见上面"范围裁剪"）。委托类todo一旦完成不能再取消勾选（按钮disabled），个人todo可以自由切换。

**商城生成**（`lib/shop.ts`）：`buildShopPrompt(query)`——有搜索词就生成相关商品，没有就生成"首页推荐"；`parseShopProducts()`解析`{"products":[{name,description,price,icon}]}`，price clamp到5-300。`ShopPage`调用时传`model: settings.shopModel`（不是`settings.model`）、`jsonMode:true`（单轮请求，不受json_object多轮bug影响）。购买时直接从`walletBalance`扣款、写入`inventory`表，没钱会弹toast提示"金币不够啦"，不会出现负数余额。

**仓库赠送**（`WarehousePage`）：选联系人后，物品从`inventory`表删除（送出去了，仓库不再持有），并往那个联系人的会话里插入一条`type:'gift'`消息(`message.gift={name,icon,description}`)，跳转到那个聊天页。同样不主动调API，AI会在下次回复时看到这条`[送出了礼物: xxx]`的历史记录。

## 表情包系统（`StickersPage` + `lib/image.ts`）
用户需求：导入图片当表情包、用户命名。核心功能一直都有（上传+起名字），后来做了这些完善：
- **上传时自动压缩**：`resizeImageDataUrl()`（`lib/image.ts`）用canvas把图片最长边缩到240px、转成JPEG quality 0.85再存库，避免直接把手机相册原图（可能几MB）塞进IndexedDB。
- **重命名**：点表情包名字（下划线样式提示可点）弹小modal改名，同样做唯一性校验（排除自己）。
- **删除加了二次确认**（`ActionSheet`），避免手滑删错。
- 命名唯一性：`db.stickers` 的 `&name` 是Dexie唯一索引，新增/改名前都手动 `where('name').equals()` 查重给出友好提示（而不是让Dexie直接抛ConstraintError）。

## 目录结构速查
- `src/pages/`：MessagesPage / ContactsPage / ContactAddPage(问卷+直接创建，含头像+性格标签+随机词条) / ContactCardPage(名片：备注/记忆展示+头像更换，无人设无关系维度展示) / ChatPage(含委托卡片交互) / TodoPage(个人待办+委托待办，底部tab) / DiscoverPage(商城/仓库/关系网入口) / RelationshipsPage(关系总览，唯一展示关系维度的地方) / ShopPage(独立模型生成商品) / WarehousePage(库存+赠送) / MePage(含货币显示) / ProfileEditPage(全屏个人资料) / SettingsPage(含购物专用模型选择+清空数据危险操作) / StickersPage(上传压缩+改名+删除确认)。
- `src/components/`：TopBar / BottomNav(5个tab) / SearchOverlay / MessageBubble(assistant消息头像上方显示名字，含委托卡片`CommissionCard`子组件+礼物卡片渲染) / ActionSheet / Avatar(圆角矩形) / AvatarPicker / ImageCropper。
- `src/lib/`：deepseek.ts(含jsonMode开关+角色合并) / aiProtocol.ts(解析+非JSON兜底按行拆气泡+委托reward clamp) / prompt.ts(三层提示词+人设生成) / memory.ts(记忆+关系增量，合并一次API调用) / relationship.ts(五维度/初始值/归纳标签) / shop.ts(独立商品生成prompt+解析) / wallet.ts(货币常量+格式化) / randomTraits.ts(随机词条池) / contact.ts(displayName) / image.ts(图片压缩) / search.ts / time.ts(含当前时间描述+年龄计算) / colors.ts / avatarEmojis.ts。

## 尚未实现 / 后续计划
- 发现页的小程序系统里"商城""仓库""关系网"都是真的，其余（比如更多品类的虚拟服务）仍待补充（地图已被移除，不在计划内）。
- 群聊 / AI与AI互动未实现——这也是关系网里"AI与AI关系"暂时没法真正使用的原因。
- 完成委托/赠送礼物不会实时触发AI反应，只是写入历史记录等下次对话时AI自然看到（见上面"待办/委托/货币/商城/仓库系统"里的范围裁剪说明），如果要做成实时反应需要抽取ChatPage的发送/调用API逻辑成独立模块。
- 一次性任务(委托)目前没有做"重复接取同一委托"之类的防护，也没有"委托过期"机制，量不大暂时够用。
- Capacitor Android 原生打包：本地已有 Android Studio（`C:\Projects\AndroidStudio`），用户说不着急。
- `CONTEXT_WINDOW_SIZE`/`MEMORY_UPDATE_INTERVAL` 仍是代码常量，没有设置页UI。

## 开发命令
- `npm run dev` — 启动开发服务器（host: true，可用局域网 IP 在手机浏览器访问）
- `npm run build` — `tsc -b && vite build`
- `npm run lint` — oxlint
