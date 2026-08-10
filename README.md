# 飞书自动刷新控制台正式版

Google Sheet“飞书自动刷新控制台”是唯一控制台。每一行对应一个飞书 Base；Playwright 不包含固定 Base 链接、固定业务时间或固定表名。

## 控制表

工作表名：`同步配置`，时区：`Asia/Shanghai`。

| 列 | 含义 |
| --- | --- |
| A | 飞书 Base 链接 |
| B | `工作日 HH:mm` 或 `每天 HH:mm` |
| C | 立即同步 checkbox |
| D | `待命`、`等待触发`、`等待轮询`、`同步中`、`成功`、`失败` |
| E | Asia/Shanghai 完成时间 |
| F | 实际同步时长 |

定时 workflow 每 5 分钟执行一次轻量检查。没有到期任务时只运行 Node 控制客户端，不执行 `npm ci`、不安装 Chromium、不启动 Playwright。调度允许 10 分钟窗口，用于吸收 GitHub Actions 排队延迟；同一行每天只会自动领取一次。

## 飞书同步行为

`sync-feishu.js` 打开 A 列 Base，动态遍历左侧数据表并逐个打开菜单。只有菜单里真实可见“同步数据”的连接器表才会被同步，普通表跳过。每张连接器表等待真实完成后才处理下一张；单表失败会记录并继续剩余表。

关键成功日志：

```text
BASE=<base url>
TABLE_FOUND=<真实表名>
TABLE_SYNC_START=<真实表名>
TABLE_SYNC_SUCCESS=<真实表名>
TOTAL_SYNCABLE_TABLES=8
SUCCESS=8
FAILED=0
BASE_SYNC_SUCCESS
```

认证继续使用仓库已有 `feishu-auth.enc`、GitHub Secret `FEISHU_AUTH_KEY` 和 Playwright 1.54.2。workflow 解密到 `playwright/.auth/feishu.json`，结束时始终删除明文文件。

## 一次性部署 Google Apps Script

1. 打开控制表，进入“扩展程序 → Apps Script”。
2. 将 `apps-script/Code.gs` 内容放入脚本项目。
3. 在 Script Properties 设置 `CONTROL_API_SECRET`。真正即时触发 C 列时，再设置仅对本仓库 Actions 有写权限的 `GITHUB_TOKEN`；仓库名和 workflow 已有安全默认值，无需额外配置。
4. 手工运行一次 `initializeControlSheet`，确认授权。它只设置标题、checkbox 和时区，不删除 A/B 数据。
5. 手工运行一次 `installOnEditTrigger`，创建可调用 GitHub API 的安装型 onEdit trigger。
6. 部署为 Web app：以本人身份执行，允许 GitHub Actions 访问。Sheet 本身无需公开；API 仍要求共享 Secret。
7. 复制部署 URL。代码更新后需部署新版本，并保持 GitHub Secret URL 指向当��部署。

这是必须由 Google 账号本人完成的授权步骤：`NEED_GOOGLE_APPS_SCRIPT_DEPLOY`。

## GitHub Secrets

仓库 Settings → Secrets and variables → Actions：

- `FEISHU_AUTH_KEY`：保留现有值。
- `CONTROL_API_URL`：Apps Script Web app 部署 URL。
- `CONTROL_API_SECRET`：必须与 Script Properties 同值。

若要求勾选 C 后真正即时触发，还需创建 GitHub fine-grained token 并仅存入 Apps Script 的 `GITHUB_TOKEN` 属性：`NEED_GITHUB_TRIGGER_AUTH`。

没有 `GITHUB_TOKEN` 时不会伪称即时：C 列状态显示“等待轮询”，任务在下一次 5 分钟轮询时领取。完成或失败后，C 自动取消，D/E/F 自动写回。

## 手工测试

`workflow_dispatch` 保留。默认 `mode=all`，用于测试所有配置行；`mode=due` 只领取已到期或 C 已勾选的行；`mode=row` 供 Apps Script 精确触发某行。

本地静态测试：

```bash
npm ci
npm test
node --check sync-feishu.js
node --check control-client.js
```

不要在没有真实授权文件的环境运行浏览器同步测试。现有云端 `BASE_SYNC_SUCCESS` 认证链路不需要重新设计或重新登录。

## 安全边界

禁止提交 `FEISHU_AUTH_KEY.txt`、解密后的 `playwright/.auth/feishu.json`、Cookie、Token、storageState、Apps Script Secret 或 GitHub Token。控制表保持私有。不绕过飞书 SSO，不 force push。
