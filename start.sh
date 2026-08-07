#!/bin/bash
# Agent Society Startup Script (Unix/macOS)
# Auto-detects Node.js first; falls back to Bun if Node.js is unavailable.
#
# 用法:
#   ./start.sh [数据目录] [选项]
#
# 选项:
#   --port, -p <端口>  HTTP 服务器端口 (默认: 3000)
#   --no-browser       不自动打开浏览器
#
# 示例:
#   ./start.sh                           # 使用默认配置
#   ./start.sh ./my-data                 # 自定义数据目录
#   ./start.sh --port 3001               # 自定义端口
#   ./start.sh ./my-data -p 3001 --no-browser

# 获取脚本所在目录
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# ============================================================
# 内存限制配置（防止 RSS 过大导致进程退出）
# ============================================================
# 设置 V8 堆内存限制为 4GB，并暴露 GC 接口
export NODE_OPTIONS="--max-old-space-size=4096 --expose-gc"

# Bun 特有的内存限制（通过 JSC 引擎参数）
# 4GB = 4294967296 字节
export BUN_JSC_forceRAMSize=4294967296

# 启用强制 GC 间隔（每 5 分钟）
export AGENT_SOCIETY_GC_INTERVAL_MS=300000

echo ""
echo "[INFO] 内存限制已设置:"
echo "       - V8 堆内存限制: 4GB"
echo "       - Bun JSC 内存限制: 4GB"
echo "       - 强制 GC 间隔: 5 分钟"
echo ""

echo ""
echo "============================================================"
echo "           Agent Society 启动脚本"
echo "============================================================"
echo ""

# 尝试更新代码（忽略错误）
echo "[0/3] 尝试更新代码..."
git pull 2>/dev/null || echo "     git pull 跳过（可能未安装 git 或网络问题）"
echo ""

# ============================================================
# 检测运行时：优先 Node.js，回退到 Bun
# ============================================================
echo "[1/3] 检测运行时..."

if command -v node &> /dev/null; then
    NODE_VERSION=$(node -v 2>/dev/null)
    echo "     使用 Node.js: $NODE_VERSION"

    echo ""
    echo "[2/3] 安装依赖 (npm)..."
    npm install
    if [ $? -ne 0 ]; then
        echo ""
        echo "错误: npm install 失败"
        echo "解决方案: 请检查网络连接，或检查 package.json 是否正确"
        exit 1
    fi

    echo ""
    echo "[3/3] 启动服务器 (Node.js)..."
    echo "     内存限制: 4GB"
    echo "     强制 GC: 启用 (每 5 分钟)"
    echo ""
    node start-wrapper.mjs "$@"
    exit $?
fi

# Node.js 未找到，尝试 Bun
echo "     Node.js 未找到，尝试 Bun..."

# 先检查常见安装路径
if [ -f "$HOME/.bun/bin/bun" ]; then
    export PATH="$HOME/.bun/bin:$PATH"
fi

if command -v bun &> /dev/null; then
    echo "     bun 已安装"
else
    # bun 未安装，询问用户是否安装
    echo "     bun 未安装"
    echo ""
    echo "Node.js 和 Bun 都未找到。"
    echo "建议安装 Node.js (https://nodejs.org/)，或安装 Bun 作为备选。"
    echo "是否自动安装 Bun? (安装来源: https://bun.sh)"
    echo ""
    read -p "请输入 y 安装，n 退出 [y/n]: " INSTALL_BUN

    if [[ "$INSTALL_BUN" != "y" && "$INSTALL_BUN" != "Y" ]]; then
        echo ""
        echo "请安装 Node.js 或 Bun 后重新运行此脚本。"
        echo "  Node.js: https://nodejs.org/"
        echo "  Bun: https://bun.sh"
        exit 0
    fi

    # 检查 curl 是否可用
    if ! command -v curl &> /dev/null; then
        echo ""
        echo "错误: 未找到 curl 命令"
        echo "解决方案: 请先安装 curl，然后重新运行此脚本"
        echo "  Ubuntu/Debian: sudo apt install curl"
        echo "  macOS: curl 通常已预装"
        exit 1
    fi

    # 安装 bun
    echo ""
    echo "[1/3] 正在安装 bun..."
    echo "     执行: curl -fsSL https://bun.sh/install | bash"
    echo ""
    curl -fsSL https://bun.sh/install | bash

    if [ $? -ne 0 ]; then
        echo ""
        echo "错误: bun 安装失败"
        echo "解决方案: 请手动安装 bun 或 Node.js"
        echo "  Node.js: https://nodejs.org/"
        echo "  Bun: https://bun.sh"
        exit 1
    fi

    # 添加 bun 到 PATH
    export PATH="$HOME/.bun/bin:$PATH"

    # 验证 bun 安装
    if ! command -v bun &> /dev/null; then
        echo ""
        echo "错误: bun 安装后无法找到"
        echo "解决方案: 请关闭此终端，重新打开后再运行此脚本"
        echo "或手动安装: https://bun.sh"
        exit 1
    fi
    echo "     bun 安装成功"
fi

# 安装依赖 (Bun)
echo ""
echo "[2/3] 安装依赖 (bun)..."
echo "     执行: bun install"
echo ""
bun install

if [ $? -ne 0 ]; then
    echo ""
    echo "错误: 依赖安装失败"
    echo "解决方案: 请检查网络连接，或检查 package.json 是否正确"
    exit 1
fi

# 启动服务器 (Bun)
echo ""
echo "[3/3] 启动服务器 (Bun)..."
echo "     内存限制: 4GB (JSC)"
echo "     强制 GC: 启用 (每 5 分钟)"
echo ""
bun run start-wrapper.mjs "$@"
exit $?
