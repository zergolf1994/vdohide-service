#!/bin/bash

# VdoHide Service Installation Script (Node.js)
# Usage: curl -fsSL https://raw.githubusercontent.com/zergolf1994/vdohide-service/main/install.sh | sudo -E bash -s -- [OPTIONS]

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# Defaults
UNINSTALL=false
DATABASE_URL=""
PORT="4000"

APP_NAME="vdohide-service"
APP_DIR="/opt/$APP_NAME"
SERVICE_NAME="vdohide-service"
GITHUB_REPO="zergolf1994/vdohide-service"
RELEASES_URL="https://github.com/$GITHUB_REPO/releases/latest/download"
NODE_MAJOR_MIN=20   # ต่ำกว่านี้ = ติดตั้ง Node ใหม่
NODE_SETUP_VERSION=22

print_status()  { echo -e "${GREEN}[INFO]${NC} $1"; }
print_warning() { echo -e "${YELLOW}[WARNING]${NC} $1"; }
print_error()   { echo -e "${RED}[ERROR]${NC} $1"; }

# Parse args
while [[ $# -gt 0 ]]; do
    case $1 in
        --uninstall)         UNINSTALL=true; shift ;;
        --database-url)      DATABASE_URL="$2"; shift 2 ;;
        --mongodb-uri)       DATABASE_URL="$2"; shift 2 ;; # alias เดิม
        --port)              PORT="$2"; shift 2 ;;
        -h|--help)
            echo "VdoHide Service Installer (Node.js — internal cron/api, no nginx)"
            echo ""
            echo "Usage: curl -fsSL https://raw.githubusercontent.com/$GITHUB_REPO/main/install.sh | sudo -E bash -s -- [OPTIONS]"
            echo ""
            echo "Options:"
            echo "  --uninstall          Uninstall completely"
            echo "  --database-url URI   MongoDB connection string (DATABASE_URL)"
            echo "  --mongodb-uri URI    Alias ของ --database-url"
            echo "  --port PORT          HTTP port (default: 4000)"
            echo "  -h, --help           Show this help"
            echo ""
            echo "Examples:"
            echo "  curl -fsSL ... | sudo -E bash -s -- --database-url \"mongodb+srv://...\""
            exit 0 ;;
        *)
            print_error "Unknown option: $1"; exit 1 ;;
    esac
done

# ─── Uninstall ────────────────────────────────────────────────
if [ "$UNINSTALL" = true ]; then
    print_warning "⚠️  Starting Uninstallation..."
    systemctl stop "${SERVICE_NAME}"    2>/dev/null || true
    systemctl disable "${SERVICE_NAME}" 2>/dev/null || true
    [ -f "/etc/systemd/system/${SERVICE_NAME}.service" ] && rm "/etc/systemd/system/${SERVICE_NAME}.service"
    systemctl daemon-reload
    [ -d "$APP_DIR" ] && rm -rf "$APP_DIR"
    print_status "✅ Uninstalled successfully!"
    exit 0
fi

# Check root
if [ "$(id -u)" -ne 0 ]; then
    print_error "This script must be run as root (use sudo)"
    exit 1
fi

print_status "🚀 Starting Installation..."

# ─── System Dependencies ──────────────────────────────────────
print_status "Installing system dependencies (curl)..."
if command -v apt-get &>/dev/null; then
    apt-get update -qq
    apt-get install -y -qq curl ca-certificates
elif command -v yum &>/dev/null; then
    yum install -y curl
elif command -v dnf &>/dev/null; then
    dnf install -y curl
fi

# ─── Node.js ──────────────────────────────────────────────────
NEED_NODE=true
if command -v node &>/dev/null; then
    NODE_MAJOR=$(node -v | sed 's/^v//' | cut -d. -f1)
    if [ "$NODE_MAJOR" -ge "$NODE_MAJOR_MIN" ]; then
        NEED_NODE=false
        print_status "Node.js $(node -v) already installed"
    else
        print_warning "Node.js $(node -v) too old (need >= v$NODE_MAJOR_MIN) — upgrading"
    fi
fi

if [ "$NEED_NODE" = true ]; then
    print_status "Installing Node.js $NODE_SETUP_VERSION (NodeSource)..."
    if command -v apt-get &>/dev/null; then
        curl -fsSL "https://deb.nodesource.com/setup_${NODE_SETUP_VERSION}.x" | bash -
        apt-get install -y -qq nodejs
    elif command -v yum &>/dev/null || command -v dnf &>/dev/null; then
        curl -fsSL "https://rpm.nodesource.com/setup_${NODE_SETUP_VERSION}.x" | bash -
        (command -v dnf &>/dev/null && dnf install -y nodejs) || yum install -y nodejs
    else
        print_error "No supported package manager (apt/yum/dnf) for Node.js install"
        exit 1
    fi
    print_status "Node.js $(node -v) installed"
fi

# ─── Stop existing service ────────────────────────────────────
systemctl stop ${SERVICE_NAME} 2>/dev/null || true

# ─── Create app directory ─────────────────────────────────────
print_status "Creating app directory: $APP_DIR"
mkdir -p "$APP_DIR"
cd "$APP_DIR"

# ─── Download release tarball (dist + package.json + lock) ────
print_status "Downloading service.tar.gz from latest release..."
# --retry: กัน GitHub release CDN สะดุดชั่วคราว (เช่น 504 gateway timeout)
curl -fsSL --retry 5 --retry-delay 3 --retry-all-errors \
    "$RELEASES_URL/service.tar.gz" -o /tmp/${APP_NAME}.tar.gz
rm -rf "$APP_DIR/dist"
tar -xzf /tmp/${APP_NAME}.tar.gz -C "$APP_DIR"
rm -f /tmp/${APP_NAME}.tar.gz

# ─── Install production dependencies ──────────────────────────
print_status "Installing npm dependencies (production)..."
npm ci --omit=dev --no-audit --no-fund

# ─── Create .env ─────────────────────────────────────────────
print_status "Creating .env file..."
cat > "$APP_DIR/.env" <<EOF
NODE_ENV=production
HTTP_PORT=$PORT
DATABASE_URL=$DATABASE_URL
EOF

# ─── Systemd service ──────────────────────────────────────────
print_status "Creating systemd service..."
NODE_BIN=$(command -v node)
cat > /etc/systemd/system/${SERVICE_NAME}.service <<EOF
[Unit]
Description=VdoHide Service (cron/api)
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=$APP_DIR
ExecStart=$NODE_BIN dist/server.js
Restart=always
RestartSec=5
EnvironmentFile=$APP_DIR/.env

[Install]
WantedBy=multi-user.target
EOF

# ─── Enable & start ───────────────────────────────────────────
systemctl daemon-reload
systemctl enable ${SERVICE_NAME}
systemctl start ${SERVICE_NAME}

# ═── Done ─────────────────────────────────────────────────────
sleep 2
echo ""
echo "============================================"
if systemctl is-active --quiet ${SERVICE_NAME}; then
    print_status "✅ Installation completed successfully!"
else
    print_warning "Service not running — check logs below"
    journalctl -u "${SERVICE_NAME}" -n 15 --no-pager
fi
echo "============================================"
echo ""
echo "  Port:       $PORT"
echo ""
echo "  Commands:"
echo "    View logs:  journalctl -u ${SERVICE_NAME} -f"
echo "    Restart:    systemctl restart ${SERVICE_NAME}"
echo "    Health:     curl http://localhost:$PORT/health"
echo "    Uninstall:  curl -fsSL https://raw.githubusercontent.com/$GITHUB_REPO/main/install.sh | sudo bash -s -- --uninstall"
echo "============================================"
