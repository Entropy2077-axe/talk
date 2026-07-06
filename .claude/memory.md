# 架构设计记忆（独立于 CLAUDE.md 中的操作细节）

## 好感度系统：单维度 warmth(-100 ~ +100)

### 评分方式
好感度变化由**多功能模型(utilityModel)**在记忆更新时一并评估，不再使用正则匹配。
每次攒够10条新消息 → `maybeUpdateMemory()` → 一次API调用同时输出:
```
{ facts, style, plans, warmthDelta: -5~+5, relationshipAssessment: "..." }
```

### 阶段仅用于展示
WARMTH_STAGES 定义了好感度区间标签（"刚认识""关系不错""很亲密"等），**不触发任何逻辑**。
所有逻辑由 `relationshipAssessment` 文本 + warmth 数值直接驱动。

### 关系双层模型
| 层 | 字段 | 谁决定 | 可改？ |
|---|---|---|---|
| 基础关系 | `relationshipBase` | 用户创建时设定 | 用户手动 / 模型评估触发自动变更 |
| 当前状态 | `relationshipDynamic` | 评分模型每次更新 | 每次记忆更新都刷新 |

### 分手/升级检测
- `containsBreakupLanguage()` — 26个关键词匹配
- 检测到分手 → warmth额外扣30 + prompt注入"⚠️ 刚刚分手"警告
- `shouldUpdateBase()` — warmth < 20 + 分手词 → base自动变为'朋友'
- `containsUpgradeLanguage()` — 11个关键词，warmth ≥ 50 → base变为'恋人'

### 性格特质钩子
`Contact.personalityTrait?: string` — 预留给未来角色性格（病娇/天然呆等）。
`traitWarmthModifier(trait, delta)` — 当前透传，未来在这里做每个性格的delta缩放。

## 提示词系统：4段压缩结构

```
1. 你是谁       — stylePrompt + persona + relationshipLine(含阶段提示词+分手警告)
2. 你们的记忆   — memoryFacts + memoryStyle
3. 当前情境     — 时间/用户/事件/约定/日程/知识库 → bullet list
4. 输出格式     — JSON示例保留（few-shot锚点），周围散文精简
```
总长度从 ~2800字 压缩到 ~950字。

## 多功能模型 utilityModel

`settings.utilityModel`（原 shopModel）：商城生成、好感度评分/记忆更新、世界观草稿等辅助任务共用。
设置页标签："多功能模型"

## 已删除的子系统
- 委托系统（Commission）— 整个删除，含DB表、UI、解析、e2e测试
- 五维关系数值（RelationshipDimensions）— 替换为单维warmth
- 正则关系变化（inferRelationshipDeltaFromTurn）— 替换为LLM评分
- RelationshipNotice 组件 — 删除
- 天眼布局诊断 + AI响应质量监控 — 删除

## 好感度初始值
创建联系人时根据 relationshipBase 设定:
恋人 +60 / 家人 +55 / 暧昧对象 +35 / 朋友 +30 / 损友 +25 / 前辈同事 +15 / 默认 0
