# Talk

一个仿微信风格的 AI 聊天陪伴应用。添加"联系人"后由 AI 自动生成人设和名字（问卷式，一次性确认，创建后人设不可再改），之后用 DeepSeek 模型进行拟人化聊天，聊天记录会持续沉淀为记忆和关系。

个人 side project，纯前端 + 本地 IndexedDB，没有后端服务器。

## 功能特性

- **联系人 / 人设生成**：填一份问卷（性格标签、年龄段、关系定位等），AI 自动生成名字、人设、头像照片、每周作息日程
- **1:1 聊天**：分句发送 + 打字延迟，支持文字/表情包/委托/礼物/日程变更等多种消息类型，聊天在后台引擎中运行，切出聊天页也不会中断
- **群聊**：单次 LLM 调用模拟多人设发言，按关系权重随机挑选发言人
- **AI 记忆与关系**：客观事实 + 相处语气两个维度的记忆摘要，五维度好感度/熟悉度等关系数值（对用户隐藏具体数字）
- **朋友圈**：AI 之间有关系链、会互相点赞评论，动态偶尔配图（Pexels/waifu.pics 搜图，非 AI 生图），评论区支持表情包和跟评（"A 回复 B"），后台自动生成回复
- **AI 自主行为**：开关控制的"看起来自主"的主动发消息 / 发朋友圈（有冷却和每日上限，避免无节制消耗 API）
- **日程系统**：每个联系人有固定作息 + 聊天协商出的临时例外，影响朋友圈发布时机和是否方便被联系
- **知识库 + 世界观**：聊天中提到不认识的梗/番剧/游戏会触发一次性联网搜索（Tavily）归纳成知识条目；世界观支持自己写或 AI 帮写，可收藏多份
- **小游戏化系统**：待办 / 委托（AI 发布任务，报酬用虚拟货币结算）/ 商城 / 仓库（送礼物给联系人）
- **其他**：未读消息红点、管理员模式（"天眼"调试页，查看 console 日志和数据库状态）

## 技术栈

React + TypeScript + Vite，Tailwind CSS v4，`react-router-dom`（HashRouter），Zustand（状态管理），Dexie（IndexedDB 封装）。安卓端通过 Capacitor 打包。

## 快速开始

```bash
npm install
cp .env.example .env   # 填入下面的 API Key
npm run dev
```

`vite.config.ts` 里 `server.host: true`，同一局域网下手机浏览器可以直接访问 `http://<电脑局域网IP>:5173` 联调。

### API Key 说明

| Key | 是否必需 | 用途 | 获取方式 |
| --- | --- | --- | --- |
| `VITE_DEEPSEEK_API_KEY` | **必需** | 聊天、人设生成等所有 LLM 调用 | [platform.deepseek.com](https://platform.deepseek.com/) |
| `VITE_TAVILY_API_KEY` | 可选 | 知识库联网搜索 | [tavily.com](https://tavily.com/) 免费注册 |
| `VITE_PEXELS_API_KEY` | 可选 | 联系人头像/朋友圈配图搜图 | [pexels.com/api](https://www.pexels.com/api/) 免费注册 |

没配置的可选 key 对应功能会自动跳过（比如没有 Pexels key，头像就还是默认 emoji），不影响主流程。也可以不写 `.env`，直接在应用内"我 - 设置"页面填写，保存在浏览器本地。

## 打包安卓 APK

Capacitor 相关依赖已经装好。本地需要 Android SDK + JDK（装一个 Android Studio 最简单）。

```bash
npm run build
npx cap add android      # 只需执行一次，已存在则跳过
npx cap sync android
cd android
./gradlew assembleDebug  # Windows 用 gradlew.bat
```

产物在 `android/app/build/outputs/apk/debug/app-debug.apk`，debug 签名，可以直接安装到手机上（Release 页面也提供预编译好的 APK，见仓库右侧 Releases）。

## 开发命令

- `npm run dev` — 启动开发服务器
- `npm run build` — 类型检查 + 构建生产包
- `npm run test:e2e` — Playwright 回归测试（会自动启动或复用 dev server）

## 发布 APK

**必须用 `npm run release:apk`**，不要手动 `npm run build` + `cap sync`。

脚本会自动：
1. 把 `.env` 里的真实 key 替换为空值再构建（防止 key 被打进 APK）
2. 构建完成后解压 APK 扫描，确认没有泄漏真实 key
3. 恢复原始 `.env`

发布出去的 APK 不含内置 key，用户首次打开后在"我 → 设置"里填写自己的 key 即可正常使用。

## 数据备份

设置页提供**导出备份**和**导入恢复**功能，覆盖联系人、聊天记录、朋友圈、表情包、仓库、知识库和当前设置。

⚠️ **备份文件可能包含你填写的 API Key，请不要发给别人。**
