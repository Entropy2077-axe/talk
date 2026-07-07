# 架构决策记忆（v0.1.14 更新）

## 模组系统（`src/features/`）

可开关的功能模块系统。每个模块声明自己的路由、发现页入口、prompt链接，由 `enabledModules: string[]`（存在 `AppSettings`）控制开关。

### 父子分组
- **🎮 更多互动**: 商城(shop) + 仓库(warehouse)
- **🌟 角色灵魂**: 世界书(worldview) + 知识库(knowledgeBase) + 好感度(relationship) + 特色人格(personalityTraits) + 心情系统(mood) + 读心(mindReading) + AI自主行为(proactiveChat)
- **独立**: 校验器(validator) + 管理员模式(adminMode)

默认全部开启，除：AI自主行为、读心、管理员模式（默认关闭）。

### 关键规则
- 移除某个功能 → 不报错，只是功能不生效。加回来恢复原样。
- 仓库关闭不影响已有赠送卡片（gift消息类型独立于仓库页面）。
- 好感度关闭 → prompt不注入关系字段、记忆更新跳过warmth/relationshipDynamic、好感度行隐藏。记忆AI正常触发。
- 特色人格关闭 → 创建联系人时无性格特质选择器、prompt不注入特质提示词。
- 管理员模式/AI自主行为的旧 boolean 字段已从 `AppSettings` 移除，统一走 `enabledModules`。
- 新模块加3步：① 创建 `src/features/xxx.ts` ② 加入 `ALL_MODULES` 数组 ③ 如果是默认关闭，加到 `DEFAULT_ENABLED_MODULES` 的 filter 里。

## 两步式生成管线（替代旧的单次JSON协议）

```
用户消息
  ↓
Step 1: 主模型 (settings.model, 默认 deepseek-v4-pro)
  ├── buildRawChatPrompt() — 纯文本提示词（人设+记忆+关系+日程+当前情境）
  ├── 不用JSON，自然分句
  ├── 括号写想法: "没关系啦(我其实超级在意)"
  ├── [sticker:名字] 指定表情包
  └── 输出: 自然文本
  ↓
Step 2: 多功能模型 (settings.utilityModel, 默认 deepseek-v4-flash)
  ├── buildJsonConversionPrompt() — 机械解析
  ├── jsonMode: true
  ├── 拆消息、提取thought(原样取第一条括号内容)、判断mood、检测sticker
  └── 输出: {"messages":[...], "mood":"...", "thought":"..."}
  ↓
Step 3 (可选): 校验器模块
  ├── 合格性鉴定: 用utility模型判断→不合格则重写
  └── 强制优化: 直接扔回主模型优化
```

**mood 和 thought 必填**：每轮都必须输出。thought 10~50字，第一人称"我"，禁止用"用户""对方"。不要求反差，自由表达。

## 心情系统（mood 模块）

- 角色灵魂子模组，默认开启
- `Contact.mood?: { text, expiresAt }` — 由转换模型从文本中判断
- 过期时间可配置：`settings.moodExpiryMs`，发现页"心情设置"滑块 5~120分钟
- 联系人名片显示心情行，管理员预览有独立心情分类
- prompt 中有 `moodPrompt()` 函数：根据心情关键词生成具体行为指令（开心→活泼、吃醋→带酸味等）

## 读心模块（mindReading）

- 角色灵魂子模组，默认关闭
- 开启后每条AI回复最后一条气泡下方显示紫色🔮想法卡片
- thought 存储在 `Message.thought` 字段（仅最后一条消息）
- 管理员 JSON 块从 ChatPage 移到 ContactCardPage 的日程下方

## 校验器模块（validator）

- 独立模组，默认开启
- `settings.validatorMode`: `'quality'`（合格性鉴定）| `'optimize'`（强制优化）
- 关闭后AI回复不经校验直接使用
- 发现页"校验器"入口，Toggle Switch UI

## 联系人名片重设计

信息列统一为白色卡片行：备注/关系定位/性格特质/心情/状态(可联系?)/好感度
日程改为 7×3 可视化网格表格（上午/下午/晚上 × 周日至周六）
新增"最新AI原始JSON"区块（管理员模式，完全展开）
提示词预览改为两个黑色边框卡片：📤主模型 + 📥多功能模型

## AI自主行为参数

发现页"自主行为设置"滑块页，6个参数（替代原来的下拉选框）：
- 每天上限 1~15/∞ · 触发概率 5~100% · 沉默阈值 5~120min · 冷却 10~2880min
- 每次朋友圈刷新数量 1~10 · 后台刷新间隔 1~30min
- `AUTONOMOUS_TICK_INTERVAL_MS` 不再硬编码，从 `settings.proactiveTickIntervalMs` 读取
- `pickPosterCount` 新增 `maxCount` 参数，受 `settings.proactiveMomentsMax` 控制

## 待办功能已移除

- BottomNav 从5个tab改为4个（消息/联系人/发现/我）
- `/todos` 路由删除、`AVAILABLE_LINK_APPS` 去掉 todo
- TodoPage 组件和 db.todos 表未删除（数据保留）

## 提示词架构变更

- `buildSystemPrompt`/`buildSystemPromptSections` 保留用于管理员预览
- 新增 `buildRawChatPrompt(relationshipBase, ...)` — 自动替换默认提示词中"朋友"为实际关系
- 新增 `buildJsonConversionPrompt(rawText)` — 机械提取，不加工thought
- 新增 `TRAIT_PROMPTS` — 10种人格各有详细行为指令
- 新增 `moodPrompt()` — 12种心情关键词→行为指令
- 日程注入主模型提示词：`describeUpcomingScheduleText()` 格式 "今天: 9-18点:上班" 无日程显示"当前无日程"
- `DEFAULT_STYLE_PROMPT` 中"朋友"替换为实际关系（`relationshipBase`）
- 默认模型改为 deepseek-v4-pro（主模型）和 deepseek-v4-flash（多功能模型）

## 新增文件索引
- `src/features/` — 模组系统（types, index, shop, warehouse, worldview, knowledgeBase, relationship, personalityTraits, mood, mindReading, proactiveChat, validator, adminMode）
- `src/pages/ModulesPage.tsx` — 手风琴式模组开关页
- `src/pages/ProactiveSettingsPage.tsx` — 自主行为滑块设置
- `src/pages/MoodSettingsPage.tsx` — 心情持续时间设置
- `src/pages/ValidatorSettingsPage.tsx` — 校验器模式选择
- `src/lib/responseQuality.ts` — 校验器(validatePrivateTurn) + 优化器(optimizePrivateTurn)
- `src/lib/contactStatus.ts` — 聊天页状态横幅
