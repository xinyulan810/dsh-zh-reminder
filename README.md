# dsh-zh-reminder

给 DeepSeek Harness 用的中文思考提醒插件：**会话开头提醒一次「用中文思考与回答」，之后只要回复里出现大段英文就再次提醒**。

零运行时依赖的 host-only bundle，不使用编译、不 import 任何 `@deepseek-ai/*` 包。

## 两个功能

| 功能 | 触发时机 | 行为 |
| --- | --- | --- |
| 会话开头提醒 | 每个会话的第一个 step（`turn 1 / step 1`） | 在本轮输入前插入一条中文提醒，一个会话只插入一次 |
| 大段英文提醒 | 折叠 `assistant/message` 时抽检到某一段非代码文字英文占比超标 | 在下一轮的下一次 `agent/pre-step` 插入一次提醒，同一段回复只提醒一次 |

判定规则（按用户要求）：**逐自然段判定，不做全文累计**。任意一段非代码文字的英文占比超过阈值就提醒；

## 安装

### 方式一：会话内安装（推荐）

在 dsh 会话里安装（`target` 传本包的绝对路径）：

```
plugin_manager: action = install_bundle, target = D:\code\dsh-zh-reminder
```

安装后 `application` 变为 `applied` 即生效；用 `cordis_inspect_query` 可以看到新插入的行。

> 注意：**替换已安装的同名包需要重启 dsh** 才会加载新的 JS 模块代；首次装入一个新 bundle 可以由 HMR 直接激活。

### 方式二：本地 link 装入（开发时用）

包本体留在工作区，profile 里只是一条 Junction 链接，改代码后重启即生效：

1. 在 profile 的 `package.json` 的 `dependencies` 里加一行 `"dsh-zh-reminder": "link:D:/code/dsh-zh-reminder"`；
2. 用 dsh 自带 CLI 安装依赖（不要在 profile 目录直接跑 pnpm）：
   `dsh plugin --profile desktop install`；
3. 在 profile 的 `cordis.patch.yml` 里插入插件行，内容可直接抄本包的 `cordis.patch.yml`。

`D:\Program Files\DSH Desktop` 之类的旧路径脚本已经失效，当前桌面版装在
`%LOCALAPPDATA%\Programs\DeepSeek Harness`，重启要杀 `DeepSeek Harness.exe` 那一棵树。

## 配置

配置写在 bundle 的 `cordis.patch.yml` 里：

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `startReminder` | 见下 | 会话开头的提醒文本 |
| `repeatReminder` | 见下 | 检测到超标英文时的提醒文本 |
| `threshold` | `0.8` | 单段英文占比阈值，严格大于该值才算超标 |
| `minChars` | `20` | 单段最少字符数，低于此长度不判定 |
| `minLetters` | `8` | 单段最少英文字母数，低于此数量不判定 |
| `maxChecks` | `8` | 最多抽检的段落数 |
| `maxScanChars` | `2000` | 只扫描回复开头这么多字符 |

配置值非法（类型不对、非正数、比例越界）时自动回落到默认值，不会让插件加载失败。

## 英文占比怎么算

1. 去掉 fenced code block（``` / ~~~）与行内代码（`` ` ``）里的内容；
2. 按空行把剩余正文切成自然段，段内换行折叠成空格；
3. 每段的**分母只数有效字符**：英文字母、数字、CJK 汉字、假名、韩文；空白与标点不计入，避免英文空行或标点把比例摊薄；
4. 分子是 ASCII 字母数。分子 / 分母 > `threshold` 即判定该段超标。

因此：

- 「这是一段完全用中文写的说明，虽然长度足够但英文为零」→ 不触发；
- 「这段主要在说中文，只是顺带出现几个专有名词」→ 不触发；
- 整段英文（含代码块之外的技术说明）→ 触发。

## 性能设计

提醒属于增强能力，所以一切都按「不能拖慢会话」来约束：

- **检测只在 `assistant/message` 事件里发生**，并且是**有界抽检**：最多看 `maxScanChars` 个字符、`maxChecks` 个段落，命中第一段超标立刻返回，不遍历全文；
- 折叠状态只有几个标量（`turn` / `step` / `waitingStart` / `awaitingRepeat` / `repeatTurn` / `repeatStep`），是纯 JSON 小对象；对不关心的事件**返回同一引用**，不会产生无意义的视图失效或新对象；
- 不订阅 `session/event` 重扫日志、不加定时器、不轮询状态、不产生额外模型请求；
- **不改写系统提示词**。同类的常驻提醒（例如 `ctx.systemPrompt.section()`）会让每一次请求都多付一次 token；本插件只在真正需要时才插入一条短消息。

## 「已提醒」是怎么记的

`agent/pre-step` 是 waterfall，只能**读**会话状态、不能回写。所以本插件把「已提醒」的真相放在**会话日志**里：注入的提醒消息落入日志后会再以 `user/message` 事件回到投影单元的 `apply`，在那里把 `waitingStart` / `awaitingRepeat` 落定（靠消息 `source.sections[0].name` 里的 `dsh-zh-reminder:start` / `dsh-zh-reminder:repeat` 标签区分）。

这样即使同一轮内多次经过 `pre-step`，也不会重复注入同一条提醒；不需要额外写事件，也不需要轮询。

## 自检

```powershell
npm test          # 20 个单元/流程用例：检测内核 + 投影折叠 + pre-step 注入
npm run probe     # 清单、入口、patch 文件与零依赖自检
```

## 目录结构

```
dsh-zh-reminder/
├── package.json          # dsh bundle 清单（exports + dsh.bundle.patch）
├── cordis.patch.yml      # 插入行与默认配置
├── lib/
│   ├── index.js          # 插件主体：投影单元 + agent/pre-step 注入
│   └── detect.js         # 纯函数检测内核与配置规范化
├── test/
│   ├── detect.test.js
│   └── plugin.test.js
└── probe/
    └── check.mjs         # 安装前自检
```

## 许可

MIT
