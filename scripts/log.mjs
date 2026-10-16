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
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
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

function readContext() {
  const { log, notes } = pathsFor(process.cwd());
  const out = [];
  if (existsSync(notes)) {
    const noteLines = readFileSync(notes, "utf8").split("\n");
    const over = noteLines.length > NOTES_MAX_LINES;
    // 笔记是快照，但快照会过期：把"多久没更新"直接摆到读者眼前，
    // 让新对话自己决定要不要先核对代码，而不是默认笔记就是现状。
    const age = Date.now() - statSync(notes).mtimeMs;
    const staleDays = age / 86400000;
    out.push(
      `===== 精炼交接笔记（当前状态快照 · 最后更新 ${fmtTime(
        statSync(notes).mtimeMs,
      )}，${humanAge(age)}）=====`,
      (over ? noteLines.slice(-NOTES_MAX_LINES) : noteLines).join("\n").trim(),
    );
    if (over) {
      out.push(
        "",
        `⚠ 笔记已 ${noteLines.length} 行，超过 ${NOTES_MAX_LINES} 行上限（只显示了尾部）。` +
          `收尾时请把它改成当前状态快照：删掉已完成与过时的条目，历史留给机械日志。`,
      );
    }
    if (staleDays >= 14) {
      out.push(
        "",
        `⚠ 笔记已 ${Math.round(staleDays)} 天没有更新，其中"现状"很可能已经不是现状：` +
          `把它当查找线索而不是事实，先核对代码再动手，并在收尾时改写它。`,
      );
    }
  } else {
    out.push("===== 精炼交接笔记：尚不存在 =====");
  }
  if (existsSync(log)) {
    const blocks = tail(log, 24 * 1024)
      .split(/^(?=### 轮次 )/m)
      .filter((b) => b.startsWith("### 轮次"));
    out.push("", "===== 最近两轮原文摘录 =====", blocks.slice(-2).join("\n").trim());
  }
  out.push("", `（完整机械日志：${log}）`);
  return out.join("\n");
}

function main() {
  const args = process.argv.slice(2);
  const flag = args.find((a) => a.startsWith("--"));
  if (flag === "--which" || flag === "--read") {
    const { log, notes } = pathsFor(process.cwd());
    if (flag === "--which") {
      process.stdout.write(`${log}\n${notes}\n`);
    } else {
      process.stdout.write(`${readContext()}\n`);
    }
    return;
  }

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
