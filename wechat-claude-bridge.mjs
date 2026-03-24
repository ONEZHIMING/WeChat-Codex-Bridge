#!/usr/bin/env node
/**
 * 微信 iLink Bot API 裸调 Demo
 * 无需 openclaw，直接 HTTP 调用 ilinkai.weixin.qq.com
 *
 * 用法:
 *   node wechat-claude-bridge.mjs start --instance wx1
 *   node wechat-claude-bridge.mjs login --instance wx1
 *   node wechat-claude-bridge.mjs accounts
 */

import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import readline from "node:readline";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

// 加载 .env（支持无 dotenv 依赖场景）
const require = createRequire(import.meta.url);
function parseEnvText(raw) {
  const out = {};
  for (const line of String(raw).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    if (!key) continue;
    let val = trimmed.slice(idx + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"'))
      || (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

function applyEnvObject(parsed) {
  for (const [k, v] of Object.entries(parsed || {})) {
    if (process.env[k] == null || process.env[k] === "") {
      process.env[k] = String(v);
    }
  }
}

(() => {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const envCandidates = [
    path.resolve(process.cwd(), ".env"),
    path.resolve(scriptDir, ".env"),
  ];
  const loaded = new Set();

  let dotenv = null;
  try {
    dotenv = require("dotenv");
  } catch {
    dotenv = null;
  }

  for (const envPath of envCandidates) {
    if (loaded.has(envPath)) continue;
    loaded.add(envPath);
    if (!fs.existsSync(envPath)) continue;
    try {
      const raw = fs.readFileSync(envPath, "utf-8");
      const parsed = dotenv?.parse ? dotenv.parse(raw) : parseEnvText(raw);
      applyEnvObject(parsed);
    } catch {
      // ignore single file parse error, continue next candidate
    }
  }
})();

// ─── 配置 ────────────────────────────────────────────────────────────────────

function withInstanceSuffix(fileName, instanceId) {
  if (!instanceId) return fileName;
  const dot = fileName.lastIndexOf(".");
  if (dot <= 0) return `${fileName}.${instanceId}`;
  return `${fileName.slice(0, dot)}.${instanceId}${fileName.slice(dot)}`;
}

function printHelp() {
  console.log(`用法:
  node wechat-claude-bridge.mjs [start] [--instance <id>] [--login]
  node wechat-claude-bridge.mjs login [--instance <id>]
  node wechat-claude-bridge.mjs accounts
  node wechat-claude-bridge.mjs memory export --user <id> [--out <json路径>]
  node wechat-claude-bridge.mjs memory import --user <id> --in <json路径> [--mode merge|replace]
  node wechat-claude-bridge.mjs memory validate --in <json路径>
  node wechat-claude-bridge.mjs --help

说明:
  start                  启动 bridge（默认命令）
  login                  强制重新扫码登录后启动
  accounts               查看已登录账号列表
  memory                 记忆迁移工具（导出/导入/校验）
  --instance, -i <id>    指定实例ID（隔离 token/session 文件）
  --login                等价于 login 子命令（兼容旧参数）
`);
}

function parseCliArgs(argv) {
  const opts = {
    command: "start",
    forceLogin: false,
    instanceId: (process.env.INSTANCE_ID || "").trim(),
    memoryAction: "",
    memoryUser: "",
    memoryIn: "",
    memoryOut: "",
    memoryMode: "merge",
  };

  const args = [...argv];
  if (args[0] && !args[0].startsWith("-")) {
    opts.command = args.shift();
  }
  if (opts.command === "memory" && args[0] && !args[0].startsWith("-")) {
    opts.memoryAction = args.shift().trim();
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--instance" || arg === "-i") {
      const val = args[i + 1];
      if (!val || val.startsWith("-")) throw new Error("参数错误: --instance 需要一个值");
      opts.instanceId = val.trim();
      i++;
      continue;
    }
    if (arg === "--login") {
      opts.forceLogin = true;
      continue;
    }
    if (arg === "--help" || arg === "-h" || arg === "help") {
      opts.command = "help";
      continue;
    }
    if (arg === "--list-accounts") {
      opts.command = "accounts";
      continue;
    }
    if (arg === "--user") {
      const val = args[i + 1];
      if (!val || val.startsWith("-")) throw new Error("参数错误: --user 需要一个值");
      opts.memoryUser = val.trim();
      i++;
      continue;
    }
    if (arg === "--in") {
      const val = args[i + 1];
      if (!val || val.startsWith("-")) throw new Error("参数错误: --in 需要一个值");
      opts.memoryIn = val.trim();
      i++;
      continue;
    }
    if (arg === "--out") {
      const val = args[i + 1];
      if (!val || val.startsWith("-")) throw new Error("参数错误: --out 需要一个值");
      opts.memoryOut = val.trim();
      i++;
      continue;
    }
    if (arg === "--mode") {
      const val = (args[i + 1] || "").trim();
      if (!val || val.startsWith("-")) throw new Error("参数错误: --mode 需要一个值");
      if (!["merge", "replace"].includes(val)) throw new Error("参数错误: --mode 仅支持 merge|replace");
      opts.memoryMode = val;
      i++;
      continue;
    }
    throw new Error(`未知参数: ${arg}`);
  }

  if (opts.command === "memory") {
    if (!["export", "import", "validate"].includes(opts.memoryAction)) {
      throw new Error("memory 子命令仅支持 export|import|validate");
    }
    if (opts.memoryAction === "export" && !opts.memoryUser) {
      throw new Error("memory export 需要 --user <id>");
    }
    if (opts.memoryAction === "import" && (!opts.memoryUser || !opts.memoryIn)) {
      throw new Error("memory import 需要 --user <id> --in <json路径>");
    }
    if (opts.memoryAction === "validate" && !opts.memoryIn) {
      throw new Error("memory validate 需要 --in <json路径>");
    }
    return opts;
  }

  if (opts.command === "login") {
    opts.command = "start";
    opts.forceLogin = true;
  }
  if (!["start", "accounts", "help"].includes(opts.command)) {
    throw new Error(`未知命令: ${opts.command}`);
  }

  return opts;
}

let CLI_OPTS;
try {
  CLI_OPTS = parseCliArgs(process.argv.slice(2));
} catch (err) {
  console.error(`参数错误: ${err.message}`);
  printHelp();
  process.exit(2);
}

const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
const BOT_TYPE = "3";
const INSTANCE_ID = CLI_OPTS.instanceId;
const TOKEN_FILE = process.env.TOKEN_FILE || withInstanceSuffix(".weixin-token.json", INSTANCE_ID);
const CODEX_SESSION_FILE = process.env.CODEX_SESSION_FILE || withInstanceSuffix(".codex-session-map.json", INSTANCE_ID);
const PERSONA_FILE = process.env.PERSONA_FILE || "soule.md";
const MEMORY_DB_FILE = process.env.MEMORY_DB_FILE || withInstanceSuffix(".wechat-memory.db", INSTANCE_ID);
const INSTANCE_LOCK_FILE = process.env.INSTANCE_LOCK_FILE || `${TOKEN_FILE}.lock`;
const CHANNEL_VERSION = "1.0.2";
const CDN_BASE_URL = process.env.WEIXIN_CDN_BASE_URL || "https://novac2c.cdn.weixin.qq.com/c2c";
const ENABLE_PERSONA = process.env.ENABLE_PERSONA !== "0";
const ENABLE_PROGRESS_STREAM = process.env.ENABLE_PROGRESS_STREAM !== "0";
const ENABLE_TYPING = process.env.ENABLE_TYPING !== "0";
const WEIXIN_VOICE_CODEC = (process.env.WEIXIN_VOICE_CODEC || "silk").trim().toLowerCase();
const WEIXIN_VOICE_UPLOAD_MEDIA_TYPE = Number(process.env.WEIXIN_VOICE_UPLOAD_MEDIA_TYPE || "3");
const WEIXIN_SILK_SAMPLE_RATE = Number(process.env.WEIXIN_SILK_SAMPLE_RATE || "24000");
const WEIXIN_VOICE_DISABLE = process.env.WEIXIN_VOICE_DISABLE === "1";
const MEMORY_ENABLED_DEFAULT = process.env.MEMORY_ENABLED !== "0";
const MEMORY_TOPK = Math.max(1, Math.min(10, Number(process.env.MEMORY_TOPK || "5")));
const MEMORY_MAX_CHARS = Math.max(120, Math.min(1200, Number(process.env.MEMORY_MAX_CHARS || "400")));
const MEMORY_MIN_CONFIDENCE = Math.max(0, Math.min(1, Number(process.env.MEMORY_MIN_CONFIDENCE || "0.72")));
const MEMORY_TTL_DAYS = Math.max(7, Math.min(3650, Number(process.env.MEMORY_TTL_DAYS || "180")));
const MEMORY_EXPORT_DIR = (process.env.MEMORY_EXPORT_DIR || "./exports").trim();
const MEMORY_SCHEMA_VERSION = 1;
const MEMORY_LEAK_REGEXES = [
  /记忆库/g,
  /检索(结果)?/g,
  /数据库/g,
  /历史记录/g,
  /调用链/g,
  /我查到/g,
];
const MAX_PERSONA_LEN = 1200;
const PERSONA_BEGIN = "<!-- SOULE_DATA_BEGIN -->";
const PERSONA_END = "<!-- SOULE_DATA_END -->";
const PERSONA_BOOTSTRAP = `# Soule Persona Store

本文件用于保存微信 Bridge 的人格配置。
请尽量通过微信指令修改（/persona ...），避免手工破坏结构化数据块。

${PERSONA_BEGIN}
{
  "global_default_persona": "你是一位专业、简洁、友好的中文微信助理。",
  "users": {}
}
${PERSONA_END}
`;
const TYPING_STATUS = {
  TYPING: 1,
  CANCEL: 2,
};

let instanceLockFd = null;

function isPidRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquireInstanceLock() {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      instanceLockFd = fs.openSync(INSTANCE_LOCK_FILE, "wx");
      const payload = {
        pid: process.pid,
        started_at: new Date().toISOString(),
        token_file: TOKEN_FILE,
        instance_id: INSTANCE_ID || null,
      };
      fs.writeFileSync(instanceLockFd, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
      return;
    } catch (err) {
      if (!(err && err.code === "EEXIST")) throw err;

      let existing = "";
      let existingPid = 0;
      try {
        existing = fs.readFileSync(INSTANCE_LOCK_FILE, "utf-8").trim();
        const parsed = JSON.parse(existing);
        existingPid = Number(parsed?.pid || 0);
      } catch {
        // ignore parse error
      }

      if (existingPid > 0 && !isPidRunning(existingPid)) {
        try {
          fs.unlinkSync(INSTANCE_LOCK_FILE);
          continue;
        } catch {
          // ignore and fallthrough to fatal
        }
      }

      throw new Error(
        `检测到同配置实例已在运行（锁文件: ${INSTANCE_LOCK_FILE}）${existing ? `\n${existing}` : ""}`,
      );
    }
  }
  throw new Error(`无法获取实例锁: ${INSTANCE_LOCK_FILE}`);
}

function releaseInstanceLock() {
  if (instanceLockFd === null) return;
  try {
    fs.closeSync(instanceLockFd);
  } catch {
    // ignore
  }
  instanceLockFd = null;
  try {
    fs.unlinkSync(INSTANCE_LOCK_FILE);
  } catch {
    // ignore
  }
}

function resolveInstanceFromTokenFile(fileName) {
  if (fileName === ".weixin-token.json") return "(default)";
  const m = fileName.match(/^\.weixin-token\.(.+)\.json$/);
  return m ? m[1] : "(unknown)";
}

function listAccounts() {
  const files = fs.readdirSync(process.cwd()).filter((f) => /^\.weixin-token(\..+)?\.json$/.test(f));
  if (!files.length) {
    console.log("未发现已登录账号。先执行：");
    console.log("  node wechat-claude-bridge.mjs login --instance wx1");
    return;
  }

  console.log("已登录账号列表:");
  for (const file of files.sort()) {
    const instanceId = resolveInstanceFromTokenFile(file);
    let info = {};
    try {
      info = JSON.parse(fs.readFileSync(file, "utf-8"));
    } catch {
      // ignore parse error and continue
    }
    const accountId = info.accountId || "(未知)";
    const userId = info.userId || "(未知)";
    const savedAt = info.savedAt || "(未知)";
    console.log(`- 实例: ${instanceId}`);
    console.log(`  文件: ${file}`);
    console.log(`  Bot: ${accountId}`);
    console.log(`  User: ${userId}`);
    console.log(`  保存时间: ${savedAt}`);
    const runCmd = instanceId === "(default)"
      ? "node wechat-claude-bridge.mjs"
      : `INSTANCE_ID=${instanceId} node wechat-claude-bridge.mjs`;
    console.log(`  启动命令: ${runCmd}`);
  }
}

// ─── 二维码渲染 ───────────────────────────────────────────────────────────────

const IMGCAT = "/Applications/iTerm.app/Contents/Resources/utilities/imgcat";

/** 渲染二维码：iTerm2 内联图片优先，降级 ASCII art */
async function renderQR(url) {
  try {
    const { default: QRCode } = await import("qrcode");
    const { execFileSync, spawnSync } = await import("node:child_process");
    const { writeFileSync, unlinkSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");

    const tmp = join(tmpdir(), `weixin-qr-${Date.now()}.png`);
    await QRCode.toFile(tmp, url, { width: 360, margin: 2 });

    // 尝试 iTerm2 imgcat
    const result = spawnSync(IMGCAT, [tmp], { stdio: ["ignore", "inherit", "ignore"] });
    unlinkSync(tmp);

    if (result.status !== 0) throw new Error("imgcat failed");
    console.log();
  } catch {
    // 降级：ASCII art
    try {
      const { default: qrterm } = await import("qrcode-terminal");
      await new Promise((resolve) => {
        qrterm.generate(url, { small: true }, (qr) => { console.log(qr); resolve(); });
      });
    } catch {
      console.log("  二维码 URL:", url, "\n");
    }
  }
}

// ─── HTTP 工具 ────────────────────────────────────────────────────────────────

/** X-WECHAT-UIN: 随机 uint32 → 十进制字符串 → base64 */
function randomWechatUin() {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), "utf-8").toString("base64");
}

function buildHeaders(token, body) {
  const headers = {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "X-WECHAT-UIN": randomWechatUin(),
  };
  if (body !== undefined) {
    headers["Content-Length"] = String(Buffer.byteLength(JSON.stringify(body), "utf-8"));
  }
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

async function apiGet(baseUrl, path) {
  const url = `${baseUrl.replace(/\/$/, "")}/${path}`;
  const res = await fetch(url);
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text}`);
  return JSON.parse(text);
}

async function apiPost(baseUrl, endpoint, body, token, timeoutMs = 15_000) {
  const url = `${baseUrl.replace(/\/$/, "")}/${endpoint}`;
  const payload = { ...body, base_info: { channel_version: CHANNEL_VERSION } };
  const bodyStr = JSON.stringify(payload);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: buildHeaders(token, payload),
      body: bodyStr,
      signal: controller.signal,
    });
    clearTimeout(timer);
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text}`);
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && typeof parsed.ret === "number" && parsed.ret !== 0) {
      const errcode = parsed.errcode != null ? ` errcode=${parsed.errcode}` : "";
      const errmsg = parsed.errmsg ? ` errmsg=${parsed.errmsg}` : "";
      throw new Error(`API错误 endpoint=${endpoint} ret=${parsed.ret}${errcode}${errmsg}`);
    }
    return parsed;
  } catch (err) {
    clearTimeout(timer);
    if (err.name === "AbortError") return null; // 长轮询超时，正常
    throw err;
  }
}

async function getTypingTicket(baseUrl, token, ilinkUserId, contextToken) {
  const resp = await apiPost(
    baseUrl,
    "ilink/bot/getconfig",
    {
      ilink_user_id: ilinkUserId,
      context_token: contextToken,
    },
    token,
    15_000,
  );
  return resp?.typing_ticket || "";
}

async function sendTyping(baseUrl, token, ilinkUserId, typingTicket, status) {
  await apiPost(
    baseUrl,
    "ilink/bot/sendtyping",
    {
      ilink_user_id: ilinkUserId,
      typing_ticket: typingTicket,
      status,
    },
    token,
    10_000,
  );
}

// ─── 登录流程 ─────────────────────────────────────────────────────────────────

async function login() {
  console.log("\n🔐 开始微信扫码登录...\n");

  // 1. 获取二维码
  const qrResp = await apiGet(DEFAULT_BASE_URL, `ilink/bot/get_bot_qrcode?bot_type=${BOT_TYPE}`);
  const qrcode = qrResp.qrcode;
  const qrcodeUrl = qrResp.qrcode_img_content;

  console.log("📱 请用微信扫描以下二维码：\n");

  // 终端渲染二维码：优先 iTerm2 内联图片，降级 ASCII
  await renderQR(qrcodeUrl);

  // 2. 轮询扫码状态
  console.log("⏳ 等待扫码...");
  const deadline = Date.now() + 5 * 60_000;
  let refreshCount = 0;
  let currentQrcode = qrcode;
  let currentQrcodeUrl = qrcodeUrl;

  while (Date.now() < deadline) {
    const statusResp = await apiGet(
      DEFAULT_BASE_URL,
      `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(currentQrcode)}`,
    );

    switch (statusResp.status) {
      case "wait":
        process.stdout.write(".");
        break;
      case "scaned":
        process.stdout.write("\n👀 已扫码，请在微信端确认...\n");
        break;
      case "expired": {
        refreshCount++;
        if (refreshCount > 3) {
          throw new Error("二维码多次过期，请重新运行");
        }
        console.log(`\n⏳ 二维码过期，刷新中 (${refreshCount}/3)...`);
        const newQr = await apiGet(DEFAULT_BASE_URL, `ilink/bot/get_bot_qrcode?bot_type=${BOT_TYPE}`);
        currentQrcode = newQr.qrcode;
        currentQrcodeUrl = newQr.qrcode_img_content;
        console.log("  新二维码 URL:", currentQrcodeUrl);
        break;
      }
      case "confirmed": {
        console.log("\n✅ 登录成功！\n");
        const tokenData = {
          token: statusResp.bot_token,
          baseUrl: statusResp.baseurl || DEFAULT_BASE_URL,
          accountId: statusResp.ilink_bot_id,
          userId: statusResp.ilink_user_id,
          savedAt: new Date().toISOString(),
        };
        fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokenData, null, 2), "utf-8");
        fs.chmodSync(TOKEN_FILE, 0o600);
        console.log(`  Bot ID : ${tokenData.accountId}`);
        console.log(`  Base URL: ${tokenData.baseUrl}`);
        console.log(`  Token 已保存到 ${TOKEN_FILE}\n`);
        return tokenData;
      }
    }

    await new Promise((r) => setTimeout(r, 1000));
  }

  throw new Error("登录超时");
}

// ─── 消息收发 ─────────────────────────────────────────────────────────────────

/** 长轮询获取新消息，返回 { msgs, get_updates_buf } */
async function getUpdates(baseUrl, token, getUpdatesBuf) {
  const resp = await apiPost(
    baseUrl,
    "ilink/bot/getupdates",
    { get_updates_buf: getUpdatesBuf ?? "" },
    token,
    38_000, // 长轮询，服务器最多 hold 35s
  );
  return resp ?? { ret: 0, msgs: [], get_updates_buf: getUpdatesBuf };
}

/** 发送文本消息 */
async function sendMessage(baseUrl, token, toUserId, text, contextToken) {
  const clientId = `demo-${crypto.randomUUID()}`;
  await apiPost(
    baseUrl,
    "ilink/bot/sendmessage",
    {
      msg: {
        from_user_id: "",
        to_user_id: toUserId,
        client_id: clientId,
        message_type: 2, // BOT
        message_state: 2, // FINISH
        context_token: contextToken,
        item_list: [
          { type: 1, text_item: { text } }, // TEXT
        ],
      },
    },
    token,
  );
  console.log(`   💬 文本已发送 clientId=${clientId} to=${toUserId}`);
  return clientId;
}

async function safeSendMessage(baseUrl, token, toUserId, text, contextToken) {
  try {
    await sendMessage(baseUrl, token, toUserId, text, contextToken);
    return true;
  } catch (err) {
    console.error(`   ⚠️ 安全发送失败 to=${toUserId}: ${err.message}`);
    return false;
  }
}

function aesEcbPaddedSize(plaintextSize) {
  return Math.ceil((plaintextSize + 1) / 16) * 16;
}

function encryptAesEcb(plaintext, key) {
  const cipher = crypto.createCipheriv("aes-128-ecb", key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

function buildCdnUploadUrl(uploadParam, filekey) {
  return `${CDN_BASE_URL}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(filekey)}`;
}

async function getUploadUrl(baseUrl, token, body) {
  return apiPost(baseUrl, "ilink/bot/getuploadurl", body, token, 15_000);
}

async function uploadBufferToCdn(buf, uploadParam, filekey, aesKey, label) {
  const ciphertext = encryptAesEcb(buf, aesKey);
  const cdnUrl = buildCdnUploadUrl(uploadParam, filekey);

  let lastErr = null;
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(cdnUrl, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: new Uint8Array(ciphertext),
      });
      if (res.status >= 400 && res.status < 500) {
        const detail = res.headers.get("x-error-message") || await res.text();
        throw new Error(`${label} 上传失败(客户端): ${res.status} ${detail}`);
      }
      if (res.status !== 200) {
        const detail = res.headers.get("x-error-message") || `status=${res.status}`;
        throw new Error(`${label} 上传失败(服务端): ${detail}`);
      }
      const downloadParam = res.headers.get("x-encrypted-param");
      if (!downloadParam) throw new Error(`${label} 上传失败: 缺少 x-encrypted-param`);
      return { downloadParam, ciphertextSize: ciphertext.length };
    } catch (err) {
      lastErr = err;
      if (i < 2) continue;
      throw lastErr;
    }
  }
  throw new Error(`${label} 上传失败`);
}

async function readBytesFromTarget(target) {
  if (isUrl(target)) {
    const res = await fetch(target);
    if (!res.ok) throw new Error(`下载媒体失败: ${res.status} ${res.statusText}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const contentType = res.headers.get("content-type") || "";
    const urlPath = new URL(target).pathname || "";
    const name = path.basename(urlPath || "remote.bin");
    return { buf, contentType, fileName: name || "remote.bin" };
  }

  const filePath = path.isAbsolute(target) ? target : path.resolve(target);
  const buf = await fsp.readFile(filePath);
  const fileName = path.basename(filePath);
  const ext = path.extname(fileName).toLowerCase();
  const contentTypeMap = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".mp4": "video/mp4",
    ".mov": "video/quicktime",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".m4a": "audio/mp4",
    ".aac": "audio/aac",
    ".amr": "audio/amr",
    ".silk": "audio/silk",
    ".pdf": "application/pdf",
  };
  return { buf, contentType: contentTypeMap[ext] || "application/octet-stream", fileName };
}

async function runCommand(args, timeoutMs = 60_000) {
  return await new Promise((resolve, reject) => {
    const child = spawn(args[0], args.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`命令超时: ${args.join(" ")}`));
    }, timeoutMs);
    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`命令失败(code=${code}): ${args.join(" ")}\n${stderr || stdout}`));
      }
    });
  });
}

async function transcodeVoiceToSilk(inputPath) {
  const silk = await import("silk-wasm");
  if (typeof silk.encode !== "function") {
    throw new Error("silk-wasm 未提供 encode 方法");
  }
  const normalizedRate = Number.isFinite(WEIXIN_SILK_SAMPLE_RATE) && WEIXIN_SILK_SAMPLE_RATE > 0
    ? Math.round(WEIXIN_SILK_SAMPLE_RATE)
    : 24000;
  const normalizedWav = path.join(
    os.tmpdir(),
    `weixin-tts-norm-${Date.now()}-${Math.random().toString(16).slice(2)}.wav`,
  );
  try {
    // 标准化到微信语音更稳的 PCM 参数，避免源音频采样率导致客户端不识别。
    await runCommand(
      [
        "ffmpeg",
        "-y",
        "-i",
        inputPath,
        "-ar",
        String(normalizedRate),
        "-ac",
        "1",
        "-c:a",
        "pcm_s16le",
        normalizedWav,
      ],
      120_000,
    );
    const wavOrPcm = await fsp.readFile(normalizedWav);
    const encoded = await silk.encode(wavOrPcm, normalizedRate);
    const silkData = Buffer.from(encoded.data);
    const out = path.join(
      os.tmpdir(),
      `weixin-tts-${Date.now()}-${Math.random().toString(16).slice(2)}.silk`,
    );
    await fsp.writeFile(out, silkData);
    let playtimeMs = Math.max(300, Number(encoded.duration || 0) || 0);
    if (typeof silk.getDuration === "function") {
      try {
        const measured = Number(silk.getDuration(silkData));
        if (Number.isFinite(measured) && measured > 0) {
          playtimeMs = Math.max(300, Math.round(measured));
        }
      } catch {
        // ignore
      }
    }
    if (!Number.isFinite(playtimeMs) || playtimeMs <= 0) {
      playtimeMs = 1200;
    }
    return {
      path: out,
      playtimeMs,
    };
  } finally {
    try {
      await fsp.unlink(normalizedWav);
    } catch {
      // ignore
    }
  }
}

async function transcodeVoiceToAmr(inputPath) {
  const out = path.join(
    os.tmpdir(),
    `weixin-tts-${Date.now()}-${Math.random().toString(16).slice(2)}.amr`,
  );
  await runCommand(
    [
      "ffmpeg",
      "-y",
      "-i",
      inputPath,
      "-ar",
      "8000",
      "-ac",
      "1",
      "-c:a",
      "libopencore_amrnb",
      "-b:a",
      "12.2k",
      out,
    ],
    120_000,
  );
  let playtimeMs = 0;
  try {
    const probe = await runCommand(
      [
        "ffprobe",
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        out,
      ],
      20_000,
    );
    const sec = Number.parseFloat(String(probe.stdout || "").trim());
    if (Number.isFinite(sec) && sec > 0) {
      playtimeMs = Math.max(300, Math.round(sec * 1000));
    }
  } catch {
    // ignore
  }
  return {
    path: out,
    playtimeMs,
  };
}

async function maybeTranscodeVoiceForWeixin(inputPath) {
  const codec = WEIXIN_VOICE_CODEC;
  if (codec === "off" || codec === "none") {
    return { path: inputPath, playtimeMs: 0 };
  }

  const errors = [];
  if (codec === "silk" || codec === "auto") {
    try {
      const ret = await transcodeVoiceToSilk(inputPath);
      console.log(`   🎚️ 语音转码: silk 成功 playtime=${ret.playtimeMs}ms`);
      return ret;
    } catch (err) {
      errors.push(`silk=${err.message}`);
      if (codec === "silk") {
        // silk 模式下仍回退一次 amr，避免彻底无回复
      }
    }
  }

  if (codec === "amr" || codec === "auto" || codec === "silk") {
    try {
      const ret = await transcodeVoiceToAmr(inputPath);
      console.log("   🎚️ 语音转码: amr 成功");
      return ret;
    } catch (err) {
      errors.push(`amr=${err.message}`);
    }
  }

  throw new Error(`语音转码失败（codec=${codec}）: ${errors.join(" | ")}`);
}

function inferAudioExtFromContentType(contentType) {
  const ct = String(contentType || "").toLowerCase();
  if (ct.includes("audio/silk")) return ".silk";
  if (ct.includes("audio/amr")) return ".amr";
  if (ct.includes("audio/wav") || ct.includes("audio/x-wav")) return ".wav";
  if (ct.includes("audio/mpeg")) return ".mp3";
  if (ct.includes("audio/mp4")) return ".m4a";
  if (ct.includes("audio/aac")) return ".aac";
  if (ct.includes("audio/ogg")) return ".ogg";
  return "";
}

async function normalizeVoicePayloadForWeixin(buf, contentType, fileName, explicitVoicePlaytimeMs = 0) {
  const currentEncodeType = inferVoiceEncodeType(contentType, fileName);
  const alreadyCompatible = currentEncodeType === 5 || currentEncodeType === 6;
  if (alreadyCompatible || WEIXIN_VOICE_CODEC === "off" || WEIXIN_VOICE_CODEC === "none") {
    return {
      buf,
      contentType,
      fileName,
      playtimeMs: explicitVoicePlaytimeMs,
      transcoded: false,
    };
  }

  const extFromName = path.extname(fileName || "").toLowerCase();
  const extFromType = inferAudioExtFromContentType(contentType);
  const inputExt = extFromName || extFromType || ".wav";
  const tempInput = path.join(
    os.tmpdir(),
    `weixin-voice-src-${Date.now()}-${Math.random().toString(16).slice(2)}${inputExt}`,
  );
  let tempOutput = "";

  try {
    await fsp.writeFile(tempInput, buf);
    const transcoded = await maybeTranscodeVoiceForWeixin(tempInput);
    const outputPath = transcoded.path;
    if (outputPath !== tempInput) {
      tempOutput = outputPath;
    }
    const nextBuf = await fsp.readFile(outputPath);
    const nextFileName = path.basename(outputPath);
    const nextExt = path.extname(nextFileName).toLowerCase();
    let nextContentType = contentType;
    if (nextExt === ".silk") nextContentType = "audio/silk";
    if (nextExt === ".amr") nextContentType = "audio/amr";
    return {
      buf: nextBuf,
      contentType: nextContentType,
      fileName: nextFileName,
      playtimeMs: transcoded.playtimeMs > 0 ? transcoded.playtimeMs : explicitVoicePlaytimeMs,
      transcoded: true,
    };
  } finally {
    try {
      await fsp.unlink(tempInput);
    } catch {
      // ignore
    }
    if (tempOutput) {
      try {
        await fsp.unlink(tempOutput);
      } catch {
        // ignore
      }
    }
  }
}

function inferMediaKind(contentType, fileName, explicitKind = "") {
  const kind = explicitKind.trim().toLowerCase();
  if (kind === "voice" || kind === "audio") return "voice";
  if (kind === "file") return "file";
  if (kind === "image") return "image";
  if (kind === "video") return "video";

  const ct = String(contentType || "").toLowerCase();
  const ext = path.extname(fileName || "").toLowerCase();
  if (ct.startsWith("image/") || [".png", ".jpg", ".jpeg", ".gif", ".webp"].includes(ext)) return "image";
  if (ct.startsWith("video/") || [".mp4", ".mov", ".mkv", ".webm"].includes(ext)) return "video";
  if (ct.startsWith("audio/") || [".wav", ".mp3", ".m4a", ".aac", ".ogg", ".amr", ".silk"].includes(ext)) return "voice";
  return "file";
}

function inferVoiceEncodeType(contentType, fileName) {
  const ct = String(contentType || "").toLowerCase();
  const ext = path.extname(fileName || "").toLowerCase();
  if (ext === ".silk" || ct.includes("audio/silk")) return 6; // silk
  if (ext === ".amr" || ct.includes("audio/amr")) return 5; // amr
  if (ext === ".mp3" || ct.includes("audio/mpeg")) return 7; // mp3
  if (ext === ".ogg" || ct.includes("ogg")) return 8; // ogg-speex
  return 1; // pcm/wav
}

function parseWavInfo(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 44) return null;
  if (buf.toString("ascii", 0, 4) !== "RIFF") return null;
  if (buf.toString("ascii", 8, 12) !== "WAVE") return null;

  let offset = 12;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let channels = 0;
  let dataBytes = 0;
  while (offset + 8 <= buf.length) {
    const chunkId = buf.toString("ascii", offset, offset + 4);
    const chunkSize = buf.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;
    if (chunkStart + chunkSize > buf.length) break;

    if (chunkId === "fmt " && chunkSize >= 16) {
      channels = buf.readUInt16LE(chunkStart + 2);
      sampleRate = buf.readUInt32LE(chunkStart + 4);
      bitsPerSample = buf.readUInt16LE(chunkStart + 14);
    } else if (chunkId === "data") {
      dataBytes = chunkSize;
    }

    offset = chunkStart + chunkSize + (chunkSize % 2);
  }

  if (!sampleRate || !bitsPerSample || !channels || !dataBytes) return null;
  const bytesPerSample = bitsPerSample / 8;
  if (!bytesPerSample) return null;
  const totalSamples = dataBytes / (channels * bytesPerSample);
  const durationMs = Math.max(300, Math.round((totalSamples / sampleRate) * 1000));
  return { sampleRate, bitsPerSample, durationMs };
}

function inferVoiceParams(buf, contentType, fileName) {
  const encodeType = inferVoiceEncodeType(contentType, fileName);
  let sampleRate;
  let bitsPerSample;
  let playtime = 1200;
  const wavInfo = parseWavInfo(buf);
  if (wavInfo) {
    sampleRate = wavInfo.sampleRate;
    bitsPerSample = wavInfo.bitsPerSample;
    playtime = wavInfo.durationMs;
  }
  if (encodeType === 6) {
    if (!sampleRate) {
      sampleRate = Number.isFinite(WEIXIN_SILK_SAMPLE_RATE) && WEIXIN_SILK_SAMPLE_RATE > 0
        ? Math.round(WEIXIN_SILK_SAMPLE_RATE)
        : 24000;
    }
    if (!bitsPerSample) bitsPerSample = 16;
  }
  return {
    encodeType,
    playtime,
    sampleRate,
    bitsPerSample,
  };
}

async function sendItemMessage(baseUrl, token, toUserId, item, contextToken) {
  const clientId = `demo-${crypto.randomUUID()}`;
  await apiPost(
    baseUrl,
    "ilink/bot/sendmessage",
    {
      msg: {
        from_user_id: "",
        to_user_id: toUserId,
        client_id: clientId,
        message_type: 2,
        message_state: 2,
        context_token: contextToken,
        item_list: [item],
      },
    },
    token,
  );
  console.log(`   📦 媒体已发送 type=${item?.type ?? "?"} clientId=${clientId} to=${toUserId}`);
  return clientId;
}

async function uploadAndSendMedia(
  baseUrl,
  token,
  toUserId,
  target,
  contextToken,
  explicitKind = "",
  explicitVoicePlaytimeMs = 0,
) {
  let { buf, contentType, fileName } = await readBytesFromTarget(target);
  const mediaKind = inferMediaKind(contentType, fileName, explicitKind);
  let voicePlaytimeMs = explicitVoicePlaytimeMs;
  if (mediaKind === "voice") {
    const normalized = await normalizeVoicePayloadForWeixin(
      buf,
      contentType,
      fileName,
      voicePlaytimeMs,
    );
    buf = normalized.buf;
    contentType = normalized.contentType;
    fileName = normalized.fileName;
    voicePlaytimeMs = normalized.playtimeMs || 0;
    if (normalized.transcoded) {
      console.log(`   🎚️ 语音预处理: 已转码为 ${fileName}`);
    }
  }
  // 官方 README 当前公开的 getuploadurl media_type 为 1/2/3；
  // 语音默认走 FILE(3) 上传，再用 MessageItem type=3 作为语音发送。
  const voiceUploadMediaType = WEIXIN_VOICE_UPLOAD_MEDIA_TYPE === 4 ? 4 : 3;
  const mediaTypeMap = { image: 1, video: 2, file: 3, voice: voiceUploadMediaType };
  const mediaType = mediaTypeMap[mediaKind] || 3;
  if (mediaKind === "voice") {
    console.log(`   📡 语音上传 media_type=${mediaType}`);
  }

  const rawsize = buf.length;
  const rawfilemd5 = crypto.createHash("md5").update(buf).digest("hex");
  const filesize = aesEcbPaddedSize(rawsize);
  const filekey = crypto.randomBytes(16).toString("hex");
  const aeskey = crypto.randomBytes(16);
  const aeskeyHex = aeskey.toString("hex");
  // 与 openclaw-weixin SDK 保持一致：CDNMedia.aes_key 使用 base64(hex-string) 编码。
  const aesKeyForMessage = Buffer.from(aeskeyHex, "utf-8").toString("base64");
  const uploadUrlResp = await getUploadUrl(baseUrl, token, {
    filekey,
    media_type: mediaType,
    to_user_id: toUserId,
    rawsize,
    rawfilemd5,
    filesize,
    no_need_thumb: true,
    aeskey: aeskeyHex,
  });
  const uploadParam = uploadUrlResp?.upload_param;
  if (!uploadParam) throw new Error("getuploadurl 返回缺少 upload_param");

  const uploaded = await uploadBufferToCdn(buf, uploadParam, filekey, aeskey, "media");
  const mediaRef = {
    encrypt_query_param: uploaded.downloadParam,
    aes_key: aesKeyForMessage,
    encrypt_type: 1,
  };

  if (mediaKind === "image") {
    await sendItemMessage(baseUrl, token, toUserId, {
      type: 2,
      image_item: { media: mediaRef, mid_size: uploaded.ciphertextSize },
    }, contextToken);
    return;
  }

  if (mediaKind === "video") {
    await sendItemMessage(baseUrl, token, toUserId, {
      type: 5,
      video_item: { media: mediaRef, video_size: uploaded.ciphertextSize },
    }, contextToken);
    return;
  }

  if (mediaKind === "voice") {
    const voiceParams = inferVoiceParams(buf, contentType, fileName);
    if (voicePlaytimeMs > 0) {
      voiceParams.playtime = voicePlaytimeMs;
    }
    console.log(
      `   🎤 发送语音: file=${fileName} encode=${voiceParams.encodeType} playtime=${voiceParams.playtime}ms`,
    );
    const voiceItem = {
      media: mediaRef,
      encode_type: voiceParams.encodeType,
      playtime: voiceParams.playtime,
    };
    if (voiceParams.sampleRate) voiceItem.sample_rate = voiceParams.sampleRate;
    if (voiceParams.bitsPerSample) voiceItem.bits_per_sample = voiceParams.bitsPerSample;
    try {
      await sendItemMessage(baseUrl, token, toUserId, {
        type: 3,
        voice_item: voiceItem,
      }, contextToken);
    } catch (err) {
      // 某些网关会拒绝额外音频参数，降级为最小字段重试一次。
      console.warn(`   ⚠️ 语音发送首发失败，尝试精简字段重试: ${err.message}`);
      await sendItemMessage(baseUrl, token, toUserId, {
        type: 3,
        voice_item: {
          media: mediaRef,
          encode_type: voiceParams.encodeType,
          playtime: voiceParams.playtime,
        },
      }, contextToken);
    }
    return;
  }

  await sendItemMessage(baseUrl, token, toUserId, {
    type: 4,
    file_item: {
      media: mediaRef,
      file_name: fileName,
      len: String(rawsize),
    },
  }, contextToken);
}

/** 从消息 item_list 提取纯文本 */
function extractText(msg) {
  const chunks = [];
  const meta = [];
  for (const item of msg.item_list ?? []) {
    if (item.type === 1 && item.text_item?.text) {
      chunks.push(item.text_item.text);
    } else if (item.type === 3) {
      const voiceText = String(item.voice_item?.text || "").trim();
      if (voiceText) chunks.push(voiceText);
      meta.push(voiceText ? "[语音]（已按微信识别文本处理）" : "[语音]（未拿到识别文本）");
    } else if (item.type === 2) {
      const ref = item.image_item?.media?.encrypt_query_param ? " 含媒体引用" : "";
      meta.push(`[图片]${ref}`);
    } else if (item.type === 4) {
      const fileName = item.file_item?.file_name ?? "未命名文件";
      const fileSize = item.file_item?.file_size ? ` 大小=${item.file_item.file_size}` : "";
      meta.push(`[文件] ${fileName}${fileSize}`);
    } else if (item.type === 5) {
      const len = item.video_item?.play_length ? ` 时长=${item.video_item.play_length}` : "";
      meta.push(`[视频]${len}`);
    }
  }
  const text = chunks.join("\n").trim();
  if (text && meta.length) return `${text}\n\n媒体摘要：${meta.join("；")}`;
  if (text) return text;
  if (meta.length) return `媒体摘要：${meta.join("；")}`;
  return "[空消息]";
}

function parseSendMediaDirective(replyText) {
  const mediaTargets = [];
  const fileTargets = [];
  const voiceTargets = [];
  const raw = String(replyText || "");
  const text = raw.replace(/\[\[(SEND_MEDIA|SEND_FILE|SEND_VOICE):([\s\S]*?)\]\]/g, (_all, type, payload) => {
    const value = String(payload || "").trim();
    if (!value) return "";
    const directiveType = String(type || "").toUpperCase();
    if (directiveType === "SEND_MEDIA") mediaTargets.push(value);
    else if (directiveType === "SEND_FILE") fileTargets.push(value);
    else if (directiveType === "SEND_VOICE") voiceTargets.push(value);
    return "";
  });
  return {
    text: text
      .split(/\r?\n/)
      .map((line) => line.replace(/[ \t]+$/g, ""))
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim(),
    mediaTargets,
    fileTargets,
    voiceTargets,
  };
}

function isUrl(str) {
  return /^https?:\/\//i.test(String(str || "").trim());
}

async function sendAssistantReply(baseUrl, token, toUserId, rawReply, contextToken) {
  const parsed = parseSendMediaDirective(rawReply);
  if (parsed.text) {
    // 必达：先发文本
    await sendMessage(baseUrl, token, toUserId, parsed.text, contextToken);
  }
  for (const target of parsed.mediaTargets) {
    try {
      await uploadAndSendMedia(baseUrl, token, toUserId, target, contextToken);
    } catch (err) {
      await sendMessage(baseUrl, token, toUserId, `❌ 发送媒体失败：${target}\n${err.message}`, contextToken);
    }
  }
  for (const target of parsed.fileTargets) {
    try {
      await uploadAndSendMedia(baseUrl, token, toUserId, target, contextToken, "file");
    } catch (err) {
      await sendMessage(baseUrl, token, toUserId, `❌ 发送文件失败：${target}\n${err.message}`, contextToken);
    }
  }
  for (const target of parsed.voiceTargets) {
    try {
      if (!WEIXIN_VOICE_DISABLE) {
        await uploadAndSendMedia(baseUrl, token, toUserId, target, contextToken, "voice");
      } else {
        await uploadAndSendMedia(baseUrl, token, toUserId, target, contextToken, "file");
      }
    } catch (err) {
      await sendMessage(baseUrl, token, toUserId, `❌ 发送语音失败：${target}\n${err.message}`, contextToken);
    }
  }
}

async function handleCommand(params) {
  const {
    text,
    fromUserId,
    contextToken,
    personaStore,
    baseUrl,
    token,
    runtimeFlags,
    memoryDb,
  } = params;
  const content = String(text || "").trim();
  if (!content.startsWith("/")) return false;

  if (content === "/persona show") {
    const userPersona = getUserPersona(personaStore, fromUserId);
    const defaultPersona = sanitizePersonaText(personaStore.global_default_persona || "");
    const label = getUserLabel(personaStore, fromUserId);
    const personaStatus = runtimeFlags.persona ? "开启" : "关闭";
    const msg = userPersona
      ? `人格开关：${personaStatus}\n当前用户标识：${label}\n当前人格（用户级）：\n${userPersona}\n\n全局默认人格：\n${defaultPersona || "(未设置)"}`
      : `人格开关：${personaStatus}\n当前用户标识：${label}\n当前未设置用户级人格，使用全局默认人格：\n${defaultPersona || "(未设置)"}`;
    await sendMessage(baseUrl, token, fromUserId, msg, contextToken);
    return true;
  }

  if (content === "/persona status") {
    await sendMessage(baseUrl, token, fromUserId, `人格开关当前为：${runtimeFlags.persona ? "开启" : "关闭"}`, contextToken);
    return true;
  }

  if (content === "/persona on") {
    runtimeFlags.persona = true;
    await sendMessage(baseUrl, token, fromUserId, "✅ 已开启人格逻辑。", contextToken);
    return true;
  }

  if (content === "/persona off") {
    runtimeFlags.persona = false;
    await sendMessage(baseUrl, token, fromUserId, "✅ 已关闭人格逻辑。", contextToken);
    return true;
  }

  if (content.startsWith("/persona set ")) {
    const persona = sanitizePersonaText(content.slice("/persona set ".length));
    if (!persona) {
      await sendMessage(baseUrl, token, fromUserId, "用法：/persona set <人格内容>", contextToken);
      return true;
    }
    setUserPersona(personaStore, fromUserId, persona);
    savePersonaStore(personaStore);
    await sendMessage(baseUrl, token, fromUserId, "✅ 已设置当前微信用户的人格。", contextToken);
    return true;
  }

  if (content === "/persona reset") {
    resetUserPersona(personaStore, fromUserId);
    savePersonaStore(personaStore);
    await sendMessage(baseUrl, token, fromUserId, "✅ 已清除用户人格，后续将使用全局默认人格。", contextToken);
    return true;
  }

  if (content === "/persona default show") {
    const defaultPersona = sanitizePersonaText(personaStore.global_default_persona || "");
    await sendMessage(baseUrl, token, fromUserId, `全局默认人格：\n${defaultPersona || "(未设置)"}`, contextToken);
    return true;
  }

  if (content.startsWith("/persona default set ")) {
    const persona = sanitizePersonaText(content.slice("/persona default set ".length));
    if (!persona) {
      await sendMessage(baseUrl, token, fromUserId, "用法：/persona default set <人格内容>", contextToken);
      return true;
    }
    personaStore.global_default_persona = persona;
    savePersonaStore(personaStore);
    await sendMessage(baseUrl, token, fromUserId, "✅ 已更新全局默认人格。", contextToken);
    return true;
  }

  if (content === "/toggle-debug") {
    runtimeFlags.progressStream = !runtimeFlags.progressStream;
    await sendMessage(
      baseUrl,
      token,
      fromUserId,
      `调试模式：过程播报已${runtimeFlags.progressStream ? "开启" : "关闭"}。`,
      contextToken,
    );
    return true;
  }

  if (content === "/debug status") {
    const memoryEnabled = memoryDb ? (getUserMemoryEnabled(memoryDb, fromUserId) ? "1" : "0") : "0";
    const statusText = [
      `instance_id=${INSTANCE_ID || "(default)"}`,
      `progress_stream=${runtimeFlags.progressStream ? "1" : "0"}`,
      `typing=${runtimeFlags.typing ? "1" : "0"}`,
      `persona=${runtimeFlags.persona ? "1" : "0"}`,
      `memory_available=${memoryDb ? "1" : "0"}`,
      `memory_enabled_for_user=${memoryEnabled}`,
      `MEMORY_DB_FILE=${MEMORY_DB_FILE}`,
      `TOKEN_FILE=${TOKEN_FILE}`,
      `PERSONA_FILE=${PERSONA_FILE}`,
      `CODEX_SESSION_FILE=${CODEX_SESSION_FILE}`,
      `INSTANCE_LOCK_FILE=${INSTANCE_LOCK_FILE}`,
    ].join("\n");
    await sendMessage(baseUrl, token, fromUserId, `当前调试状态：\n${statusText}`, contextToken);
    return true;
  }

  if (content.startsWith("/persona")) {
    await sendMessage(
      baseUrl,
      token,
      fromUserId,
      "可用指令：/persona show | /persona status | /persona on | /persona off | /persona set <内容> | /persona reset | /persona default show | /persona default set <内容>",
      contextToken,
    );
    return true;
  }

  if (content === "/user label show") {
    const label = getUserLabel(personaStore, fromUserId);
    await sendMessage(baseUrl, token, fromUserId, `当前用户标识：${label}\n用户ID：${fromUserId}`, contextToken);
    return true;
  }

  if (content.startsWith("/user label set ")) {
    const label = sanitizePersonaText(content.slice("/user label set ".length));
    if (!label) {
      await sendMessage(baseUrl, token, fromUserId, "用法：/user label set <标识>", contextToken);
      return true;
    }
    setUserLabel(personaStore, fromUserId, label);
    savePersonaStore(personaStore);
    await sendMessage(baseUrl, token, fromUserId, `✅ 已设置用户标识为：${label}`, contextToken);
    return true;
  }

  if (content === "/user label reset") {
    resetUserLabel(personaStore, fromUserId);
    savePersonaStore(personaStore);
    await sendMessage(baseUrl, token, fromUserId, `✅ 已清除用户标识，当前为：${getUserLabel(personaStore, fromUserId)}`, contextToken);
    return true;
  }

  if (content.startsWith("/user")) {
    await sendMessage(
      baseUrl,
      token,
      fromUserId,
      "可用指令：/user label show | /user label set <标识> | /user label reset",
      contextToken,
    );
    return true;
  }

  if (content === "/memory on") {
    if (!memoryDb) {
      await sendMessage(baseUrl, token, fromUserId, "❌ 记忆库不可用（请确认 better-sqlite3 依赖已安装）", contextToken);
      return true;
    }
    setUserMemoryEnabled(memoryDb, fromUserId, true);
    await sendMessage(baseUrl, token, fromUserId, "✅ 已开启当前用户记忆。", contextToken);
    return true;
  }

  if (content === "/memory off") {
    if (!memoryDb) {
      await sendMessage(baseUrl, token, fromUserId, "❌ 记忆库不可用（请确认 better-sqlite3 依赖已安装）", contextToken);
      return true;
    }
    setUserMemoryEnabled(memoryDb, fromUserId, false);
    await sendMessage(baseUrl, token, fromUserId, "✅ 已关闭当前用户记忆。", contextToken);
    return true;
  }

  if (content === "/memory clear") {
    if (!memoryDb) {
      await sendMessage(baseUrl, token, fromUserId, "❌ 记忆库不可用（请确认 better-sqlite3 依赖已安装）", contextToken);
      return true;
    }
    const removed = clearUserMemories(memoryDb, fromUserId);
    await sendMessage(baseUrl, token, fromUserId, `✅ 已清空当前用户记忆，共删除 ${removed} 条。`, contextToken);
    return true;
  }

  if (content.startsWith("/memory forget ")) {
    if (!memoryDb) {
      await sendMessage(baseUrl, token, fromUserId, "❌ 记忆库不可用（请确认 better-sqlite3 依赖已安装）", contextToken);
      return true;
    }
    const kw = content.slice("/memory forget ".length).trim();
    if (!kw) {
      await sendMessage(baseUrl, token, fromUserId, "用法：/memory forget <关键词>", contextToken);
      return true;
    }
    const removed = forgetUserMemoriesByKeyword(memoryDb, fromUserId, kw);
    await sendMessage(baseUrl, token, fromUserId, `✅ 已删除 ${removed} 条相关记忆。`, contextToken);
    return true;
  }

  if (content === "/memory show" || content.startsWith("/memory show ")) {
    if (!memoryDb) {
      await sendMessage(baseUrl, token, fromUserId, "❌ 记忆库不可用（请确认 better-sqlite3 依赖已安装）", contextToken);
      return true;
    }
    const suffix = content.slice("/memory show".length).trim();
    const n = suffix ? Math.max(1, Math.min(20, Number(suffix) || 8)) : 8;
    const enabled = getUserMemoryEnabled(memoryDb, fromUserId);
    const rows = listUserMemories(memoryDb, fromUserId, n);
    const body = rows.length
      ? rows.map((r, idx) => `${idx + 1}. [${labelForMemoryType(r.type)}] ${r.content}`).join("\n")
      : "(暂无记忆)";
    await sendMessage(
      baseUrl,
      token,
      fromUserId,
      `记忆状态：${enabled ? "开启" : "关闭"}\n共展示 ${rows.length} 条：\n${body}`,
      contextToken,
    );
    return true;
  }

  if (content.startsWith("/memory")) {
    await sendMessage(
      baseUrl,
      token,
      fromUserId,
      "可用指令：/memory show [n] | /memory on | /memory off | /memory clear | /memory forget <关键词>",
      contextToken,
    );
    return true;
  }

  if (content.startsWith("/debug")) {
    await sendMessage(baseUrl, token, fromUserId, "可用指令：/debug status", contextToken);
    return true;
  }

  return false;
}

// ─── Codex CLI ────────────────────────────────────────────────────────────────

function loadCodexSessionMap() {
  if (!fs.existsSync(CODEX_SESSION_FILE)) return {};
  try {
    const raw = fs.readFileSync(CODEX_SESSION_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function saveCodexSessionMap(map) {
  fs.writeFileSync(CODEX_SESSION_FILE, JSON.stringify(map, null, 2), "utf-8");
  fs.chmodSync(CODEX_SESSION_FILE, 0o600);
}

// ─── Memory Store ─────────────────────────────────────────────────────────────

let memoryDb = null;

function openMemoryDb() {
  let BetterSqlite3 = null;
  try {
    BetterSqlite3 = require("better-sqlite3");
  } catch (err) {
    throw new Error(`记忆库不可用：缺少 better-sqlite3 依赖（${err.message}）`);
  }

  const db = new BetterSqlite3(MEMORY_DB_FILE);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      type TEXT NOT NULL,
      content TEXT NOT NULL,
      normalized_key TEXT NOT NULL DEFAULT '',
      confidence REAL NOT NULL DEFAULT 0.5,
      importance REAL NOT NULL DEFAULT 0.5,
      source_msg_id TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_hit_at TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_memory_user_type_updated
      ON memory_items(user_id, type, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_memory_user_active
      ON memory_items(user_id, active);
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_memory_user_key
      ON memory_items(user_id, normalized_key)
      WHERE normalized_key <> '';

    CREATE TABLE IF NOT EXISTS user_memory_settings (
      user_id TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS memory_items_fts
      USING fts5(user_id UNINDEXED, content, type UNINDEXED, tokenize='unicode61');
  `);
  return db;
}

function getMemoryDb() {
  if (!memoryDb) memoryDb = openMemoryDb();
  return memoryDb;
}

function closeMemoryDb() {
  if (!memoryDb) return;
  try {
    memoryDb.close();
  } catch {
    // ignore
  }
  memoryDb = null;
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeMemoryType(type) {
  const t = String(type || "").trim().toLowerCase();
  if (["profile", "preference", "constraint", "goal"].includes(t)) return t;
  return "preference";
}

function normalizeMemoryKey(input) {
  return String(input || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .slice(0, 180);
}

function sanitizeMemoryContent(input) {
  return String(input || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 280);
}

function syncMemoryFtsRow(db, row) {
  if (!row || typeof row.id !== "number") return;
  db.prepare("DELETE FROM memory_items_fts WHERE rowid = ?").run(row.id);
  db.prepare("INSERT INTO memory_items_fts(rowid, user_id, content, type) VALUES (?, ?, ?, ?)")
    .run(row.id, row.user_id, row.content, row.type);
}

function getUserMemoryEnabled(db, userId) {
  const row = db.prepare("SELECT enabled FROM user_memory_settings WHERE user_id = ?").get(userId);
  if (!row) return MEMORY_ENABLED_DEFAULT;
  return Number(row.enabled || 0) === 1;
}

function setUserMemoryEnabled(db, userId, enabled) {
  const ts = nowIso();
  db.prepare(`
    INSERT INTO user_memory_settings(user_id, enabled, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      enabled = excluded.enabled,
      updated_at = excluded.updated_at
  `).run(userId, enabled ? 1 : 0, ts);
}

function pruneExpiredMemories(db, userId) {
  const cutoff = new Date(Date.now() - MEMORY_TTL_DAYS * 24 * 3600 * 1000).toISOString();
  const rows = db.prepare(`
    SELECT id
    FROM memory_items
    WHERE user_id = ? AND active = 1 AND updated_at < ?
  `).all(userId, cutoff);
  if (!rows.length) return 0;
  const del = db.transaction((ids) => {
    for (const row of ids) {
      db.prepare("DELETE FROM memory_items WHERE id = ?").run(row.id);
      db.prepare("DELETE FROM memory_items_fts WHERE rowid = ?").run(row.id);
    }
  });
  del(rows);
  return rows.length;
}

function upsertMemoryItem(db, userId, item, options = {}) {
  const type = normalizeMemoryType(item.type);
  const content = sanitizeMemoryContent(item.content);
  const normalizedKey = normalizeMemoryKey(item.normalized_key || content);
  if (!content || !normalizedKey) return { inserted: false, updated: false, id: 0 };

  const minConfidence = Number.isFinite(options.minConfidence)
    ? Number(options.minConfidence)
    : MEMORY_MIN_CONFIDENCE;
  const confidence = Math.max(0, Math.min(1, Number(item.confidence ?? 0.8)));
  if (confidence < minConfidence) return { inserted: false, updated: false, id: 0 };

  const importance = Math.max(0, Math.min(1, Number(item.importance ?? 0.75)));
  const ts = nowIso();
  const sourceMsgId = String(options.sourceMsgId || item.source_msg_id || "").slice(0, 120);
  const existing = db.prepare(`
    SELECT id, confidence, importance
    FROM memory_items
    WHERE user_id = ? AND normalized_key = ? AND active = 1
  `).get(userId, normalizedKey);

  if (existing) {
    db.prepare(`
      UPDATE memory_items
      SET
        type = ?,
        content = ?,
        confidence = ?,
        importance = ?,
        source_msg_id = ?,
        updated_at = ?,
        last_hit_at = ?
      WHERE id = ?
    `).run(
      type,
      content,
      Math.max(Number(existing.confidence || 0), confidence),
      Math.max(Number(existing.importance || 0), importance),
      sourceMsgId,
      options.updatedAt || ts,
      options.lastHitAt || ts,
      existing.id,
    );
    const row = db.prepare("SELECT id, user_id, content, type FROM memory_items WHERE id = ?").get(existing.id);
    syncMemoryFtsRow(db, row);
    return { inserted: false, updated: true, id: existing.id };
  }

  const createdAt = options.createdAt || ts;
  const info = db.prepare(`
    INSERT INTO memory_items (
      user_id, type, content, normalized_key, confidence, importance,
      source_msg_id, created_at, updated_at, last_hit_at, active
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
  `).run(
    userId,
    type,
    content,
    normalizedKey,
    confidence,
    importance,
    sourceMsgId,
    createdAt,
    options.updatedAt || createdAt,
    options.lastHitAt || createdAt,
  );
  const id = Number(info.lastInsertRowid || 0);
  const row = db.prepare("SELECT id, user_id, content, type FROM memory_items WHERE id = ?").get(id);
  syncMemoryFtsRow(db, row);
  return { inserted: true, updated: false, id };
}

function listUserMemories(db, userId, limit = 8) {
  const n = Math.max(1, Math.min(30, Number(limit || 8)));
  return db.prepare(`
    SELECT id, type, content, confidence, importance, updated_at, last_hit_at
    FROM memory_items
    WHERE user_id = ? AND active = 1
    ORDER BY
      CASE type
        WHEN 'constraint' THEN 1
        WHEN 'profile' THEN 2
        WHEN 'goal' THEN 3
        ELSE 4
      END,
      importance DESC,
      updated_at DESC
    LIMIT ?
  `).all(userId, n);
}

function clearUserMemories(db, userId) {
  const rows = db.prepare("SELECT id FROM memory_items WHERE user_id = ?").all(userId);
  if (!rows.length) return 0;
  const del = db.transaction((ids) => {
    for (const row of ids) {
      db.prepare("DELETE FROM memory_items WHERE id = ?").run(row.id);
      db.prepare("DELETE FROM memory_items_fts WHERE rowid = ?").run(row.id);
    }
  });
  del(rows);
  return rows.length;
}

function forgetUserMemoriesByKeyword(db, userId, keyword) {
  const kw = String(keyword || "").trim();
  if (!kw) return 0;
  const escaped = `%${kw.replace(/[\\%_]/g, "\\$&")}%`;
  const rows = db.prepare(`
    SELECT id
    FROM memory_items
    WHERE user_id = ? AND active = 1 AND content LIKE ? ESCAPE '\\'
  `).all(userId, escaped);
  if (!rows.length) return 0;
  const del = db.transaction((ids) => {
    for (const row of ids) {
      db.prepare("DELETE FROM memory_items WHERE id = ?").run(row.id);
      db.prepare("DELETE FROM memory_items_fts WHERE rowid = ?").run(row.id);
    }
  });
  del(rows);
  return rows.length;
}

function buildSearchTerms(text) {
  const out = new Set();
  const normalized = String(text || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  for (const token of normalized.split(" ")) {
    if (token.length >= 2 && token.length <= 20) out.add(token);
  }
  const hanParts = String(text || "").match(/[\p{Script=Han}]{2,}/gu) || [];
  for (const seg of hanParts) {
    if (seg.length <= 8) out.add(seg);
    for (let i = 0; i < seg.length - 1 && i < 12; i++) {
      out.add(seg.slice(i, i + 2));
    }
  }
  return [...out].slice(0, 12);
}

function buildFtsQuery(terms) {
  const cleaned = (terms || [])
    .map((t) => String(t || "").replace(/"/g, '""').trim())
    .filter(Boolean);
  if (!cleaned.length) return "";
  return cleaned.map((t) => `"${t}"`).join(" OR ");
}

function retrieveMemoryCandidates(db, userId, userText, topK) {
  pruneExpiredMemories(db, userId);
  const scoreMap = new Map();
  const pushScored = (row, baseScore) => {
    if (!row || typeof row.id !== "number") return;
    const prev = scoreMap.get(row.id);
    const updatedMs = Date.parse(String(row.updated_at || ""));
    const ageDays = Number.isFinite(updatedMs)
      ? Math.max(0, (Date.now() - updatedMs) / 86400000)
      : 3650;
    const recency = Math.max(0, 20 - ageDays * 0.08);
    const score = baseScore + Number(row.importance || 0) * 30 + recency;
    if (!prev || score > prev.score) scoreMap.set(row.id, { row, score });
  };

  const structural = db.prepare(`
    SELECT id, type, content, importance, updated_at
    FROM memory_items
    WHERE user_id = ? AND active = 1 AND type IN ('profile', 'constraint')
    ORDER BY importance DESC, updated_at DESC
    LIMIT 6
  `).all(userId);
  for (const row of structural) pushScored(row, 130);

  const terms = buildSearchTerms(userText);
  const ftsQuery = buildFtsQuery(terms);
  if (ftsQuery) {
    try {
      const ftsRows = db.prepare(`
        SELECT m.id, m.type, m.content, m.importance, m.updated_at, bm25(memory_items_fts) AS bm
        FROM memory_items_fts
        JOIN memory_items m ON m.id = memory_items_fts.rowid
        WHERE memory_items_fts.user_id = ?
          AND memory_items_fts MATCH ?
          AND m.user_id = ?
          AND m.active = 1
        ORDER BY bm
        LIMIT 12
      `).all(userId, ftsQuery, userId);
      let pos = 0;
      for (const row of ftsRows) {
        pushScored(row, 100 - pos * 4);
        pos++;
      }
    } catch {
      // ignore invalid MATCH syntax edge cases
    }
  }

  for (const term of terms.slice(0, 4)) {
    const likeRows = db.prepare(`
      SELECT id, type, content, importance, updated_at
      FROM memory_items
      WHERE user_id = ? AND active = 1 AND content LIKE ? ESCAPE '\\'
      ORDER BY importance DESC, updated_at DESC
      LIMIT 6
    `).all(userId, `%${term.replace(/[\\%_]/g, "\\$&")}%`);
    for (const row of likeRows) pushScored(row, 88);
  }

  const selected = [...scoreMap.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map((v) => v.row);

  if (selected.length) {
    const ts = nowIso();
    const touch = db.transaction((rows) => {
      const stmt = db.prepare("UPDATE memory_items SET last_hit_at = ? WHERE id = ?");
      for (const row of rows) stmt.run(ts, row.id);
    });
    touch(selected);
  }
  return selected;
}

function labelForMemoryType(type) {
  if (type === "profile") return "画像";
  if (type === "constraint") return "约束";
  if (type === "goal") return "目标";
  return "偏好";
}

function buildMemoryPromptContext(db, userId, userText) {
  if (!getUserMemoryEnabled(db, userId)) return "";
  const rows = retrieveMemoryCandidates(db, userId, userText, MEMORY_TOPK);
  if (!rows.length) return "";
  const lines = [];
  let total = 0;
  for (const row of rows) {
    const line = `- ${labelForMemoryType(row.type)}：${String(row.content || "").trim()}`;
    const next = total + line.length + 1;
    if (next > MEMORY_MAX_CHARS) break;
    total = next;
    lines.push(line);
  }
  return lines.join("\n");
}

function isLikelyTransientMemory(text) {
  return /(今天|明天|后天|刚刚|这周|今晚|马上|临时|稍后)/.test(String(text || ""));
}

function extractMemoryCandidates(userText) {
  const text = String(userText || "").trim();
  if (!text || text.startsWith("/")) return [];
  const segments = text
    .split(/[。！？\n]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 12);
  const out = [];
  const seen = new Set();
  for (const segRaw of segments) {
    const seg = sanitizeMemoryContent(segRaw);
    if (seg.length < 4 || seg.length > 120) continue;
    if (isLikelyTransientMemory(seg) && !/(请记住|记一下|记住)/.test(seg)) continue;

    let type = "";
    let confidence = 0.75;
    let importance = 0.72;
    if (/(我叫|我是|我的名字|来自|在.*工作|职业|身份)/.test(seg)) {
      type = "profile";
      confidence = 0.9;
      importance = 0.88;
    } else if (/(不喜欢|不要|别给我|不能|忌口|不吃|避免)/.test(seg)) {
      type = "constraint";
      confidence = 0.88;
      importance = 0.9;
    } else if (/(目标|计划|打算|想要|今年|长期)/.test(seg)) {
      type = "goal";
      confidence = 0.8;
      importance = 0.84;
    } else if (/(喜欢|偏好|习惯|希望|倾向|更爱)/.test(seg) || /(请记住|记一下|记住)/.test(seg)) {
      type = "preference";
      confidence = /(请记住|记一下|记住)/.test(seg) ? 0.92 : 0.78;
      importance = /(请记住|记一下|记住)/.test(seg) ? 0.86 : 0.74;
    }
    if (!type) continue;
    const content = seg
      .replace(/^(请记住|帮我记住|记一下|记住)\s*/g, "")
      .trim();
    const key = normalizeMemoryKey(content);
    if (!content || !key || seen.has(key)) continue;
    seen.add(key);
    out.push({ type, content, confidence, importance, normalized_key: key });
  }
  return out;
}

function persistAutoMemoryFromTurn(db, userId, userText, sourceMsgId = "") {
  if (!getUserMemoryEnabled(db, userId)) return { inserted: 0, updated: 0 };
  const candidates = extractMemoryCandidates(userText);
  if (!candidates.length) return { inserted: 0, updated: 0 };
  let inserted = 0;
  let updated = 0;
  const tx = db.transaction((items) => {
    for (const item of items) {
      const r = upsertMemoryItem(db, userId, item, { sourceMsgId });
      if (r.inserted) inserted++;
      if (r.updated) updated++;
    }
  });
  tx(candidates);
  return { inserted, updated };
}

function applyMemoryLeakGuard(rawReply) {
  let text = String(rawReply || "");
  text = text
    .replace(/根据(?:你|您的)?(?:历史记录|记忆库|数据库|检索结果|调用链)/g, "结合你之前提到的信息")
    .replace(/我(?:查到|检索到|在数据库里看到)/g, "我了解到");
  for (const re of MEMORY_LEAK_REGEXES) {
    text = text.replace(re, "");
  }
  return text
    .replace(/\s+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function ensureParentDir(filePath) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
}

function safeUserFilePrefix(userId) {
  const slug = String(userId || "")
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 32) || "user";
  const hash = crypto.createHash("sha1").update(String(userId || "")).digest("hex").slice(0, 8);
  return `${slug}-${hash}`;
}

function resolveMemoryExportPath(userId, outHint = "") {
  const defaultName = `${safeUserFilePrefix(userId)}.memory.v${MEMORY_SCHEMA_VERSION}.json`;
  if (!outHint) {
    return path.resolve(MEMORY_EXPORT_DIR, defaultName);
  }
  const abs = path.isAbsolute(outHint) ? outHint : path.resolve(outHint);
  if (path.extname(abs).toLowerCase() === ".json") return abs;
  return path.join(abs, defaultName);
}

function buildMemoryExportPayload(db, userId) {
  const items = db.prepare(`
    SELECT type, content, normalized_key, confidence, importance, source_msg_id, created_at, updated_at, last_hit_at
    FROM memory_items
    WHERE user_id = ? AND active = 1
    ORDER BY updated_at DESC
  `).all(userId);
  const setting = db.prepare("SELECT enabled, updated_at FROM user_memory_settings WHERE user_id = ?").get(userId);
  return {
    schema_version: MEMORY_SCHEMA_VERSION,
    exported_at: nowIso(),
    source_instance_id: INSTANCE_ID || "(default)",
    source_user_id: userId,
    user_memory_settings: {
      enabled: setting ? Number(setting.enabled || 0) === 1 : MEMORY_ENABLED_DEFAULT,
      updated_at: setting?.updated_at || null,
    },
    memory_items: items,
    stats: {
      total: items.length,
    },
  };
}

function exportUserMemoryPackage(db, userId, outHint = "") {
  const outPath = resolveMemoryExportPath(userId, outHint);
  ensureParentDir(outPath);
  const payload = buildMemoryExportPayload(db, userId);
  const json = `${JSON.stringify(payload, null, 2)}\n`;
  fs.writeFileSync(outPath, json, "utf-8");
  const sha = crypto.createHash("sha256").update(json, "utf-8").digest("hex");
  fs.writeFileSync(`${outPath}.sha256`, `${sha}  ${path.basename(outPath)}\n`, "utf-8");
  return { outPath, sha, total: payload.stats.total };
}

function parseMemoryPayload(raw, sourceLabel) {
  let payload = null;
  try {
    payload = JSON.parse(raw);
  } catch (err) {
    throw new Error(`无法解析 JSON（${sourceLabel}）：${err.message}`);
  }
  if (!payload || typeof payload !== "object") {
    throw new Error("迁移包格式错误：根对象无效");
  }
  if (Number(payload.schema_version) !== MEMORY_SCHEMA_VERSION) {
    throw new Error(`迁移包版本不支持：${payload.schema_version}`);
  }
  if (!Array.isArray(payload.memory_items)) {
    throw new Error("迁移包格式错误：缺少 memory_items 数组");
  }
  return payload;
}

function validateMemoryPackage(inputPath) {
  const abs = path.isAbsolute(inputPath) ? inputPath : path.resolve(inputPath);
  const raw = fs.readFileSync(abs, "utf-8");
  const payload = parseMemoryPayload(raw, abs);
  const localSha = crypto.createHash("sha256").update(raw, "utf-8").digest("hex");
  const shaFile = `${abs}.sha256`;
  let shaMatched = null;
  if (fs.existsSync(shaFile)) {
    const txt = fs.readFileSync(shaFile, "utf-8");
    const expected = String(txt.split(/\s+/)[0] || "").trim().toLowerCase();
    shaMatched = expected ? expected === localSha.toLowerCase() : null;
  }
  return {
    path: abs,
    total: payload.memory_items.length,
    sourceUserId: payload.source_user_id || "",
    schemaVersion: payload.schema_version,
    sha256: localSha,
    shaMatched,
  };
}

function importUserMemoryPackage(db, targetUserId, inputPath, mode = "merge") {
  const abs = path.isAbsolute(inputPath) ? inputPath : path.resolve(inputPath);
  const raw = fs.readFileSync(abs, "utf-8");
  const payload = parseMemoryPayload(raw, abs);
  if (mode === "replace") {
    clearUserMemories(db, targetUserId);
  }
  let inserted = 0;
  let updated = 0;
  const tx = db.transaction((items) => {
    for (const rawItem of items) {
      const result = upsertMemoryItem(db, targetUserId, {
        type: rawItem.type,
        content: rawItem.content,
        normalized_key: rawItem.normalized_key,
        confidence: rawItem.confidence,
        importance: rawItem.importance,
        source_msg_id: rawItem.source_msg_id,
      }, {
        minConfidence: 0,
        createdAt: rawItem.created_at || nowIso(),
        updatedAt: rawItem.updated_at || nowIso(),
        lastHitAt: rawItem.last_hit_at || rawItem.updated_at || nowIso(),
      });
      if (result.inserted) inserted++;
      if (result.updated) updated++;
    }
  });
  tx(payload.memory_items);
  if (payload.user_memory_settings && typeof payload.user_memory_settings === "object") {
    setUserMemoryEnabled(db, targetUserId, payload.user_memory_settings.enabled !== false);
  }
  return { inserted, updated, sourceUserId: payload.source_user_id || "" };
}

function runMemoryCli() {
  const db = getMemoryDb();
  if (CLI_OPTS.memoryAction === "export") {
    const result = exportUserMemoryPackage(db, CLI_OPTS.memoryUser, CLI_OPTS.memoryOut);
    console.log(`✅ 记忆导出成功`);
    console.log(`   user=${CLI_OPTS.memoryUser}`);
    console.log(`   path=${result.outPath}`);
    console.log(`   total=${result.total}`);
    console.log(`   sha256=${result.sha}`);
    return;
  }
  if (CLI_OPTS.memoryAction === "validate") {
    const result = validateMemoryPackage(CLI_OPTS.memoryIn);
    console.log(`✅ 迁移包校验完成`);
    console.log(`   path=${result.path}`);
    console.log(`   schema_version=${result.schemaVersion}`);
    console.log(`   source_user=${result.sourceUserId || "(unknown)"}`);
    console.log(`   total=${result.total}`);
    console.log(`   sha256=${result.sha256}`);
    console.log(`   sha_match=${result.shaMatched == null ? "(未提供sha文件)" : (result.shaMatched ? "yes" : "no")}`);
    return;
  }
  if (CLI_OPTS.memoryAction === "import") {
    const result = importUserMemoryPackage(db, CLI_OPTS.memoryUser, CLI_OPTS.memoryIn, CLI_OPTS.memoryMode);
    console.log(`✅ 记忆导入成功`);
    console.log(`   target_user=${CLI_OPTS.memoryUser}`);
    console.log(`   source_user=${result.sourceUserId || "(unknown)"}`);
    console.log(`   mode=${CLI_OPTS.memoryMode}`);
    console.log(`   inserted=${result.inserted}`);
    console.log(`   updated=${result.updated}`);
    return;
  }
  throw new Error(`未知 memory 子命令: ${CLI_OPTS.memoryAction}`);
}

function ensurePersonaStoreFile() {
  if (!fs.existsSync(PERSONA_FILE)) {
    fs.writeFileSync(PERSONA_FILE, PERSONA_BOOTSTRAP, "utf-8");
    fs.chmodSync(PERSONA_FILE, 0o600);
  }
}

function normalizePersonaStore(parsed) {
  if (!parsed || typeof parsed !== "object") {
    return {
      global_default_persona: "你是一位专业、简洁、友好的中文微信助理。",
      users: {},
    };
  }
  const defaultPersona = typeof parsed.global_default_persona === "string"
    ? parsed.global_default_persona
    : "你是一位专业、简洁、友好的中文微信助理。";
  const users = parsed.users && typeof parsed.users === "object" ? parsed.users : {};
  return { global_default_persona: defaultPersona, users };
}

function shortUserId(fromUserId) {
  const raw = String(fromUserId || "").trim();
  if (!raw) return "(unknown)";
  const left = raw.split("@")[0] || raw;
  if (left.length <= 12) return left;
  return `${left.slice(0, 6)}...${left.slice(-4)}`;
}

function getUserLabel(store, fromUserId) {
  const userEntry = store.users?.[fromUserId];
  if (userEntry && typeof userEntry === "object" && typeof userEntry.label === "string" && userEntry.label.trim()) {
    return userEntry.label.trim();
  }
  return shortUserId(fromUserId);
}

function loadPersonaStore() {
  ensurePersonaStoreFile();
  const raw = fs.readFileSync(PERSONA_FILE, "utf-8");
  const begin = raw.indexOf(PERSONA_BEGIN);
  const end = raw.indexOf(PERSONA_END);
  if (begin === -1 || end === -1 || end <= begin) {
    fs.writeFileSync(PERSONA_FILE, PERSONA_BOOTSTRAP, "utf-8");
    fs.chmodSync(PERSONA_FILE, 0o600);
    return normalizePersonaStore(null);
  }

  const jsonText = raw.slice(begin + PERSONA_BEGIN.length, end).trim();
  try {
    const parsed = JSON.parse(jsonText);
    return normalizePersonaStore(parsed);
  } catch {
    fs.writeFileSync(PERSONA_FILE, PERSONA_BOOTSTRAP, "utf-8");
    fs.chmodSync(PERSONA_FILE, 0o600);
    return normalizePersonaStore(null);
  }
}

function savePersonaStore(store) {
  const normalized = normalizePersonaStore(store);
  const content = `# Soule Persona Store

本文件用于保存微信 Bridge 的人格配置。
请尽量通过微信指令修改（/persona ...），避免手工破坏结构化数据块。

${PERSONA_BEGIN}
${JSON.stringify(normalized, null, 2)}
${PERSONA_END}
`;
  fs.writeFileSync(PERSONA_FILE, content, "utf-8");
  fs.chmodSync(PERSONA_FILE, 0o600);
}

function sanitizePersonaText(input) {
  const text = String(input || "").trim().replace(/\s+/g, " ");
  return text.slice(0, MAX_PERSONA_LEN);
}

function getUserPersona(store, fromUserId) {
  const userEntry = store.users?.[fromUserId];
  if (!userEntry || typeof userEntry !== "object") return "";
  if (typeof userEntry.persona !== "string") return "";
  return userEntry.persona.trim();
}

function setUserPersona(store, fromUserId, persona) {
  if (!store.users || typeof store.users !== "object") store.users = {};
  const prev = store.users[fromUserId] && typeof store.users[fromUserId] === "object" ? store.users[fromUserId] : {};
  store.users[fromUserId] = {
    ...prev,
    persona,
    updated_at: new Date().toISOString(),
  };
}

function resetUserPersona(store, fromUserId) {
  if (!store.users || typeof store.users !== "object") return;
  const prev = store.users[fromUserId];
  if (!prev || typeof prev !== "object") {
    delete store.users[fromUserId];
    return;
  }
  if (typeof prev.label === "string" && prev.label.trim()) {
    store.users[fromUserId] = {
      label: prev.label.trim(),
      updated_at: new Date().toISOString(),
    };
    return;
  }
  delete store.users[fromUserId];
}

function setUserLabel(store, fromUserId, label) {
  if (!store.users || typeof store.users !== "object") store.users = {};
  const prev = store.users[fromUserId] && typeof store.users[fromUserId] === "object" ? store.users[fromUserId] : {};
  store.users[fromUserId] = {
    ...prev,
    label,
    updated_at: new Date().toISOString(),
  };
}

function resetUserLabel(store, fromUserId) {
  if (!store.users || typeof store.users !== "object") return;
  const prev = store.users[fromUserId];
  if (!prev || typeof prev !== "object") return;
  if (typeof prev.persona === "string" && prev.persona.trim()) {
    store.users[fromUserId] = {
      persona: prev.persona.trim(),
      updated_at: new Date().toISOString(),
    };
    return;
  }
  delete store.users[fromUserId];
}

function buildCodexPrompt(userText, fromUserId, personaStore, memoryContext = "", personaEnabled = true) {
  const defaultPersona = sanitizePersonaText(personaStore.global_default_persona || "");
  const userPersona = sanitizePersonaText(getUserPersona(personaStore, fromUserId));
  const personaLines = [];
  if (personaEnabled && defaultPersona) personaLines.push(`全局默认人格：${defaultPersona}`);
  if (personaEnabled && userPersona) personaLines.push(`当前用户人格：${userPersona}`);
  const memoryLines = String(memoryContext || "").trim()
    ? [
      "【内部记忆，仅用于组织回复】",
      "以下内容严禁向用户暴露来源，禁止出现“记忆库/检索/数据库/历史记录/调用链”等字样：",
      String(memoryContext || "").trim(),
      "",
    ]
    : [];

  return [
    "你是微信机器人助手。请根据用户消息直接回复可发送给微信用户的文本。",
    "回复要求：简洁、自然、不要包含多余前缀，不要输出思考过程。",
    "若你需要系统发送媒体，请在最终回复中单独一行输出指令：",
    "- [[SEND_MEDIA:<绝对路径或https链接>]] （自动按类型发送）",
    "- [[SEND_FILE:<绝对路径或https链接>]] （强制按文件发送）",
    "- [[SEND_VOICE:<绝对路径或https链接>]] （强制按语音发送）",
    "若输出了上述指令，其余正文照常输出。",
    "",
    ...personaLines,
    "",
    ...memoryLines,
    `用户消息：${userText}`,
  ].join("\n");
}

function classifyCommand(command) {
  const raw = String(command || "").trim();
  const shellWrapped = raw.match(/-lc\s+'([\s\S]+)'$/);
  const normalized = shellWrapped ? shellWrapped[1] : raw;
  const cmd = normalized.trim().toLowerCase();
  if (!cmd) return { emoji: "⚙️", label: "命令" };

  if (
    cmd.includes("apply_patch")
    || cmd.startsWith("sed -i")
    || cmd.startsWith("perl -i")
    || cmd.startsWith("tee ")
    || cmd.includes(" > ")
    || cmd.includes(">>")
  ) {
    return { emoji: "🧑‍💻", label: "改代码" };
  }

  if (
    cmd.startsWith("cat ")
    || cmd.startsWith("sed ")
    || cmd.startsWith("rg ")
    || cmd.startsWith("ls ")
    || cmd.startsWith("find ")
    || cmd.startsWith("head ")
    || cmd.startsWith("tail ")
    || cmd.startsWith("wc ")
  ) {
    return { emoji: "👀", label: "读文件" };
  }

  if (
    cmd.startsWith("npm test")
    || cmd.startsWith("pnpm test")
    || cmd.startsWith("yarn test")
    || cmd.includes(" vitest")
    || cmd.includes(" jest")
    || cmd.startsWith("pytest")
    || cmd.startsWith("go test")
    || cmd.startsWith("cargo test")
    || cmd.startsWith("node ")
    || cmd.startsWith("python ")
    || cmd.startsWith("uv run")
  ) {
    return { emoji: "🧪", label: "运行/验证" };
  }

  if (
    cmd.startsWith("git ")
  ) {
    return { emoji: "🌿", label: "Git" };
  }

  if (
    cmd.startsWith("curl ")
    || cmd.startsWith("wget ")
    || cmd.startsWith("npm view ")
    || cmd.startsWith("npx ")
  ) {
    return { emoji: "🌐", label: "网络" };
  }

  return { emoji: "⚙️", label: "命令" };
}

function formatCodexProgress(event) {
  if (!event || typeof event !== "object") return null;

  if (event.type === "item.started" && event.item?.type === "command_execution") {
    const cmd = String(event.item.command || "").trim();
    const kind = classifyCommand(cmd);
    return cmd ? `[${kind.emoji} ${kind.label}] 正在执行: ${cmd.slice(0, 160)}` : `[${kind.emoji} ${kind.label}] 正在执行命令…`;
  }

  if (event.type === "item.completed" && event.item?.type === "command_execution") {
    const cmd = String(event.item.command || "").trim();
    const code = event.item.exit_code;
    const codeText = typeof code === "number" ? ` (exit ${code})` : "";
    const kind = classifyCommand(cmd);
    return cmd ? `[${kind.emoji} ${kind.label}] 完成${codeText}: ${cmd.slice(0, 120)}` : `[${kind.emoji} ${kind.label}] 完成${codeText}`;
  }

  return null;
}

async function runCodex(args, prompt, timeoutMs, onProgress) {
  const model = process.env.CODEX_MODEL?.trim();
  const profile = process.env.CODEX_PROFILE?.trim();
  const sandbox = process.env.CODEX_SANDBOX?.trim();
  const cmdArgs = [...args];
  if (model) cmdArgs.splice(1, 0, "-m", model);
  if (profile) cmdArgs.splice(1, 0, "-p", profile);
  if (sandbox) cmdArgs.splice(1, 0, "-s", sandbox);

  const child = spawn("codex", cmdArgs, {
    cwd: process.cwd(),
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
  });

  child.stdin.write(prompt);
  child.stdin.end();

  let stderrText = "";
  let threadId = "";
  let reply = "";
  let closed = false;
  let hardKilled = false;

  let progressChain = Promise.resolve();
  const pushProgress = (text) => {
    if (!text || typeof onProgress !== "function") return;
    progressChain = progressChain.then(() => onProgress(text)).catch(() => {});
  };

  child.stderr.on("data", (chunk) => {
    stderrText += chunk.toString("utf-8");
  });

  const rl = readline.createInterface({ input: child.stdout });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }

    if (event.type === "thread.started" && event.thread_id) {
      threadId = String(event.thread_id);
    }
    if (event.type === "item.completed" && event.item?.type === "agent_message") {
      reply = String(event.item.text || "");
    }

    const progressText = formatCodexProgress(event);
    if (progressText) pushProgress(progressText);
  });

  let forceKillTimer = null;
  const exitPromise = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => {
      closed = true;
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
        forceKillTimer = null;
      }
      resolve(code ?? 1);
    });
  });

  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => {
      if (closed) return;
      pushProgress(`⏱️ Codex 超时（>${Math.round(timeoutMs / 1000)}s），正在中断…`);
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
      forceKillTimer = setTimeout(() => {
        if (closed) return;
        hardKilled = true;
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore
        }
      }, 5000);
      reject(new Error(`codex 超时（${timeoutMs}ms）`));
    }, timeoutMs);
  });

  let exitCode;
  try {
    exitCode = await Promise.race([exitPromise, timeoutPromise]);
  } finally {
    if (forceKillTimer) {
      clearTimeout(forceKillTimer);
      forceKillTimer = null;
    }
  }

  await progressChain;

  if (exitCode !== 0) {
    const reason = hardKilled ? "（已强制终止）" : "";
    throw new Error(`codex 退出码 ${exitCode}${reason}: ${(stderrText || "").trim() || "未知错误"}`);
  }

  return { threadId, reply: reply.trim() || "（Codex 无回复）" };
}

/** 调用 Codex CLI，按微信用户复用会话 */
async function askCodex(userKey, userText, personaStore, memoryContext, personaEnabled, sessionMap, onProgress) {
  const prompt = buildCodexPrompt(userText, userKey, personaStore, memoryContext, personaEnabled);
  const timeoutMs = Number(process.env.CODEX_TIMEOUT_MS || "180000");
  const existingThread = sessionMap[userKey];

  if (existingThread) {
    try {
      const resumed = await runCodex(
        ["exec", "resume", "--skip-git-repo-check", "--json", existingThread, "-"],
        prompt,
        timeoutMs,
        onProgress,
      );
      if (resumed.threadId) {
        sessionMap[userKey] = resumed.threadId;
      }
      return resumed.reply;
    } catch (err) {
      console.warn(`   ⚠️ Codex 续会话失败，改为新会话: ${err.message}`);
    }
  }

  const created = await runCodex(
    ["exec", "--skip-git-repo-check", "--json", "-C", process.cwd(), "-"],
    prompt,
    timeoutMs,
    onProgress,
  );
  if (created.threadId) {
    sessionMap[userKey] = created.threadId;
  }
  return created.reply;
}

// ─── 主循环 ───────────────────────────────────────────────────────────────────

async function main() {
  acquireInstanceLock();
  process.on("exit", () => {
    closeMemoryDb();
    releaseInstanceLock();
  });
  process.on("SIGINT", () => {
    closeMemoryDb();
    releaseInstanceLock();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    closeMemoryDb();
    releaseInstanceLock();
    process.exit(143);
  });

  const forceLogin = CLI_OPTS.forceLogin;
  const codexSessionMap = loadCodexSessionMap();
  const personaStore = loadPersonaStore();
  let memoryDbForRuntime = null;
  try {
    memoryDbForRuntime = getMemoryDb();
  } catch (err) {
    console.warn(`⚠️ 记忆库初始化失败，将以无记忆模式运行：${err.message}`);
  }
  const typingTicketCache = new Map();
  const runtimeFlags = {
    progressStream: ENABLE_PROGRESS_STREAM && !memoryDbForRuntime,
    typing: ENABLE_TYPING,
    persona: ENABLE_PERSONA,
  };

  console.log(`🔧 实例: ${INSTANCE_ID || "(default)"}`);
  console.log(`   TOKEN_FILE=${TOKEN_FILE}`);
  console.log(`   CODEX_SESSION_FILE=${CODEX_SESSION_FILE}`);
  console.log(`   PERSONA_FILE=${PERSONA_FILE}`);
  console.log(`   ENABLE_PERSONA=${runtimeFlags.persona ? "1" : "0"}`);
  console.log(`   MEMORY_DB_FILE=${MEMORY_DB_FILE}`);
  console.log(`   LOCK_FILE=${INSTANCE_LOCK_FILE}\n`);

  // 加载或获取 token
  let session;
  if (!forceLogin && fs.existsSync(TOKEN_FILE)) {
    session = JSON.parse(fs.readFileSync(TOKEN_FILE, "utf-8"));
    console.log(`✅ 已加载 token（Bot: ${session.accountId}，保存于 ${session.savedAt}）`);
    console.log(`   如需重新登录，运行: node wechat-claude-bridge.mjs --login\n`);
  } else {
    session = await login();
  }

  const { token, baseUrl, accountId } = session;

  console.log("🚀 开始长轮询收消息（Ctrl+C 退出）...\n");

  let getUpdatesBuf = "";

  while (true) {
    try {
      const resp = await getUpdates(baseUrl, token, getUpdatesBuf);

      // 更新 buf（服务器下发的游标，下次请求带上）
      if (resp.get_updates_buf) {
        getUpdatesBuf = resp.get_updates_buf;
      }

      for (const msg of resp.msgs ?? []) {
        // 只处理用户发来的消息（message_type=1）
        if (msg.message_type !== 1) continue;

        const from = msg.from_user_id;
        const text = extractText(msg);
        const contextToken = msg.context_token;
        const userLabel = getUserLabel(personaStore, from);
        let lastProgressAt = 0;
        let lastProgressText = "";

        console.log(`📩 [${new Date().toLocaleTimeString()}] 收到消息`);
        console.log(`   From: ${userLabel} (${from})`);
        console.log(`   Text: ${text}`);

        let typingTicket = typingTicketCache.get(from) || "";
        if (!typingTicket) {
          try {
            typingTicket = await getTypingTicket(baseUrl, token, from, contextToken);
            if (typingTicket) typingTicketCache.set(from, typingTicket);
          } catch (typingErr) {
            console.warn(`   ⚠️ 获取 typing_ticket 失败: ${typingErr.message}`);
          }
        }

        let commandHandled = false;
        try {
          commandHandled = await handleCommand({
            text,
            fromUserId: from,
            contextToken,
            personaStore,
            baseUrl,
            token,
            runtimeFlags,
            memoryDb: memoryDbForRuntime,
          });
        } catch (cmdErr) {
          console.error(`   ❌ 指令处理失败: ${cmdErr.message}`);
          await safeSendMessage(baseUrl, token, from, `❌ 指令处理失败：${cmdErr.message}`, contextToken);
          continue;
        }
        if (commandHandled) {
          continue;
        }

        if (runtimeFlags.typing && typingTicket) {
          try {
            await sendTyping(baseUrl, token, from, typingTicket, TYPING_STATUS.TYPING);
          } catch (typingErr) {
            console.warn(`   ⚠️ 发送“正在输入”失败: ${typingErr.message}`);
          }
        }

        try {
          // 调用 Codex 生成回复
          process.stdout.write(`   🤔 Codex 处理中...`);
          const memoryContext = memoryDbForRuntime
            ? buildMemoryPromptContext(memoryDbForRuntime, from, text)
            : "";
          const reply = await askCodex(
            from,
            text,
            personaStore,
            memoryContext,
            runtimeFlags.persona,
            codexSessionMap,
            async (progressText) => {
            if (!runtimeFlags.progressStream) return;
            const now = Date.now();
            if (progressText === lastProgressText) return;
            if (now - lastProgressAt < 1200) return;
            lastProgressAt = now;
            lastProgressText = progressText;
            await sendMessage(baseUrl, token, from, `【处理中】${progressText}`, contextToken);
            },
          );
          saveCodexSessionMap(codexSessionMap);
          process.stdout.write(` 完成\n`);

          const guardedReply = applyMemoryLeakGuard(reply);
          await sendAssistantReply(baseUrl, token, from, guardedReply, contextToken);
          if (memoryDbForRuntime) {
            try {
              const saved = persistAutoMemoryFromTurn(
                memoryDbForRuntime,
                from,
                text,
                String(msg.client_msg_id || msg.msg_id || ""),
              );
              if (saved.inserted || saved.updated) {
                console.log(`   🧠 记忆更新: inserted=${saved.inserted} updated=${saved.updated}`);
              }
            } catch (memErr) {
              console.warn(`   ⚠️ 记忆写入失败: ${memErr.message}`);
            }
          }
          console.log(`   ✅ 已回复: ${guardedReply.slice(0, 60)}${guardedReply.length > 60 ? "…" : ""}\n`);
        } catch (replyErr) {
          console.error(`   ❌ 回复流程失败: ${replyErr.message}`);
          await safeSendMessage(baseUrl, token, from, `❌ 回复失败：${replyErr.message}`, contextToken);
        } finally {
          if (runtimeFlags.typing && typingTicket) {
            try {
              await sendTyping(baseUrl, token, from, typingTicket, TYPING_STATUS.CANCEL);
            } catch (typingErr) {
              console.warn(`   ⚠️ 取消“正在输入”失败: ${typingErr.message}`);
            }
          }
        }
      }
    } catch (err) {
      if (err.message?.includes("session timeout") || err.message?.includes("-14")) {
        console.error("❌ Session 已过期，请重新登录: node wechat-claude-bridge.mjs --login");
        process.exit(1);
      }
      console.error(`⚠️  轮询出错: ${err.message}，3 秒后重试...`);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

if (CLI_OPTS.command === "help") {
  printHelp();
  process.exit(0);
}

if (CLI_OPTS.command === "accounts") {
  listAccounts();
  process.exit(0);
}

if (CLI_OPTS.command === "memory") {
  try {
    runMemoryCli();
    process.exit(0);
  } catch (err) {
    console.error("memory 命令失败:", err.message);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
