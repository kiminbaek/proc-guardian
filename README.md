# proc-guardian

> 飞牛 fnOS 应用 —— 进程 / 端口 / 资源管理小工具
> 专注：找占用、杀残留、看流量

## 简介

proc-guardian 是一个**轻量级**的 fnOS 应用管理工具，帮助你：

- **快速查找** 哪个进程占用了某个端口（解决「端口被占用」死锁）
- **一键结束** 残留 / 半死进程（按用户名 / 命令名 / PID）
- **配置白名单** 保护关键进程（systemd / sshd / fnOS 系统服务等）不被误杀
- **流量监控** 实时看进程的网络连接（基于 /proc/net/tcp）
- **Web UI 访问** 端口 8877，桌面图标一键直达

适合：折腾 NAS 的开发者 / 装了大量第三方应用的用户 / 经常遇到「端口冲突」的人。

## 功能

### 1. 进程列表
- 按 PID / 用户 / 命令名 / CPU / 内存 / 启动时间排序
- 实时刷新（默认 5s）
- 关键字过滤

### 2. 端口查找
- 输入端口号 → 列出占用该端口的进程（PID + 命令名 + 用户）
- 一键结束占用进程（**白名单内的进程会拒绝**，弹出确认）

### 3. 进程管理
- 选中进程 → SIGTERM（15） / SIGKILL（9） / 暂停 / 继续
- **白名单配置**（`/vol3/@appdata/proc-guardian/whitelist.json`）：
  ```json
  {
    "users": ["sshd", "root", "fnos"],
    "commands": ["systemd", "sshd", "trim_app_center"]
  }
  ```
- 白名单内的用户 / 命令**禁止杀**（API 直接返 403）

### 4. 网络流量
- 读 `/proc/net/tcp` + `/proc/net/tcp6` 实时显示连接
- 按状态（ESTABLISHED / LISTEN / TIME_WAIT）过滤
- 显示本地 / 远端 IP + 端口 + 进程映射

## 安装

1. 下载 `proc-guardian.vX.X.X.fpk`（GitHub Release）
2. fnOS 应用中心 → 右上角「手动安装」→ 选择 fpk
3. 应用中心 → 找到「进程管理」→ 启用
4. 桌面图标「进程管理」点击 → 浏览器打开 `http://NAS_IP:8877`

> 端口 8877（**不撞** trim_app_center 2087 / xray-proxy-native 2087）

## 升级

- **in-place 升级**（v1.0.2 → v1.0.4）：应用中心 → 进程管理 → 更新
- **数据保留**：`/vol3/@appdata/proc-guardian/` 下的 `whitelist.json` / `history.ndjson` / `info.log` **不会丢**
- **回滚**：v1.0.0~v1.0.3 在应用中心「回滚」按钮（v1.0.4 起会显示）

## 卸载

应用中心 → 进程管理 → 卸载

**自动清理**：
- ✅ 杀所有 `proc_guardian` 用户进程
- ✅ 删 `/vol3/@appdata/proc-guardian/` 数据目录
- ✅ 释放 8877 端口
- ✅ 同步 `appcenter` 数据库 `status='stop'`

## 关键版本

| 版本 | 关键变化 |
|:-----|:---------|
| **v1.0.4** | **修复 fnOS 启用应用前「端口被占用」死锁** —— `cmd/main` 加 `status` case（fnOS 启用前必先调 `main status` 检查）|
| v1.0.3 | 杀进程时自动 sync appcenter DB status（治本修复）|
| v1.0.2 | install/upgrade 钩子自动清老进程残留 |
| v1.0.1 | Web UI 端口检查 + 进程列表分页 |
| v1.0.0 | 首个发布版本 |

## 配置

| 路径 | 说明 |
|:-----|:-----|
| `/vol3/@appdata/proc-guardian/whitelist.json` | 进程白名单（用户 / 命令名）|
| `/vol3/@appdata/proc-guardian/history.ndjson` | 操作历史（杀进程 / 找端口）|
| `/vol3/@appdata/proc-guardian/info.log` | 应用 info 日志 |
| `/var/apps/proc-guardian/cmd/main` | 启动 / 停止 / 状态脚本（**注意是 `/var/apps/`，不是 `@appcenter/...`）** |

## 开发者

- **作者**：黄元亮（元亮 / QQ 昵称 小米虾）
- **fnOS 应用开发文档**：[`fnnas_dev_notes.md`](../blob/main/../)（同组织其他仓库）
- **Bug 反馈**：GitHub Issues
- **License**：MIT

## 致谢

- fnOS 应用中心开发组 —— 提供 `appcenter-cli` + 完整 manifest 规范
- 飞牛社区 —— 真实生产环境测试 + 死锁案例反馈
- xray-proxy-native 项目 —— **沙箱 / 打包 / 发版** 经验参考
