# ArkMedia Stack

极简家用媒体栈（Caddy 版）：

- OpenList（外部网盘聚合）
- Jellyfin（媒体库/播放）
- qBittorrent（下载）
- Watchtower（自动更新）
- Caddy + Cloudflare DNS（自动 HTTPS 证书）
- rclone mount（把网盘挂成宿主机目录）

适配场景：不开放 80/443/8080，只用高位端口；同域名不同端口统一访问。

---

## 1. 当前架构

- 统一域名：`pve.example.com`
- 业务入口：
  - Jellyfin：`https://pve.example.com:8443`
  - qBittorrent：`https://pve.example.com:2053`
  - OpenList：`https://pve.example.com:2096`
- 证书：Caddy 通过 Cloudflare DNS-01 自动签发
- 网盘：OpenList 提供 WebDAV，rclone 挂到 `/srv/cloud`

---

## 2. 仓库结构

```text
.
├── .env.example
├── docker-compose.yml
├── Dockerfile.caddy
├── Caddyfile
├── README.md
└── systemd
    ├── rclone-openlist-drive@.service
    └── rclone-openlist-root.service
```

---

## 3. 安装前提（Debian）

命令约定：

- 你是 `root`：直接执行，不要 `sudo`
- 你是普通用户：命令前加 `sudo`

### 3.1 安装 Docker（官方脚本）

```bash
curl -fsSL https://get.docker.com -o install-docker.sh
sh install-docker.sh
systemctl enable --now docker
docker --version
docker compose version
```

### 3.2 安装 rclone / fuse3 / curl

```bash
apt update
apt install -y rclone fuse3 curl
```

开启 FUSE `allow_other`：

```bash
sed -i 's/^#user_allow_other/user_allow_other/' /etc/fuse.conf
```

---

## 4. 初始化部署

### 4.1 放置项目

```bash
cd /srv
mkdir -p arkstack
cd /srv/arkstack
# 将本仓库文件放到这里
```

### 4.2 生成环境变量

```bash
cp .env.example .env
```

最少修改以下字段：

- `BASE_DOMAIN`（例：`pve.example.com`）
- `ACME_EMAIL`
- `CF_DNS_API_TOKEN`

### 4.3 一条命令创建目录

```bash
mkdir -p /srv/docker/{caddy/data,caddy/config,openlist,jellyfin/config,jellyfin/cache,qbittorrent} /srv/media/{local,incoming} /srv/downloads /srv/cloud /var/cache/rclone
```

### 4.4 启动

```bash
docker compose up -d --build
docker compose ps
```

---

## 5. Cloudflare DNS 与端口

### 5.1 DNS

添加一条 A 记录：

- `pve.example.com -> VPS IP`

### 5.2 端口（橙云建议）

Cloudflare 橙云代理支持的常用 HTTPS 端口：

- `443`, `8443`, `2053`, `2083`, `2087`, `2096`

本项目默认端口：

- `8443`（Jellyfin）
- `2053`（qBittorrent）
- `2096`（OpenList）

如果你改用 `9443`、`10443` 这类端口：

- 需要灰云（DNS only）直连。

---

## 6. OpenList 接入夸克

1. 登录 OpenList（`https://pve.example.com:2096`）
2. 添加夸克存储
3. 创建一个 WebDAV 专用账号（建议只读）
4. WebDAV 地址（宿主机本地）：`http://127.0.0.1:25244/dav`

说明：

- OpenList 负责“接入网盘”
- rclone 负责“挂载成宿主机目录”

---

## 7. rclone 配置与挂载

### 7.1 创建 remote

```bash
rclone config
```

建议配置：

- name: `openlist`
- type: `webdav`
- url: `http://127.0.0.1:25244/dav`
- vendor: `other`
- user/password：OpenList WebDAV 账号

验证：

```bash
rclone lsd openlist:
```

### 7.2 单网盘方案（挂根目录）

```bash
cp systemd/rclone-openlist-root.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now rclone-openlist-root
systemctl status rclone-openlist-root
```

挂载后检查：

```bash
ls -lah /srv/cloud
```

### 7.3 多网盘方案（每个网盘一个挂载服务）

创建挂载目录：

```bash
mkdir -p /srv/cloud/{quark,alipan,onedrive}
```

安装模板并启动实例：

```bash
cp systemd/rclone-openlist-drive@.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now rclone-openlist-drive@quark
systemctl enable --now rclone-openlist-drive@alipan
systemctl enable --now rclone-openlist-drive@onedrive
```

检查：

```bash
systemctl status rclone-openlist-drive@quark
systemctl status rclone-openlist-drive@alipan
systemctl status rclone-openlist-drive@onedrive
```

---

## 8. Jellyfin 多来源扫描（网盘 + 本地）

Jellyfin 可以在一个库里添加多个文件夹。例如 TV 库可同时添加：

- `/media/cloud/quark/TV`
- `/media/local/TV`

容器映射已包含：

- `/srv/media/local -> /media/local`
- `/srv/media/incoming -> /media/incoming`
- `/srv/cloud -> /media/cloud`

---

## 9. 附加教程：新增 SSD 挂载并接入 Jellyfin

### 9.1 查看设备

```bash
lsblk -f
```

### 9.2 （可选）新盘格式化 ext4

```bash
mkfs.ext4 /dev/nvme1n1p1
```

### 9.3 挂载测试

```bash
mkdir -p /mnt/ssd
mount /dev/nvme1n1p1 /mnt/ssd
df -h | grep /mnt/ssd
```

### 9.4 开机自动挂载（fstab）

获取 UUID：

```bash
blkid /dev/nvme1n1p1
```

写入 `/etc/fstab`（示例）：

```fstab
UUID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx /mnt/ssd ext4 defaults,nofail 0 2
```

生效验证：

```bash
umount /mnt/ssd
mount -a
df -h | grep /mnt/ssd
```

### 9.5 加入 Jellyfin 扫描

编辑 `docker-compose.yml` 的 `jellyfin.volumes`，追加：

```yaml
- /mnt/ssd/media:/media/ssd:ro
```

重启 Jellyfin：

```bash
docker compose up -d jellyfin
```

然后在 Jellyfin 库中增加路径：

- `/media/cloud/quark/TV`
- `/media/ssd/TV`

---

## 10. 统一入口扩展（后续加 Dify 等）

如果新增服务（比如 Dify），思路是固定的：

1. 在 compose 增加新服务容器
2. 在 `Caddyfile` 新增一段同域名+新端口反代
3. 在 `.env` 增加对应端口变量
4. `docker compose up -d --build`

示例（Dify 网关假设端口 3000）：

```caddy
{$BASE_DOMAIN}:{$DIFY_HTTPS_PORT} {
    reverse_proxy dify:3000
}
```

---

## 11. 常用运维命令

```bash
# 服务状态
docker compose ps

# 日志
docker compose logs -f caddy
docker compose logs -f jellyfin
docker compose logs -f qbittorrent
docker compose logs -f openlist

# 升级镜像
docker compose pull
docker compose up -d

# 检查挂载
mount | grep /srv/cloud

# 查看 Caddy 是否有 cloudflare dns 模块
docker compose exec caddy caddy list-modules | grep cloudflare
```

---

## 12. 安全建议

- `CF_DNS_API_TOKEN` 只给最小权限：`Zone.DNS:Edit` + `Zone:Read`
- `127.0.0.1:25244` 不要改成公网监听
- Jellyfin 网盘路径建议只读挂载
- 公网可叠加：Fail2ban / CrowdSec / Cloudflare Access

