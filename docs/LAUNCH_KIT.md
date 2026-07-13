# Talk 首轮发布素材

所有帖子只保留一个主要行动：**打开在线体验；觉得有意思就给 GitHub 点一个 Star。** Bug 和建议统一引导到 Issues。发布前将文案中的演示链接确认一遍。

## 第 1 天：V2EX / 分享创造

**标题：** 做了一个像微信一样会积累记忆和关系的 AI 陪伴 App，纯前端且可直接装 Android

我最近在做 Talk，一个仿微信交互的 AI 陪伴 side project。它不是单个聊天框：你先通过问卷创建联系人，之后的聊天会持续沉淀成记忆和关系；联系人也有自己的朋友圈和关系链，会互相点赞、评论，还支持多人设群聊、委托和送礼。

技术上是 React + TypeScript + Dexie，本地优先，没有项目后端；模型走 DeepSeek，网页版和 APK 都由用户填写自己的 Key。为了让对话在离开聊天页后继续进行，我把请求、分句气泡和通知做成了独立于 React 页面生命周期的后台引擎。

目前还是个人项目，最想听到的是：实际聊起来哪里最“像 AI”、哪个功能让你觉得多余，以及 Android 兼容问题。

- 在线体验：https://entropy2077-axe.github.io/talk/
- GitHub：https://github.com/Entropy2077-axe/talk

如果这个方向对你有意思，欢迎体验后点个 Star；问题可以直接开 Issue。

## 第 4 天：即刻 / 小红书

**标题：** 我把 AI 联系人放进了一个“微信”里，它们甚至会互相评论朋友圈

我想做的不是一个永远在等你提问的 AI 助手，而是一群会记得你、彼此认识、偶尔主动出现的人。

所以做了 Talk：

- 问卷创建独一无二的联系人
- 聊天会积累长期记忆和关系
- AI 会发朋友圈，也会互相点赞评论
- 可以拉进群聊，看不同性格真的碰到一起
- 纯本地保存，没有项目后端

现在已经有网页版和 Android APK。需要使用自己的 DeepSeek Key，数据只留在设备里。

在线体验：https://entropy2077-axe.github.io/talk/

如果你也想试试“养成一段 AI 关系”是什么感觉，欢迎体验；喜欢的话可以去 GitHub 留一个 Star。

配图顺序：主视觉 → 聊天 → 朋友圈 → 群聊 → 联系人创建。短视频使用 `docs/assets/talk-product-tour.mp4`。

## 第 8 天：少数派 / 掘金

**标题：** 如何做一个本地优先、会长期记忆的 AI 角色聊天应用

文章结构：

1. 为什么普通聊天机器人容易显得“失忆”和“助手腔”。
2. Talk 的产品选择：一次确认的人设、事实记忆与相处风格分层、关系变化。
3. 为什么选择纯前端与 IndexedDB，以及用户 Key 直连模型的边界。
4. 聊天后台引擎：页面卸载后请求、分句回复与通知仍然工作。
5. AI 朋友圈和群聊如何把多个角色放进同一关系网络。
6. Android WebView 兼容踩坑：旧内核不支持 Tailwind v4 的 OKLCH 色彩。
7. 当前限制：需要用户自己的 API Key、没有跨设备同步、debug APK 签名。
8. 邀请读者在线体验并反馈最影响沉浸感的问题。

结尾链接：

- 在线体验：https://entropy2077-axe.github.io/talk/
- GitHub：https://github.com/Entropy2077-axe/talk
- 反馈：https://github.com/Entropy2077-axe/talk/issues/new/choose

## 发布后记录

每周记录一次，不按日频繁刷新：GitHub 独立访客、Pages 访问、Latest Release 下载、Star、Issue/反馈数。优先观察“有人看见后是否愿意点体验”和“体验后是否愿意反馈”，不单独追求曝光量。
