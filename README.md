# 方舟 NAS 中控台（ArkNAS Hub）

一个基于 Debian + Docker 的自建 NAS 统一管理入口，聚合容器、影视、下载与系统状态，目标是实现类似 NAS 商业系统首页的体验，但保持完全可控、可审计、可长期维护。

## 项目定位
- 不做操作系统发行版
- 做一套可独立部署的 Docker 化 Web 管理系统
- 面向家庭/个人服务器场景，优先安全与可维护

## 当前结论
- 你列出的核心需求都可实现
- 你补充的能力也可实现
- Cloudflare DNS 自动签发/续期 SSL
- 统一 SSL 管理面板（给后续新增业务复用）
- 非 80/443/8080 端口公网访问
- 公网访问安全基线（最小权限、鉴权、审计、防暴露）

## 核心功能范围（MVP）
- Dashboard 总览
- 容器总数、运行/异常/停止统计
- CPU/内存/磁盘/网络实时状态
- Jellyfin 播放状态与最近新增
- qBittorrent 下载状态与最近完成
- 容器管理
- 容器列表、状态、端口映射
- 启动/停止/重启
- 最近日志查看
- 手动更新（拉镜像并重建）
- 影视管理（Jellyfin API）
- 继续观看、最近添加、活跃会话
- 一键跳转播放页
- 媒体库刷新
- 下载管理（qBittorrent API）
- 任务列表、速度、进度、ETA
- 暂停/继续/删除
- 添加磁力与种子文件
- 统一入口与 SSL 管理
- 单入口反向代理
- Cloudflare DNS Challenge 证书签发/续期
- 证书生命周期管理面板

## 安全设计（重点）
- 不直接暴露 Docker Socket 到公网（使用 socket proxy）
- 默认仅开放一个公网高位端口（例如 `24443`）
- 管理面板建议仅内网/VPN访问，公网时加二次认证
- Cloudflare API Token 最小权限（仅 DNS 必需权限）
- 关键操作审计日志（登录、容器控制、删除任务、证书操作）

## 部署形态
本项目以 Docker Compose 形式交付和运维，不依赖定制 Linux 发行版。

示例运行：

```bash
cp .env.example .env
make up
```

示例升级：

```bash
make restart
```

本地访问：
- Web：`http://localhost:20080`
- API 健康检查：`http://localhost:20080/api/health`

## 目录结构
```text
.
├── apps
│   ├── api
│   └── web
├── docs
│   ├── planning
│   └── process
├── infra
│   └── docker-compose.yml
└── README.md
```

## 文档
- 需求说明：`docs/planning/SRS.zh-CN.md`
- 产品 PRD：`docs/planning/PRD.zh-CN.md`
- 公网部署与安全方案：`docs/planning/Deployment-Security.zh-CN.md`
- TODO 清单：`docs/process/TODO.md`
- 一致性规范：`docs/process/DEVELOPMENT-WORKFLOW.md`

## 里程碑（建议）
- M1：项目骨架、登录、全局布局、Docker 只读打通
- M2：容器控制闭环 + Dashboard 资源图表
- M3：qBittorrent + Jellyfin 聚合闭环
- M4：统一入口、SSL 面板、审计与上线

## 非目标
- RAID 管理
- 企业级复杂权限系统
- 完整复刻商业 NAS 操作系统全部功能

## License
建议后续补充（例如 MIT / Apache-2.0）。
