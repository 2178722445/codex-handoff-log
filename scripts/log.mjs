// 跨对话交接日志。
//
// 两种运行模式：
//   1) notify 钩子模式：Codex 每轮结束时把 JSON 负载作为最后一个参数传进来
//      （type/thread-id/turn-id/cwd/input-messages/last-assistant-message），
//      这里把该轮追加进对应项目的机械日志。
//   2) 命令行模式：--which 打印日志路径，--read 打印"精炼笔记 + 最近两轮"。
//
// 设计要点：任何异常都不能阻塞每轮结束，所以顶层 try/catch 吞掉错误并写 errors.log；
// 若配置了转发命令，用 detached 子进程触发，绝不等待。
//
// 位置与转发都可通过环境变量覆盖，便于在不同机器上复用：
//   CODEX_HANDOFF_DIR      日志目录，默认 ~/.codex/handoff
//   CODEX_NOTIFY_FORWARD   每轮结束时额外执行的命令（覆盖 forward.txt）
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const HANDOFF_DIR =
  process.env.CODEX_HANDOFF_DIR ?? join(homedir(), ".codex", "handoff");
const LOG_DIR = join(HANDOFF_DIR, "logs");
const MAX_USER_CHARS = 300;
const MAX_REPLY_CHARS = 1200;
const ROTATE_BYTES = 512 * 1024;
// 精炼笔记是"当前状态快照"，不是流水账；超过这个行数就在 --read 时明确要求收敛。
// 没有这道闸，笔记会随项目时间线无限增长，读它的成本就吃掉省下来的 token。
const NOTES_MAX_LINES = 80;
// 机器笔记是跨项目复用的"环境备忘"，每轮读取都带上它，所以上限卡得更紧。
const MACHINE_MAX_LINES = 40;

// 长期记忆里绝不该出现明文密钥：一旦写进去，就会随每次读取进入模型上下文。
// 这里只做保守模式匹配（宁可漏报也不要把普通文本误判成密钥），命中就提醒改成"指针"。
const SECRET_PATTERNS = [
  { kind: "API key（sk- 开头）", re: /\bsk-[A-Za-z0-9_-]{12,}/ },
  { kind: "GitHub token", re: /\b(?:gho_|ghp_|ghs_|ghu_|github_pat_)[A-Za-z0-9_]{10,}/ },
  { kind: "AWS Access Key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { kind: "私钥块", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  {
    kind: "疑似口令赋值",
    re: /\b(?:token|password|passwd|secret|api[_-]?key|bearer)\b\s*[:=]\s*["']?[A-Za-z0-9_\-./+]{12,}/i,
  },
];

const TEXT_EXTENSIONS = new Set([
  ".md",
  ".markdown",
  ".txt",
  ".json",
  ".jsonl",
  ".toml",
  ".yaml",
  ".yml",
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".py",
  ".go",
  ".rs",
  ".sh",
  ".bash",
  ".ps1",
  ".cmd",
  ".bat",
  ".env",
  ".ini",
  ".cfg",
  ".conf",
]);

function scanSecrets(text) {
  const hits = [];
  const lines = String(text).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    for (const p of SECRET_PATTERNS) {
      if (p.re.test(lines[i])) hits.push({ line: i + 1, kind: p.kind, text: lines[i].trim().slice(0, 120) });
    }
  }
  return hits;
}

function logError(where, err) {
  try {
    mkdirSync(HANDOFF_DIR, { recursive: true });
    appendFileSync(
      join(HANDOFF_DIR, "errors.log"),
      `${new Date().toISOString()} ${where} ${err?.stack ?? err}\n`,
      "utf8",
    );
  } catch {}
}

// 诊断开关：HANDOFF_DIR 里存在 debug-on 文件时，记录每次被调用的参数形状。
// 平时完全不写，避免给每轮增加无谓的 IO。
function debugNote(args) {
  if (!existsSync(join(HANDOFF_DIR, "debug-on"))) return;
  try {
    appendFileSync(
      join(HANDOFF_DIR, "invocations.log"),
      `${new Date().toISOString()} argv=${JSON.stringify(args).slice(0, 300)} ` +
        `stdin=${process.stdin.isTTY ? "tty" : "pipe"}\n`,
      "utf8",
    );
  } catch {}
}

// 项目根：从 cwd 往上找 .git，找不到就用 cwd 本身。
// 目的是让 backend/ 与仓库根开的对话落进同一份日志。
function projectRoot(cwd) {
  let dir = cwd;
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return cwd;
}

function slugFor(p) {
  return p.replace(/[\\/:]+/g, "-").replace(/^-+|-+$/g, "");
}

function pathsFor(cwd) {
  const root = projectRoot(cwd);
  const slug = slugFor(root);
  return {
    root,
    log: join(LOG_DIR, `${slug}.log.md`),
    notes: join(LOG_DIR, `${slug}.notes.md`),
    machine: join(HANDOFF_DIR, "machine.md"),
  };
}

function oneLine(text = "", limit) {
  const flat = String(text).replace(/\s+/g, " ").trim();
  if (flat.length <= limit) return flat;
  return `${flat.slice(0, limit)}…（已截断）`;
}

function fmtTime(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(
    d.getMinutes(),
  )}`;
}

function humanAge(ms) {
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.round(min / 60);
  if (hour < 48) return `${hour} 小时前`;
  return `${Math.round(hour / 24)} 天前`;
}

function tail(file, bytes) {
  if (!existsSync(file)) return "";
  const size = statSync(file).size;
  const start = Math.max(0, size - bytes);
  return readFileSync(file).subarray(start).toString("utf8");
}

// 转发命令：优先环境变量，其次 <HANDOFF_DIR>/forward.txt 的第一行非注释内容。
// 用它把原有的 notify 程序串起来（一个 notify 槽位只能配一个程序）。
function forwardCommand() {
  if (process.env.CODEX_NOTIFY_FORWARD) return process.env.CODEX_NOTIFY_FORWARD;
  const file = join(HANDOFF_DIR, "forward.txt");
  if (!existsSync(file)) return null;
  const line = readFileSync(file, "utf8")
    .split(/\r?\n/)
    .find((l) => l.trim() && !l.trim().startsWith("#"));
  return line?.trim() ?? null;
}

function appendTurn(payload) {
  const cwd = payload["cwd"] ?? process.cwd();
  const { log } = pathsFor(cwd);
  mkdirSync(LOG_DIR, { recursive: true });

  if (existsSync(log) && statSync(log).size > ROTATE_BYTES) {
    const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15);
    renameSync(log, log.replace(/\.log\.md$/, `.archive-${stamp}.log.md`));
  }

  const thread = payload["thread-id"] ?? "unknown-thread";
  const header = `## 对话 ${thread} `;
  const prior = tail(log, 16 * 1024);
  const headerAt = prior.lastIndexOf(header);
  const sameThread = headerAt >= 0;
  // 只数本对话标题之后的轮次，否则会把上一个对话的轮次累计进来
  const turnCount = sameThread
    ? ((prior.slice(headerAt).match(/^### 轮次/gm) ?? []).length || 0) + 1
    : 1;
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(
    now.getHours(),
  )}:${pad(now.getMinutes())}`;

  const isFreshFile = !existsSync(log) || statSync(log).size === 0;
  const lines = [];
  if (!sameThread) {
    if (!isFreshFile) lines.push("");
    lines.push(
      `## 对话 ${thread} · 起于 ${stamp} · ${payload["client"] ?? "codex"} · ${projectRoot(cwd)}`,
      "",
    );
  }
  const userMsgs = payload["input-messages"];
  const lastUser = Array.isArray(userMsgs) ? (userMsgs[userMsgs.length - 1] ?? "") : (userMsgs ?? "");
  lines.push(
    `### 轮次 ${turnCount} · ${stamp}`,
    "",
    `- 用户：${oneLine(lastUser, MAX_USER_CHARS)}`,
    `- 回复：${oneLine(payload["last-assistant-message"], MAX_REPLY_CHARS)}`,
    "",
  );
  appendFileSync(log, `${lines.join("\n")}\n`, "utf8");
}

// 一段长期记忆：标题带更新时间和年龄（快照会过期，读者得知道多旧），超过行数上限只给尾部。
function noteSection(title, file, maxLines, warnings) {
  if (!existsSync(file)) return [`===== ${title}：尚不存在 =====`];
  const text = readFileSync(file, "utf8");
  const lines = text.split("\n");
  const over = lines.length > maxLines;
  const age = Date.now() - statSync(file).mtimeMs;
  const out = [
    `===== ${title}（最后更新 ${fmtTime(statSync(file).mtimeMs)}，${humanAge(age)}）=====`,
    (over ? lines.slice(-maxLines) : lines).join("\n").trim(),
  ];
  if (over) {
    warnings.push(
      `${title} 已 ${lines.length} 行，超过 ${maxLines} 行上限（只显示了尾部）：` +
        `收尾时删掉已完成与过时的条目，改写当前状态。`,
    );
  }
  if (age / 86400000 >= 14) {
    warnings.push(
      `${title} 已 ${Math.round(age / 86400000)} 天没有更新，其中"现状"很可能已经不是现状：` +
        `当线索而不是事实，先核对代码再动手。`,
    );
  }
  for (const hit of scanSecrets(text)) {
    warnings.push(`${title} 第 ${hit.line} 行疑似明文密钥（${hit.kind}）：${hit.text}`);
  }
  return out;
}

function readContext() {
  const { log, notes, machine } = pathsFor(process.cwd());
  const warnings = [];
  const out = [
    ...noteSection("机器笔记（跨项目复用的环境事实）", machine, MACHINE_MAX_LINES, warnings),
    "",
    ...noteSection("精炼交接笔记（当前状态快照）", notes, NOTES_MAX_LINES, warnings),
  ];
  if (existsSync(log)) {
    const blocks = tail(log, 24 * 1024)
      .split(/^(?=### 轮次 )/m)
      .filter((b) => b.startsWith("### 轮次"));
    out.push("", "===== 最近两轮原文摘录 =====", blocks.slice(-2).join("\n").trim());
  }
  out.push("", `（完整机械日志：${log}）`);
  if (warnings.length) {
    // 安全告警放最前面：读者一定会看到，而不是淹没在正文里
    return [
      "⚠⚠ 需要处理：",
      ...warnings.map((w) => `  ⚠ ${w}`),
      "",
      ...out,
    ].join("\n");
  }
  return out.join("\n");
}

// 扫描任意文本文件里的明文密钥，用于"发不发布"之前自检，或检查笔记是否写脏了。
function scanDir(dir, hits, root = dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      scanDir(full, hits, root);
      continue;
    }
    if (statSync(full).size > 1024 * 1024) continue;
    const ext = entry.name.slice(entry.name.lastIndexOf(".")).toLowerCase();
    if (!TEXT_EXTENSIONS.has(ext)) continue;
    const text = readFileSync(full, "utf8");
    if (text.includes("\u0000")) continue;
    for (const hit of scanSecrets(text)) {
      hits.push(`${full.slice(root.length + 1)} 第 ${hit.line} 行：${hit.kind} —— ${hit.text}`);
    }
  }
  return hits;
}

function main() {
  const args = process.argv.slice(2);
  const flag = args.find((a) => a.startsWith("--"));
  if (flag === "--which" || flag === "--read" || flag === "--check") {
    const { log, notes, machine } = pathsFor(process.cwd());
    if (flag === "--which") {
      process.stdout.write(`${machine}\n${notes}\n${log}\n`);
    } else if (flag === "--check") {
      const target = args[args.indexOf("--check") + 1];
      const hits = target
        ? scanDir(target, [])
        : [
            ...scanSecrets(existsSync(machine) ? readFileSync(machine, "utf8") : "").map(
              (h) => `${machine} 第 ${h.line} 行：${h.kind} —— ${h.text}`,
            ),
            ...scanSecrets(existsSync(notes) ? readFileSync(notes, "utf8") : "").map(
              (h) => `${notes} 第 ${h.line} 行：${h.kind} —— ${h.text}`,
            ),
          ];
      process.stdout.write(
        hits.length
          ? `⚠ 发现 ${hits.length} 处疑似明文密钥：\n${hits.map((h) => `  - ${h}`).join("\n")}\n`
          : `未发现疑似明文密钥（${target ?? `${machine} 与 ${notes}`}）\n`,
      );
    } else {
      process.stdout.write(`${readContext()}\n`);
    }
    return;
  }

  debugNote(args);

  // 逐个人参倒着找负载：不同入口（CLI / 桌面端）附加的参数不完全一致，
  // 只认最后一个参数会在桌面端把负载前的开关误当成负载。
  let raw = null;
  let payload = null;
  for (let i = args.length - 1; i >= 0; i--) {
    const a = args[i];
    if (typeof a !== "string" || !a.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(a);
      if (parsed?.type === "agent-turn-complete") {
        raw = a;
        payload = parsed;
        break;
      }
    } catch {}
  }
  if (!payload) return;
  appendTurn(payload);

  const forward = forwardCommand();
  if (forward) {
    try {
      // 负载通过环境变量交给转发命令，避免再拼一次命令行引号
      spawn(forward, {
        shell: true,
        detached: true,
        stdio: "ignore",
        env: { ...process.env, CODEX_NOTIFY_PAYLOAD: raw },
      }).unref();
    } catch (err) {
      logError("forward", err);
    }
  }
}

try {
  main();
} catch (err) {
  logError("main", err);
}
process.exit(0);
