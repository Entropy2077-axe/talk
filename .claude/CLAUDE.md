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
- **安卓策略**: 响应式 Web（`.app-shell` 在 PC 端居中显示手机宽度的卡片，移动端全屏铺满），同时**已经真正打包成 Capacitor 原生 APK**（见下面"Capacitor 安卓打包"章节，不再是占位阶段）。**用户本地已装好 Android Studio，路径 `C:\Projects\AndroidStudio`**，Android SDK 在默认的 `%LOCALAPPDATA%\Android\Sdk`。
- **API Key 处理**: DeepSeek/Tavily/Pexels 三个 key 都写在根目录 `.env`，已加入 `.gitignore`。**打包APK发布前必须把 `.env` 里的key清空重新构建**，见下面章节——Vite 会把 `import.meta.env.VITE_*` 在构建时原样内联进编译后的JS里，APK本质是个zip包，解压就能看到明文key，绝对不能带着真key构建要对外分发的包。
- **独立路由页面的高度陷阱（踩过坑，别再犯，而且真的又犯过一次）**：不在 `TabLayout` 里的整页路由（`ChatPage`、`ContactAddPage`、`ProfileEditPage` 等，需要内容区滚动+底部按钮/输入框固定）**不能用 `min-h-full`**。`.app-shell` 只有 `min-height`，不是 `height`，导致子元素的百分比高度解析不确定，`flex-1` 拿不到真实剩余空间，底部固定栏会紧跟在内容后面而不是贴在可视区域底部。正确写法：根容器用 `h-[var(--app-height)] flex flex-col overflow-hidden`，中间滚动区用 `flex-1 overflow-y-auto`，底部栏保持普通flow（`--app-height`是什么、为什么不直接用`h-dvh`，见下面"Capacitor 安卓打包"章节里的踩坑记录）。**这条教训曾经只被应用到`ChatPage`/`ContactAddPage`/`GroupAddPage`/`GroupInfoPage`/`ProfileEditPage`/`SkyEyePage`这几个页面，但`ContactCardPage`/`MomentsPage`/`RelationshipsPage`/`SettingsPage`/`ShopPage`/`StickersPage`/`TodoPage`/`WarehousePage`/`WorldSettingsPage`这9个页面从一开始就没套用这个规则、一直用的是`min-h-full`**——这些页面早期内容比较少、恰好没超出屏幕高度，问题被长期掩盖，直到这个session陆续给这些页面加了很多新section（Tavily/Pexels设置、AI自主行为开关、管理员模式开关等）之后终于超出可视区域，`.app-shell`的`overflow:hidden`直接裁切掉超出部分且不可滚动触及——**用户反馈"测试连接按钮/AI自主行为开关/管理员模式开关都莫名其妙消失了"，一度怀疑是具体某个按钮的bug，用Playwright实测才确认是这个全局布局问题**（`.app-shell`实际渲染高度远超视口，且document级别虽然技术上能滚动露出内容，但整个"手机卡片"外壳会跟着一起滚走，体验上等于"看起来彻底消失了"）。已经把这9个页面全部统一改成`h-[var(--app-height)] flex-col overflow-hidden`+内部`flex-1 overflow-y-auto`。**以后新建任何独立整页路由，第一件事就是检查根容器是不是这个模式，不要抄`min-h-full`，TabLayout内部的5个tab页面（`MessagesPage`/`ContactsPage`/`DiscoverPage`/`MePage`）除外——那几个在`TabLayout`自己的`overflow-y-auto`包裹层里面，`min-h-full`在那种场景下是安全的。**

## Capacitor 安卓打包（`android/` 目录本身被 `.gitignore` 排除，不进仓库）
**排查荣耀60渲染bug时发现这台机器上装了两套完整的Android SDK**（`%LOCALAPPDATA%\Android\Sdk`和`D:\ProjectsD\AndroidStudioSDK`各有一份`platform-tools\adb.exe`），两个adb daemon会抢USB设备的连接——如果以后又遇到"adb devices明明设备驱动装好了但列表就是空的"，先检查是不是有另一个adb.exe进程占着连接，`Get-Process | Where-Object ProcessName -match adb`能看到具体是哪个路径的。这次真机USB/无线调试最终因为这个沙盒执行环境自身的网络限制（USB驱动冲突之外，无线调试配对协议层也报错，怀疑是这个环境的网络出站路径对这类二进制协议不友好）没能跑通，绕过去改用"直接读Tailwind构建产物内容"找到了根因，没有真的走成chrome://inspect这条路——以后如果这个环境依然连不上真机调试，同样可以优先考虑"直接检查构建产物/依赖库的实际输出内容"这条路，往往比远程调试更容易在这个环境里跑通。

用户要求"发到GitHub上面 + 打包成APK提交Release"。流程：`npm run build` → `npx cap add android`（首次）/`npx cap sync android` → 用 Android Studio 自带的 SDK/JDK（`C:\Projects\AndroidStudio\jbr` 当 `JAVA_HOME`，`%LOCALAPPDATA%\Android\Sdk` 当 `ANDROID_HOME`）跑 `gradlew assembleDebug`，产物在 `android/app/build/outputs/apk/debug/app-debug.apk`。用 `gh release create` 把APK当附件发到GitHub Release。

**发布前踩过一个真实的密钥泄漏事故，流程里必须固定下来**：第一次直接拿本地正常开发用的 `.env`（真实DeepSeek/Tavily/Pexels key）跑的构建，Claude Code的安全分类器在执行`gh release create`时拦截了操作，原因是Vite会把`import.meta.env.VITE_*`在构建时原样内联成字符串编进产物JS里，`dist/`会被`cap sync`原样拷进`android/app/src/main/assets/public`、最终打进APK——APK本质就是个zip，解压grep一下明文key全出来了。**正确流程**：发布用的构建必须先把`.env`临时替换成空值版本（`cp .env .env.backup` 备份，写一份`VITE_xxx=`全空的`.env`）→ `rm -rf dist && npm run build` → `npx cap sync android` → 构建APK → **把APK解压后对全部文件grep一遍确认三个真实key的字符串一个都不在里面**才能发布 → 发布完把`.env.backup`还原回真实key继续本地开发。这一套"空key构建、解压核实、再还原"流程以后每次发新版本APK都要重复，不能图省事跳过验证步骤。好在这不影响功能——app本来就支持用户在"我-设置"页面手动填key（存localStorage，不依赖编译时常量），所以发布出去的APK没内置key完全不影响正常使用，只是需要用户自己填一次。
- 当前用的是**debug签名**（Gradle默认自带的debug keystore），可以直接装机，但不是应用商店发布用的正式签名。如果以后要长期维护同一个签名身份（比如后续版本要保留升级路径），需要额外生成一个真正的release keystore，目前没做这一步。

**上线后真实反馈的Bug：安卓APK里底部菜单栏(BottomNav)没有贴在屏幕最下面**——排查+修复记录：
- root cause属于一类广为人知的Capacitor Android WebView布局坑（社区里能查到大量类似issue，比如`ionic-team/capacitor`仓库的"WebView不能撑满全屏高度"、"导航栏遮挡应用界面"这类）：这个项目全局依赖`100dvh`/`h-dvh`（`.app-shell`的`min-height`、以及`ChatPage`/`ContactAddPage`等好几个独立整页路由的根容器）来撑满可视区域高度，这套viewport unit在桌面浏览器和手机浏览器里测试一直正常（这个session之前所有Playwright测试都是拿真实浏览器测的），但Capacitor包出来的**不是浏览器tab，是原生WebView控件**，对`dvh`、以及跟Android系统导航栏/状态栏叠加区域相关的可视高度计算，不一定跟真正的移动端浏览器完全一致——具体是`dvh`本身计算不对、还是跟系统导航栏（手势条/三大金刚键）叠加区域的兼容问题，因为没有真实安卓设备/模拟器能在这个沙盒环境里直接复现验证，没有100%实锤到底是哪一层，但两种可能都指向同一个结论："CSS viewport unit在这个WebView环境下不可信"。
- **修复思路是彻底绕开这个问题，不去猜到底是dvh不支持还是安全区计算错误**：用JS读`window.innerHeight`（这是任何JS引擎都保证准确反映实际可视高度的基础API，不存在CSS viewport unit那些历史遗留的兼容性坑）写进一个CSS自定义属性`--app-height`，`main.tsx`里页面一加载就同步一次、并监听`resize`/`orientationchange`持续同步。`index.css`的`:root`给`--app-height`一个`100dvh`的兜底初始值（JS跑起来之前那一瞬间用）。`.app-shell`的`min-height`和所有页面的`h-dvh`（`ChatPage`/`ContactAddPage`/`GroupAddPage`/`GroupInfoPage`/`ProfileEditPage`/`SkyEyePage`）全部换成`h-[var(--app-height)]`（Tailwind v4任意值语法）。这是"移动端100vh不可靠"这个老问题的经典解法，比`dvh`还早、比`dvh`更可靠，因为它完全不依赖CSS引擎对某个viewport unit关键字的支持程度。
- **这个修复没能在真安卓设备/模拟器上实测**（本地SDK装的是`platforms`/`build-tools`/`platform-tools`/`cmdline-tools`，唯独没装`emulator`这个包，临时装模拟器+起模拟器的成本较高，没有为了验证这一个CSS修复去走这条路）——只用真实Chromium浏览器（Playwright）验证了修复后`--app-height`能正确同步、`BottomNav`在浏览器里精确贴底（`viewport高度 - (nav.y+nav.height) === 0`），逻辑上这个JS测高度的方案对任何渲染环境都应该同样有效，但**如果用户装了新APK之后菜单栏还是没贴底，下一步应该是想办法真正拿到一台安卓设备或模拟器直接调试，而不是继续猜测CSS细节**。**后续用户自己在Android Studio里装好了模拟器**，以后有类似"CSS在Playwright里测着没问题但Android上有问题"的情况，应该直接引导用户用模拟器实测，而不是继续靠猜测/查社区issue这条路。

**上面这个`--app-height`修复发布之后，用户在真实荣耀60上装了新版还是复现——加了`SkyEyePage`布局诊断区块（见下面天眼章节）之后，用户提供的真实设备数据显示`window.innerHeight`/`visualViewport.height`/`--app-height`计算值/`.app-shell`实际测量高度这四个数字完全一致，也就是说JS这层测出来的数字根本没错**——问题指向另一层：`userAgent`里能看到这台设备的WebView内核停在`Chrome/99`（2022年3月的版本，4年多没更新，大概率是国行荣耀没有Google Play无法走标准WebView自动更新通道）。这么老的Blink内核，一个已知的坑是**通过`element.style.setProperty()`修改CSS自定义属性时，不一定会正确让隔了好几层DOM、通过`var()`引用它的后代元素触发重绘**——数值算对了，但真正需要用到这个高度的元素没有正确重绘/应用。**修复**（`main.tsx`）：`syncAppHeight()`除了设`--app-height`这个CSS变量，还**直接**把`.app-shell`元素的`minHeight`当内联样式设一遍（绕开var()引用链，对这一个最关键的元素做兜底），并且顺手读一次`document.body.offsetHeight`强制触发一次同步重排。**这个直接内联样式的兜底只在`.app-shell`第一次真正出现在DOM里之后才有意义**——`main.tsx`最早那次`syncAppHeight()`调用发生在`createRoot().render()`之前，这时候`.app-shell`还不存在，所以挂载后必须再补跑一次，用了`requestAnimationFrame`+`setTimeout(100ms)`两个机制一起兜底（不迷信只有一种时序机制一定会在需要的时候先于别的代码跑完，两个都挂上更保险）。**这个具体的repaint bug理论目前没有办法在这个沙盒环境里针对Chrome 99实锤验证**（连不上这么老的引擎去直接测），只能算是"从真实设备数据反推出的最合理解释"，如果装上新版本还是有问题，下一步大概率不是继续猜CSS细节，而是应该建议用户先去应用商店手动更新一下WebView内核，因为4年没更新的内核本身大概率还有其他没被发现的兼容性坑，靠不断打补丁去适配一个这么老的引擎收益会越来越低。
- **调试这个问题时顺带踩到一个跟代码本身无关的环境坑，记录一下避免以后重蹈覆辙**：开发过程中用`curl`直接测本地dev server（`http://localhost:5173`）一直返回502，一度以为dev server挂了，重启了好几次、换端口、杀进程查半天——**实际上dev server一直是好的，只是这个沙盒环境的`curl`（走Git Bash）和Playwright（独立Node进程）访问"localhost"走的网络路径不一样，Playwright能连通、curl连不通，502是这层网络路由本身的问题，不是vite进程的问题**。以后再遇到"改了代码但Playwright测试结果好像没变化"这种诡异情况，先用Playwright自己`fetch('/src/xxx.ts')`直接把dev server实际吐出来的源码内容打印出来确认一下版本，而不是先入为主地怀疑server挂了或者去用curl验证连通性——curl在这个环境里对localhost的判断不可信。

- **上面两轮修复（`--app-height`同步+`.app-shell`内联样式兜底）发布之后用户在荣耀60上还是复现，这次追问出了一句关键澄清，直接推翻了之前的整个排查方向**：用户明确说"按钮都是可用的 只是不显示而已"——**底部菜单栏其实是能点的（点击生效、能正常导航），只是没有被画出来（看不见）**。这跟之前一直假设的"元素被裁切/挤出可视区域导致点不到"是完全不同性质的bug：前者(能点但看不见)是浏览器渲染流程里**布局(layout)正确但绘制(paint)没跟上**——元素的位置、大小、可交互性都是对的，只是没有被真正画到屏幕上；后者(点不到)才是布局本身错了。也正因为是这样，之前基于"布局/高度算错了"这个前提做的两轮修复（`--app-height`用`visualViewport`同步、给`.app-shell`加内联样式兜底）从根上就没有对症，会一直无效也就不奇怪了。**教训：用户反馈"元素不见了/消失了"这种描述天然有歧义，一定要追问清楚"是彻底点不到，还是能点到只是看不见"，这两者对应的debug方向南辕北辙，不要自己脑补成"一定是布局挤出去了"就一头扎进CSS高度计算里。**
  - **重新定位到大概率的根因**：`BottomNav.tsx`用了`bg-white/95 backdrop-blur`（半透明+背景高斯模糊），`NotificationBanner.tsx`也用了同款`backdrop-blur`。`backdrop-filter`这个CSS特性需要走GPU合成层(compositing layer)，在老旧/低端Android设备的WebView+GPU驱动组合上（尤其是2022年前后的Chromium版本，配合某些型号的Mali/Adreno驱动）是有据可查的一类经典bug来源：合成层没有被正确绘制导致内容不可见，但因为**布局阶段是正常完成的、命中测试(hit-testing)不受绘制阶段影响**，所以元素的可点击区域和交互完全正常，只是视觉上"消失"——跟用户描述的现象完全吻合。**修复**：`BottomNav`和`NotificationBanner`都去掉了`backdrop-blur`和背景色的透明度(`bg-white/95`→`bg-white`纯色不透明)，彻底绕开`backdrop-filter`这条GPU合成路径，不再指望这么老的引擎+驱动组合能正确处理这个特效。搜过全项目只有这两处用了`backdrop-blur`，没有遗漏。
  - **这依然是从用户这一句关键澄清反推出的最可能解释，同样没条件在这个沙盒环境里针对Chrome 99+荣耀GPU驱动的具体组合去实锤复现验证**——如果这次发布之后还是没解决，说明真正的根因还要往深挖，下一步大概率得让用户配合走真机USB调试+`chrome://inspect`远程连模拟器/真机的DevTools，直接在这台设备上截取一次渲染层(layers/paint)信息，而不是继续靠"猜测某个CSS属性→改掉→发新包→等用户重新测"这种一轮几十分钟的慢循环。
  - **这一轮(去掉backdrop-blur)发布后用户实测依然复现，`chrome://inspect`真机远程调试也因为这个沙盒环境自身的网络限制（USB驱动冲突+无线调试配对协议层报错，折腾了一整轮ADB/WiFi调试都连不上）没能跑通**——两轮"猜CSS属性"都落空之后，改变策略：**不再猜测具体是哪个CSS特性有问题，而是直接去看Tailwind实际编译出来的CSS内容里用了什么**。一查发现`dist/assets/*.css`里`--color-gray-*`/`--color-red-*`/`--color-blue-*`等18个颜色token全部是用`oklch(...)`定义的——**这是Tailwind v4默认调色板的设计decision(v4从v3的纯hex/rgb改成了oklch色彩空间)，Chrome到111版本(2023年3月)才支持解析`oklch()`，而这台设备的WebView卡在Chrome 99(2022年3月)，整整早了一年**。CSS规范里一个属性的值如果解析不了(invalid at computed-value time)，继承型属性(比如`color`)会静默回退成"父元素算出来的颜色"而不是报错——这解释了"按钮布局、点击区域完全正常，但看起来消失了"这个现象：不是某个组件的绘制/合成bug，是**整个应用范围内所有用到Tailwind灰色/红色/蓝色等调色板的文字和背景色，在这台设备上全都解析失败、静默变成继承色**，`BottomNav`只是恰好第一个被用户注意到的地方，理论上其它页面同样受影响（比如各种`text-gray-400`辅助文字、`text-red-500`错误提示，只是可能因为背景/继承链凑巧显示得没那么明显而没被专门反馈）。**修复**：`src/index.css`里`@import 'tailwindcss'`之后加一个`@theme`块，把这18个`--color-*`token全部覆盖成Tailwind v3时代的经典hex值（同一个视觉颜色，只是从oklch色彩空间换成十六进制表达，任何浏览器包括最老的都认得），一次性、全局解决，不用一个个组件去排查。**这次没有再"从用户描述反推猜测"，而是直接读Tailwind构建产物的真实内容去确认问题范围**，这是这一整条排查链路里第一次拿到了可validate的直接证据（"确实有18处用了当时Chrome不支持的色彩语法"）而不是纯推理，比前两轮"合理但没法验证"的假设更可信。**用户装上v0.1.6之后确认问题真正解决了**——这是三轮修复尝试里唯一被实机验证成功的一次，前两轮(视口高度、backdrop-blur)都是合理但错误的方向。
  - **教训**：遇到"看起来消失了但其实还在(hit-testable)"这类"渲染层面表现异常"的bug，尤其是目标设备浏览器内核已知很旧的情况下，**排查顺序应该优先检查"我依赖的这些具体CSS语法/特性，这个内核版本发布的时候支持不支持"，而不是先假设是某个孤立组件的属性用错了**——`backdrop-filter`和`oklch()`都属于"现代CSS特性在老内核上会静默失效"这一类问题，前者是GPU合成层面的，后者是颜色解析层面的，性质不同但表现类似，都值得在处理"老设备渲染异常"时作为第一梯队的检查项，比逐个组件排查效率高得多。

**安卓物理/手势返回键会直接退出App（用户真机反馈的bug，已修复）**：Capacitor默认把Android的返回键交给原生WebView自己的页面历史栈处理，但这个app是`HashRouter`的单页应用，"返回"这个概念存在于react-router的hash历史里，不是WebView的整页加载历史，两者根本不是一回事，所以物理返回键在原生层面完全没有历史可退，直接触发了Android的默认行为——退出Activity。**修复**：装了`@capacitor/app`，`App.tsx`新增`useAndroidBackButton()`，监听`CapacitorApp.addListener('backButton', ({ canGoBack }) => ...)`——`canGoBack`是Capacitor原生桥自己维护的、"WebView历史栈里还有没有上一页"的判断，不需要自己在JS这边猜测/维护一套"当前是不是在根路由"的逻辑，有历史就`window.history.back()`（`HashRouter`底层就是真实的浏览器History API，这个调用会被react-router正确感知并处理导航），没历史（已经退到底）就老老实实`CapacitorApp.exitApp()`。这是Capacitor官方文档推荐的标准处理方式，不是这个项目自己发明的启发式判断。

**"选待办/点输入框时页面莫名其妙变长、底部菜单栏消失"（用户真机反馈，已修复）**：跟上面`--app-height`是同一根线上的坑，但触发条件不同——这次是软键盘弹出导致的。`main.tsx`原来只用`window.innerHeight`+`resize`/`orientationchange`事件同步`--app-height`，但Android WebView在软键盘弹出时（尤其配合`viewport-fit=cover`）常见的行为是**布局视口(layout viewport)本身不缩小，键盘只是盖在上面**，这种模式下`window.innerHeight`根本不会变、`resize`事件也不会因为键盘而触发——`--app-height`没跟着缩小，`.app-shell`还是撑到全屏高度，底部菜单栏就被键盘盖住了，视觉上就是"页面变长、菜单栏没了"。**修复**：改用`window.visualViewport?.height`（有则优先用，没有兜底回`innerHeight`），并且监听`visualViewport`自己的`resize`事件而不只是`window`的——`visualViewport`是专门追踪"当前实际可见区域"的API，键盘遮挡这种场景下才是它存在的意义，跟`window.innerHeight`（布局视口，键盘弹出不一定变）是两个不同的东西。真机上无法完全模拟真实软键盘，但用Playwright手动触发`visualViewport`的`resize`事件验证过监听链路本身是通的（`--app-height`确实会跟着`visualViewport.height`变化）。

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
- **打开聊天要立刻在最底部**：滚动effect从`useEffect`改成`useLayoutEffect`（在浏览器绘制前同步执行，避免打开长对话时先闪一下中间/顶部内容再跳到底部）。**这个功能曾经长期实际上完全没生效**（`scrollTop`一直停在0，只是因为对话通常刚好没长到需要滚动、没人真正注意到）——用Playwright真机测试才第一次实锤复现。根因分两层：
  1. 原写法是给列表末尾一个空`<div ref={bottomRef}/>`占位符调用`scrollIntoView()`，但排查发现这个ref在effect触发时**几乎每次都是`null`**——因为`conversation`/`contact`/`group`各自是独立的`useLiveQuery`，`messages`经常比`contact`更快resolve；只要`messages.length`先稳定下来，effect的依赖数组`[conversationId, messages.length, aiTyping]`就已经打完了触发次数，等`contact`终于resolve、组件真正越过loading guard渲染出聊天内容时，这几个依赖项其实都没再变化，**effect不会再触发一次**，于是滚动永远停在“组件还没渲染出内容”的那一轮，ref自然是null。
  2. 依赖数组必须把`contact`（以及群聊的`group`）也加进去——这样"loading guard刚放行、聊天内容第一次真正挂载"这一刻本身会让依赖变化，从而补上这次必须发生的滚动。
  3. 顺手把实现方式也从"找一个占位子元素`scrollIntoView`"改成"直接给滚动容器本身一个ref、`el.scrollTop = el.scrollHeight`"——不再依赖某个哨兵子节点必须存在，更不容易受这类挂载时机影响。
  - **教训**：`useLayoutEffect`/`useEffect`的依赖数组只列出"你自己认为相关"的状态是不够的——如果effect里访问的DOM/ref来自一个**由多个独立异步数据源共同门控的条件渲染分支**，必须把所有门控条件都放进依赖数组，否则"内容第一次真正出现"这一刻可能刚好不触发effect。
- **头像对齐**：`MessageBubble`外层容器原来是`items-end`（跟时间戳文字的底部对齐，导致头像视觉上偏低），改成`items-start`（头像顶部对齐气泡顶部，微信那种标准对齐方式）。

## 系统提示词分层（三层，不要合并）
`src/lib/prompt.ts`：
1. **`DEFAULT_STYLE_PROMPT`**——纯"说话方式"规则，是 `settings.globalSystemPrompt` 默认值，**用户可在设置页编辑**。
2. **`FIXED_PROTOCOL_PROMPT`**（模块内 const，未export）——JSON输出格式/分句/表情包与小程序/委托占位符说明。**固定、不给用户看、不可编辑**。协议指令放在拼接顺序的**最后**（离生成位置最近），对模型遵守JSON格式有帮助。
3. **人物设定 `persona`** + **记忆** + **关系维度**——每个联系人各自的部分，`persona` 完全不给用户看。

`buildSystemPrompt()` 拼接顺序：`stylePrompt + 人物设定 + 记忆 + 实时上下文(当前时间/用户资料/最近事件) + 固定协议`。

**"活人感"优化**（用户反馈"大家的发言都太人机了"，只改`DEFAULT_STYLE_PROMPT`，不碰JSON协议）：上网查了一下roleplay/聊天机器人的常见"AI味"来源，加了3条针对性最强的：①不要无脑顺着/附和/夸对方(对抗sycophancy，这是最常见的AI味来源)；②不要重复总结对方刚说的话再接话、也不要每条都用问句结尾追问(这两个是经典的"assistant腔")；③回复长度不用每次都工整完整，允许就回一两个字/一个表情包。**这几条只影响`DEFAULT_STYLE_PROMPT`这个常量本身，不会自动覆盖用户已经在设置页保存过的`globalSystemPrompt`**——因为它持久化在localStorage里，不是每次都读常量；已经跑过这个app的人如果想吃到这次更新，得去设置页点"恢复默认"再保存，不会自动生效。

## 添加联系人流程（问卷式，生成后直接创建，无二次确认）
用户明确要求：名字必须TA自己起，交互要像"添加联系人"而不是"配置AI"，**创建后不允许用户再修改人设**，页面文案不能出现"AI"字眼。
- `ContactAddPage`（路由 `/contact/new`）：先选头像（`AvatarPicker`），性格标签多选 + 自定义标签 + 🎲随机词条、年龄段/性别/关系定位单选chip、**TA与其他联系人的关系（可选，见下面AI-AI关系）**、补充说明文本框。
- 点"确认添加"→ `buildPersonaGenerationPrompt()` 一次性调用 DeepSeek 生成 `{name, persona}`（`jsonMode:true`，单轮请求不受json_object多轮bug影响）→ **直接**创建contact+conversation+关系链接（无确认/修改页）→ `navigate('/contacts')`。
- 创建后 `name` 和 `systemPrompt`（人设）**完全不可再改、也不再展示给用户**。唯一能后续改的是**头像**和**备注**。

## 好友备注
`Contact.remark`（可选）。`src/lib/contact.ts` 的 `displayName(contact)` = `remark || name`，全应用统一用这个函数显示名字。

## AI记忆功能（`src/lib/memory.ts`）
两个独立轴，只影响语气不改人设：`memoryFacts`(客观事实摘要≤200字)、`memoryStyle`(相处状态/语气调整≤150字)。省token机制：`CONTEXT_WINDOW_SIZE=30`（主聊天只发最近30条原文）、`MEMORY_UPDATE_INTERVAL=10`（攒够10条新消息才整理一次）。触发时机：`chatEngine.ts`的`revealBubbles()`最后一个气泡落库后fire-and-forget调用`maybeUpdateMemory`（`jsonMode:true`），不阻塞UI。`ContactCardPage`可查看/清空记忆。

## AI的"约定/代办意识"（`PlanItem`，新增，跟正式的委托/Todo系统是两回事）
用户反馈场景：AI在聊天（包括群聊）里随口答应了个安排（"周三晚上一起吃烧烤"），希望这个AI后续聊天时能记得、时间快到了能自然提一下。**这不是走`Commission`那套正式委托流程**（那个需要用户接取/拒绝、有报酬），而是每个联系人自己的一条轻量记忆。
- `Contact.upcomingPlans?: PlanItem[]`，`PlanItem{id,text,date?,createdAt}`——`date`是`YYYY-MM-DD`，模型能从当前时间结合"周三"这类相对表达推算出具体日期就填，算不出来就留空。
- **提取时机和现有记忆更新合并成同一次调用**，不单独起一次API请求：`buildMemoryUpdatePrompt`现在也要求模型顺带输出`"plans":[{"text":"...","date":"..."}]`（只要这批新消息里**新出现**的约定，不重复已有的），和`facts`/`style`/`relationshipDelta`一起解析、一起落库。
- `activeUpcomingPlans()`/`activeUpcomingPlansText()`按`date`过期自动过滤（没有date的永不过期，靠`MAX_UPCOMING_PLANS=8`硬上限兜底防止无限增长），在1:1的`buildSystemPrompt`里作为新的一段【你和对方的约定/计划】注入，**不像`pendingEvents`那样用一次就清空**——会一直留着直到日期过了才自然从列表消失。
- `ContactCardPage`记忆区块顺带展示了当前有效的约定列表，`hasMemory`判断也把它算进去了。
- **明确没做的**：不会主动推送提醒（没有闹钟/通知机制），也不会理解"取消/改期"这种口头撤销——纯粹是"到期自动消失"，靠模型自己看当前时间判断要不要提。

## 群聊记忆系统（`maybeUpdateGroupMemory`，新增，`lib/memory.ts`里跟1:1那套memory函数放一起）
群聊v1上线时明确跳过了记忆（`groupChatEngine.ts`当时完全没接`maybeUpdateMemory`），这次补上，用的是跟朋友圈/群聊回复同一套"一次API调用、按位置对应多个人"的模式，而不是群里几个人就打几次API：
- **游标挂在`Group`上，不是`Contact`上**：`Group.memoryMessageCursor?`（可选字段，群聊功能刚加时创建的Group没有这个字段，读取时`?? 0`兜底）。因为一个联系人可能同时在好几个群+一对一里，`Contact.memoryMessageCursor`是那条1:1对话专用的，不能借来给群聊计数，会互相踩。
- **只更新这批新消息里真的说过话的人**，不是群里全部成员——从新消息里去重收集出现过的`speakerContactId`，只有这些人会被喂进`buildGroupMemoryUpdatePrompt`、只有这些人的`memoryFacts`/`memoryStyle`/`upcomingPlans`会被更新。一个群里全程没说话的成员这次不会被碰。
- **一次调用同时更新多人**：prompt里把这批群聊记录（每行都带说话人名字前缀）+ 需要更新的这几位各自的已有记忆一起喂给模型，要求输出`{"updates":[{"facts":"...","style":"...","plans":[...]}]}`，**顺序必须和喂进去的发言人顺序一致**，不靠模型回显名字，纯按位置zip回去（跟`moments.ts`/`groupChat.ts`一个思路）。
- **v1明确没做的**：没有`relationshipDelta`（群聊没有对应的关系数值维度，这个之前就定过），解析失败或这批消息里没人说话时只推进游标（避免同一批消息被反复重新处理），不重试。
- **群聊系统提示词也顺带更新了**：`buildGroupSystemPrompt`原来只给被选中发言人的人设，现在也把`memoryFacts`/`memoryStyle`/`upcomingPlans`一起塞进每个人的发言人区块（明确告诉模型"这是TA自己的记忆，其他发言人不能知道/不能提"），不然更新了记忆但从来不读回去也没意义。

## 关系网功能（`src/lib/relationship.ts`，用户-AI关系，对用户完全隐藏数值，只在关系网页面展示）
5个维度0-100分：`familiarity熟悉度` `affection好感度` `trust信任度` `romance暧昧度` `friction摩擦感`，存在`Contact.relationship`。**和记忆更新合并成同一次API调用**（`buildMemoryUpdatePrompt`同时要求输出`relationshipDelta`变化量）。`relationshipStageLabel()`归纳成短标签。**UI只有`RelationshipsPage`一处**（`ContactCardPage`不显示任何维度）。

**"设成恋人但AI不会把用户当恋人"（用户真实反馈，真实bug，已修复）**：根因是`relationship`这个关系定位标签（问卷里选的"恋人"/"暧昧对象"/"朋友"等，`RELATIONSHIP_OPTIONS`，跟上面这5个数值维度是两回事）**从来没有持久化存到`Contact`上**——只在创建那一刻被喂进`buildPersonaGenerationPrompt`当一次性提示("和用户的关系定位: 恋人")+`initialRelationshipFor()`用来给5个数值维度定初始值，生成完毕之后这个标签本身就被丢弃了。这意味着"你们是恋人"这个设定唯一的落脚点是模型当次生成`persona`文本时**恰好**写没写清楚、写得够不够重——属于"一次性软提示、被埋进自由文本里、聊得越久越容易被稀释淡化"的经典角色扮演一致性问题，数值维度那边`romance`分数虽然会相应设高，但那个只影响语气浓淡（CLAUDE.md早就记过"只影响语气不改人设"），不是一个明确的"你们是情侣关系"结构化指令，两者不能互相替代。
- **修复**：`Contact`新增可选字段`relationshipType`，创建联系人时把问卷选的`relationship`原样存下来；`lib/prompt.ts`新增`RELATIONSHIP_TYPE_HINTS`（每个关系标签配一句具体的行为提示，比如"恋人"对应"说话方式要体现恋人间的亲密感 可以用昵称、撒娇、吃醋...不是普通朋友的疏离感"），`buildSystemPrompt`新增`relationshipType`参数，**每一轮对话都重新注入**一个独立的【你和对方的关系定位】区块（跟着persona和这条hint一起放，而且明确加了一句"不要因为聊了很久就淡化成普通朋友的语气"），而不是依赖生成时那次性的软提示。群聊`buildGroupSystemPrompt`同样按每个发言人各自的`relationshipType`加了对应的一行。
- **老联系人怎么办**：这个字段是新加的，创建于这次更新之前的联系人不会自带`relationshipType`。**没有沿用"人设创建后不可改"那条规矩**——特意在`ContactCardPage`加了一个可以随时点开改的"关系定位"行（复用`RELATIONSHIP_OPTIONS`列表的`ActionSheet`），因为关系定位更像是可以事后修正/演变的标签，不像`persona`/`name`那样是深度绑定人设本体的东西，允许补设或修改能让用户直接修好已经存在的"设成恋人但没生效"的联系人，不用重新建一个。
- 用Playwright验证过：`buildSystemPrompt`传入`relationshipType:'恋人'`确实会生成带"每次回复都要符合这个定位"这句强化提示的独立区块；`ContactCardPage`对没有这个字段的老联系人正确显示"未设置"，点选之后能正确落库。

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

## 头像/朋友圈配图（`lib/photoSearch.ts` + `lib/avatarCategory.ts`，新增）
用户提的真实需求（用户原话概括）："AI发朋友圈得有图，但图库API太随机、AI生图又太麻烦"——讨论后确定的方案：**朋友圈配图用图库API+LLM顺便生成的搜索关键词**（零额外调用成本，复用同一次生成朋友圈文字的API调用），**不做真正的AI生图**。头像则借着同一套图库接口，又补了一层"分类"：现实里大部分人头像根本不是自己的脸，而是动漫图/风景照/网图帅哥美女/宠物照，所以头像走"性格标签加权决定分类→分类专属图库/关键词"这条路，而不是尝试"生成一张长得像这个人设的脸"。

- **图库选型**：Pexels（免费、注册即拿key、额度充足：200次/小时+2万次/月），配到`.env`的`VITE_PEXELS_API_KEY`+`settings.pexelsApiKey`（跟Tavily key同等处理）。动漫分类走**waifu.pics**（`https://api.waifu.pics/sfw/{waifu|neko}`，完全不需要key，随机返回一张，无法按关键词搜索）。
- **头像分类完全由代码决定，不是LLM**（跟"谁发朋友圈/谁点赞评论/群聊谁发言"是同一个哲学）：`lib/avatarCategory.ts`的`pickAvatarCategory(tags)`，4个分类`anime|landscape|person|pet`，每个性格标签(`PERSONALITY_TAG_OPTIONS`)在`TAG_CATEGORY_WEIGHTS`里对应几个分类的额外权重（比如"高冷禁欲"偏`landscape`、"软萌粘人"偏`pet`、"中二"偏`anime`），所有分类都有`BASE_WEIGHT=1`兜底，用户自定义/随机词条这些不在权重表里的标签不会报错、只是不加成。`ContactAddPage.handleGenerate()`在调用persona生成API**之前**先算出这个分类。
- **LLM只负责在算好分类之后生成一个贴合的搜索关键词**：`buildPersonaGenerationPrompt(answers, avatarCategory)`新增第二个参数，根据传入的分类动态决定要不要在JSON schema里问模型要`avatarKeyword`字段（anime分类没有搜索能力，直接跳过不问）；person分类特别要求模型按它自己刚生成的这个角色的性别写英文关键词（比如"handsome young man portrait"或"beautiful young woman portrait"）。
- **头像只在创建联系人时自动配一次，不是持续任务**（区别于朋友圈配图会一直发生）：如果用户在`AvatarPicker`里手动选过（`avatarManuallySet`标记），就完全不触发自动配图，尊重用户选择；否则用`photoSearch.ts`按分类调对应接口，成功就把返回的图片URL直接存进`Contact.avatar`（`Avatar`组件本来就支持`http://`开头的URL当图片渲染，不需要额外下载转data URL这一步），失败（没配key、网络错误、没搜到结果）就静默回退到原来的随机emoji，不阻断联系人创建这个主流程。
- **朋友圈配图是概率性的，不是每条都配**（`MOMENT_PHOTO_PROBABILITY=0.6`，仿真实朋友圈很多动态就是纯文字）：`refreshMoments`在调用生成API之前，对每个要发圈的人**代码先掷骰子**决定`willHavePhoto`，只有掷中的人才会在`buildMomentsPrompt`里被要求额外写一个`imageKeyword`字段；生成结果落库之后，`willHavePhoto`+关键词都有效才去调`searchPexelsPhoto`（landscape方向，比头像的方形更适合朋友圈横图），失败同样静默跳过、纯文字动态照常发出去。
- **图片来源标注**：Pexels注册时申请表要求说明"如何使用图片"，回复里承诺过会保留摄影师署名，所以`Moment`/`Contact`都带了`imagePhotographer(Url)`/`avatarPhotographer(Url)`字段——`ContactCardPage`在头像下面小字展示"头像照片来自 Pexels · 摄影师名"（可点开原图页面），`MomentsPage`的配图用`title`属性做hover提示，不占版面。waifu.pics来源的动漫头像没有对应的摄影师信息，不需要标注。
- **踩过的坑**：本地沙盒环境的出站网络有域名白名单（连Unsplash这种主流服务都会被解析到`198.18.0.0/15`那个RFC测试保留网段的哨兵IP，属于沙盒本身限制而非代码问题），导致我没法在自己的Playwright测试里真正验证waifu.pics请求成功——已经用真实浏览器环境跑通了Pexels三个分类(landscape/pet/person的搜索关键词、真实返回图片URL+摄影师信息)和完整的联系人创建端到端流程（生成人设→算分类→搜图→落库，全部真实API），只有anime分类的waifu.pics请求没能在沙盒里实测，但代码有try/catch兜底，就算真的连不上也只是退回默认emoji、不会导致联系人创建失败。**以后如果用户反馈"动漫头像一直用不上/头像还是emoji"，先怀疑waifu.pics域名连通性，而不是代码逻辑。**

**级联删除**：删除联系人时会调用`lib/moments.ts`的`cascadeDeleteContactSocialData(contactId)`——删掉TA自己发的朋友圈（连带清空这些圈子下所有的赞和评论）、删掉TA在**别人**朋友圈下留的赞和评论、删掉涉及TA的`contactRelations`链接。不会因为删一个人而误删别人还在的朋友圈。

**入口**：`DiscoverPage`新增"朋友圈"（排在商城/仓库/关系网前面）。

**上线后用户反馈的4处小更新**：
- **朋友圈语气问题**：用户抓到一条AI发的圈是"我跟你说，这周末总算把露营装备凑齐了！...你们人来就行..."——这是把朋友圈写成了"对着用户说话"的私聊口吻，不对，朋友圈是发给所有人看的公开广播，不该有明确的"听话对象"。`buildMomentsPrompt`加了一条强约束：绝对不能写"我跟你说""告诉你""咱们"这类对特定的人说话的措辞，可以用"大家"泛指或者纯自言自语；但**评论**不受此约束（评论本来就是回复给发布者看的，正常用"你"没问题）。
- **联系人创建进度条**：`ContactAddPage`原来只有一个"正在添加…"文案，创建过程（人设生成LLM调用→可能的头像搜图→数据库写入）偏长、用户体感没反馈。加了`progressStep: 'persona'|'avatar'|'saving'|null`状态，在`handleGenerate`的三个真实异步阶段各自打点，UI渲染对应的文案+进度条百分比（30/70/95）——**是真实反映代码执行到哪一步，不是纯时间驱动的假动画**，如果用户手动选了头像会跳过`avatar`这一步（内容更准确）。
- **用户评论朋友圈**：之前用户只能点赞不能评论，现在`MomentsPage`每条动态下加了"评论"按钮，点开一个内联输入框，提交后落库一条`MomentComment{authorContactId:'user'}`。**这块逻辑很快又被下面的"评论区跟评"功能整个替换掉了**（不再走pendingEvents延后到下次聊天，见下一条），这里只是记录UI入口本身的由来。
- **AI评论可以带表情包**：用户要求"直接接在文本后面"而不是做成独立字段/类型——`buildMomentsPrompt`/`buildUserMomentCommentPrompt`都新增了可用表情包名字列表+一句指引：想配表情包就在评论文字**末尾**直接加`[sticker:表情名字]`。`lib/moments.ts`导出`parseCommentSticker(content, validStickerNames)`在渲染时把这个后缀从文字里摘出来、换成真正的表情图片；**只有名字精确匹配现存的表情包才会摘取+渲染，匹配不上（比如表情后来被改名/删除了）就完全不动原文**，避免把用户看不懂的裸露markup展示出来、也避免误吃正常文字。这个"直接拼在同一个字符串字段末尾的marker"写法和`aiProtocol.ts`的`[发布了委托: X]`那类placeholder不是一回事——那个是喂给模型的历史压缩格式容易被模仿泄漏，这个是主动设计好、专门给模型用的输出协议，不存在泄漏风险。
  - **上线后用户真实反馈过一次"表情包没有正确加载"**：贴出来的原文是"...实物占地方果断扔！[sticker:疑问] 你还真以为我会留着发霉啊"——marker出现在句子**中间**，后面还有文字，而`parseCommentSticker`最初的正则是`/\[sticker:([^[\]]+)\]\s*$/`（`$`锚定字符串末尾），只要marker不在最后就完全匹配不上，于是原样把"[sticker:疑问]"这种裸markup显示给了用户。**这本质上还是"prompt指令不可靠 必须靠解析层兜底"这条教训的又一次重演**（跟1:1的委托方括号leak、群聊的名字前缀leak是同一类问题）——已修复：正则去掉`$`锚定，改成在整个字符串里搜索marker（`match.index`不依赖出现在末尾），命中就把marker从原位置摘掉、拼接前后剩余文字、清理多余空格，不管模型把marker放在开头/中间/末尾哪个位置都能正确识别。prompt那句指引也加固成"只能加在整句话的最后 不能插在句子中间"，但这只是第二层保险，不是主要修复手段。
- 这四处验证方式：前两处（语气prompt/进度条）只做了`tsc`+`lint`+`build`确认无回归，没有再额外拉真实API测；后两处（用户评论+表情包渲染）是纯数据库/UI逻辑、不需要调用LLM，直接用Playwright种数据验证了"评论落库+表情包正确渲染并从文字里摘除"符合预期。

**评论区跟评（新增，替换了上面"用户评论朋友圈"原本的pendingEvents通知机制）**：用户明确要求"用户回复了之后也不用发送给那个联系人了 让发帖的人在评论区回复就行了 这个依旧得是后台操作"——原来的设计是评论会往poster的`pendingEvents`塞一条note、等用户下次真的去1:1聊天才会被AI提起，用户觉得这样太绕，希望评论区本身就能像真实社交软件一样实时（其实是后台异步）有来有回。
- **数据模型**：`MomentComment`新增可选字段`replyToCommentId`，指向被回复的那条评论的id（WeChat风格"A回复B"），不做深层嵌套，所有评论还是同一个moment下的一条平铺列表，只是加了这个指针用于展示"A 回复 B：内容"。
- **谁来回复完全是poster，不是被点名回复的那个人**：不管用户是对着moment本身发一条全新评论，还是点某一条已有评论的"回复"按钮，触发的都是**发帖人**在评论区补一句回复——用户原话明确说的"发帖的人"，不是去动态触发对应被回复的那个AI（简化设计，避免"评论串里谁该回复谁"这种多agent复杂度）。
- **后台单次调用，纯文字输出不是JSON**：`lib/moments.ts`的`generateMomentReply(momentId, poster, triggeringCommentId, settings)`——喂给模型poster人设+这条朋友圈原文+当前完整评论串(按时间顺序，作者名+内容)+可用表情包列表，明确指示"针对评论串里最后一条评论写一句回复"，直接要一句纯文字（不是JSON数组），用`cleanPlainReply()`简单地去markdown代码块/去首尾引号，比批量生成朋友圈那套`{"moments":[...]}`结构简单很多，因为这里只需要单条内容。生成结果落库为一条新`MomentComment{authorContactId: poster.id, replyToCommentId: triggeringCommentId}`。
- **调用方式是fire-and-forget，MomentsPage不等它**：`submitComment`把用户的评论/回复落库后立刻调用`generateMomentReply(...)`但不`await`，函数内部自己有try/catch吞掉所有失败（没配key、网络错误、解析出来是空字符串都直接return，安静地什么都不做）——用户体验上就是"发完评论，过一会儿poster的回复自然地出现在列表里"，全靠dexie的`useLiveQuery`自动感知新数据、不需要额外的loading state。这个"背景异步、组件不用管、live query自动捕捉"的模式跟`postUserMoment`里生成评论那部分是同一个哲学，比`chatEngine.ts`那套要接管typing indicator/打断逻辑的后台引擎简单得多——因为这里只是"补一条评论"，不存在"打字中"状态也不需要可打断。
- **踩到一个真实排序bug，靠这次的Playwright结构化测试才抓出来**：`MomentsPage`原来的`commentsByMoment`是直接从`db.momentComments.toArray()`（无排序）分组来的——Dexie的`toArray()`不排序的话是按主键（这里是随机uuid字符串）的字典序返回，不是插入/创建顺序！之前只是点赞/评论列表，顺序乱了也不明显；这次加了"点某条评论的回复按钮→应该定位到那一条的作者"的功能后，乱序会导致"点第一条评论的回复按钮，实际把回复目标设成了另一条评论的作者"这种错位——**用Playwright真实复现过**：种两条评论(一条更早创建, 一条更晚)，点DOM里第一个"回复"按钮，结果`replyTarget`对应的却是后创建的那条。**修复**：`commentsByMoment`分组之后对每个数组按`createdAt`显式`sort`。**教训**：任何从Dexie无序`toArray()））取出来又需要"顺序"语义（无论是显示顺序还是"点第N个对应第N条"这种索引寻址）的地方，都得显式排序，不能假设返回顺序等于插入顺序——这跟`moments`列表本身一直用`orderBy('createdAt')`是对的、只有这处漏了排序不是一回事的坑。

## AI自主行为（"看起来自主"版本，`lib/proactiveChat.ts` + `App.tsx`，新增）
用户明确要求AI能不需要用户先介入就自己发消息/发朋友圈，讨论后达成一致：**这个app没有后端，所有代码只有在浏览器标签页真的开着的时候才会跑**——手机锁屏/切后台太久会被系统挂起甚至杀掉，做不到真正意义上"app关着也会收到消息"（那需要服务器+定时任务+推送通知，完全是另一个量级的项目，明确没做）。这里做的是**"app开着的时候看起来是自主的"**：
- `App.tsx`里`useAutonomousBehaviorTimer()`挂一个前台`setInterval`（`AUTONOMOUS_TICK_INTERVAL_MS=5分钟`），每次tick做两件事：调用已有的`refreshMoments()`（本来就有10分钟冷却兜底，空转也不产生API调用）+ 调用新的`maybeTriggerProactiveMessage()`。**受`settings.autonomousBehaviorEnabled`总开关控制，默认关闭**（`SettingsPage`里一个开关，因为这个功能会在用户没有直接操作的情况下产生真实API调用/费用）。
- **谁会主动找你聊天、要不要触发，还是代码决定，不交给模型**（跟朋友圈/群聊一个哲学）：候选池是"有对话、且沉默超过45分钟"（`PROACTIVE_SILENCE_THRESHOLD_MS`，顺便避免打断正在进行的对话）的联系人，用`groupChat.ts`里那套`relationshipWeight`+`weightedSampleWithoutReplacement`（导出复用，跟群聊选发言人是同一份权重公式）挑**恰好1个**——不像朋友圈可以一次刷出好几条动态，主动私聊这种事一次好几个人一起找你会很奇怪。
- **两层成本兜底**（用户明确要求"不希望过度消耗API key"）：①`PROACTIVE_COOLDOWN_MS=6小时`——同一个联系人不会短时间内反复主动找你；②`DAILY_CAP=3`——全局每天最多触发3次，不管候选池多大、骰子多欧，存在`settings.proactiveMessageLog:{date,count}`里（按本地日期`toDateKey`滚动，不是DB表，因为这是全局单例状态，`AppSettings`本来就是这个app唯一的"全局可变状态"落脚点，跟`walletBalance`同类）。另外还有`PROACTIVE_PROBABILITY=0.25`——就算候选池非空，大部分tick也什么都不做。
- **怎么让AI"知道该主动开口"，复用现成机制不新写生成逻辑**：选中之后直接往该联系人的`Contact.pendingEvents`塞一条"你已经有一阵子没主动找对方聊天了 可以自然地找个话题主动开启对话"，然后调用已经存在的`triggerAiTurn()`——生成、落库、通知横幅这些全部不用碰，模型自己看这条提示+当前时间+记忆决定聊什么、怎么开口。
- **原来这几个阈值是代码常量没有设置页UI，用户后来明确要求"从开/关改成参数可设置的"**：`PROACTIVE_COOLDOWN_MS`/`PROACTIVE_SILENCE_THRESHOLD_MS`/`PROACTIVE_PROBABILITY`/`DAILY_CAP`四个从`lib/proactiveChat.ts`里的硬编码const挪到了`AppSettings`（`proactiveCooldownMs`/`proactiveSilenceThresholdMs`/`proactiveProbability`/`proactiveDailyCap`，默认值不变），`SettingsPage`的"AI自主行为"区块在开关打开时展开4个下拉选择（每天次数上限/触发概率/沉默阈值/单人冷却时间，都是预设的几个档位而不是自由输入数字，避免用户填出极端值）。**`AUTONOMOUS_TICK_INTERVAL_MS`(后台定时器多久检查一次)特意没有暴露**——这是纯实现细节(轮询频率)而不是用户会关心的"行为参数"，跟`REACT_PROBABILITY`/`COMMENT_SHARE`(朋友圈那套)一样继续留作代码常量。
- **上线后用户反馈"感觉没触发"，排查出一个真实bug**：`maybeTriggerProactiveMessage`选中联系人后，往DB里写入新的`pendingEvents`，但紧接着调用`triggerAiTurn(conv.id, chosen, ...)`时传的还是**函数最开始`db.contacts.toArray()`拿到的那个旧`chosen`对象**——`runAiTurn`读的是`contact.pendingEvents`这个内存字段，不会自己重新查一次库，于是刚写进去的这条"该主动开口了"提示从来没被模型看到过，也从来没被`runAiTurn`那段"读到就清空"的逻辑清掉过（一直堆在DB里）。**教训**：任何"先写DB、再把同一个内存对象传给下一个也会读这个字段的函数"的写法都要注意——写完DB之后手上的对象已经是旧快照，必须重新取（或者手动把这次patch合并进去再传下去），不能想当然觉得"我刚更新过就应该是最新的"。**修复**：`triggerAiTurn(conv.id, { ...chosen, ...patch }, settings, stickers)`，传合并后的对象而不是原始`chosen`。用Playwright直接种一条"3小时没说话"的对话+强制`Math.random`必过骰子的方式复现和验证的（不用真的等45分钟+踩中25%概率）。
- **另外提醒**：就算逻辑完全正确，默认阈值下**用户短时间内测试大概率也看不到效果**——沉默要求45分钟起步，命中概率25%/5分钟一次tick，正常情况下期望要等上小半个到一个小时才会触发一次，这是设计上"别太吵"的代价，不是bug；如果想更容易验证效果，得调低`PROACTIVE_SILENCE_THRESHOLD_MS`/调高`PROACTIVE_PROBABILITY`这两个常量。

**用户自己发圈**（`postUserMoment`）：`MomentsPage`右上角✏️按钮打开一个内联文本框，发布后`Moment.contactId`写字面量`'user'`（渲染时用`settings.userNickname`/`userAvatar`兜底显示，其余UI逻辑照旧）。发圈之后谁会点赞评论走的是**另一套概率模型**，不复用`contactRelations`（因为用户不是那张图里的节点）——改成读每个联系人的`Contact.relationship`（用户-AI五维度），`userMomentReactionProbability = (affection*0.6 + familiarity*0.4)/100`，clamp到`[0.05, 0.9]`，越熟悉/越有好感的AI越可能刷到并回应。通过的人一定点赞，其中`COMMENT_SHARE`比例的人也留评论（同一套评论生成走一次API调用，`buildUserMomentCommentPrompt`+`parseCommentsResponse`，跟AI发圈那套`buildMomentsPrompt`结构类似但只服务单条动态）。API调用失败/没配置key时朋友圈本身仍然发布成功，只是没有人反应（reactions是nice-to-have，不应该挡住发布本身）。

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

**后来用户又主动要求加了一个"日程系统"回来**（见下面`lib/schedule.ts`章节）——**这不是打脸重做v1那套**，提出时特意跟用户确认过范围：新的日程系统只是每个联系人身上的几个纯字段（周期性作息+偶尔的一次性例外），没有地图/GPS概念、没有独立的任务/日程管理页面、不影响用户主动发起的1:1聊天的即时回复。范围比v1删掉的那套小得多，别看到"日程"两个字就以为是同一个东西被偷偷加回来了。

## AI输出JSON协议（`src/lib/aiProtocol.ts` + `src/types/index.ts`）
气泡类型：`text`、`sticker`、`link`(占位符shop/todo)、`commission`(委托，见待办章节)。`gift`类型是用户侧直接构造、不走AI协议解析的。协议说明全部在`FIXED_PROTOCOL_PROMPT`里。

分句发送+打字延迟：`typingDelayMs()`按长度算延迟，`revealBubbles()`（住在`chatEngine.ts`）用多个`setTimeout`依次落库。用户插话打断：模块级streamId/定时器/AbortController。

**"经常没有回复/回复有毛病"排查记录，用临时Node脚本直接打真实API验证过，别重蹈覆辙**：
1. 每轮AI回复拆成多条独立`assistant`消息存库，历史1:1映射会破坏user/assistant交替结构 → 加了`coalesceConsecutiveRoles()`合并连续同角色消息（这个问题真实存在但不是主因）。
2. **真正的根因**：开着`response_format:{type:"json_object"}`时，第2轮及以后模型会正常返回`finish_reason:"stop"`但`content`是纯空格——json_object约束解码器在"复杂系统提示词+已有assistant历史"下的服务端行为。**修复**：`chatCompletion()`的`jsonMode`参数默认不开，主聊天请求不传；人设生成/记忆整理/商城生成/朋友圈生成都是单轮请求，继续传`jsonMode:true`不受影响。`parseAiResponse()`解析失败时按行拆成text气泡兜底，不再直接丢弃。
3. **追加修复**：非text气泡（比如commission）偶尔会整段原始JSON被当成文字发出来——因为模型真实输出在JSON前后夹了闲聊文字，或者字段类型不严格匹配（比如reward给成字符串）导致该条被过滤、bubbles变空数组、退回逐行文本兜底。修了`extractJsonObject()`（括号配对扫描，从文本中挖出完整JSON子串）+ reward字段改成`Number()`兜底转换。
4. **委托卡片"又出问题了"，用Playwright真机复现锁定了根因**：`chatEngine.ts`喂给API的历史记录里，一条已经落库的commission消息会被压缩成`[发布了委托: 帮忙取快递]`这种方括号占位文本（见下面`runAiTurn`的history-mapping）。模型在同一个对话里**后续**想再发一次委托时，会直接照抄这个方括号格式当成`text`类型的文字内容打出来，而不是老老实实用`commission`类型的JSON字段——**这是模型在模仿自己历史记录里见过的"系统压缩摘要"格式，不是我们协议解析的bug**。复现方法：真实聊天里连续要求发布2个委托，第二个commission大概率会以`"[发布了委托: xxx]"`这种text气泡形式出现。**修复分两层**：①在`FIXED_PROTOCOL_PROMPT`里明确告诉模型"聊天记录里的方括号格式是系统摘要标记，不是真人会说的话，绝对不能模仿输出"——**这一层单独测试过，不够用，模型照样偶尔会漏**；②真正兜底的是`aiProtocol.ts`里的`recoverLeakedBubbles()`结构性修复——扫描每个`text`气泡，凡是内容精确匹配`/^\[发布了委托[:：]\s*(.+?)\s*\]$/`这个模式，直接就地转换成一个真正的`commission`气泡（reward用`clampReward(NaN)`兜底成最低值）。**教训**：这类"模型抄自己历史压缩格式"的leak，光靠prompt提醒不可靠，必须在解析层加结构性识别/纠正，跟`extractJsonObject`/reward强转是同一个哲学。

**如果以后又有人反馈"经常没回复"**：先怀疑是不是哪里又不小心给主聊天请求加上了`jsonMode:true`。**如果反馈"委托/礼物/日程变更又变成纯文字了"**：先怀疑是不是又出现了新的"历史占位符格式被模型抄了"这种leak，照着`recoverLeakedBubbles()`的模式加一条新的识别+纠正规则，而不是单纯改prompt措辞。

## 群聊功能（`lib/groupChat.ts` + `lib/groupChatEngine.ts` + `GroupAddPage`/`GroupInfoPage`，新增）
用户明确要求：群聊依然是**单个LLM调用模拟多个人设**，不是真正独立的多AI agent互相对话。每轮"谁来发言"完全由代码决定（不交给模型选）：
- `Group{id,name,avatar,avatarColor,memberContactIds,createdAt}`独立表，`Conversation`现在`contactId`/`groupId`二选一（改成都是可选字段）。
- `pickSpeakers(members)`（`groupChat.ts`）：成员数≤3——全部人都回答；>3——`weightedSampleWithoutReplacement`随机选3个，权重来自**用户-AI关系**（`affection*0.4+familiarity*0.35+trust*0.25-friction*0.2`，没有"群内关系"这个维度，复用已有的用户-AI五维度）。
- **一次API调用出多人对话**：`buildGroupSystemPrompt`把这一轮被选中的发言人（不是全部成员，只有被选中的才给人设）编号"发言人1/发言人2/..."连同各自人设喂给模型，要求输出`{"messages":[{"speakerIndex":1,"type":"text","content":"..."}]}`，**按speakerIndex编号定位说话人，不依赖模型回显名字**，同一个人可以连续发好几条、也可以互相打断插话，顺序就是数组顺序。`parseGroupAiResponse`校验speakerIndex必须落在这一轮实际选中的人数范围内。
- **给模型看的历史需要显式标注发言人**：1:1聊天里"assistant角色=固定人设"这件事是隐含的，但群聊一轮里assistant角色可能代表好几个不同的人，模型没法单靠role字段区分谁说了什么——所以`groupChatEngine.ts`构造历史消息时把每一行都手动加上`"名字: "`前缀（包括用户自己的发言），再喂进去，而不是像1:1那样直接传原文。
- **这套"名字: 内容"历史标注格式也会被模型抄进自己的输出里，用户真机反馈过**：群里聊着聊着，气泡的文字内容会变成"周子扬: 哟 又来一遍"这种自带名字前缀的样子，而且抄的名字经常还是**错的**（跟气泡上方真正显示的发言人对不上，因为那个名字标签是`speakerIndex`老老实实算出来的，永远是对的；模型自己在content里加的名字前缀只是照抄历史格式的习惯动作，压根没在认真追踪"这句话到底是哪个speakerIndex"）——这是1:1那个`[发布了委托: X]`方括号leak的同类问题，同一个"模型把喂给它的历史压缩格式当成自己该学的输出格式"的坑。**修复同样是两层**：prompt里加了"content只写话本身 绝对不能加'某某: '前缀"的强调；`groupChat.ts`导出的`stripSpeakerNamePrefix(content, memberNames)`在`groupChatEngine.ts`的`revealGroupBubbles`落库前做结构性清洗——**不管模型抄的名字对不对，只要content开头精确匹配"群成员某某:"或"群成员某某："就整段砍掉**，因为气泡上方的名字标签本来就100%来自`speakerIndex`，content里重复写名字永远是多余的，写错了更是纯噪音。
- **协议故意比1:1简化**：`GroupAiBubble`只有`text`/`sticker`两种类型，**没有commission/link**——群聊场景里"谁该收到委托"语义会很奇怪，第一版直接不支持，防止prompt和解析复杂度失控。
- **v1明确不做的事（范围内的取舍，不是遗漏）**：群聊没有per-contact记忆更新、没有关系数值增量（`maybeUpdateMemory`那套逻辑完全没有接入群聊turn）——群聊场景下"对谁的记忆""对谁的关系"语义不清晰，等真的有需求再设计。群里也不会触发仓库赠礼/委托这些游戏化系统。
- **消息落库**：`Message.speakerContactId`（可选字段）记录群聊assistant气泡具体是谁说的，1:1消息不填这个字段。渲染时`ChatPage`按`isGroupConv`分支决定气泡的头像/名字用`speakerContactId`查到的成员还是走原来1:1的`contact`。
- **后台引擎复用而非重写**：`groupChatEngine.ts`是独立文件（不是塞进`chatEngine.ts`），但**直接复用`chatEngine.ts`导出的`useChatEngineStore`（aiTyping/error）和`buildUserProfileText`**，因为这两个本来就是按`conversationId`键值存的、跟1:1没耦合，`ChatPage`的订阅代码完全不用改。streamId/定时器/AbortController这套打断机制在`groupChatEngine.ts`里单独维护了一份模块级Map（跟`chatEngine.ts`的Map是两份独立实例，但因为conversationId全局唯一不会冲突）。
- **群创建/管理**：`GroupAddPage`（`/group/new`）选头像+群名+勾选≥2个已有联系人，创建后直接建`Conversation{groupId}`跳进`ChatPage`。**群成员目前只能创建时选定，没有事后增删成员的入口**（跟AI-AI关系链的"只能创建时设置"是同一种取舍）。`GroupInfoPage`（`/group/:groupId`）只读展示成员列表+"解散群聊"（删Group+Conversation+全部Message，不可恢复，有二次确认）。删除联系人时`removeContactFromAllGroups()`会把TA从所有群的`memberContactIds`里摘掉，避免野指针。
- **入口**：`MessagesPage`右上角"+"从原来直接跳`/contact/new`改成弹ActionSheet选"添加联系人"还是"发起群聊"。

## 日程系统（`lib/schedule.ts`，新增，别跟上面已删除的地图/日程系统搞混）
用户要求每个联系人有自己的作息，"能不能看手机"影响朋友圈/主动聊天的时机，聊天/朋友圈内容要符合当前地点状态，还能通过聊天协商临时改日程。跟用户确认过范围：**日程只影响朋友圈发布时机+"AI主动找你聊天"的资格判断，不影响你自己主动发起的1:1聊天——你发消息永远秒回**，不会因为对方"在上班"就等很久（这个决策很重要，别为了"更真实"就把它加到普通聊天回复上，之前明确讨论过并排除了这个方向）。
- **数据模型**：`Contact.schedule?: ScheduleBlock[]`（每周固定重复的作息，`{dayOfWeek(0-6), startHour, endHour, phoneAccess:'available'|'unavailable', location, activity}`）+ `Contact.scheduleOverrides?: ScheduleOverride[]`（聊天协商出的一次性例外，按具体日期`date:"YYYY-MM-DD"`生效，覆盖优先于固定schedule）。`schedule`是可选字段——这个功能上线前创建的联系人没有这个字段，所有读取都要`?? []`兜底。
- **跨零点的时间段**（比如"23点到次日7点睡觉"）：`startHour > endHour`是合法的、代表跨天，`schedule.ts`的`blockCoversNow()`专门处理这个——同时检查"今天dayOfWeek的尾巴(hour>=startHour)"和"前一天dayOfWeek+1的头(hour<endHour)"两种情况。**这个逻辑很容易写错，之前专门用Playwright真机验证过跨零点前后两侧都判断正确**。`validateScheduleBlocks()`校验时也要注意：拒绝的条件是`startHour===endHour`（零长度），不是`startHour>=endHour`（那样会把合法的跨天block也拒了）。
- **生成时机**：并入人设生成那一次调用，不额外起API请求——`buildPersonaGenerationPrompt`（`lib/prompt.ts`）要求模型在生成人设的同时输出一个`schedule`数组，`parsePersonaGeneration`用`validateScheduleBlocks`清洗。
- **协商改日程 = 新的AI协议类型**：`AiBubbleScheduleChange`（`type:'scheduleChange'`，字段`date/startHour/endHour/phoneAccess/location/activity/summary`）。`FIXED_PROTOCOL_PROMPT`里教模型自己用逻辑推演该不该答应（结合人设、那个时段本来的安排、和用户的关系），**协商本身走普通文字气泡，只有真的达成新约定才输出这个类型**（光讨论"要不要"不算）。1:1系统提示词新增【你当前的状态】【你接下来几天的安排】两个区块（`describeCurrentSchedule`/`describeUpcomingScheduleText`）给模型推演用。**群聊协议不支持这个类型**（延续群聊协议比1:1简化的既有设计）。
- **落库/渲染**：`chatEngine.ts`的`revealBubbles`处理`scheduleChange`气泡时，**会重新`db.contacts.get()`取一份新鲜的contact再合并写入`scheduleOverrides`**，不能直接用`runAiTurn`一开始拿到的那个`contact`对象（同一类"内存对象在写库之后就过期了"的坑，`proactiveChat.ts`的`pendingEvents`那次已经踩过一次，这次是照着教训写的，不是又犯了）。`MessageBubble.tsx`渲染一个"📅 日程变更"卡片，纯展示，不需要交互（协商已经在前面的文字气泡完成了）。
- **联系人名片可以看到日程**（用户明确要求）：`ContactCardPage`新增"日程"只读展示区，按星期分组+📴标记不可联系的时段，外加当前生效的例外安排列表。**没有编辑入口**，跟"人设创建后不可改"是同一种取舍——只能通过聊天协商出`scheduleChange`来改。
- **朋友圈/AI主动聊天的资格判断**：`moments.ts`的`eligiblePosters()`、`proactiveChat.ts`的候选池过滤都加了`isPhoneAvailable()`检查——"不可联系"的时段不会发朋友圈、也不会被选中主动找你聊天。`buildMomentsPrompt`/`buildUserMomentCommentPrompt`/`buildGroupSystemPrompt`每个人的描述里都加了一行`describeCurrentSchedule()`（"现在在哪 在干嘛"），提示模型内容可以但不强制符合这个状态。

## 联网搜索 + 知识库 + 世界观（新增，三个功能一起做的）
- **联网搜索选了Tavily**（`lib/webSearch.ts`的`tavilySearch()`）——专门给LLM/agent场景设计，返回的是已经提炼好的摘要文字，不用自己再解析原始HTML。**跟用户明确确认过范围：只给知识库这个任务用，聊天时AI不会自己临时决定实时搜索**（那需要真正的tool-calling循环，复杂度/延迟/出错率都高很多，主动排除了）。key跟DeepSeek key一个套路，走`.env`的`VITE_TAVILY_API_KEY`+`useSettingsStore`的env兜底，`SettingsPage`也有对应输入框。

### 知识库 v2：从"定时刷3个固定方向"改成"关键词触发、只查一次"
用户明确要求改造：不要固定方向+15天周期，改成**AI/用户聊天里提到不认识的东西就触发，同一个话题只查一次、不会重复更新**。设计（这版细节里我拥有裁量权，用户说了"有更好的方案可以用你的"）：
- **协议层**：`AiResponse`/`GroupAiResponse`（`types/index.ts`）新增一个**跟`messages`平级、不是bubble**的可选字段`knowledgeQueries?: string[]`——模型这一轮如果碰到不认识的具体网络热梗/番剧/游戏名词，最多列2个关键词，**不需要额外一次API调用**，复用同一次聊天completion的返回。`aiProtocol.ts`的`parseAiResponse()`和`groupChat.ts`的`parseGroupAiResponse()`现在都返回`{bubbles, knowledgeQueries}`而不是裸的bubbles数组，两处调用方（`chatEngine.ts`/`groupChatEngine.ts`）都要解构。
- **触发+去重**：`chatEngine.ts`/`groupChatEngine.ts`拿到`knowledgeQueries`后调用`knowledgeBase.ts`的`processKnowledgeQueries()`（fire-and-forget，不阻塞回复展示）。**去重是这版唯一真正踩过坑的地方**：`KnowledgeEntry`新增了`sourceQuery`字段（模型在总结时被要求原样回显是哪个"搜索方向"产出的这条知识，`resolveSourceQuery()`兜底处理模型没回显准的情况），去重函数`hasKnowledgeForQuery()`拿新关键词去跟**已有entry的`sourceQuery`**做松散包含匹配——**第一版实现直接拿关键词去匹配`topic`字段，被Playwright真机测试当场抓包：`topic`是LLM自己起的一个子标题（比如查"崩坏：星穹铁道"，`topic`会是"匹诺康尼剧情"这种），跟原始搜索词完全对不上，导致去重形同虚设，同一个关键词会被反复搜索**。**教训**：判断"这个话题是否已经查过"，必须比对"当初拿去搜索的那个词"本身，不能比对"总结出来给人看的标题"——这两个字段看着都是"topic-ish"的字符串，语义完全不同，以后类似"判断是否重复"的需求都要留意用哪个字段比对。
- **成本控制**：`DAILY_QUERY_CAP=8`（全局每日硬上限，跟`proactiveMessageLog`同一个套路存在`settings.knowledgeQueryLog`），不再挂`App.tsx`的定时器（旧的`maybeAutoRefreshKnowledgeBase`/`KNOWLEDGE_REFRESH_INTERVAL_MS`已删除，不受`autonomousBehaviorEnabled`开关影响了——这个机制现在是"聊天直接触发"，不是"无操作后台定时"，性质变了）。30天自动清理旧条目防止无限增长保留不变。
- **手动指定方向搜索**（用户新加的需求）：`WorldSettingsPage`的搜索框调`searchKnowledgeTopic()`——**明确不做去重、不占每日额度**，因为是用户自己主动点的、可能就是想刷新已有话题的最新说法。
- **知识条目可以删除**（用户新加的需求）：`WorldSettingsPage`每条知识旁边直接`db.knowledgeEntries.delete(id)`。
- `knowledgeDigestText()`把最近15条格式化成带日期的摘要，注入到1:1和群聊的系统提示词里（**朋友圈没有接入知识库**——范围内裁剪，不是遗漏）。

### 世界观 v2：自己写/AI帮写分开 + 收藏夹
- `settings.worldview`还是单一当前生效值（跟`globalSystemPrompt`一个模式），但`WorldSettingsPage`现在拆成"自己写"（纯文本框直接保存应用，不调用任何API）和"让AI帮写"（原来那套idea→草稿→确认的流程，`buildWorldviewDraftPrompt`/`parseWorldviewDraft`）两个tab，用户要求分开、不要合在一起。
- **新增收藏夹**：`db.savedWorldviews`表（`SavedWorldview{id,name,content,createdAt}`），当前生效的/自己写的/AI草稿都能存一份进去（弹窗起名字），收藏列表里"应用"（写回`settings.worldview`）或"删除"。**收藏 ≠ 应用**——存进收藏夹不会立刻生效，是两个独立动作。
- **这个必须注入到1:1聊天、群聊、朋友圈生成三处**（跟知识库不同——世界设定如果朋友圈内容不遵守会很出戏，不能省），统一放在拼接顺序里"说话风格"之后、"人物设定"之前。
- `WorldSettingsPage`（`/world-settings`，`DiscoverPage`入口"世界设定"）同时承载世界观（当前生效+两个tab+收藏夹）和知识库（列表+删除+手动搜索），两个概念放一个页面是因为都是"影响全局、不属于任何单个联系人"的设定。

## 待办/委托/货币/商城/仓库系统
**底部导航5个tab**：`消息 / 联系人 / 待办 / 发现 / 我`。

**数据模型**（`types/index.ts`）：`Commission{id,contactId,title,description,reward,status,createdAt,respondedAt?,completedAt?}`（reward由AI给，`aiProtocol.ts`的`clampReward()`强制clamp到10-200）；`Todo{id,title,note?,done,createdAt,completedAt?,source:'user'|'commission',commissionId?}`（个人待办和接取的委托同一张表，靠source区分）；`InventoryItem{id,name,description,icon,price,acquiredAt}`（没有单独商品目录表，商品即时生成，没买的不落库）；`AppSettings.walletBalance`(金币🪙默认100)+`shopModel`(商城独立模型选择，不跟聊天用的`model`混用)。

**委托生命周期**：AI输出commission气泡 → `chatEngine.revealBubbles`先建`Commission`行(pending)，`MessageBubble`里的`CommissionCard`子组件实时读状态渲染按钮/状态文字 → 用户接取/拒绝 → `ChatPage.handleCommissionRespond`更新状态+(接取时)建`Todo` → 调用`sendMessage()`发一句"好这个我接了"触发AI反应 → 用户在`TodoPage`勾选完成 → `completeCommissionTodo()`标记完成+发奖金+写完成消息+调用`triggerAiTurn()`触发AI反应（这一步之前是缺失的，见上面"聊天引擎"章节的坑）。委托类todo完成后不能取消勾选。

**商城**（`lib/shop.ts`）：`buildShopPrompt(query)`+`parseShopProducts()`，`ShopPage`调用时传`model: settings.shopModel`、`jsonMode:true`。购买直接扣`walletBalance`、写入`inventory`。

**"商品生成模型好像被锁定成chat模型"（用户真机反馈，真实bug，已修复，别再被"代码看起来是对的"骗过去）**：第一次排查这个反馈时只读了`ShopPage.tsx`的代码，看到确实传的是`settings.shopModel`不是`settings.model`，就误判成"代码没问题、大概是别的原因"——**这是个教训：用户反馈"看起来是XX"的时候，代码读起来对不代表实际运行起来对，得真的跑一遍**。后来用Playwright实测才挖出真正的bug：`SettingsPage.tsx`的`handlePullModels()`（"拉取模型"按钮）只对主模型`modelDraft`做了"如果拉取到的列表里没有当前这个值，就换成列表第一个"的兜底修正，**没有对`shopModelDraft`做同样的修正**；而且哪怕是主模型这个修正本身也只调了`setModelDraft(list[0])`更新本地草稿状态，**根本没调`setSettings(...)`把新值写回store**——`AppSettings`默认的`model`/`shopModel`都是硬编码的`'deepseek-chat'`，但实测DeepSeek`/v1/models`接口现在实际返回的是`deepseek-v4-flash`/`deepseek-v4-pro`（模型名称已经改过），一拉取模型，`shopModelDraft`没被拉取结果修正也没被持久化，购物商城那个`<select>`因为`value`匹配不到任何`<option>`，浏览器兜底显示第一个选项——**看起来好像选中了新模型，实际`settings.shopModel`存的还是那个可能已经过期的`'deepseek-chat'`**，这才是"锁定成chat"的真正来源。**修复**：`handlePullModels()`里`modelDraft`和`shopModelDraft`都做"不在新列表里就纠正+立刻`setSettings`持久化"，两个字段对称处理，不再只改本地草稿。用Playwright实测点"拉取模型"之后`useSettingsStore`里`model`和`shopModel`两个字段真的变成了拉取到的第一个真实模型ID，不再是过期默认值。

**仓库赠送**（`WarehousePage`）：物品从`inventory`删除，插入`type:'gift'`消息到对应会话，然后`triggerAiTurn()`触发AI反应。

## 未读消息红点（`lib/unread.ts`，新增）
`Conversation.lastReadAt`（可选字段）——`ChatPage`只要打开着某个会话就会不断盖章"现在是已读"：`useEffect`依赖`[conversationId, messages.length]`，挂载时和每次有新消息流入时都会`db.conversations.update(conversationId, {lastReadAt: Date.now()})`。`unreadCountFor(lastReadAt, messages)`只统计`role==='assistant'`且`createdAt`比这个时间新的消息（用户自己发的永远不算未读）。`MessagesPage`每一行头像右上角、`BottomNav`的"消息"tab图标右上角都用同一个`UnreadBadge`组件叠一个数字红点（`count>99`显示"99+"）——**两处都是各自独立`useLiveQuery`全表扫`conversations`+`messages`再本地算**，这个app数据量小，没必要搞共享缓存。

## 管理员模式 + 天眼（`lib/consoleCapture.ts` + `SkyEyePage`，新增）
`settings.adminModeEnabled`（默认关，`SettingsPage`一个开关），控制`DiscoverPage`要不要显示"天眼"这个入口——**这是纯前端条件渲染，不是权限系统**，别指望它能防住谁，就是个"开发者调试模式"开关。
- **console捕获是全局常驻的，不跟着开关走**：`App.tsx`模块顶层（不是组件里，import时就执行一次）调用`installConsoleCapture()`，猴子补丁`console.log/info/warn/error`四个方法——**依然调用原始方法**（不影响正常devtools输出），同时把内容塞进一个`useConsoleCaptureStore`（zustand，不persist，最多留最近300条）。这样不管admin开关什么时候打开，之前发生的日志已经在缓冲区里了，不用现开现录。
- **`SkyEyePage`**（`/sky-eye`）三块内容：①刚才说的console日志（按level着色，可清空）；②数据库各表行数统计（`Promise.all`并发`count()`一堆表）；③当前`settings`的JSON dump——**`apiKey`/`tavilyApiKey`这两个字段必须脱敏**（显示"(已配置)"/"(未配置)"而不是明文key），这条被Playwright真机测试专门验证过，以后往这个页面加新内容如果又涉及展示settings，记得别漏了脱敏这一步。
- 以后想加别的"方便开发调试"的东西，往这个页面加就行（用户原话"如果还有什么方便管理员用的内容的话也可以往里面加"）。
- **上线后用户反馈"天眼console不会显示最近的对话"——不是bug，是从来没有代码往console打印过聊天相关的东西**，`chatEngine.ts`/`groupChatEngine.ts`原来的catch块只是把错误塞进`error` state给UI用，从不`console.error`。补了几行`console.log`/`console.warn`/`console.error`：开始生成回复时、收到原始响应+解析出几条气泡时、解析失败(bubbles为空)时把原始内容前200字打出来、真正出错时。**以后如果再有人反馈"天眼看不到XX活动"，先检查是不是那条代码路径压根没调用过console.*，而不是去查`consoleCapture.ts`的猴子补丁本身**（补丁机制已经验证没问题，见上面章节）。
- **同样的道理后来也补到了`lib/photoSearch.ts`**（用户主动要求"图像api调用是否成功也需要写在console里面"）：`searchPexelsPhoto`/`randomAnimeAvatar`在HTTP失败、返回结果为空、返回结果没有可用图片链接、以及成功这几个分支都加了`[photo]`前缀的console输出，用Playwright验证过能正确进到天眼的console缓冲区。
- **`SettingsPage`原来只有DeepSeek一个"测试连接"按钮**，Tavily/Pexels两个key配完之后没有对应的验证入口，只能等实际用到的功能（知识库搜索/头像配图）失败了才知道key不对。补了两个独立的"测试连接"按钮：Tavily的调`tavilySearch(key, 'test')`看会不会抛错、返回几条结果；Pexels的调`searchPexelsPhoto(key, 'cat', 'square')`看能不能搜到示例图。都是真实最小成本的API调用（各查一次"test"/"cat"，不是空转），点击时也会顺手把输入框里的草稿值`setSettings`持久化一遍（跟DeepSeek那个"测试连接"按钮的`persistConnection()`是同一个思路，测试成功等于顺便帮用户保存了）。

## 应用内检查更新（`lib/updateCheck.ts` + `MePage`，新增）
用户问"有没有办法内置一个github更新按钮 按了之后就能更新软件 然后也不改变数据"，明确给了"不行就算了"的余地。**没做成真正意义上的原生自更新**（那需要`REQUEST_INSTALL_PACKAGES`权限+下载APK+触发Android安装器intent，纯native代码，对一个个人项目来说风险/工作量都偏大）——做的是一个折中但确实有用的版本：`MePage`"检查更新"这一行，点击调`checkForUpdate()`打`https://api.github.com/repos/Entropy2077-axe/talk/releases/latest`，用数字化版本号比较（不是简单字符串比较，避免"v0.10.0" < "v0.2.0"这种坑）跟当前`__APP_VERSION__`（Vite的`define`从`package.json`的`version`字段注入的编译期常量，见`vite.config.ts`+`src/vite-env.d.ts`）比对，有新版本就显示"发现新版本 vX.X.X"并把按钮变成"点击前往下载"（`window.open`到GitHub release页面，用户自己点APK下载、系统安装器里点安装）。
- **"不改变数据"这个要求其实不需要额外做什么，是白捡的**：只要新APK的`appId`（`com.talk.aichat`）和签名跟旧的一致，Android系统本身就会把"装一个包名相同的新APK"当成**原地升级**处理，不会清空app的数据目录（IndexedDB这些都在里面）——这跟你升级应用商店里任何一个app是同一个机制，不是这个项目自己做了什么特殊处理。**唯一的前提/风险点**：只要一直在同一台机器上用同一个debug keystore签名构建，这个前提就成立；如果换机器/keystore丢了导致签名对不上，Android会直接拒绝安装"更新"（提示签名冲突），届时必须先卸载旧的（会清空数据）才能装新的——这也是为什么"debug签名，没上正式release keystore"这件事以后如果要长期维护迭代版本，值得重新评估。
- 用Playwright真实测试过：本地`package.json`版本跟GitHub上最新release的tag一致时正确显示"已是最新版本"。

## 表情包系统（`StickersPage` + `lib/image.ts`）
上传时用`resizeImageDataUrl()`压缩到240px/JPEG。支持重命名（唯一性校验）、删除二次确认。

## 目录结构速查
- `src/pages/`：MessagesPage(消息列表，含1:1+群聊+未读红点，右上角"+"发起) / ContactsPage / ContactAddPage(问卷+直接创建+AI关系设定+日程生成) / ContactCardPage(含日程展示) / ChatPage(1:1与群聊共用，含委托卡片交互) / GroupAddPage(建群) / GroupInfoPage(成员列表+解散群聊) / TodoPage / DiscoverPage(朋友圈/商城/仓库/关系网/世界设定/天眼(仅管理员模式)入口) / RelationshipsPage(用户-AI关系总览+AI-AI关系展示) / MomentsPage(朋友圈) / WorldSettingsPage(世界观自写/AI帮写/收藏夹+知识库列表/删除/手动搜索) / SkyEyePage(console日志+数据统计+设置dump) / ShopPage / WarehousePage / MePage(含货币显示) / ProfileEditPage / SettingsPage(含Tavily key+管理员模式开关) / StickersPage。
- `src/components/`：TopBar / BottomNav(5个tab，消息tab带未读红点) / SearchOverlay / MessageBubble(含`CommissionCard`子组件+礼物卡片+日程变更卡片渲染) / NotificationBanner / ActionSheet / Avatar(圆角矩形) / AvatarPicker / ImageCropper / UnreadBadge(红点数字组件)。
- `src/lib/`：**chatEngine.ts(核心！sendMessage+triggerAiTurn+后台引擎，1:1专用)** / **groupChatEngine.ts(群聊版后台引擎，复用chatEngine.ts的store)** / groupChat.ts(群聊发言人选择+多人设prompt+协议解析+名字前缀leak清洗) / proactiveChat.ts(AI主动找你聊天) / schedule.ts(日程可用性判断+跨零点处理+校验) / webSearch.ts(Tavily搜索) / knowledgeBase.ts(知识库：关键词触发+去重+手动搜索) / photoSearch.ts(Pexels搜图+waifu.pics随机动漫图+console日志) / avatarCategory.ts(头像分类：性格标签加权随机，代码决定不是LLM) / consoleCapture.ts(全局console捕获) / unread.ts(未读消息计数) / updateCheck.ts(GitHub Release版本检查) / deepseek.ts(jsonMode开关+角色合并) / aiProtocol.ts(解析+兜底+委托reward clamp+scheduleChange解析+leak修复+平衡括号JSON提取) / prompt.ts(三层提示词+人设生成+日程生成+世界观草稿+头像搜图关键词) / memory.ts(记忆+关系增量+群聊记忆+约定提取) / relationship.ts(用户-AI五维度) / contactRelations.ts(AI-AI关系标签+情感分类) / moments.ts(朋友圈生成引擎+配图+级联删除) / shop.ts(独立商品生成) / wallet.ts(货币常量) / messagePreview.ts / randomTraits.ts / contact.ts(displayName) / image.ts(图片压缩) / search.ts / time.ts(含WEEKDAYS/toDateKey) / colors.ts / avatarEmojis.ts。
- `src/store/`：useSettingsStore(persist，含worldview/tavilyApiKey/autonomousBehaviorEnabled/adminModeEnabled等) / useChatEngineStore(不persist，每会话aiTyping/error) / useChatUiStore(不persist，activeConversationId+通知) / useConsoleCaptureStore(不persist，天眼用的console缓冲区)。

## 尚未实现 / 后续计划
- 发现页目前"朋友圈""商城""仓库""关系网"都是真的，虚拟网购(独立于商城)/TODO类占位仍待补充。
- 群聊已实现（见上面`群聊功能`章节），但仍是单LLM调用模拟多人设，不是AI-AI真正独立对话；朋友圈的AI-AI关系依然是静态标签、不会随时间演变——这两者是同一个有意的简化（没有真正的AI-AI对话通道，无法像用户-AI关系那样靠聊天动态更新）。
- AI-AI关系链、群聊成员都只能在创建时设置，没有事后编辑入口。群聊记忆已实现（见`群聊记忆系统`章节）但没有关系数值增量，也不支持委托/礼物这些游戏化系统（范围内的取舍）。
- AI的"约定/代办意识"（`PlanItem`）纯粹是软性的、靠模型自己看当前时间判断要不要提，没有主动推送/闹钟式提醒，也不理解口头取消改期（见`AI的"约定/代办意识"`章节）。
- 委托没有"重复接取""过期"防护，量不大暂时够用。（朋友圈"用户自己发圈"已实现，见上面`postUserMoment`章节）
- Capacitor Android 原生打包：本地已有 Android Studio（`C:\Projects\AndroidStudio`），用户说不着急。
- `CONTEXT_WINDOW_SIZE`/`MEMORY_UPDATE_INTERVAL`/朋友圈的`REACT_PROBABILITY`/`COMMENT_SHARE`/日程和知识库那批阈值(`PROACTIVE_*`/`KNOWLEDGE_REFRESH_INTERVAL_MS`等)仍是代码常量，没有设置页UI。
- 日程只能通过聊天协商(`scheduleChange`)临时改，没有直接编辑入口；`scheduleChange`目前群聊不支持；模型不总是愿意主动使用这个新协议类型去记录已达成的日程变更(prompt层面引导，非强制)。
- 知识库只支持"聊天触发的关键词一次性查询"+"用户手动指定方向搜索"两种途径，聊天时AI不会自己临时决定实时搜索(tool-calling循环明确排除的范围，见`联网搜索+知识库+世界观`章节)。
- 未读红点/管理员模式+天眼都是刚上线的，没有再往下细化的计划；天眼目前只有console日志/数据统计/设置dump三块，用户说了以后想加别的调试内容可以往这个页面加。

## 开发命令
- `npm run dev` — 启动开发服务器（host: true，可用局域网 IP 在手机浏览器访问）
- `npm run build` — `tsc -b && vite build`
- `npm run lint` — oxlint

## 浏览器自动化测试（Playwright，已作为devDependency装好）
`playwright`已装好、`npx playwright install chromium`也跑过了，可以真的用无头浏览器点开这个app验证功能，不用只靠类型检查臆测。**注意路由是`HashRouter`**（`http://localhost:5173/#/xxx`），Playwright内置的`page.waitForURL()`/`page.goBack()`默认`waitUntil:'load'`对纯hash跳转的SPA不适用（不会再触发`load`事件，会一直等到超时）——测试脚本里必须自己手写一个轮询`page.url()`字符串的等价函数，不要用这两个内置API。写测试脚本时放在项目根目录内（比如`.pw-test.mjs`）才能解析到`node_modules/playwright`，用完记得删掉临时脚本和截图，别留在仓库里。IndexedDB相关的功能想快速验证/复现bug时，不必每次都走完整的问卷生成人设那套真实API流程——可以直接`page.evaluate`里`await import('/src/db/db.ts')`拿到`db`实例手动`db.contacts.add(...)`等直接种数据，跳过真实AI调用，排查UI/渲染类问题快得多（滚动到底部那个bug就是这么复现和验证修复的）。
