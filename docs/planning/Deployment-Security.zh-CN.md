# 部署与管理方案（公网安全版）

## 1. 结论先行
- 可以一次性实现：以 Docker Compose 方式一次部署完整栈。
- 推荐形态：`统一入口反代 + SSL 管理面板 + 业务聚合 API + 前端仪表盘`。
- 证书方式：Cloudflare DNS Challenge（不依赖 80 端口）。

## 2. 部署形式（你最关心）
采用单仓库、多服务 Docker Compose 形态：

```text
nas-dashboard/
  docker-compose.yml
  .env
  secrets/
  data/
    sqlite/
    ssl/
    proxy/
  apps/
    web/
    api/
```

运行方式：
- 首次安装：`docker compose pull && docker compose up -d`
- 日常管理：`docker compose ps / logs / restart`
- 升级：`docker compose pull && docker compose up -d --remove-orphans`

## 3. 网络与端口策略（符合你约束）
你要求不开放 `80/443/8080`，建议如下：

- 对公网仅开放一个高位 HTTPS 端口，例如：`24443`
- 管理后台端口不对公网开放，只允许内网或 VPN 访问
- 内部服务端口不映射到宿主机，仅在 Docker 内网通信

示例端口：
- 公网入口：`24443 -> reverse-proxy:443`
- 面板管理：仅绑定 `127.0.0.1:20081 -> ssl-panel:81`（通过 SSH 隧道/VPN 访问）

## 4. SSL 管理面板设计
目标：后续你新增业务时，都在同一处管理证书。

面板能力：
- 证书申请（Cloudflare DNS）
- 自动续期与到期提醒
- 手动续期/吊销
- 证书绑定站点（服务路由）
- 证书导入（自有证书）

安全要求：
- Cloudflare API Token 最小权限（仅 Zone DNS Edit + Zone Read）
- Token 用 Docker Secret 挂载，不写死在 compose
- 面板必须加登录，建议再叠加 2FA

## 5. 一次性实现的交付范围（建议）
一次性上线版本包含：
- Dashboard（容器、影视、下载、系统资源）
- 容器管理（启停/重启/日志/更新）
- 下载管理（任务增删改查）
- Jellyfin 聚合（继续观看/最近添加/会话/刷新）
- SSL 管理面板（Cloudflare DNS）
- 统一入口反代（高位端口）
- 基础安全（鉴权、审计、限流、socket-proxy）

## 6. 运维管理方式
### 6.1 配置管理
- `.env`：非敏感配置
- `secrets/`：敏感信息（API Token、JWT 密钥、数据库密钥）
- 配置变更需版本化（Git）

### 6.2 日志管理
- API、反代、关键操作日志分离
- 关键审计日志持久化（登录、容器操作、删除任务、证书操作）

### 6.3 备份恢复
- 备份目录：
- `data/sqlite/`
- `data/proxy/`
- `data/ssl/`
- 每日自动备份 + 异地副本（可后续接入）

### 6.4 安全基线
- 默认拒绝公网访问管理面板
- 只暴露统一入口
- 限流 + 失败登录封禁（Fail2ban/CrowdSec）
- 每周镜像漏洞扫描与依赖更新窗口

## 7. 关于“完整复刻飞牛OS”
建议目标从“1:1 完整复刻”调整为“核心能力超越”：
- 你当前核心场景（Docker/影视/下载）可完整覆盖
- fnOS 的存储阵列、硬件深度管理、生态应用中心不是当前必要项
- 更高优先是：稳定性、安全性、可维护性

## 8. 推荐分层架构
- L1 入口层：Reverse Proxy + SSL Panel
- L2 安全层：Auth Gateway + Rate Limit + Audit
- L3 业务层：Dashboard API + Web UI
- L4 基础服务层：Docker/Jellyfin/qBittorrent 适配器

## 9. 上线前清单（必须）
- 关闭 Docker Socket 直接暴露
- Cloudflare Token 改为最小权限
- 所有默认密码改掉
- 禁止弱密码
- 管理端口仅内网可达
- 漏洞扫描通过后上线

