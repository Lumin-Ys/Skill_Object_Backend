#!/bin/bash
# Deploy Skill_Object_Backend on server
# 运行方式: bash install.sh

set -e

echo "=========================================="
echo "  Deploy Skill 后端部署脚本"
echo "=========================================="

# 配置
DOMAIN="aeladder.store"
PORT=3000

# 1. 安装 Node.js
echo "📦 安装 Node.js 18..."
curl -fsSL https://deb.nodesource.com/setup_18.x | bash -
apt-get install -y nodejs

# 2. 创建目录
echo "📁 创建应用目录..."
mkdir -p /var/www/skill-backend
cd /var/www/skill-backend

# 3. 下载代码（你需要先上传代码或用 git clone）
# 这里假设你已经通过 SFTP 上传了 Skill_Object_Backend 的内容
# 如果没有，请先上传代码

# 4. 安装依赖
echo "📦 安装项目依赖..."
npm install

# 5. 配置 PM2
echo "⚙️ 配置 PM2 进程管理..."
npm install -g pm2
pm2 stop skill-backend 2>/dev/null || true
pm2 start server.js --name skill-backend
pm2 save
pm2 startup

# 6. 配置 Nginx
echo "🌐 配置 Nginx 反向代理..."
cat > /etc/nginx/sites-available/$DOMAIN << EOF
server {
    listen 80;
    server_name $DOMAIN www.$DOMAIN;

    location / {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_cache_bypass \$http_upgrade;
    }
}
EOF

# 启用站点
ln -sf /etc/nginx/sites-available/$DOMAIN /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default

# 测试并重载 Nginx
nginx -t && systemctl reload nginx

# 7. 配置防火墙
echo "🔥 配置防火墙..."
ufw allow 80/tcp
ufw allow 443/tcp

echo ""
echo "=========================================="
echo "  ✅ 部署完成！"
echo "=========================================="
echo "  🌐 访问地址: http://$DOMAIN"
echo "  📊 管理后台: http://$DOMAIN/console"
echo ""
