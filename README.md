# WeChat Codex Bridge

这是一份给小白的使用说明。  
你只需要按步骤执行命令，就可以把微信消息接到 Codex，再把回复发回微信。

---

## 1. 这个项目是做什么的？

它是一个“桥接器”：

1. 利用微信 openclaw 插件 对接本地 codex 

<img width="400" height="auto" alt="image" src="https://github.com/user-attachments/assets/a1b0ae2a-0233-45f9-b478-20b8d3f5dc93" />

支持功能：
- 人格设置（每个用户可单独配置）
- 记忆库（本地 SQLite）
- 媒体发送指令（图片/文件/语音）
- 多账号（基于 `instance` 隔离）

---

## 2. 运行前准备（必须）

请先确认以下 3 项：

1. Node.js 版本 `>=22`
```bash
node -v
```

2. npm 可用
```bash
npm -v
```

3. `codex` 命令可用
```bash
codex --version
```

如果第 3 步报 `command not found`，请先安装并配置 Codex CLI。

---

## 3. 第一次启动（一步一步）

在项目目录执行：

```bash
npm install
npm run login
npm run start
```

你会看到什么：

- `npm run login` 时，终端会显示微信二维码  
- 你扫码并确认后，会生成 token 文件（例如 `.weixin-token.wx1.json`）  
- `npm run start` 后，终端会持续输出“收消息/回消息”日志

如果你能在微信里发一句话并收到回复，说明启动成功。

---

## 4. 日常最常用命令

### 4.1 npm 命令

```bash
npm run start
npm run login
npm run accounts
npm run help
```

### 4.2 Node 命令（完整）

```bash
node wechat-claude-bridge.mjs [start] [--instance <id>] [--login]
node wechat-claude-bridge.mjs login [--instance <id>]
node wechat-claude-bridge.mjs accounts
node wechat-claude-bridge.mjs memory export --user <id> [--out <json路径或目录>]
node wechat-claude-bridge.mjs memory import --user <id> --in <json路径> [--mode merge|replace]
node wechat-claude-bridge.mjs memory validate --in <json路径>
node wechat-claude-bridge.mjs --help
```

### 4.3 参数说明（常用）

- `--instance` / `-i`：实例 ID（用于隔离不同账号的数据文件）
- `--login`：强制重新扫码登录
- `--help` / `-h`：查看帮助
- `--list-accounts`：等同 `accounts`

### 4.4 记忆迁移命令（参数）

- `memory export`
  - 必填：`--user <id>`
  - 可选：`--out <path>`（可填目录或完整文件路径）
- `memory import`
  - 必填：`--user <id> --in <json路径>`
  - 可选：`--mode merge|replace`（默认 `merge`）
- `memory validate`
  - 必填：`--in <json路径>`

### 4.5 多账号用法（重点）

登录第 1 个账号（实例 `wx1`）：

```bash
npm run login -- --instance wx1
```

登录第 2 个账号（实例 `wx2`）：

```bash
npm run login -- --instance wx2
```

分别启动两个账号（建议开两个终端）：

```bash
npm run start -- --instance wx1
npm run start -- --instance wx2
```

查看当前目录下已登录账号：

```bash
npm run accounts
```

文件隔离规则（按实例ID自动分开）：

- token：`.weixin-token.<instance>.json`
- 会话映射：`.codex-session-map.<instance>.json`
- 记忆库：`.wechat-memory.<instance>.db`

参数优先级：

- 启动参数 `--instance` / `-i` 优先级高于 `.env` 里的 `INSTANCE_ID`
- 不传 `--instance` 时，默认使用 `.env` 中的 `INSTANCE_ID`

---

## 5. 微信内可用命令（发给机器人）

### 人格相关

- `/persona show`：看当前人格
- `/persona status`：看人格开关
- `/persona on`：开人格逻辑
- `/persona off`：关人格逻辑
- `/persona set <内容>`：设置当前用户人格
- `/persona reset`：清除当前用户人格
- `/persona default show`：看全局默认人格
- `/persona default set <内容>`：设置全局默认人格

### 用户标识

- `/user label show`
- `/user label set <标识>`
- `/user label reset`

### 记忆库

- `/memory show [n]`：查看记忆（默认 8 条）
- `/memory on`：开记忆
- `/memory off`：关记忆
- `/memory clear`：清空记忆
- `/memory forget <关键词>`：按关键词删记忆

### 调试

- `/debug status`：查看当前状态
- `/toggle-debug`：切换过程播报

---

## 6. `.env` 配置怎么改（小白推荐）

项目里已经自带 `.env`，直接修改即可：

```bash
vim .env
```

先只改这几个：

- `INSTANCE_ID=wx1`  
  默认实例 ID；不传 `--instance` 时就用它。

- 多账号建议：  
  登录/启动时优先用 `--instance` 显式指定，例如 `--instance wx2`。

- `ENABLE_PROGRESS_STREAM=0`  
  建议保持 `0`，避免把处理过程发给微信用户。

- `ENABLE_PERSONA=1`  
  默认开启人格逻辑；不需要可改成 `0`。

- `MEMORY_ENABLED=1`  
  默认开启记忆；不需要可改成 `0`。

其他配置可以先保持默认，跑通后再调整。

---

## 7. 模型可用的媒体发送指令

如果模型在回复里输出下面格式，系统会自动发送媒体：

- `[[SEND_MEDIA:<绝对路径或https链接>]]`
- `[[SEND_FILE:<绝对路径或https链接>]]`
- `[[SEND_VOICE:<绝对路径或https链接>]]`

示例：

```text
这是你要的文件。
[[SEND_FILE:/absolute/path/to/report.pdf]]
```

---

## 8. 记忆导入导出（实战示例）

导出用户记忆：

```bash
node wechat-claude-bridge.mjs memory export --user wxid_xxx --out ./exports
```

校验导出文件：

```bash
node wechat-claude-bridge.mjs memory validate --in ./exports/wxid_xxx.memory.v1.json
```

导入到另一个用户（合并模式）：

```bash
node wechat-claude-bridge.mjs memory import --user wxid_target --in ./exports/wxid_xxx.memory.v1.json --mode merge
```

---

## 9. 常见问题（先看这里）

### Q1: 报错 `spawn codex ENOENT`
说明系统找不到 `codex` 命令。  
先执行：

```bash
codex --version
```

确认安装并加入 `PATH`。

### Q2: Node 版本不对
如果提示引擎不匹配，请升级到 Node.js `>=22`。

### Q3: 已扫码但收不到消息
请依次检查：

1. 当前实例是否使用了正确的 `INSTANCE_ID`
2. token 文件是否存在（例如 `.weixin-token.json`）
3. 网络是否可以访问 iLink API
4. 机器人账号状态是否正常

### Q4: 想重登账号

```bash
npm run login
```

或：

```bash
node wechat-claude-bridge.mjs --login
```

---

## 10. 安全建议（上线前）

- 不要提交以下文件到仓库：
  - `.env.local`
  - `.env.*.local`
  - `.weixin-token*.json`
  - `.codex-session-map*.json`
  - `.wechat-memory*.db`
- 生产建议：
  - `ENABLE_PROGRESS_STREAM=0`
  - 敏感配置写入 `.env.local`（不要写进默认 `.env`）
  - 定期备份 `MEMORY_DB_FILE`

---

## 11. 目录说明

- `wechat-claude-bridge.mjs`：主程序入口
- `.env`：默认可用配置（开箱即用）
- `.env.example`：配置模板
- `soule.md`：人格存储文件
- `protocol.md`、`weixin-bot-api.md`：协议参考
- `packages/`：相关插件源码
