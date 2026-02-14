# ArkMedia Stack

基于 Debian 的家用媒体栈（Caddy 入口版）：

- OpenList（网盘聚合）
- Jellyfin（媒体库/播放）
- qBittorrent（下载）
- Watchtower（自动更新）
- Caddy + Cloudflare DNS-01（自动 HTTPS）
- rclone + systemd（网盘挂载到宿主机目录）

适配目标：

- 不开放 80/443/8080
- 同一域名，不同端口访问不同服务
- 后续可继续加业务（如 Dify）

---

## 1. 架构与访问方式

统一域名示例：`pve.example.com`

默认访问地址：

- Jellyfin: `https://pve.example.com:8443`
- qBittorrent: `https://pve.example.com:2053`
- OpenList: `https://pve.example.com:2096`

说明：

- 证书由 Caddy 通过 Cloudflare DNS API 自动签发与续期。
- 本文默认你是普通用户，命令按 `sudo` 写（`cd` 不需要 `sudo`）。

---

## 2. 项目结构

```text
.
├── .env.example
├── docker-compose.yml
├── Dockerfile.caddy
├── Caddyfile
├── README.md
├── scripts
│   └── add-mount.sh
└── systemd
    ├── rclone-openlist-root.service
    └── rclone-openlist-drive@.service
```

---

## 3. 前置要求

- Debian 12/13
- Cloudflare 托管域名
- 公网放行你自定义的 HTTPS 端口（示例：8443/2053/2096）

---

## 4. 快速部署（推荐）

### 4.1 安装 Docker

```bash
curl -fsSL https://get.docker.com -o install-docker.sh
sudo sh install-docker.sh
sudo systemctl enable --now docker
sudo docker --version
sudo docker compose version
```

### 4.2 安装 rclone/fuse

```bash
sudo apt update
sudo apt install -y rclone fuse3 curl
sudo sed -i 's/^#user_allow_other/user_allow_other/' /etc/fuse.conf
```

### 4.3 拉取项目并准备 `.env`

```bash
sudo mkdir -p /srv/arkstack
sudo chown -R "$USER:$USER" /srv/arkstack
cd /srv/arkstack
# git clone 后进入目录
cp .env.example .env
```

至少修改以下变量：

- `BASE_DOMAIN=pve.example.com`
- `ACME_EMAIL=you@example.com`
- `CF_DNS_API_TOKEN=...`
- `PUID/PGID`（qB 等容器目录权限）
- `OPENLIST_UID/OPENLIST_GID`（OpenList 运行用户，建议与 `PUID/PGID` 一致）

### 4.4 手动初始化目录与权限

```bash
sudo mkdir -p /srv/docker/{caddy/data,caddy/config,openlist,jellyfin/config,jellyfin/cache,qbittorrent} /srv/media/{local,incoming} /srv/downloads /srv/cloud /var/cache/rclone
sudo chown -R 1000:1000 /srv/docker/openlist /srv/docker/qbittorrent
sudo chmod -R u+rwX,g+rwX /srv/docker/openlist /srv/docker/qbittorrent
sudo chmod 755 /srv /srv/docker
```

如果你把 `.env` 里的 `PUID/PGID` 改成其他值，`chown` 也要改成对应 UID/GID。

### 4.5 逐目录权限命令（细化版）

以下命令按默认 UID/GID `1000:1000` 示例，你可替换为自己的值：

```bash
# Caddy
sudo install -d -m 755 -o root -g root /srv/docker/caddy
sudo install -d -m 755 -o root -g root /srv/docker/caddy/data
sudo install -d -m 755 -o root -g root /srv/docker/caddy/config

# OpenList（重点）
sudo install -d -m 775 -o 1000 -g 1000 /srv/docker/openlist
sudo chmod 755 /srv /srv/docker
sudo namei -l /srv/docker/openlist
sudo docker run --rm -u 1000:1000 -v /srv/docker/openlist:/data alpine sh -c 'touch /data/.perm-check && ls -l /data/.perm-check'

# Jellyfin
sudo install -d -m 755 -o root -g root /srv/docker/jellyfin
sudo install -d -m 775 -o 1000 -g 1000 /srv/docker/jellyfin/config
sudo install -d -m 775 -o 1000 -g 1000 /srv/docker/jellyfin/cache

# qBittorrent
sudo install -d -m 775 -o 1000 -g 1000 /srv/docker/qbittorrent
sudo install -d -m 775 -o 1000 -g 1000 /srv/downloads
sudo install -d -m 775 -o 1000 -g 1000 /srv/media/incoming

# 影视库与网盘挂载点
sudo install -d -m 755 -o root -g root /srv/media/local
sudo install -d -m 755 -o root -g root /srv/cloud
sudo install -d -m 755 -o root -g root /var/cache/rclone
```

### 4.6 启动服务

```bash
sudo docker compose up -d --build
sudo docker compose ps
```

---

## 5. Cloudflare DNS 设置

添加 A 记录：

- `pve.example.com -> VPS IP`

提示：

- 先灰云（DNS only）验证。
- 使用橙云时，优先用 Cloudflare 支持的 HTTPS 端口（8443/2053/2096/2083/2087 等）。

---

## 6. 首次初始化

### 6.1 OpenList

- 打开 `https://pve.example.com:2096`
- 创建管理员账号
- 添加网盘（夸克/阿里盘/OneDrive 等）

### 6.2 Jellyfin

- 打开 `https://pve.example.com:8443`
- 创建管理员
- 添加媒体库路径，例如：
  - `/media/local/TV`
  - `/media/cloud/quark/TV`

### 6.3 qBittorrent

- 打开 `https://pve.example.com:2053`
- 用户名：`admin`
- 临时密码查看：

```bash
sudo docker compose logs qbittorrent | rg -i "temporary password|administrator password"
```

登录后建议立即改管理员密码。

---

## 7. OpenList + rclone 挂载网盘

核心分工：

- OpenList：对接云盘
- rclone：把云盘挂载到宿主机目录（如 `/srv/cloud`）

### 7.1 配置 rclone remote

```bash
sudo rclone config
```

建议：

- name: `openlist`
- type: `webdav`
- url: `http://127.0.0.1:25244/dav`
- vendor: `other`
- user/password: OpenList 的 WebDAV 账号

验证：

```bash
sudo rclone lsd openlist:
```

### 7.2 单网盘（挂根目录）

```bash
sudo cp systemd/rclone-openlist-root.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now rclone-openlist-root
sudo systemctl status rclone-openlist-root
```

### 7.3 多网盘（推荐）

```bash
sudo mkdir -p /srv/cloud/{quark,alipan,onedrive}
sudo cp systemd/rclone-openlist-drive@.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now rclone-openlist-drive@quark
sudo systemctl enable --now rclone-openlist-drive@alipan
sudo systemctl enable --now rclone-openlist-drive@onedrive
```

验证：

```bash
sudo systemctl status rclone-openlist-drive@quark
sudo systemctl status rclone-openlist-drive@alipan
sudo systemctl status rclone-openlist-drive@onedrive
ls -lah /srv/cloud
```

---

## 8. 存储与权限模型

### 8.1 新增 SSD 并挂载

```bash
sudo lsblk -f
sudo mkfs.ext4 /dev/nvme1n1p1
sudo mkdir -p /mnt/ssd
sudo mount /dev/nvme1n1p1 /mnt/ssd
sudo blkid /dev/nvme1n1p1
```

把 UUID 写入 `/etc/fstab` 后验证：

```bash
sudo umount /mnt/ssd
sudo mount -a
df -h | grep /mnt/ssd
```

### 8.2 Jellyfin 同时扫描多个来源

可在同一个库里加入多个路径：

- `/media/local/TV`
- `/media/cloud/quark/TV`
- `/media/ssd/TV`

如果要增加 SSD 映射，在 `jellyfin.volumes` 追加：

```yaml
- /mnt/ssd/media:/media/ssd:ro
```

然后重启 Jellyfin：

```bash
sudo docker compose up -d jellyfin
```

### 8.3 同目录给多个容器

支持，且推荐“写入方 rw、读取方 ro”：

```yaml
qbittorrent:
  volumes:
    - /srv/media/incoming:/media/incoming

jellyfin:
  volumes:
    - /srv/media/incoming:/media/incoming:ro
```

### 8.4 网盘写入策略

支持写入网盘挂载目录，但推荐：

- qB 先下载到本地盘 `/srv/downloads`
- 再用 `rclone move/copy` 推送网盘

示例：

```bash
sudo rclone move /srv/downloads openlist:/quark/downloads --progress --transfers 4 --checkers 8
```

如果你坚持“容器直接写网盘”，可把 `/srv/cloud/<drive>` 以 `rw` 挂给目标容器。

---

## 9. 常见故障

### 9.1 OpenList 启动失败：`/opt/openlist/data` 权限错误

```bash
cd /srv/arkstack
OPENLIST_DATA=$(awk -F= '/^OPENLIST_DATA=/{print $2}' .env)
sudo mkdir -p "$OPENLIST_DATA"
sudo chown -R 1000:1000 "$OPENLIST_DATA"
sudo chmod -R u+rwX,g+rwX "$OPENLIST_DATA"
sudo docker compose up -d --force-recreate openlist
```

并确认 `docker-compose.yml` 是：

```yaml
- ${OPENLIST_DATA}:/opt/openlist/data
```

### 9.2 qBittorrent `Unauthorized`（反代场景）

手动写入反代兼容配置（关闭 HostHeader/CSRF 严格校验，开启反代支持）：

```bash
cd /srv/arkstack
QBIT_CONFIG=$(awk -F= '/^QBIT_CONFIG=/{print $2}' .env)
sudo mkdir -p "$QBIT_CONFIG/qBittorrent"
sudo touch "$QBIT_CONFIG/qBittorrent/qBittorrent.conf"
sudo tee -a "$QBIT_CONFIG/qBittorrent/qBittorrent.conf" >/dev/null <<'EOF'

WebUI\ReverseProxySupportEnabled=true
WebUI\HostHeaderValidation=false
WebUI\CSRFProtection=false
EOF
sudo chown -R 1000:1000 "$QBIT_CONFIG"
sudo chmod -R u+rwX,g+rwX "$QBIT_CONFIG"
sudo docker compose up -d --force-recreate qbittorrent caddy
```

再查看临时密码并用无痕窗口登录：

```bash
sudo docker compose logs qbittorrent | rg -i "temporary password|administrator password"
```

如果登录页静态资源也返回 401（表现为“无样式登录页”），继续执行：

```bash
cd /srv/arkstack
sudo docker compose logs --tail=200 qbittorrent | rg -i "origin|referer|host header|csrf|unauthorized" || true
```

然后确认 `Caddyfile` 的 qB 段包含以下关键项：

```caddy
{$BASE_DOMAIN}:{$QBIT_HTTPS_PORT} {
    reverse_proxy qbittorrent:8080 {
        header_up Host qbittorrent:8080
        header_up X-Forwarded-Host {http.request.header.Host}
        header_up X-Forwarded-Proto https
        header_up -Origin
        header_up -Referer
    }
}
```

应用配置后重建：

```bash
cd /srv/arkstack
sudo docker compose up -d --force-recreate qbittorrent caddy
```

再用无痕窗口访问并登录，避免旧 cookie 影响。

### 9.3 Watchtower 报 Docker API 版本过旧

本项目默认已加：

```yaml
environment:
  - DOCKER_API_VERSION=1.44
```

若仍异常：

```bash
sudo docker compose up -d --force-recreate watchtower
```

### 9.4 OpenList 502（Caddy 日志 no such host）

如果 Caddy 日志出现 `lookup openlist ... no such host`，说明 OpenList 容器没有正常运行（通常是前面的权限错误）。

按顺序执行：

```bash
cd /srv/arkstack
OPENLIST_DATA=$(awk -F= '/^OPENLIST_DATA=/{print $2}' .env)
sudo install -d -m 775 -o 1000 -g 1000 "$OPENLIST_DATA"
sudo docker compose up -d --force-recreate openlist
sudo docker compose ps
sudo docker compose logs --tail=120 openlist
```

OpenList 正常后，`https://<domain>:<OPENLIST_HTTPS_PORT>` 的 502 会消失。

---

## 10. 交互式新增挂载脚本

你可以用下面脚本为指定容器新增挂载目录（不会直接改主 `docker-compose.yml`，而是写入 `docker-compose.override.yml`）：

```bash
cd /srv/arkstack
chmod +x scripts/add-mount.sh
sudo ./scripts/add-mount.sh
```

脚本流程：

1. 列出当前 compose 服务并让你选择
2. 输入宿主机路径和容器内路径
3. 选择 `rw/ro`
4. 自动创建目录并设置权限（默认只处理目录本身，不递归）
5. 写入 `docker-compose.override.yml`
6. 重建你选择的容器

数据影响说明：

- 不会删除宿主机已有数据
- 但如果你把挂载目标设为容器内已有文件目录，该目录原内容会被“覆盖隐藏”（不是删除）
- OpenList 禁止挂到 `/opt/openlist/data` 下方，避免再次触发启动权限检查失败

---

## 11. 媒体服务选择（Jellyfin / Emby）

- Jellyfin：开源免费、无授权限制，适合你当前目标。
- Emby：基础可用，高级能力通常需要 Premiere（付费）。

如果你未来要改成 Emby，最小改动是替换 `jellyfin` 服务镜像和端口，并保留现有挂载目录结构。

---

## 12. 运维命令

```bash
# 状态
sudo docker compose ps

# 日志
sudo docker compose logs -f caddy
sudo docker compose logs -f openlist
sudo docker compose logs -f jellyfin
sudo docker compose logs -f qbittorrent
sudo docker compose logs -f watchtower

# 重启单服务
sudo docker compose up -d --force-recreate openlist

# 更新镜像
sudo docker compose pull
sudo docker compose up -d

# 验证 Caddy cloudflare 模块
sudo docker compose exec caddy caddy list-modules | rg cloudflare
```

---

## 13. 重新部署

### 保留数据重装

```bash
cd /srv/arkstack
sudo docker compose down --remove-orphans
sudo docker compose pull
sudo docker compose up -d --build
```

### 全量清空重装（危险）

```bash
cd /srv/arkstack
sudo docker compose down -v --remove-orphans
sudo rm -rf /srv/docker/caddy /srv/docker/openlist /srv/docker/jellyfin /srv/docker/qbittorrent
```

---

## 14. 安全建议

- `CF_DNS_API_TOKEN` 最小权限：`Zone.DNS:Edit` + `Zone:Read`
- OpenList WebDAV 仅本地监听（`127.0.0.1:25244`）
- 媒体库目录优先只读挂载（`:ro`）
- 公网部署建议叠加 Fail2ban / CrowdSec / Cloudflare Access
