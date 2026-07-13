# 参与贡献

感谢你愿意帮助 Talk 变得更好。提交代码前，请先搜索现有 Issue，避免重复工作；较大的功能建议请先开 Discussion 或 Issue 对齐方向。

## 本地开发

1. Fork 仓库并创建功能分支。
2. 复制 `.env.example` 为 `.env`，填写你自己的 API Key；任何 Key 都不能提交到仓库。
3. 运行 `npm install` 和 `npm run dev`。
4. 提交前运行：

```bash
npm run lint
npm run test:unit
npm run build
npm run test:e2e
```

## 提交约定

- 每个 PR 聚焦一个问题，说明修改动机、验证方式和界面变化。
- UI 改动请附截图或短视频；数据库结构变化请说明 Dexie 迁移策略。
- 独立整页路由必须使用有硬高度边界的滚动布局，避免底部栏被内容撑出视口。
- 聊天请求与回复逻辑应保留在 `src/lib/chatEngine.ts` 等后台引擎中，不要重新绑定到页面组件生命周期。
- 不要提交 `.env`、APK、真实聊天数据或包含 API Key 的备份。

适合第一次贡献的任务会标记 [`good first issue`](https://github.com/Entropy2077-axe/talk/labels/good%20first%20issue)。
