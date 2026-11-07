# 部署准备（未执行）

本目录是 P4-02 的可审查配置，不代表已经部署或通过用户验收。当前环境没有部署授权，也没有在 Linux / 公网证书 / 正式 PostgreSQL 上运行过这些文件。

## 拓扑

- 一个 server 进程，只监听 `127.0.0.1:8787`。
- 同机 Nginx 提供 HTTPS、静态工作台和 `/api` 反向代理。
- PostgreSQL 使用独立账号和数据库；开发集群不是部署配置。
- Pi SQLite、文档、浏览器 profile、截图和执行工作区放在 `/var/lib/waterbot`。
- 浏览器功能要求宿主安装 Edge 或 Chrome；容器没有浏览器时只关闭该能力，不伪造成功。

## 步骤

1. 安装 Node.js 22、PostgreSQL，并创建 `waterbot` 系统用户：

   ```bash
   sudo useradd --system --home /opt/waterbot --shell /usr/sbin/nologin waterbot
   sudo install -d -o waterbot -g waterbot /opt/waterbot /var/lib/waterbot
   ```

2. 把仓库放到 `/opt/waterbot`，以 `waterbot` 用户构建：

   ```bash
   sudo -u waterbot npm ci
   sudo -u waterbot npm run build
   ```

3. 创建 `/etc/waterbot.env`（权限 0600），至少包含：

   ```
   DATABASE_URL=postgres://waterbot:<password>@127.0.0.1:5432/waterbot
   PORT=8787
   HOST=127.0.0.1
   PUBLIC_ORIGIN=https://waterbot.example.com
   WATERBOT_DATA_DIR=/var/lib/waterbot
   BACKUP_PASSPHRASE=<至少 12 个字符，与数据分开保存>
   BROWSER_CHANNEL=msedge
   ```

   QQ、模型、搜索和空间写入开关按 `.env.example` 另行填写。`QQ_ALLOW_SEND=1` 才会真实外发。

4. 以部署账号执行迁移：

   ```bash
   sudo -u waterbot bash -c 'set -a; . /etc/waterbot.env; set +a; npm run db:migrate'
   ```

5. 安装服务与反向代理：

   ```bash
   sudo cp deploy/waterbot.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now waterbot
   sudo cp deploy/nginx.conf /etc/nginx/sites-available/waterbot
   sudo ln -s /etc/nginx/sites-available/waterbot /etc/nginx/sites-enabled/waterbot
   sudo nginx -t && sudo systemctl reload nginx
   ```

6. 首次访问 HTTPS 域名，用 `/var/lib/waterbot/owner-key` 里的本机访问码登录。

## 恢复与对账

```bash
sudo -u waterbot bash -c 'set -a; . /etc/waterbot.env; set +a; npm run backup'
sudo -u waterbot bash -c 'set -a; . /etc/waterbot.env; set +a; npm run restore'
```

恢复后检查 `/api/status` 的待派发、失败作业、动作 unknown、QQ 缺口和用量；文档、截图和工作区文件不在数据库逻辑备份内，需要单独备份 `/var/lib/waterbot`。

## 已知缺口

- 没有在目标主机上执行这些文件，也没有 TLS、域名、PostgreSQL 或 systemd 的实际证据。
- 没有多实例调度或容器编排；同一 Pi SQLite 不能被两个进程同时打开。
- 浏览器需要宿主浏览器；没有无头桌面、原生手机桥或硬件密钥转发。
- 备份只覆盖数据库逻辑内容；文件、浏览器 profile 和外部账号状态需要各自备份。
