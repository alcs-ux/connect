#!/bin/bash
# 使い方: scripts/shots.sh  （ビルドして再起動）
cd "$(dirname "$0")/.."
pkill -f "next start" 2>/dev/null; pkill -f "next-server" 2>/dev/null
npm run build 2>&1 | grep -E "error|Error|Failed|warn|✓ Compiled|Type error" -A6 | head -40
(PORT=3100 npx next start > /tmp/next-vig.log 2>&1 &)
sleep 3
