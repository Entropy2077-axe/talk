# Talk UI 精简重构计划

## 背景

当前 Talk 应用的"发现"页和"我"页（设置部分）功能过于复杂，入口过多，导致：
1. 新用户不知道从哪里开始
2. 常用功能被次要功能淹没
3. 概念层级混乱（模组/Prompt模块/设置/预设）
4. 动态生成的入口位置不固定，用户难以形成记忆

**目标**：精简"我"页入口，将高级功能收起，让新用户只看到 3-6 个核心设置。

---

## Phase 1: 精简"我"页 (MePage.tsx)

### 当前状态分析

**现有入口（13个一级入口）**：
1. 编辑个人资料（头像区域）
2. 体验模式
3. 全屏切换
4. 软件风格切换
5. LLM 设置
6. 绘图工具
7. 预设
8. 模组
9. 表情包管理
10. 选择世界（条件显示）
11. 通用设置
12. 其他接口
13. 检查更新

**问题**：入口过多，次要功能（全屏、软件风格、绘图工具、预设、表情包）占据了与核心功能（LLM设置、模组）同等的位置。

### 目标结构

```
┌─ 我 ─────────────────────────────────┐
│ [头像] 用户昵称                        │
│        职业 · 点击编辑个人资料          │
│ ┌─────────────────────────────────┐  │
│ │ 我的余额 ¥1,234                  │  │
│ └─────────────────────────────────┘  │
│ [今日工资 - 签到领取] (条件显示)       │
├─ 使用体验 ─────────────────────────┤
│ › 体验模式                    沉浸模式 │
│ › 聊天外观                    配置外观 │
├─ AI 与内容 ────────────────────────┤
│ › LLM 设置              deepseek-chat│
│ › 模组                           7 个 │
│ › 选择世界 (条件显示)         当前世界 │
├─ 应用管理 ─────────────────────────┤
│ › 数据备份与恢复              导入/导出│
│ ▼ 高级设置 (默认收起)                 │
│   · 绘图工具                          │
│   · 预设                              │
│   · 表情包管理                        │
│   · 软件风格切换                      │
│   · 私聊工具判断                      │
│   · 其他接口                          │
│   · 货币图标设置                      │
│   · 世界经济隔离                      │
│   · 管理员模式                        │
│   · AI 调用预算                       │
│   · 危险操作                          │
│ › 检查更新                  当前 v0.x.x│
└──────────────────────────────────────┘
```

### 详细改动清单

#### 1.1 删除功能

**删除"全屏"按钮**
- **文件**: `src/pages/MePage.tsx`
- **位置**: 第 183-196 行
- **原因**: 
  - PC 端：用户可以用 F11 或浏览器自带全屏
  - Android 端：已有"体验模式"中的沉浸式模式
  - 这个功能占用了宝贵的一级入口位置
- **检查点**: 删除后确保相关状态管理代码一并清理（`isFullscreen`, `handleFullscreen`, `useEffect` 中的 fullscreen 监听器，`androidFullscreenActive` 模块级变量）

#### 1.2 移动到"高级设置"折叠区

**需要移入折叠区的功能**：

1. **软件风格切换**
   - 当前位置: MePage.tsx 第 198-210 行
   - 移动到: 高级设置折叠区
   - 保持功能不变，只改变位置

2. **绘图工具**
   - 当前位置: MePage.tsx 第 223-230 行
   - 移动到: 高级设置折叠区

3. **预设**
   - 当前位置: MePage.tsx 第 231-238 行
   - 移动到: 高级设置折叠区

4. **表情包管理**
   - 当前位置: MePage.tsx 第 248-256 行
   - 移动到: 高级设置折叠区

5. **其他接口**
   - 当前位置: MePage.tsx 第 263 行
   - 移动到: 高级设置折叠区

6. **从 SettingsPage.tsx 移入的项目**：
   - 私聊工具判断 (SettingsPage.tsx 第 164-197 行)
   - 货币图标设置 (SettingsPage.tsx 第 328-357 行)
   - 世界经济隔离开关 (SettingsPage.tsx 第 361-367 行)
   - 管理员模式开关 (SettingsPage.tsx 第 401-413 行)
   - AI 调用预算 (SettingsPage.tsx 第 428 行)
   - 危险操作：清空联系人 (SettingsPage.tsx 第 415-426 行)

#### 1.3 新增功能

**新增"聊天外观"入口和页面**

**步骤 A: 在 MePage.tsx 添加入口**
- 位置: "使用体验"分组下，"体验模式"之后
- 显示文本: "聊天外观"
- 跳转路径: `/chat-appearance`

**步骤 B: 创建新页面 `/src/pages/ChatAppearancePage.tsx`**

该页面需要整合以下设置（来自 SettingsPage.tsx）：

1. **聊天分页设置** (SettingsPage 第 202-217 行)
   - 每次加载消息条数选择器
   - 默认值 40 条
   - 恢复默认按钮

2. **回复等待超时** (SettingsPage 第 217-251 行)
   - 开关控制
   - 超时时间输入框（秒）
   - 默认 60 秒

3. **外观设置** (SettingsPage 第 254-324 行)
   - 顶部显示区域微调滑块（0-80px）
   - 界面动效开关
   - 聊天背景色选择器（预设色块 + 颜色选择器 + 上传图片）
   - 背景图片裁剪器（使用 ImageCropper 组件）

**页面结构参考**：
```typescript
import { useRef, useState } from 'react'
import { TopBar } from '../components/TopBar'
import { ToggleSwitch } from '../components/ToggleSwitch'
import { ImageCropper } from '../components/ImageCropper'
import { useSettingsStore } from '../store/useSettingsStore'
import { CHAT_PAGE_SIZE_OPTIONS, normalizeChatPageSize } from '../lib/chatPagination'

export function ChatAppearancePage() {
  const {
    chatPageSize,
    chatResponseTimeoutMs,
    topInsetAdjustmentPx,
    animationsEnabled,
    chatBackground,
    setSettings,
  } = useSettingsStore()
  
  const backgroundInputRef = useRef<HTMLInputElement | null>(null)
  const [backgroundCropSrc, setBackgroundCropSrc] = useState('')
  const presetBackgrounds = ['#f4f4f6', '#f7f0e8', '#eef6f1', '#edf4ff', '#f5efff', '#fff3f0', '#f3f6e8', '#eef7f7']

  async function handleBackgroundImage(file: File) {
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') setBackgroundCropSrc(reader.result)
    }
    reader.readAsDataURL(file)
  }
  
  return (
    <div className="flex h-[var(--app-height)] flex-col overflow-hidden bg-[var(--ui-bg)]">
      <TopBar title="聊天外观" showBack />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {/* 第一部分：聊天分页 */}
        <h2 className="px-4 pb-1 pt-5 text-xs font-medium text-[var(--ui-text-3)]">聊天</h2>
        <section className="mt-3 bg-[var(--ui-surface)] px-4 py-3">
          {/* ... chatPageSize 选择器和恢复默认按钮 ... */}
        </section>

        {/* 第二部分：回复超时 */}
        <section className="mt-3 bg-[var(--ui-surface)] px-4 py-3">
          {/* ... chatResponseTimeoutMs 开关和时间输入 ... */}
        </section>

        {/* 第三部分：外观 */}
        <h2 className="px-4 pb-1 pt-5 text-xs font-medium text-[var(--ui-text-3)]">外观</h2>
        <section className="mt-3 bg-[var(--ui-surface)] px-4 py-3">
          {/* ... topInsetAdjustmentPx 滑块、animationsEnabled 开关、chatBackground 选择器和图片上传 ... */}
        </section>
      </div>
      
      {/* 背景图片裁剪器 */}
      {backgroundCropSrc && (
        <ImageCropper
          src={backgroundCropSrc}
          aspectRatio={0.68}
          mode="frame"
          title="裁剪聊天背景"
          onCancel={() => setBackgroundCropSrc('')}
          onConfirm={(dataUrl) => {
            setSettings({ chatBackground: dataUrl })
            setBackgroundCropSrc('')
          }}
        />
      )}
    </div>
  )
}
```

**步骤 C: 注册路由**
- 文件: `src/App.tsx`
- 在 routes 中添加: `<Route path="/chat-appearance" element={<ChatAppearancePage />} />`

**步骤 D: 懒加载**
- 在 `App.tsx` 顶部添加: `const ChatAppearancePage = lazy(() => import('./pages/ChatAppearancePage').then(m => ({ default: m.ChatAppearancePage })))`

**新增"数据备份与恢复"一级入口**

- 将 SettingsPage.tsx 第 369-397 行的"数据备份与恢复"整段代码移到 MePage.tsx
- 放在"应用管理"分组下
- 保持功能完全不变（导出备份、导入恢复、状态提示）
- 注意：Android 平台的 BackupDirectory 逻辑需要一并保留

**新增"高级设置"折叠区**

实现方式：
```typescript
const [advancedExpanded, setAdvancedExpanded] = useState(false)

// 在 MePage 的"应用管理"分组中添加：
<button 
  onClick={() => setAdvancedExpanded(!advancedExpanded)}
  className="flex w-full items-center justify-between border-b border-[var(--ui-border-soft)] px-4 py-3.5 text-left active:bg-gray-50"
>
  <span className="text-[15px] text-gray-900">高级设置</span>
  <svg 
    width="18" 
    height="18" 
    viewBox="0 0 24 24" 
    fill="none"
    className={`transition-transform ${advancedExpanded ? 'rotate-90' : ''}`}
  >
    <path d="M9 5l7 7-7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
</button>

{advancedExpanded && (
  <div className="border-t border-[var(--ui-border-soft)] bg-[var(--ui-surface-2)]">
    {/* 所有被移入的高级功能，每个保持为独立的 button */}
  </div>
)}
```

**默认状态**: 折叠（`advancedExpanded` 初始为 `false`）

#### 1.4 调整现有入口顺序

**调整后的顺序**：

**使用体验** 分组:
1. 体验模式 (immersive/free)
2. 聊天外观 (新增)

**AI 与内容** 分组:
1. LLM 设置
2. 模组
3. 选择世界 (条件显示：`saveLoadEnabled`)

**应用管理** 分组:
1. 数据备份与恢复 (从 SettingsPage 移入)
2. 高级设置 (新增折叠区)
3. 检查更新

**删除的分组和入口**:
- ❌ 删除"通用设置"入口（内容已拆分）
- ❌ 删除"其他接口"入口（移入高级设置）

---

## Phase 2: 处理 SettingsPage.tsx

### 当前状态

`SettingsPage.tsx` 是一个独立的长页面，包含：
- AI 与创作 (私聊工具判断)
- 聊天体验 (分页、超时)
- 外观 (顶部调整、动效、背景)
- 货币图标
- 世界经济隔离
- 数据备份
- 管理员模式
- AI 调用预算
- 危险操作

### 改动方案

**不删除 SettingsPage.tsx 文件**，但要：

1. **移除已迁移的内容**：
   - 聊天体验 → 已移到 ChatAppearancePage
   - 外观设置 → 已移到 ChatAppearancePage
   - 数据备份 → 已移到 MePage
   - 其他内容 → 已移到 MePage 的高级设置

2. **保留但重构的内容**：
   - 如果 Phase 1 后 SettingsPage 还有剩余内容，将其整合到一个"其他设置"页面
   - 或者直接将 SettingsPage.tsx 改为仅显示"该页面已废弃，请从'我'页进入相关设置"的提示页

3. **路由处理**：
   - 保留 `/settings` 路由（避免破坏用户书签）
   - 但让它重定向到 `/me` 或显示迁移提示

---

## Phase 3: 移动端特殊处理

### Android 特有逻辑

**需要注意的 Android 专属功能**：

1. **今日工资签到** (MePage.tsx 第 158-171 行)
   - 这个功能在 PC 端也显示，但依赖 `careerEnabled` 模组
   - 无需区分平台，保持现有逻辑

2. **全屏/沉浸式模式** (MePage.tsx 第 76-94 行)
   - Android: 使用 Capacitor Fullscreen 插件的 `activateImmersiveMode`
   - PC: 使用 `document.requestFullscreen`
   - **改动**: 完全删除这个功能（无论平台）

3. **备份导出** (SettingsPage.tsx 第 71-76 行)
   - Android: 使用 `BackupDirectory.stage` 和 `BackupDirectory.saveStaged`
   - PC: 使用 `URL.createObjectURL` + `<a>` 下载
   - **改动**: 将此逻辑完整移到 MePage，保持平台判断不变

4. **应用内更新** (MePage.tsx 第 116-137 行)
   - Android: 使用 `InAppUpdate.downloadAndInstall`
   - PC: 使用 `window.open` 打开 GitHub Release
   - **改动**: 保持不变

### PC 端特有逻辑

**PC 端无特殊限制**，所有功能均可用。

### 跨平台兼容检查清单

在实施时，请确保以下内容在两个平台都正确：

- [ ] MePage 在 Android 和 PC 上的布局一致
- [ ] ChatAppearancePage 的背景图片上传在两端都能用
- [ ] 备份导出/导入在 Android 使用原生选择器，PC 使用浏览器下载
- [ ] 全屏功能完全移除后，Android 的状态栏/导航栏通过"体验模式"控制
- [ ] 所有新增的路由在两端都能正常跳转

---

## Phase 4: 代码审查检查点

### 文件修改清单

**需要修改的文件**：
1. `src/pages/MePage.tsx` - 大幅重构
2. `src/pages/SettingsPage.tsx` - 移除大部分内容或废弃
3. `src/pages/ChatAppearancePage.tsx` - **新建**
4. `src/App.tsx` - 添加新路由

**需要检查的文件**：
1. `src/store/useSettingsStore.ts` - 确保所有设置字段的读写正确
2. `src/features/index.ts` - 确保模组逻辑未受影响
3. `src/components/TopBar.tsx` - 确保新页面的返回按钮正确

### 功能完整性检查

**迁移后必须保留的功能**：
- [ ] 体验模式切换（沉浸/自由）
- [ ] LLM 设置（API Key、模型、Base URL）
- [ ] 模组开关
- [ ] 选择世界（条件显示）
- [ ] 聊天分页大小
- [ ] 回复超时设置
- [ ] 顶部显示区域调整
- [ ] 界面动效开关
- [ ] 聊天背景色/图片上传
- [ ] 数据备份导出/导入
- [ ] 软件风格切换（移到高级设置）
- [ ] 绘图工具配置
- [ ] 预设管理
- [ ] 表情包管理
- [ ] 其他接口配置
- [ ] 私聊工具判断（LLM/Jev）
- [ ] Jev API Key 配置
- [ ] 货币图标设置
- [ ] 世界经济隔离开关
- [ ] 管理员模式开关
- [ ] 余额设定（管理员功能）
- [ ] AI 调用预算
- [ ] 清空联系人（危险操作）
- [ ] 检查更新

**必须删除的功能**：
- [ ] 全屏按钮（包括相关状态管理）

### UI 一致性检查

**样式规范**：
- 使用现有的 CSS 变量：`var(--ui-bg)`, `var(--ui-surface)`, `var(--ui-text)` 等
- 使用现有的 UI 组件：`TopBar`, `ToggleSwitch`, `ActionSheet`
- 保持圆角、间距、字体大小与现有页面一致

**响应式检查**：
- MePage 在折叠"高级设置"时的动画流畅
- ChatAppearancePage 在移动端和 PC 端都能正常滚动
- 背景图片裁剪器在两端都能用

### 性能检查

- [ ] MePage 的"高级设置"折叠不会导致整页重新渲染
- [ ] ChatAppearancePage 的懒加载正确
- [ ] 备份导出不会阻塞 UI（已有异步处理，保持不变）

---

## Phase 5: 测试用例

### 手动测试清单

**PC 端测试**：
1. [ ] 打开"我"页，确认只看到 6 个一级入口 + 1 个折叠
2. [ ] 点击"聊天外观"，进入 ChatAppearancePage
3. [ ] 在 ChatAppearancePage 修改聊天背景，返回后生效
4. [ ] 点击"高级设置"，展开后看到所有次要功能
5. [ ] 在高级设置中修改"软件风格切换"，界面风格改变
6. [ ] 点击"数据备份与恢复"，导出备份成功
7. [ ] 导入刚才的备份，数据恢复成功
8. [ ] 确认"全屏"按钮已消失，按 F11 仍可全屏

**Android 端测试**：
1. [ ] 打开"我"页，布局与 PC 端一致
2. [ ] 点击"聊天外观"，进入 ChatAppearancePage
3. [ ] 上传聊天背景图片，使用 Android 图片选择器
4. [ ] 点击"数据备份与恢复" → "导出备份"，使用 Android 文件选择器保存
5. [ ] 导入备份，使用 Android 文件选择器打开
6. [ ] 确认"全屏"按钮已消失，通过"体验模式"切换沉浸式
7. [ ] 检查更新功能，下载 APK 并安装

### 回归测试

**确保未破坏的功能**：
- [ ] 修改 LLM 设置后，聊天仍能正常调用 API
- [ ] 开关模组后，对应功能正常启用/禁用
- [ ] 切换世界后，联系人列表正确更新
- [ ] 修改聊天分页大小后，打开聊天页加载正确数量的消息
- [ ] 开启回复超时后，超时能正确触发

---

## Phase 6: 发布说明

### 更新日志

```markdown
## v0.x.x - UI 精简与优化

### 改进
- **精简"我"页入口**：将 13 个一级入口缩减为 6 个，次要功能收到"高级设置"折叠区
- **新增"聊天外观"页面**：统一管理聊天背景、动效、分页和超时设置
- **优化设置组织**：将分散的设置整合到对应功能入口，更易查找

### 移除
- **移除"全屏"按钮**：PC 端用户可使用 F11，Android 用户可使用"体验模式"中的沉浸式模式

### 迁移指南
- "通用设置"中的聊天相关配置已移到"聊天外观"
- "通用设置"中的数据备份已移到"我"页一级入口
- 软件风格切换、绘图工具、预设等高级功能已移到"高级设置"折叠区
```

### 用户沟通

**对于可能的用户疑问**：

1. **"全屏按钮哪去了？"**
   - PC 端：按 F11 进入全屏
   - Android 端：使用"体验模式 → 沉浸模式"获得更好的沉浸体验

2. **"找不到设置了？"**
   - 常用设置已整合到"我"页的分组中
   - 高级设置在"我"页底部的"高级设置"折叠区

3. **"为什么要改？"**
   - 让新用户更容易上手
   - 将常用功能和高级功能区分开
   - 减少界面复杂度

---

## 实施注意事项

### 代码风格

- 保持与现有代码一致的命名和格式
- 使用 TypeScript 类型，不要用 `any`
- 组件使用函数式组件，不要用类组件

### Git 提交

建议分多个提交：

1. `refactor(me): reorganize MePage entries and add advanced section`
2. `feat(appearance): add ChatAppearancePage for chat UI settings`
3. `refactor(settings): migrate backup/restore to MePage`
4. `refactor(settings): move advanced features to collapsible section`
5. `chore(me): remove fullscreen button`

### 回滚方案

如果发现重大问题，可以：
1. 保留 SettingsPage 的完整备份
2. 在 MePage 添加"返回旧版设置"的临时入口
3. 收集用户反馈后再决定是否继续

---

## 附录：文件路径速查

- **MePage**: `src/pages/MePage.tsx`
- **SettingsPage**: `src/pages/SettingsPage.tsx`
- **ChatAppearancePage**: `src/pages/ChatAppearancePage.tsx` (新建)
- **App 路由**: `src/App.tsx`
- **Settings Store**: `src/store/useSettingsStore.ts`
- **TopBar 组件**: `src/components/TopBar.tsx`
- **ToggleSwitch 组件**: `src/components/ToggleSwitch.tsx`
- **ImageCropper 组件**: `src/components/ImageCropper.tsx`
- **BackupDirectory 插件**: `src/lib/backupDirectory.ts`

---

## 最终检查清单

在提交前，请确认：

- [ ] 所有提到的功能都已迁移，没有遗漏
- [ ] MePage 只有 6 个一级入口 + 1 个高级折叠
- [ ] ChatAppearancePage 已创建并正确注册路由
- [ ] "全屏"按钮和相关代码已完全删除
- [ ] 高级设置默认折叠
- [ ] 数据备份功能在两个平台都能用
- [ ] 所有设置的读写都通过 useSettingsStore
- [ ] 代码中没有 console.log 等调试语句
- [ ] TypeScript 编译无错误
- [ ] Lint 检查通过
- [ ] 在 PC 和 Android 上都测试过
- [ ] 更新日志已准备好

---

**预期完成时间**: 2-3 小时（不含测试）

**风险评估**: 低（主要是 UI 重组，核心逻辑不变）

**优先级**: 中（用户体验改进，非紧急 bug）
