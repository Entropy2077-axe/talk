# Talk — AI 聊天软件项目记忆

## 项目定位
React 核心的仿微信风格 AI 对话应用。用户"添加联系人"（通过问卷让对方自动生成人设+名字，一次性确认，之后不能再改人设），
与 DeepSeek 模型进行拟人化聊天，并随聊天积累记忆和关系。内置待办/委托/货币/商城/仓库这套小游戏化系统，以及朋友圈系统（AI之间也有关系链、会互相点赞评论）。目标：安卓适配良好、PC 浏览器可直接调试、后续可选打包为原生 APK。

## 技术栈与关键决策
- **构建**: Vite + React + TypeScript。`vite.config.ts` 设置 `server.host: true`，方便手机在同一局域网通过 `http://<PC局域网IP>:5173` 直接访问调试。
- **样式**: Tailwind CSS v4（`@tailwindcss/vite` 插件，无需 tailwind.config.js，通过 `src/index.css` 里 `@import 'tailwindcss'` 引入）。整体白色简约风格。头像统一用圆角矩形（`Avatar` 组件默认 `rounded="lg"`）。
- **路由**: `react-router-dom`，使用 `HashRouter`（而非 BrowserRouter）—— 是为了以后 Capacitor 原生打包时用 `file://` 协议加载也不会有路由 404 问题。
- **状态管理**: Zustand，`useSettingsStore` 持久化到 localStorage（API Key、模型、说话风格提示词、用户昵称头像等资料、朋友圈封面图）。
- **本地数据库**: Dexie（IndexedDB 封装），`src/db/db.ts`，目前到 version(5)。表：`contacts`（人设+记忆+关系+朋友圈字段）、`conversations`、`messages`、`stickers`、`todos`、`commissions`、`inventory`、`moments`/`momentComments`/`momentLikes`、`contactRelations`。`locations`/`tasks` 两张表在 version(2) 加过、又在 version(3) 里用 `null` 显式删除了（Dexie删表的正确写法就是在新版本 `.stores()` 里把该表设为 `null`）——这是地图/日程功能被整体移除留下的痕迹，别奇怪。
- **安卓策略**: 当前只做响应式 Web（`.app-shell` 在 PC 端居中显示手机宽度的卡片，移动端全屏铺满）。Capacitor 依赖与 `capacitor.config.ts` 已装好占位。**用户本地已装好 Android Studio，路径 `C:\Projects\AndroidStudio`**——但用户表示打包 APK 不着急，先把功能做完。
- **API Key 处理**: DeepSeek key 写在根目录 `.env`（`VITE_DEEPSEEK_API_KEY`），已加入 `.gitignore`。
- **独立路由页面的高度陷阱（踩过坑，别再犯）**：不在 `TabLayout` 里的整页路由（`ChatPage`、`ContactAddPage`、`ProfileEditPage` 等，需要内容区滚动+底部按钮/输入框固定）**不能用 `min-h-full`**。`.app-shell` 只有 `min-height`，不是 `height`，导致子元素的百分比高度解析不确定，`flex-1` 拿不到真实剩余空间，底部固定栏会紧跟在内容后面而不是贴在可视区域底部。正确写法：根容器用 `h-dvh flex flex-col overflow-hidden`，中间滚动区用 `flex-1 overflow-y-auto`，底部栏保持普通flow。

## 聊天引擎在后台运行（重要架构决策，别把逻辑挪回ChatPage组件里）
用户反馈过"退出聊天界面之后聊天无法进行了"——根因是发消息/调API/逐条揭示气泡这套逻辑原本整个长在 `ChatPage` 组件的 `useState`/`useRef` 里，组件卸载时的cleanup effect会 `abort()` 掉正在进行的请求、清空所有待触发的气泡定时器。

**已经整体挪到 `src/lib/chatEngine.ts`，独立于任何组件的生命周期**：
- `sendMessage(conversationId, contact, settings, stickers, text)`——插入一条新的用户消息 + 触发AI回复，`ChatPage`的输入框和委托卡片的接取/拒绝按钮都调用这一个函数。
- `triggerAiTurn(conversationId, contact, settings, stickers)`——**不插入新用户消息**，只基于会话里已有的历史直接触发一轮AI回复。给"不在ChatPage里但希望AI能回应"的后台动作用（赠送礼物、完成委托，见下面对应章节）。
- 响应式状态（`aiTyping`、`error`）放在模块级的 `useChatEngineStore`（zustand，**没有persist**，纯内存态），按 `conversationId` 分开存，`ChatPage`只是订阅它、不再自己用`useState`管理。
- 不需要响应式的簿记（当前streamId、待触发的气泡定时器、AbortController）用模块级 `Map<conversationId, ...>` 存。
- **`ChatPage`卸载时现在什么都不清理**——没有 `abort()`、没有清定时器。只有"同一个会话又发了新消息"才会打断上一轮，退出页面本身不再触发任何打断。

**如果以后要改聊天发送/回复逻辑，去改 `chatEngine.ts`，不要加回 `ChatPage.tsx` 里**——一旦看到`ChatPage`里又出现 `streamRef`/`timersRef`/`abortRef`/本地`aiTyping` state，说明有人把后台化以前的写法抄回来了。

**后台化上线后立刻炸了一次："聊天界面直接卡没了"（白屏/崩溃）**——根因是个经典的 React18+Zustand 陷阱：`ChatPage` 订阅 `useChatEngineStore` 时兜底写成了内联字面量 `(s) => s.states[id] ?? { aiTyping: false, error: '' }`，**这个兜底对象每次selector执行都会new一个新的**，触发了React `useSyncExternalStore` 的"getSnapshot返回值不稳定"检测，直接导致组件崩溃。**已修复**：`chatEngine.ts` 导出模块级单例 `DEFAULT_RUNTIME_STATE`，selector兜底用这个稳定引用。**以后凡是写 `useXxxStore(s => s.xxx ?? 默认值)` 这种selector，默认值必须是模块级的稳定引用，绝对不能是内联字面量**——这是"页面直接崩掉/白屏"故障的常见根源。

**"后台触发回复"这块也踩过一次坑**：最早觉得"完成委托/赠送礼物发生在ChatPage之外，专门做后台触发API不值得"，所以只把消息写进数据库、不实际调用API。用户测试后明确反馈这样不行，要求修复。现在 `WarehousePage.handleGift`、`TodoPage.completeCommissionTodo` 插入各自的消息后都会调用 `triggerAiTurn`（需要额外查一下`stickers`列表和完整的`settings`）。以后新增类似"不在ChatPage里但希望AI能回应"的后台动作，照抄这个模式，不要图省事又退回去只写消息不触发。

## 全局通知横幅（`NotificationBanner` + `useChatUiStore`）
用户要求"发了消息会给模拟弹窗"。`useChatUiStore`（不persist）存：`activeConversationId`（当前打开的会话，`ChatPage` mount/unmount时登记/清空）+ `notification`（当前要展示的通知内容）。`chatEngine.ts` 的 `revealBubbles()` 每次有新气泡落库时，检查 `activeConversationId !== conversationId` 才会弹通知。`NotificationBanner` 挂载在 `App.tsx` 最外层（`.app-shell`内、`Routes`外面），4秒自动消失，点击跳转到对应聊天。`previewForMessage()`（`lib/messagePreview.ts`）把不同消息类型变成一行预览文字，会话列表和通知横幅共用。

## 聊天界面的两个UI细节修复
- **打开聊天要立刻在最底部**：滚动effect从`useEffect`改成`useLayoutEffect`（在浏览器绘制前同步执行，避免打开长对话时先闪一下中间/顶部内容再跳到底部），依赖数组加了`conversationId`。
- **头像对齐**：`MessageBubble`外层容器原来是`items-end`（跟时间戳文字的底部对齐，导致头像视觉上偏低），改成`items-start`（头像顶部对齐气泡顶部，微信那种标准对齐方式）。

## 系统提示词分层（三层，不要合并）
`src/lib/prompt.ts`：
1. **`DEFAULT_STYLE_PROMPT`**——纯"说话方式"规则，是 `settings.globalSystemPrompt` 默认值，**用户可在设置页编辑**。
2. **`FIXED_PROTOCOL_PROMPT`**（模块内 const，未export）——JSON输出格式/分句/表情包与小程序/委托占位符说明。**固定、不给用户看、不可编辑**。协议指令放在拼接顺序的**最后**（离生成位置最近），对模型遵守JSON格式有帮助。
3. **人物设定 `persona`** + **记忆** + **关系维度**——每个联系人各自的部分，`persona` 完全不给用户看。

`buildSystemPrompt()` 拼接顺序：`stylePrompt + 人物设定 + 记忆 + 实时上下文(当前时间/用户资料/最近事件) + 固定协议`。

## 添加联系人流程（问卷式，生成后直接创建，无二次确认）
用户明确要求：名字必须TA自己起，交互要像"添加联系人"而不是"配置AI"，**创建后不允许用户再修改人设**，页面文案不能出现"AI"字眼。
- `ContactAddPage`（路由 `/contact/new`）：先选头像（`AvatarPicker`），性格标签多选 + 自定义标签 + 🎲随机词条、年龄段/性别/关系定位单选chip、**TA与其他联系人的关系（可选，见下面AI-AI关系）**、补充说明文本框。
- 点"确认添加"→ `buildPersonaGenerationPrompt()` 一次性调用 DeepSeek 生成 `{name, persona}`（`jsonMode:true`，单轮请求不受json_object多轮bug影响）→ **直接**创建contact+conversation+关系链接（无确认/修改页）→ `navigate('/contacts')`。
- 创建后 `name` 和 `systemPrompt`（人设）**完全不可再改、也不再展示给用户**。唯一能后续改的是**头像**和**备注**。

## 好友备注
`Contact.remark`（可选）。`src/lib/contact.ts` 的 `displayName(contact)` = `remark || name`，全应用统一用这个函数显示名字。

## AI记忆功能（`src/lib/memory.ts`）
两个独立轴，只影响语气不改人设：`memoryFacts`(客观事实摘要≤200字)、`memoryStyle`(相处状态/语气调整≤150字)。省token机制：`CONTEXT_WINDOW_SIZE=30`（主聊天只发最近30条原文）、`MEMORY_UPDATE_INTERVAL=10`（攒够10条新消息才整理一次）。触发时机：`chatEngine.ts`的`revealBubbles()`最后一个气泡落库后fire-and-forget调用`maybeUpdateMemory`（`jsonMode:true`），不阻塞UI。`ContactCardPage`可查看/清空记忆。

## 关系网功能（`src/lib/relationship.ts`，用户-AI关系，对用户完全隐藏数值，只在关系网页面展示）
5个维度0-100分：`familiarity熟悉度` `affection好感度` `trust信任度` `romance暧昧度` `friction摩擦感`，存在`Contact.relationship`。**和记忆更新合并成同一次API调用**（`buildMemoryUpdatePrompt`同时要求输出`relationshipDelta`变化量）。`relationshipStageLabel()`归纳成短标签。**UI只有`RelationshipsPage`一处**（`ContactCardPage`不显示任何维度）。

## AI与AI的关系链（新增，区别于上面用户-AI的数值关系）
用户要求"AI和AI之间也要有关系链接"，用于驱动朋友圈的点赞评论逻辑。这是**静态的、创建时手动设置的标签关系**，不像用户-AI关系那样靠聊天动态演变（因为没有AI-AI聊天功能，没法动态更新）。
- `ContactRelationLink { id, fromContactId, toContactId, label, createdAt }`，`label`是`CONTACT_RELATION_LABELS`里的一个（`types/index.ts`）：好朋友/损友/暧昧对象/恋人/家人/前辈同事/点头之交/看不顺眼/对头。
- `lib/contactRelations.ts` 的 `relationSentiment(label)` 把每个标签分类成 good/neutral/bad，`canReactToMoments(label)` = sentiment !== 'bad'——"看不顺眼""对头"这两个不会互相点赞评论，其余都可能（还要过随机数，见朋友圈系统）。
- 在`ContactAddPage`设置：新增联系人时有"TA与其他联系人的关系"区块，点"+添加关系"加一行(选目标联系人+选关系标签)，创建时批量写入`contactRelations`表。**只能在创建时设置，之后没有编辑入口**（如果以后要加，得在`ContactCardPage`补一个管理关系的UI）。
- `RelationshipsPage`展开联系人卡片时会显示"TA与其他人的关系"列表（从`contactRelations`表读，双向查找）。

## 朋友圈系统（`lib/moments.ts` + `MomentsPage`，新增，最复杂的一块）
用户要求：发现页点"刷新"，让10分钟内没发过朋友圈的AI立即发一条纯文字朋友圈，其他AI按关系随机点赞评论。**谁发、谁回应完全由代码里的随机系统决定，不交给LLM决定**——LLM只负责把决定好的这些人对应的文字内容写出来，一次API调用搞定全部。

**发圈人数规则**（`pickPosterCount`，按用户原话实现）：eligible = 10分钟内没发过圈的联系人。如果 eligible.length > 5，人数上限设成5（结果是随机2~4个人发）；否则上限是联系人总数（随机2~(总数-1)个人发，clamp到eligible数量，至少1个）。

**谁会点赞评论**（`planReactors`）：对每个发圈的人，找`contactRelations`里跟TA有链接、且`canReactToMoments`为true（不是"看不顺眼"/"对头"）的其他联系人作为候选。每个候选还要过一次`REACT_PROBABILITY=0.6`的随机数——**"就算关系好也有一定概率不回复"**就是这个。通过的人一定会点赞，其中再有`COMMENT_SHARE=0.55`概率的人**也**留评论（不是所有点赞的人都评论，更像真实社交软件）。

**一次API调用生成内容**：只把"会留评论"的那些人的人设喂给模型（点赞不需要生成文字，代码直接写`MomentLike`记录），要求输出`{"moments":[{"content":"...", "comments":["...", ...]}]}`，**顺序必须和输入的人物/评论者顺序完全一致**（不依赖模型回显名字/ID，纯按位置zip回去，更稳）。`parseMomentsResponse`校验数组长度对不上就整体判定失败。

**数据落库**：`Moment{id,contactId,content,createdAt}`、`MomentComment{id,momentId,authorContactId,content,createdAt}`、`MomentLike{id,momentId,likerId,createdAt}`（`likerId`要么是contactId要么是字面量`'user'`表示用户自己点的赞）。发圈后更新`contact.lastMomentAt`。

**用户点赞行为**：用户可以给任意AI的朋友圈点赞（`MomentsPage`的❤按钮，纯本地toggle）。**AI之间的点赞是静默的，不产生任何通知**；但**用户点赞会往那个AI的`Contact.pendingEvents`数组里追加一条note**（比如"你发的朋友圈刚被对方点赞了"），下次聊天时`chatEngine.runAiTurn`会读取`pendingEvents`塞进prompt的【最近发生的事】区块、说完就清空（不会反复提、也不需要专门做"主动推送消息"这种更复杂的机制）。这个`pendingEvents`机制是通用的，以后有别的"要让AI知道但不想做成大功能"的场景可以复用。

**页面排版**（仿微信朋友圈）：顶部`40vh`高度的封面图（点击可以换图，走`resizeImageDataUrl`压缩到960px宽存进`settings.momentsCoverPhoto`），封面图右下角浮着用户头像+昵称。下面是动态流：每条显示发布者头像+名字+正文+时间+点赞按钮，下面如果有人点赞/评论会显示一个灰底小方框（❤ 点赞人列表，评论列表）。

**级联删除**：删除联系人时会调用`lib/moments.ts`的`cascadeDeleteContactSocialData(contactId)`——删掉TA自己发的朋友圈（连带清空这些圈子下所有的赞和评论）、删掉TA在**别人**朋友圈下留的赞和评论、删掉涉及TA的`contactRelations`链接。不会因为删一个人而误删别人还在的朋友圈。

**入口**：`DiscoverPage`新增"朋友圈"（排在商城/仓库/关系网前面）。

## 委托发布延迟问题（提示词加固，非100%保证）
用户反馈"跟AI说'发点任务吧'，AI会用大白话答应('帮我带杯咖啡吧')但不会真的发commission卡片，要追问才发"。在`FIXED_PROTOCOL_PROMPT`的commission说明里加了一句强约束："如果对方直接明确要求发布委托，必须在这一条回复里就直接用commission类型输出，不能只用text敷衍带过"。**这只是prompt层面的加固，不是代码强制的，模型仍有概率不遵守**——因为如果强行要求它每次都必须输出commission类型可能引发过度发放委托的问题，只能靠措辞引导。

## 强制删除联系人的限制（重要，别再被问到时懵）
所有数据（联系人、聊天记录、朋友圈等）都存在用户浏览器的 IndexedDB 里（`talk-db`），这个Bash/PowerShell环境访问不到用户正在跑的浏览器会话，我没法直接从命令行清掉。`SettingsPage`有"危险操作 → 清空所有联系人与聊天记录"按钮（`handleWipeContacts`），**用户需要自己点**，或者在浏览器devtools console执行`indexedDB.deleteDatabase('talk-db')`并刷新。以后遇到"帮我清空/删除xx数据"，都要意识到这一点。

## 个人资料（用户自己的），全屏页面 `ProfileEditPage`
`/profile/edit`。`AppSettings`有`userGender` `userBirthday`("YYYY-MM-DD") `userBio`，生日只用来算年龄（`ageFromBirthday`），没做星座之类的花活。这些资料会注入到系统提示词的【关于对方(用户)】区块。

## 系统提示词里的实时上下文注入
`chatEngine.ts`的`runAiTurn`每次发请求都**现算**：`describeCurrentTime(now)`(【当前时间】)、`buildUserProfileText()`(【关于对方(用户)】)、`contact.pendingEvents`(【最近发生的事】，见朋友圈章节，读取后立即清空)。

## 地图/日程/任务系统 —— 已整体移除，别再往这个方向排查
v1做过一套完整的地图+日程+一次性任务系统，后来**用户明确反馈"感觉不是很有用"，要求全删**，已经彻底清干净。别指望复用已删除代码，也别在没有明确需求时主动提议做这个方向的功能。

## AI输出JSON协议（`src/lib/aiProtocol.ts` + `src/types/index.ts`）
气泡类型：`text`、`sticker`、`link`(占位符shop/todo)、`commission`(委托，见待办章节)。`gift`类型是用户侧直接构造、不走AI协议解析的。协议说明全部在`FIXED_PROTOCOL_PROMPT`里。

分句发送+打字延迟：`typingDelayMs()`按长度算延迟，`revealBubbles()`（住在`chatEngine.ts`）用多个`setTimeout`依次落库。用户插话打断：模块级streamId/定时器/AbortController。

**"经常没有回复/回复有毛病"排查记录，用临时Node脚本直接打真实API验证过，别重蹈覆辙**：
1. 每轮AI回复拆成多条独立`assistant`消息存库，历史1:1映射会破坏user/assistant交替结构 → 加了`coalesceConsecutiveRoles()`合并连续同角色消息（这个问题真实存在但不是主因）。
2. **真正的根因**：开着`response_format:{type:"json_object"}`时，第2轮及以后模型会正常返回`finish_reason:"stop"`但`content`是纯空格——json_object约束解码器在"复杂系统提示词+已有assistant历史"下的服务端行为。**修复**：`chatCompletion()`的`jsonMode`参数默认不开，主聊天请求不传；人设生成/记忆整理/商城生成/朋友圈生成都是单轮请求，继续传`jsonMode:true`不受影响。`parseAiResponse()`解析失败时按行拆成text气泡兜底，不再直接丢弃。
3. **追加修复**：非text气泡（比如commission）偶尔会整段原始JSON被当成文字发出来——因为模型真实输出在JSON前后夹了闲聊文字，或者字段类型不严格匹配（比如reward给成字符串）导致该条被过滤、bubbles变空数组、退回逐行文本兜底。修了`extractJsonObject()`（括号配对扫描，从文本中挖出完整JSON子串）+ reward字段改成`Number()`兜底转换。

**如果以后又有人反馈"经常没回复"**：先怀疑是不是哪里又不小心给主聊天请求加上了`jsonMode:true`。

## 待办/委托/货币/商城/仓库系统
**底部导航5个tab**：`消息 / 联系人 / 待办 / 发现 / 我`。

**数据模型**（`types/index.ts`）：`Commission{id,contactId,title,description,reward,status,createdAt,respondedAt?,completedAt?}`（reward由AI给，`aiProtocol.ts`的`clampReward()`强制clamp到10-200）；`Todo{id,title,note?,done,createdAt,completedAt?,source:'user'|'commission',commissionId?}`（个人待办和接取的委托同一张表，靠source区分）；`InventoryItem{id,name,description,icon,price,acquiredAt}`（没有单独商品目录表，商品即时生成，没买的不落库）；`AppSettings.walletBalance`(金币🪙默认100)+`shopModel`(商城独立模型选择，不跟聊天用的`model`混用)。

**委托生命周期**：AI输出commission气泡 → `chatEngine.revealBubbles`先建`Commission`行(pending)，`MessageBubble`里的`CommissionCard`子组件实时读状态渲染按钮/状态文字 → 用户接取/拒绝 → `ChatPage.handleCommissionRespond`更新状态+(接取时)建`Todo` → 调用`sendMessage()`发一句"好这个我接了"触发AI反应 → 用户在`TodoPage`勾选完成 → `completeCommissionTodo()`标记完成+发奖金+写完成消息+调用`triggerAiTurn()`触发AI反应（这一步之前是缺失的，见上面"聊天引擎"章节的坑）。委托类todo完成后不能取消勾选。

**商城**（`lib/shop.ts`）：`buildShopPrompt(query)`+`parseShopProducts()`，`ShopPage`调用时传`model: settings.shopModel`、`jsonMode:true`。购买直接扣`walletBalance`、写入`inventory`。

**仓库赠送**（`WarehousePage`）：物品从`inventory`删除，插入`type:'gift'`消息到对应会话，然后`triggerAiTurn()`触发AI反应。

## 表情包系统（`StickersPage` + `lib/image.ts`）
上传时用`resizeImageDataUrl()`压缩到240px/JPEG。支持重命名（唯一性校验）、删除二次确认。

## 目录结构速查
- `src/pages/`：MessagesPage / ContactsPage / ContactAddPage(问卷+直接创建+AI关系设定) / ContactCardPage / ChatPage(含委托卡片交互) / TodoPage / DiscoverPage(朋友圈/商城/仓库/关系网入口) / RelationshipsPage(用户-AI关系总览+AI-AI关系展示) / MomentsPage(朋友圈) / ShopPage / WarehousePage / MePage(含货币显示) / ProfileEditPage / SettingsPage / StickersPage。
- `src/components/`：TopBar / BottomNav(5个tab) / SearchOverlay / MessageBubble(含`CommissionCard`子组件+礼物卡片渲染) / NotificationBanner / ActionSheet / Avatar(圆角矩形) / AvatarPicker / ImageCropper。
- `src/lib/`：**chatEngine.ts(核心！sendMessage+triggerAiTurn+后台引擎)** / deepseek.ts(jsonMode开关+角色合并) / aiProtocol.ts(解析+兜底+委托reward clamp+平衡括号JSON提取) / prompt.ts(三层提示词+人设生成) / memory.ts(记忆+关系增量) / relationship.ts(用户-AI五维度) / contactRelations.ts(AI-AI关系标签+情感分类) / moments.ts(朋友圈生成引擎+级联删除) / shop.ts(独立商品生成) / wallet.ts(货币常量) / messagePreview.ts / randomTraits.ts / contact.ts(displayName) / image.ts(图片压缩) / search.ts / time.ts / colors.ts / avatarEmojis.ts。
- `src/store/`：useSettingsStore(persist) / useChatEngineStore(不persist，每会话aiTyping/error) / useChatUiStore(不persist，activeConversationId+通知)。

## 尚未实现 / 后续计划
- 发现页目前"朋友圈""商城""仓库""关系网"都是真的，虚拟网购(独立于商城)/TODO类占位仍待补充。
- 群聊 / AI与AI之间的真实对话未实现——朋友圈的AI-AI关系是静态标签、不会随时间演变，这是有意的简化（没有AI-AI聊天，无法像用户-AI关系那样靠聊天动态更新）。
- AI-AI关系只能在创建联系人时设置，没有事后编辑入口。
- 委托没有"重复接取""过期"防护，朋友圈没有"用户自己发圈"功能（只有AI发圈），量不大暂时够用。
- Capacitor Android 原生打包：本地已有 Android Studio（`C:\Projects\AndroidStudio`），用户说不着急。
- `CONTEXT_WINDOW_SIZE`/`MEMORY_UPDATE_INTERVAL`/朋友圈的`REACT_PROBABILITY`/`COMMENT_SHARE`仍是代码常量，没有设置页UI。

## 开发命令
- `npm run dev` — 启动开发服务器（host: true，可用局域网 IP 在手机浏览器访问）
- `npm run build` — `tsc -b && vite build`
- `npm run lint` — oxlint
