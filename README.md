# codex-handoff-log

给 Codex 的**跨对话交接日志**：每轮对话结束时自动落盘一条记录，让同一个项目的下一个对话能接着上一个干，
而不是从零重新翻仓库。

它是 [Codex 技能（skill）](https://developers.openai.com/codex/) `handoff-log` 的发布版，
配合 Codex 的 `notify` 钩子使用。写日志不经过模型，**不消耗 token**。

## 为什么需要它

Codex 的对话之间不共享上下文，也不共享记忆。同一件事分几次做，每次都要重新交代背景、
重新读代码、重新踩一遍上次踩过的坑。

这个技能用两层日志解决：

| 层 | 文件 | 谁来写 | 特点 |
| --- | --- | --- | --- |
| 机械日志 | `<项目>.log.md` | notify 钩子自动追加 | 每轮一条，零 token 成本，完整可回溯 |
| 精炼笔记 | `<项目>.notes.md` | Codex 在任务收尾时改写 | **当前状态快照**，硬上限 80 行，原地改写不追加 |

新对话开场只读"精炼笔记 + 最近两轮原文"，几十行就能接上进度。

### 读进来的上下文不会越来越长

这是设计上刻意保住的性质，靠两条：

- **机械日志只按尾部读**：`--read` 永远只给最近两轮，日志再长也不进上下文（文件本身超过 512 KB 自动归档轮转）。
- **笔记是快照、有硬上限**：笔记回答"现在在哪、下一步做什么"，不记录时间线；脚本在 `--read` 时数行数，
  超过 80 行就提示收敛，并且只输出尾部 80 行。

于是每个新对话的"接手成本"大致是常数：笔记约 600～1000 token，加最近两轮约 300～800 token，
与项目做了多久无关。相比之下，不看笔记重新翻一遍仓库通常是几万 token。

### 旧信息会不会污染新对话

会，这是这类机制的主要失效模式：项目做得越久，笔记里的"现状"越可能已经不是现状，
而新对话会倾向于相信先读到的东西。脚本没法消灭它，只能把它压到可控：

- **上限逼着淘汰**：笔记 80 行封顶，想写新内容就得先删旧的，物理上不允许无限累积。
- **年龄信号**：`--read` 打印笔记最后更新时间与"多久没更新"，超过 14 天明确告警，
  提醒先核对代码再动手。
- **权威顺序写死在技能里**：代码、README、`AGENTS.md` 的现状高于笔记；笔记只用于决定"去哪看"。
- **机械日志不进上下文**：只读最近两轮，日志再长也不构成污染源（文件超 512 KB 自动归档）。

剩下的残余风险只能靠纪律：笔记质量取决于收尾那一刻是否诚实——把"以为做完的"写成"已做完"，
下一个对话就会带着错误前提开工。所以收尾时只写已验证的结论，没验证的标 `未核实`。

另一个已知限制：**日志按仓库分文件，不按任务分**。在同一个仓库里做不相干的事（比如给 某个内部项目 写代码，
同时在同一个目录里折腾 Codex 配置），两类轮次会落进同一份日志。这时候笔记的"当前目标"是唯一的区分，
开场只取与本轮任务相关的段落即可；实在介意就临时用 `CODEX_HANDOFF_DIR` 指到别处。

## 安装

需要 Node.js（用了 ESM 与 `node:` 前缀，建议 18 以上）。

**1. 放进技能目录**

```bash
git clone https://github.com/<你的账号>/codex-handoff-log.git ~/.codex/skills/handoff-log
```

Windows 上默认位置是 `C:\Users\<你>\.codex\skills\handoff-log`。

**2. 配置 notify 钩子**

在 `~/.codex/config.toml` 里加上：

```toml
# Windows
notify = [ "node", "C:\\Users\\<你>\\.codex\\skills\\handoff-log\\scripts\\log.mjs" ]

# macOS / Linux
# notify = [ "node", "/home/<你>/.codex/skills/handoff-log/scripts/log.mjs" ]
```

改完重启 Codex 会话生效。`notify` 是**单个槽位**，如果你的配置里已经有一个程序（例如电脑操作通知），
见下一步。

**3.（可选）转发给原有的 notify 程序**

在日志目录里建 `forward.txt`，写一行要额外执行的命令；每轮结束时它会被触发，
原始 JSON 负载通过环境变量 `CODEX_NOTIFY_PAYLOAD` 传给它：

```
# ~/.codex/handoff/forward.txt
C:\Users\<你>\AppData\Local\OpenAI\Codex\runtimes\...\codex-computer-use.exe turn-ended
```

也可以用环境变量覆盖：`CODEX_NOTIFY_FORWARD`。

**4. 验证**

```bash
node ~/.codex/skills/handoff-log/scripts/log.mjs --which
```

能打印出两个文件路径就说明脚本可用；然后在任意项目里跟 Codex 说一句话，
看 `<项目>.log.md` 是否多出一条记录。

## 用法

```bash
# 打印当前项目的日志文件路径（在子目录里跑也可以，会往上找 .git 定位项目根）
node ~/.codex/skills/handoff-log/scripts/log.mjs --which

# 读上下文：精炼笔记 + 最近两轮原文
node ~/.codex/skills/handoff-log/scripts/log.mjs --read
```

`--read` 的输出形如：

```
===== 精炼交接笔记（由历次对话维护，当前状态快照）=====
# D:\projects\demo · 交接笔记

## 当前目标
把扩增模块的输入过滤对齐

## 现状
- ExcludeAugmented 与 validateDerivedInputChain 已同时改完，测试全绿

## 关键决定 / 坑
- 两处实现必须同时改，只改一处会让产物继续出现在下拉里，选中才被 400 打回

## 未决 / 下一步
- noised 血缘的测试还没补

===== 最近两轮原文摘录 =====
### 轮次 7 · 2026-10-16 12:02
- 用户：…
- 回复：…
```

日常使用不需要手动敲这些命令：把 `AGENTS.md` 里的约定告诉 Codex（见下），它会自己读和写。

## 配合 AGENTS.md

把下面几条加到 `~/.codex/AGENTS.md`（全局）或项目里的 `AGENTS.md`，
新对话就会自动先读笔记、收尾时自动写笔记：

```markdown
- 接手一个既有项目时，先跑 `node ~/.codex/skills/handoff-log/scripts/log.mjs --read`，
  读上一次对话留下的交接笔记，从"未决 / 下一步"续接。
- 任务收尾（提交完成、验证通过、或用户说"结束"）时，把增量结论追加进该项目笔记：
  做了什么 / 关键决定与坑 / 未决下一步，一条不超过 5 行。
```

这几行会进入每一轮上下文（约一百 token），是"自动接续"的代价；觉得不划算可以只留第一条。

## 工作原理

Codex 每轮结束时，把一段 JSON 作为最后一个参数交给 `notify` 程序，负载形如：

```json
{
  "type": "agent-turn-complete",
  "thread-id": "01a142e1-83f4-79b3-91eb-8c4c4583da7a",
  "turn-id": "01a142e1-9a02-7f31-8b90-1f0cf0f0a9a2",
  "cwd": "D:\\projects\\demo",
  "client": "codex_exec",
  "input-messages": ["把登录接口的超时改成 5 秒"],
  "last-assistant-message": "已改完，并补了重试。改动：…"
}
```

`scripts/log.mjs` 读它，做三件事：

1. 从 `cwd` 往上找 `.git` 得到项目根，路径转成 slug 当作日志文件名；
2. 把这一轮追加进 `<项目>.log.md`（同一 `thread-id` 归为同一个对话，逐轮编号）；
3. 如果配了转发命令，把原始负载交给它，保持你原有的 notify 行为。

日志写在 `~/.codex/handoff/logs/`，**不写进项目仓库**。

## 隐私与安全

- **不联网**：脚本只做本地文件读写，没有任何网络请求。
- **不读代码**：它只写 `input-messages` 与 `last-assistant-message` 两个字段，
  不会去扫描你的仓库内容。
- **不写进仓库**：日志目录在 `~/.codex/handoff/`，与本仓库无关；`.gitignore` 也已排除日志与 `forward.txt`。
- 日志里会包含你的提问与 Codex 的最终回复，按需选择存放位置：
  涉密项目建议 `CODEX_HANDOFF_DIR` 指到加密盘或不放日志；也不要让日志目录进云同步盘。
- 发布版脚本不含任何机器相关的绝对路径，转发命令从本地 `forward.txt` 读取。

## 已知限制

- 只记录**最终回复**，过程中的工具调用与中间输出不会进日志。
- `notify` 是单槽位，已有程序需要按安装第 3 步转发。
- Codex 桌面端升级或重装可能重写 `config.toml`，`notify` 被覆盖后日志会静默停止；
  排障看 `~/.codex/handoff/errors.log`。
- 单条日志会截断（用户 300 字、回复 1200 字），单文件超过 512 KB 自动归档轮转。

## 目录结构

```
codex-handoff-log/
├── SKILL.md              # 技能说明（Codex 加载的入口）
├── agents/openai.yaml    # 技能在界面上的展示信息
├── scripts/log.mjs       # notify 钩子脚本 + --read/--which 命令行
├── README.md
└── .gitignore
```

## 自测

改脚本后可以用合成负载验证写入逻辑（不会真的调用模型）：

```powershell
$env:CODEX_HANDOFF_DIR = "$env:TEMP\handoff-selftest"
$payload = @{
  type = 'agent-turn-complete'; 'thread-id' = 't1'; 'turn-id' = 'u1'
  cwd = (Get-Location).Path; client = 'selftest'
  'input-messages' = @('测试'); 'last-assistant-message' = '测试回复'
} | ConvertTo-Json -Compress
node .\scripts\log.mjs $payload
Get-ChildItem "$env:TEMP\handoff-selftest\logs"
```

技能结构可用 skill-creator 的校验脚本检查：

```bash
python <skill-creator>/scripts/quick_validate.py .
```

## 卸载

1. 从 `~/.codex/config.toml` 删掉 `notify`（或改回原来的程序）；
2. 删掉技能目录 `~/.codex/skills/handoff-log`；
3. 日志目录 `~/.codex/handoff/` 按需保留或删除。

## 许可

本仓库暂未附加开源许可证。若要允许他人自由复用、修改与再分发，建议补一个 `LICENSE`（例如 MIT）。
