# All In One Video

快速无损视频剪辑工具（Electron）。核心特性：**流复制秒切**——不转码、不重压缩，导出速度≈文件复制，画质零损失。

## 开发

```bash
# 1. 安装依赖
npm install

# 2. 下载 ffmpeg/ffprobe 二进制（含 NVENC 硬件编码，约 180MB，只需一次）
bash scripts/download-ffmpeg.sh

# 3. 启动开发
npm run dev

# 4. 测试 / 类型检查 / 构建
npm test
npm run typecheck
npm run build
```

## 架构

- `electron/` 主进程：ffmpeg/ffprobe 封装、关键帧扫描（带缓存）、剪切规划（纯函数）、串行任务队列
- `src/` 渲染进程：React + Tailwind，Canvas 时间轴，`requestVideoFrameCallback` 帧精确播放器
- `shared/` 跨进程类型与纯逻辑
- `docs/TECHNICAL_DESIGN.md` 技术方案

## 使用

1. 打开视频 → 时间轴上拖动入/出点（自动吸附关键帧，琥珀色刻度）
2. 点「导出选段」→ 输出到视频同目录，`原名_cut_时间戳.mp4`
3. 快捷键：空格播放/暂停、←/→ 逐帧、Shift+←/→ 跳 1 秒、I/O 设入出点、Home/End 跳首尾

## 路线图

- P2：smart cut 帧级精确（头部小段硬件编码 + 其余流复制）
- P3：缩略图、波形、多片段 EDL、撤销重做
- P4：批量转码、格式转换
