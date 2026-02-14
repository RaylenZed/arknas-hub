# ArkOS（独立多栈 + 独立环境变量）

默认组件：

- OpenList（网盘聚合）
- Emby（媒体库/播放）
- qBittorrent（下载）
- Dify（AI 应用平台）
- Caddy（统一 HTTPS 入口，Cloudflare DNS 证书）
- Watchtower（自动更新）
- rclone + systemd（把 OpenList 挂载到宿主机）

特点：

- 不依赖 80/443/8080
- 单域名 + 多端口访问
- 每个服务独立目录、独立 `docker-compose.yml`、独立 `.env`

---

## 1. 目录结构

```text
/srv/arkstack
├── gateway/
│   ├── docker-compose.yml
│   ├── .env
│   ├── .env.example
│   ├── Dockerfile.caddy
│   └── Caddyfile
├── openlist/
│   ├── docker-compose.yml
│   ├── .env
│   ├── .env.example
│   └── systemd/
│       ├── rclone-openlist-root.service
│       └── rclone-openlist-drive@.service
├── emby/
│   ├── docker-compose.yml
│   ├── .env
│   └── .env.example
├── qbittorrent/
│   ├── docker-compose.yml
│   ├── .env
│   ├── .env.example
│   └── init/10-reverse-proxy.sh
├── dify/
│   ├── docker-compose.yml
│   ├── .env
│   ├── .env.example
│   ├── nginx/
│   ├── ssrf_proxy/
│   └── certbot/
├── watchtower/
│   ├── docker-compose.yml
│   ├── .env
│   └── .env.example
└── scripts/
    ├── stack.sh
    ├── add-mount.sh
    └── reset-stack.sh
```

---

## 2. 前置要求

- Debian 12/13
- Cloudflare 托管域名（例如 `pve.example.com`）
- 放行你自定义端口（示例：8443/2053/2096/3053）

---

## 3. 安装 Docker 与基础工具

```bash
curl -fsSL https://get.docker.com -o install-docker.sh
sudo sh install-docker.sh
sudo systemctl enable --now docker
sudo docker --version
sudo docker compose version

sudo apt update
sudo apt install -y rclone fuse3 curl
sudo sed -i 's/^#user_allow_other/user_allow_other/' /etc/fuse.conf
```

---

## 4. 初始化项目

```bash
sudo mkdir -p /srv/arkstack
sudo chown -R "$USER:$USER" /srv/arkstack
cd /srv/arkstack
sudo git clone https://github.com/RaylenZed/arkmedia-stack.git .
```

复制每个 stack 的环境变量模板：

```bash
cp gateway/.env.example gateway/.env
cp openlist/.env.example openlist/.env
cp emby/.env.example emby/.env
cp qbittorrent/.env.example qbittorrent/.env
cp dify/.env.example dify/.env
cp watchtower/.env.example watchtower/.env
```

---

## 5. 配置 .env（必须）

### 5.1 `gateway/.env`

- `BASE_DOMAIN`
- `ACME_EMAIL`
- `CF_DNS_API_TOKEN`
- `EMBY_HTTPS_PORT` / `QBIT_HTTPS_PORT` / `OPENLIST_HTTPS_PORT` / `DIFY_HTTPS_PORT`
- `ARK_NETWORK`

### 5.2 `openlist/.env`

- `OPENLIST_UID` / `OPENLIST_GID`
- `OPENLIST_DATA`
- `OPENLIST_LOCAL_PORT`
- `ARK_NETWORK`（必须与 gateway 一致）

### 5.3 `emby/.env`

- `PUID` / `PGID`
- `EMBY_CONFIG`
- `MEDIA_LOCAL_PATH` / `MEDIA_INCOMING_PATH` / `CLOUD_MOUNT_ROOT`
- `EMBY_LOCAL_PORT`
- `ARK_NETWORK`（一致）

### 5.4 `qbittorrent/.env`

- `PUID` / `PGID`
- `QBIT_CONFIG`
- `DOWNLOADS_PATH` / `MEDIA_INCOMING_PATH`
- `QBIT_PEER_PORT` / `QBIT_LOCAL_PORT`
- `BASE_DOMAIN` / `QBIT_HTTPS_PORT`
- `ARK_NETWORK`（一致）

### 5.5 `watchtower/.env`

- `WATCHTOWER_INTERVAL`
- `ARK_NETWORK`（一致）

### 5.6 `dify/.env`

- `BASE_DOMAIN` / `DIFY_HTTPS_PORT`（必须与 `gateway/.env` 对齐）
- `CONSOLE_API_URL` / `CONSOLE_WEB_URL` / `SERVICE_API_URL` / `APP_API_URL` / `APP_WEB_URL` / `FILES_URL`
- `SECRET_KEY`
- `EXPOSE_NGINX_PORT` / `EXPOSE_NGINX_SSL_PORT`（建议仅 127.0.0.1 监听）
- `ARK_NETWORK`（一致）

---

## 6. 初始化目录与权限

### 6.1 一条命令建目录

```bash
sudo mkdir -p \
  /srv/docker/{caddy/data,caddy/config,openlist,emby/config,qbittorrent} \
  /srv/media/{local,incoming} \
  /srv/downloads \
  /srv/cloud \
  /var/cache/rclone
```

### 6.2 权限（按 UID/GID 1000:1000 示例）

```bash
sudo chown -R 1000:1000 /srv/docker/openlist /srv/docker/emby /srv/docker/qbittorrent /srv/downloads /srv/media/incoming
sudo chmod -R u+rwX,g+rwX /srv/docker/openlist /srv/docker/emby /srv/docker/qbittorrent /srv/downloads /srv/media/incoming
sudo chmod 755 /srv /srv/docker /srv/media /srv/cloud /var/cache/rclone
```

说明：Dify 使用官方 compose，数据默认落在 `/srv/arkstack/dify/volumes`（相对 `dify/` 目录）。

---

## 7. 启动与访问

### 7.1 启动全部

```bash
cd /srv/arkstack
sudo ./scripts/stack.sh up
sudo ./scripts/stack.sh ps
```

### 7.2 访问地址（示例）

假设 `BASE_DOMAIN=pve.example.com`：

- Emby: `https://pve.example.com:8443`
- qBittorrent: `https://pve.example.com:2053`
- OpenList: `https://pve.example.com:2096`
- Dify: `https://pve.example.com:3053`

Cloudflare DNS：

- 添加 A 记录：`pve.example.com -> VPS IP`
- 建议先灰云验证

---

## 8. 首次初始化

### 8.1 OpenList

1. 访问 `https://pve.example.com:2096`
2. 创建管理员
3. 添加网盘（夸克/阿里云盘/OneDrive）

### 8.2 Emby

1. 访问 `https://pve.example.com:8443`
2. 创建管理员
3. 添加媒体库路径（多路径可共存）：
- `/media/local/TV`
- `/media/cloud/quark/TV`
- `/media/incoming`

### 8.3 qBittorrent

1. 访问 `https://pve.example.com:2053`
2. 用户名 `admin`
3. 查看临时密码：

```bash
sudo docker compose --env-file /srv/arkstack/qbittorrent/.env -f /srv/arkstack/qbittorrent/docker-compose.yml logs qbittorrent | rg -i "temporary password|administrator password"
```

### 8.4 Dify

1. 访问 `https://pve.example.com:3053`
2. 注册首个管理员账号
3. 进入设置配置模型供应商（OpenAI/火山/硅基流动等）

---

## 9. OpenList + rclone 挂载（多网盘）

### 9.1 配置 rclone

```bash
sudo mkdir -p /etc/rclone
sudo rclone config
```

建议 remote：

- `name = openlist`
- `type = webdav`
- `url = http://127.0.0.1:25244/dav`（如你改了 `openlist/.env` 的 `OPENLIST_LOCAL_PORT`，这里同步改）
- `vendor = other`
- `user/pass = OpenList WebDAV 账号`

保存后：

```bash
sudo install -m 600 -o root -g root /root/.config/rclone/rclone.conf /etc/rclone/rclone.conf
sudo rclone --config /etc/rclone/rclone.conf lsd openlist:
```

### 9.2 单挂载根目录

```bash
cd /srv/arkstack
sudo cp openlist/systemd/rclone-openlist-root.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now rclone-openlist-root
sudo systemctl status rclone-openlist-root
```

### 9.3 多网盘挂载

```bash
sudo mkdir -p /srv/cloud/{quark,alipan,onedrive}
cd /srv/arkstack
sudo cp openlist/systemd/rclone-openlist-drive@.service /etc/systemd/system/
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

## 10. SSD 与多目录媒体

### 10.1 挂载 SSD

```bash
sudo lsblk -f
sudo mkfs.ext4 /dev/nvme1n1p1
sudo mkdir -p /mnt/ssd
sudo mount /dev/nvme1n1p1 /mnt/ssd
sudo blkid /dev/nvme1n1p1
```

写入 `/etc/fstab` 后验证：

```bash
sudo umount /mnt/ssd
sudo mount -a
df -h | grep /mnt/ssd
```

### 10.2 映射给 Emby

可用 `add-mount.sh` 交互添加，或手工写：

`/srv/arkstack/emby/docker-compose.override.yml`

```yaml
services:
  emby:
    volumes:
      - /mnt/ssd/media:/media/ssd:ro
```

重建：

```bash
sudo ./scripts/stack.sh restart emby
```

---

## 11. 运维命令

```bash
# 全栈
sudo ./scripts/stack.sh up
sudo ./scripts/stack.sh down
sudo ./scripts/stack.sh pull
sudo ./scripts/stack.sh ps

# 单栈日志
sudo ./scripts/stack.sh logs gateway
sudo ./scripts/stack.sh logs openlist
sudo ./scripts/stack.sh logs emby
sudo ./scripts/stack.sh logs qbittorrent
sudo ./scripts/stack.sh logs dify

# 单栈重启
sudo ./scripts/stack.sh restart emby
```

---

## 12. 交互脚本

### 12.1 追加挂载

```bash
sudo ./scripts/add-mount.sh
```

会在目标 stack 目录写入 `docker-compose.override.yml`。

### 12.2 一键重置（危险）

```bash
sudo ./scripts/reset-stack.sh
```

---

## 13. 常见问题

### 13.1 OpenList 权限报错

```bash
source /srv/arkstack/openlist/.env
sudo mkdir -p "$OPENLIST_DATA"
sudo chown -R "$OPENLIST_UID:$OPENLIST_GID" "$OPENLIST_DATA"
sudo chmod -R u+rwX,g+rwX "$OPENLIST_DATA"
sudo ./scripts/stack.sh restart openlist
```

### 13.2 qBittorrent 401/无样式

本仓库已内置 `qbittorrent/init/10-reverse-proxy.sh` 自动写入反代兼容配置。

仍异常时：

```bash
sudo ./scripts/stack.sh restart qbittorrent
sudo ./scripts/stack.sh restart gateway
sudo docker compose --env-file /srv/arkstack/qbittorrent/.env -f /srv/arkstack/qbittorrent/docker-compose.yml logs qbittorrent --tail=120
```

---

## 14. 安全建议

- Cloudflare Token 最小权限：`Zone.DNS:Edit` + `Zone:Read`
- OpenList WebDAV 仅本地监听（127.0.0.1）
- 媒体目录尽量只读挂载（`:ro`）
- 公网建议加 Fail2ban/CrowdSec/Cloudflare Access
