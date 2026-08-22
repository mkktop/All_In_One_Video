#!/usr/bin/env bash
# 下载 BtbN GPL 构建（含 NVENC/QSV/AMF + libx264/x265）到 resources/bin
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
url="https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip"
tmp="$(mktemp -d)"

echo "下载 $url"
curl -L --retry 3 -o "$tmp/ffmpeg.zip" "$url"
powershell -NoProfile -Command "Expand-Archive -Path '$tmp/ffmpeg.zip' -DestinationPath '$tmp/x' -Force"

mkdir -p "$root/resources/bin"
cp "$tmp"/x/ffmpeg-master-latest-win64-gpl/bin/ffmpeg.exe "$root/resources/bin/"
cp "$tmp"/x/ffmpeg-master-latest-win64-gpl/bin/ffprobe.exe "$root/resources/bin/"
rm -rf "$tmp"
echo "完成：$root/resources/bin"
