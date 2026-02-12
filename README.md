# ArkMedia Stack

一个专注家庭影音的极简生产方案：

- OpenList（外部网盘聚合）
- Jellyfin（媒体库与播放）
- qBittorrent（下载）
- Watchtower（自动更新）
- Traefik + Cloudflare DNS（HTTPS 自动证书）
- rclone mount（把网盘挂载成宿主机目录）

适配你的实际场景：不开放 80/443/8080，只使用高位端口（默认 8443/2053/2096）。

---

## 1. 项目定位

这个仓库不再是完整 NAS 面板开发项目，而是可直接落地的一键部署方案。

推荐使用路径：

- 项目目录：`/srv/arkstack`
- 本地媒体：`/srv/media/local`
- 下载目录：`/srv/downloads`
- 网盘挂载根：`/srv/cloud`

---

## 2. 目录结构

```text
.
├── .env.example
├── docker-compose.yml
├── README.md
└── systemd
    ├── rclone-openlist-drive@.service
    └── rclone-openlist-root.service
```

---

## 3. 先决条件（Debian）

命令约定：

- 如果你是 `root`，直接执行命令（不要 `sudo`）。
- 如果你是普通用户，把文档里的命令前加 `sudo`。

### 3.1 安装 Docker（官方脚本，推荐）

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

启用 FUSE 的 `allow_other`：

```bash
sed -i 's/^#user_allow_other/user_allow_other/' /etc/fuse.conf
```

---

## 4. 初始化部署

```bash
cd /srv
mkdir -p arkstack
cd /srv/arkstack
# 将本仓库内容放到这里
```

复制环境变量模板：

```bash
cp .env.example .env
```

按需修改 `.env`：

- `BASE_DOMAIN`
- `ACME_EMAIL`
- `CF_DNS_API_TOKEN`
- `JELLYFIN_HTTPS_PORT / QBIT_HTTPS_PORT / OPENLIST_HTTPS_PORT`
- 路径变量（默认值可直接用）

创建宿主机目录：

```bash
mkdir -p /srv/docker/{traefik,openlist,jellyfin/config,jellyfin/cache,qbittorrent} /srv/media/{local,incoming} /srv/downloads /srv/cloud /var/cache/rclone && touch /srv/docker/traefik/acme.json && chmod 600 /srv/docker/traefik/acme.json
```

启动：

```bash
docker compose up -d
docker compose ps
```

---

## 5. 域名与 HTTPS（Cloudflare）

在 Cloudflare DNS 中添加一个 A 记录到 VPS：

- `<BASE_DOMAIN>` -> VPS IP

访问地址（同域名、不同端口）：

- Jellyfin: `https://pve.example.com:8443`
- qBittorrent: `https://pve.example.com:2053`
- OpenList: `https://pve.example.com:2096`

说明：

- 证书通过 DNS-01 签发，不依赖 80/443 入站。
- 你只需开放 `JELLYFIN_HTTPS_PORT / QBIT_HTTPS_PORT / OPENLIST_HTTPS_PORT` 和 qB BT 端口（默认 16881 TCP/UDP）。
- 若 Cloudflare 使用橙云代理，请确认端口在 Cloudflare 支持列表内；否则使用灰云直连。

### 5.1 Cloudflare 橙云端口建议（重点）

同域名不同端口是可行的，但如果 DNS 记录开了橙云代理，端口必须用 Cloudflare 支持的端口。

- 推荐默认组合：
- Jellyfin: `8443`
- qBittorrent: `2053`
- OpenList: `2096`

Cloudflare 橙云常用可代理 HTTPS 端口：

- `443`, `8443`, `2053`, `2083`, `2087`, `2096`

Cloudflare 橙云常用可代理 HTTP 端口：

- `80`, `8080`, `8880`, `2052`, `2082`, `2086`, `2095`

如果你一定要用 `9443`、`10443` 之类端口：

- 需要把 DNS 记录改成灰云（DNS only）直连，不能走橙云代理。

---

## 6. OpenList 与夸克接入

1. 登录 OpenList。
2. 添加存储：选择夸克驱动，按驱动文档填写参数。
3. 创建一个专用账号用于 WebDAV（建议只读）。
4. 确认 WebDAV 地址：`http://127.0.0.1:25244/dav`（宿主机本地访问）。

> OpenList 负责“接入夸克等网盘”；
> rclone 负责“把 OpenList WebDAV 挂成本地目录”。

---

## 7. rclone 配置

进入交互配置：

```bash
rclone config
```

新建 remote（建议名 `openlist`）：

- `Storage` 选 `webdav`
- `url` 填 `http://127.0.0.1:25244/dav`
- `vendor` 选 `other`
- 用户名/密码填 OpenList WebDAV 账号

验证：

```bash
rclone lsd openlist:
```

---

## 8. 单网盘挂载方案（最简单）

把 OpenList 根目录整体挂到 `/srv/cloud`：

```bash
cp systemd/rclone-openlist-root.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now rclone-openlist-root
systemctl status rclone-openlist-root
```

验证：

```bash
ls -lah /srv/cloud
```

Jellyfin 里配置媒体库目录：

- `/media/cloud/<你的网盘目录>/Movies`
- `/media/cloud/<你的网盘目录>/TV`

---

## 9. 多网盘挂载方案（推荐生产）

适合场景：夸克、阿里云盘、115、OneDrive 等分开管理，互不影响。

先创建目标目录（举例）：

```bash
mkdir -p /srv/cloud/{quark,alipan,onedrive}
```

安装模板服务：

```bash
cp systemd/rclone-openlist-drive@.service /etc/systemd/system/
systemctl daemon-reload
```

为每个网盘启动一个实例（实例名就是 OpenList 里的路径名）：

```bash
systemctl enable --now rclone-openlist-drive@quark
systemctl enable --now rclone-openlist-drive@alipan
systemctl enable --now rclone-openlist-drive@onedrive
```

查看状态：

```bash
systemctl status rclone-openlist-drive@quark
systemctl status rclone-openlist-drive@alipan
systemctl status rclone-openlist-drive@onedrive
```

停止某一个：

```bash
systemctl disable --now rclone-openlist-drive@onedrive
```

Jellyfin 建议按挂载点分别建库：

- `/media/cloud/quark`
- `/media/cloud/alipan`
- `/media/cloud/onedrive`

---

## 10. qBittorrent 与 Jellyfin 联动建议

- qB 下载目录：`/downloads`
- 媒体整理目录：`/media/incoming`
- Jellyfin 同时扫描：
  - `/media/local`
  - `/media/incoming`
  - `/media/cloud`

建议再配一个小脚本做下载完成后整理（可选）。

---

## 11. 常用运维命令

```bash
# 查看服务
docker compose ps

# 看日志
docker compose logs -f openlist
docker compose logs -f jellyfin
docker compose logs -f qbittorrent

docker compose logs -f traefik

# 更新镜像并重建
docker compose pull
docker compose up -d

# 查看挂载是否还在
mount | grep /srv/cloud
```

---

## 12. 安全建议（必须）

- Cloudflare Token 仅授予必要 DNS 权限。
- OpenList WebDAV 账号最小权限（只读优先）。
- `25244` 只监听 `127.0.0.1`，不要暴露公网。
- Jellyfin 的 `/media/cloud` 建议只读挂载。
- 公网建议叠加：Fail2ban / WAF / Cloudflare Access（可选）。

---

## 13. 故障排查

### 13.1 证书签发失败

检查：

- `CF_DNS_API_TOKEN` 是否有效
- DNS 记录是否指向 VPS
- `acme.json` 权限是否 `600`

看日志：

```bash
docker compose logs -f traefik
```

### 13.2 rclone 看不到目录

检查：

```bash
rclone lsd openlist:
systemctl status rclone-openlist-root
journalctl -u rclone-openlist-root -f
```

### 13.3 Jellyfin 看不到网盘媒体

检查：

- `/srv/cloud` 是否有文件
- `docker compose exec jellyfin ls -lah /media/cloud`
- Jellyfin 媒体库路径是否正确

---

## 14. 版本识别（你要求的“好判断”）

这个版本的特征：

- `.env.example` 不包含 `ADMIN_USERNAME / ADMIN_PASSWORD`
- 也不包含 `SEED_ADMIN_FROM_ENV`
- 仓库只保留“媒体栈部署文件”，不再包含旧的 NAS 面板源码

---

## 15. 附加教程：新增 SSD 挂载并接入 Jellyfin（多来源同类资源）

适用场景：

- 你新增一块 SSD，想把它作为本地媒体盘。
- 同时保留网盘内容，Jellyfin 统一展示。
- 例如同时存在：
  - 网盘：`/media/cloud/quark/TV`
  - SSD：`/media/ssd/TV`

### 15.1 查看新盘与文件系统

```bash
lsblk -f
```

记下你的设备名与 UUID（示例设备：`/dev/nvme1n1p1`）。

### 15.2 （可选）格式化为 ext4

仅在新盘无数据时执行：

```bash
mkfs.ext4 /dev/nvme1n1p1
```

### 15.3 挂载并测试

```bash
mkdir -p /mnt/ssd
mount /dev/nvme1n1p1 /mnt/ssd
df -h | grep /mnt/ssd
```

### 15.4 写入 fstab（开机自动挂载）

先获取 UUID：

```bash
blkid /dev/nvme1n1p1
```

编辑 `/etc/fstab` 增加一行（将 UUID 替换为实际值）：

```fstab
UUID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx /mnt/ssd ext4 defaults,nofail 0 2
```

应用并验证：

```bash
umount /mnt/ssd
mount -a
df -h | grep /mnt/ssd
```

### 15.5 给 Jellyfin 增加 SSD 映射

编辑 `docker-compose.yml` 中 `jellyfin` 的 `volumes`，追加：

```yaml
- /mnt/ssd/media:/media/ssd:ro
```

重建 Jellyfin：

```bash
docker compose up -d jellyfin
```

### 15.6 在 Jellyfin 里配置“同一媒体库多个文件夹”

Jellyfin 支持一个媒体库挂多个路径。  
以“电视剧库”为例，可以同时添加：

- `/media/cloud/quark/TV`
- `/media/ssd/TV`

这样会在同一个 TV 库里统一展示。

建议：

- 两侧文件命名规则保持一致，减少重复识别。
- 如果存在重复剧集，优先保留一个主来源，另一路做备份。
