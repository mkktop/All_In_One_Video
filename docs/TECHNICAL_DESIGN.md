# All In One Video — 技术方案 v1

> 定位：帧级精确、近流复制速度的视频剪辑工具。核心是 smart cut（智能剪切）——只有片段头部一小段需要转码，其余全部流复制。
> 阶段目标：Phase 1 关键帧吸附 + 纯流复制剪切 → Phase 2 smart cut 帧级精确 → Phase 3 合并/音轨等多功能。

---

## 1. 总体架构

```
┌──────────────────────────────────────────────────────┐
│ 渲染进程 (React + TypeScript)                          │
│  ├─ Player        HTML5 <video> + rVFC 帧精确控制      │
│  ├─ Timeline      Canvas 自绘时间轴 + 缩略图 + 吸附     │
│  ├─ InOutPanel    入点/出点/模式选择/导出              │
│  └─ TaskPanel     任务列表 + 进度 + 取消               │
└───────────────┬──────────────────────────────────────┘
                │ IPC（contextBridge 暴露窄接口，invoke + 事件推送）
┌───────────────┴──────────────────────────────────────┐
│ 主进程 (Node.js)                                       │
│  ├─ BinariesManager   ffmpeg/ffprobe 路径与能力探测    │
│  ├─ ProbeService      媒体信息 + 关键帧索引（含缓存）  │
│  ├─ SegmentPlanner    剪切规划（纯函数，可单测）        │
│  ├─ FfmpegRunner      spawn 封装、进度解析、取消       │
│  ├─ CutJobQueue       串行任务队列、临时文件生命周期    │
│  └─ Verifier          导出结果校验（时长/帧数）        │
└───────────────┬──────────────────────────────────────┘
                │ child_process.spawn（数组参数，无 shell）
         ffmpeg / ffprobe 独立二进制
```

关键原则：

- **ffmpeg 全部在主进程跑**，渲染进程零 Node 能力（`contextIsolation: true`、`nodeIntegration: false`）。
- **规划与执行分离**：SegmentPlanner 是纯函数（输入：起止时间 + 关键帧列表 + 媒体信息；输出：段计划），单元测试不依赖 ffmpeg。
- **两种剪切模式共用同一套执行器**：
  - `keyframe-snap`：起点吸附关键帧，纯 `-c copy`，秒级完成；
  - `smart`：头部小段转码 + 其余复制，帧级精确。

---

## 2. 技术选型

| 项 | 选择 | 理由 |
|---|---|---|
| 框架 | Electron + electron-vite | 跨平台桌面，生态成熟 |
| 前端 | React 18 + TypeScript | 时间轴这类复杂组件生态最好 |
| 状态 | zustand | 轻量，避免 redux 样板 |
| 时间轴 | Canvas 自绘（不用 DOM） | 长视频性能、自定义吸附刻度 |
| ffmpeg 分发 | 自打包二进制放 `resources/bin/`，asarUnpack | ffmpeg-static 不含 NVENC；BtbN 的 win64-gpl 构建含 NVENC/QSV/AMF + libx264/x265 |
| 打包 | electron-builder（NSIS） | Windows 优先 |

> 许可证注意：分发含 libx264 的 GPL 构建，应用需 GPL 兼容（本项目自有代码无问题，闭源商用需换 LGPL 构建并放弃 x264，优先硬件编码器）。

---

## 3. 主进程服务设计

### 3.1 BinariesManager

- 解析二进制路径：开发态用 `resources/bin/`，安装态用 `process.resourcesPath/bin/`。
- **能力探测**（结果缓存）：
  1. `ffmpeg -hide_banner -encoders` 解析可用编码器列表；
  2. 对 h264_nvenc / h264_qsv / h264_amf 各试编码 0.2s 纯色（`-f lavfi -i color=c=black:s=64x64:d=0.2`），**存在 ≠ 可用**（驱动可能不支持），试运行才算数；
  3. 产出硬件编码器优先级表，供 smart cut 选择：`nvenc → qsv → amf → libx264(ultrafast)`。

### 3.2 ProbeService

**媒体信息**（一次调用，<1s）：

```bash
ffprobe -v error -print_format json -show_format -show_streams <file>
```

提炼为 `MediaInfo`（见 §6 类型），重点字段：codec、分辨率、`r_frame_rate` / `avg_frame_rate`（VFR 判断）、`pix_fmt`、`profile`、`level`、SAR、音频 codec/采样率/声道、是否含 B 帧（`has_b_frames`）。

**关键帧索引**（时间轴吸附与规划的基础）：

```bash
ffprobe -v error -select_streams v:0 \
  -show_entries packet=pts_time,flags \
  -of compact=sep_lines=1:p=0 <file>
```

- 用 `-of compact` 逐行流式解析（spawn + readline），**不要用 JSON 一次性输出**——长视频数十万包，JSON 全量字符串会撑内存。
- 只收 `flags` 含 `K` 的包 → `keyframes: number[]`（升序）。
- 全文件 demux（不解码）顺序读，几 GB 文件秒级；**按 `path + size + mtime` 哈希缓存**到 userData，重复打开同一文件零成本。
- 扫描期间向渲染进程流式推送进度（已读字节 / 文件大小）。

### 3.3 SegmentPlanner（核心纯函数）

一个关键事实（决定了方案比"三段式"更简单）：

> **头部必须落在关键帧，尾部不必。** H.264/HEVC 默认 closed GOP，GOP 内的帧只依赖本 GOP 内的前序帧。在 GOP 中间截断尾部，之前的帧全部可解码可显示，播放安全。所以尾部用 `-t` 截断即可，精度到包级（≈帧级）；只有片段**开头**落在非关键帧时才需要转码小段。

两种模式的规划逻辑：

```ts
// snap 模式：纯复制
//   copyStart = 满足 kf <= start 的最大关键帧（内容只多不少）
//   copyEnd   = 用户 end（包级截断）
// smart 模式：
//   若 start 距最近关键帧 < 半帧 → 视为已在关键帧，退化为 snap
//   否则两段：
//     A: [start, kfAfter(start))   转码（通常 0.x ~ 几秒）
//     B: [kfAfter(start), end)     -c copy
//   尾部严格帧级（可选增强）：end 落在 GOP 内且用户要求精确尾帧时
//   追加 C 段转码；Phase 2 先不做，包级精度已够
```

输出类型：

```ts
type Segment =
  | { kind: 'copy';   startSec: number; endSec: number }
  | { kind: 'encode'; startSec: number; endSec: number };
```

### 3.4 执行器（smart cut 命令集）

设用户剪切 `[s, e]`，`k` 为 s 之后第一个关键帧。**执行顺序固定为 B → A → concat**，原因见下文"起点校准"。

**段 B（复制，先跑）：**

```bash
ffmpeg -y -ss <k> -i input.mp4 -t <e-k> \
  -c copy -avoid_negative_ts make_zero -movflags +faststart seg_b.mp4
```

**起点校准（关键细节）**：`-ss` 的 seek 目标经时间基舍入后，实际落点可能与 `k` 有毫秒级偏差。所以段 B 跑完后立即 ffprobe 它的首帧 pts：

```bash
ffprobe -v error -select_streams v:0 -show_entries packet=pts_time \
  -read_intervals %+0.1 -of json seg_b.mp4
```

用**实际起点 `k'`** 反推段 A 的 `-t`（即 `k' − s`），保证 A 的尾帧与 B 的首帧无缝衔接、不丢帧不重复。

**段 A（转码，参数对齐源）：**

```bash
ffmpeg -y -ss <s> -i input.mp4 -t <k'−s> \
  -c:v <encoder> <encoderArgs> \
  -c:a aac -b:a <源码率或128k> \
  -movflags +faststart seg_a.mp4
```

参数匹配表（concat 能否 `-c copy` 成功就取决于这张表）：

| 项 | 取值 |
|---|---|
| encoder | nvenc → qsv → amf → libx264（按 §3.1 探测结果） |
| 分辨率 / SAR / pix_fmt | 严格等于源（pix_fmt 统一 `yuv420p`） |
| 帧率 | 等于源 `r_frame_rate`（CFR 源）；VFR 源见 §9-R3 |
| profile / level | 尽量对齐源（`-profile:v high -level:v <源level>`），降低 concat 与播放器兼容风险 |
| GOP | 段 A 很短，默认即可，但强制首帧 IDR（编码器默认满足） |
| libx264 附加 | `-preset ultrafast -crf 16`（肉眼无损，速度优先） |
| NVENC 附加 | `-preset p1 -tune ll -cq 16` |

音频：段 A 重编码 AAC（几秒音频，毫秒级）；段 B 音频随 `-c copy`。无音频流则两侧都加 `-an` 逻辑。

**拼接（依然是复制）：**

```bash
# list.txt:
file 'seg_a.mp4'
file 'seg_b.mp4'
ffmpeg -y -f concat -safe 0 -i list.txt -c copy \
  -movflags +faststart output.mp4
```

**容器策略**：段 A/C 的编码器与源不同，MP4 的 avcC（SPS/PPS）按轨道存储，参数严格来说不一致——实际主流播放器都能容忍（每段首帧都是关键帧）。默认输出 MP4；提供 MKV 选项（天生段级自带头，最稳）；若 concat 报 codec 参数不匹配，自动 fallback：段 A 改用与源完全一致的 profile/level 重跑一次，仍失败则整段转码并在 UI 明确提示。

### 3.5 CutJobQueue 与生命周期

- **串行队列**（磁盘顺序读写对大文件更友好），任务对象含状态机 `queued → running → done | failed | canceled`。
- 进度：`-progress pipe:1` 输出结构化键值对（`out_time_us` / `speed` / `progress=end`），解析后按 job 加权（B 段按字节占比估算、A 段按 out_time）合成总进度，通过 IPC 事件推送。
- 取消：Windows 下 `taskkill /PID <pid> /T /F` 杀进程树（ffmpeg 的子进程kill 在 win 上必须这样），随后清理该 job 的临时目录。
- 临时目录：`app.getPath('temp')/aiov/<jobId>/`，导出成功即删；**应用启动时清扫孤儿目录**。
- Verifier：导出后 ffprobe 输出文件，校验时长与期望差 ≤ 1 帧时间、流参数与源一致；失败自动进入 fallback 策略并上报。

---

## 4. 渲染进程设计

### 4.1 页面结构（单窗口三栏）

```
┌────────────────────────────────────────────┐
│ 工具栏：打开文件 / 模式(吸附|精确) / 导出    │
├────────────────────────────────────────────┤
│                                            │
│              播放器（video）                │
│                                            │
├────────────────────────────────────────────┤
│ 时间轴：波形/缩略图 + 关键帧刻度 + IO 标记   │
├────────────────────────────────────────────┤
│ 任务面板（折叠）：进度 / 取消 / 打开目录      │
└────────────────────────────────────────────┘
```

### 4.2 播放器与帧级定位

- seek：设 `video.currentTime`，监听 `seeked`。
- **帧步进用 `requestVideoFrameCallback`**（Chromium 原生支持）：回调给出当前帧精确 `mediaTime`，步进 = `currentTime = mediaTime ± 1/fps` 后等下一次 rVFC 确认落帧。比裸算 `currentTime±1/fps` 可靠（不丢帧不重复）。
- 入点/出点显示对应的帧号与时间码（`帧 1234 @ 00:01:23.500`）。
- 编解码兼容预检：H.264/AAC 在 Electron（内置 Chromium 含专有编解码）全平台稳；HEVC 依赖系统解码器（Win10/11 装了 HEVC 扩展即可），检测失败时 UI 提示"预览不可用，仍可剪切"。VP9/AV1 原生支持。

### 4.3 时间轴（Canvas）

- 视口虚拟化：只绘制可见区间，支持缩放（滚轮）到帧级。
- 图层：缩略图条（后台 ffmpeg 每 N 秒抽帧拼雪碧图，渐进加载）→ 关键帧竖线刻度（吸附提示）→ IO 选区高亮。
- 吸附行为：snap 模式下拖动入点时 magnet 到最近关键帧并显示"⚠ 已吸附，起点提前 2.3s"；smart 模式自由拖动。
- 音频波形（Phase 2）：`ffmpeg -filter:a showwavespic` 生成整条波形图。

---

## 5. IPC 契约

| channel | 方向 | 类型 |
|---|---|---|
| `media:open` | invoke | `(path) → MediaInfo`（内部触发关键帧扫描） |
| `media:keyframeProgress` | 主→渲染事件 | `{ path, progress }` |
| `cut:submit` | invoke | `(CutRequest) → jobId` |
| `job:progress` | 主→渲染事件 | `{ jobId, phase, percent, etaSec }` |
| `job:done` / `job:failed` / `job:canceled` | 主→渲染事件 | `{ jobId, outputPath?, error? }` |
| `job:cancel` | invoke | `(jobId) → void` |
| `app:capabilities` | invoke | `→ { encoders, platform }`（硬件编码器探测结果） |

shared 类型（`shared/types.ts`，主/渲染共用）：

```ts
export interface MediaInfo {
  path: string;
  durationSec: number;
  container: string;
  video: {
    codec: string;            // h264 | hevc | ...
    width: number; height: number;
    fps: number;              // r_frame_rate 换算
    avgFps: number;           // VFR 判断: |fps - avgFps|/fps > 1% → isVfr
    pixFmt: string; profile?: string; level?: number;
    sar: string; hasBFrames: boolean;
  } | null;
  audio: { codec: string; sampleRate: number; channels: number }[];
  isVfr: boolean;
  keyframes: number[];        // 扫描完成后补充推送
}

export type CutMode = 'keyframe-snap' | 'smart';

export interface CutRequest {
  inputPath: string;
  startSec: number;
  endSec: number;
  mode: CutMode;
  output: { dir: string; container: 'mp4' | 'mkv' };
}
```

---

## 6. 目录结构

```
All_In_One_Video/
├─ electron/
│  ├─ main.ts                 # 窗口、IPC 注册、生命周期
│  ├─ preload.ts              # contextBridge 窄接口
│  └─ services/
│     ├─ binaries.ts
│     ├─ probe.ts
│     ├─ keyframes.ts
│     ├─ planner.ts           # 纯函数 + 单测
│     ├─ ffmpeg-runner.ts
│     ├─ job-queue.ts
│     └─ verifier.ts
├─ src/                       # 渲染进程
│  ├─ App.tsx
│  ├─ components/Player/  Timeline/  TaskPanel/  InOutPanel/
│  ├─ stores/                # zustand
│  └─ ipc.ts                 # 类型化 IPC 客户端
├─ shared/types.ts
├─ resources/bin/             # ffmpeg.exe / ffprobe.exe（asarUnpack）
└─ tests/fixtures/            # 2~3 秒小样本视频（含 H.264 CFR / VFR 各一）
```

---

## 7. 关键风险与对策

| # | 风险 | 对策 |
|---|---|---|
| R1 | NVENC 声明存在但驱动不可用 | §3.1 试编码探测；fallback 链 nvenc→qsv→amf→x264 ultrafast |
| R2 | concat `-c copy` 报参数不匹配 | 参数对齐表 + profile/level 强制对齐重试 + 整段转码兜底（UI 明示） |
| R3 | VFR 源（录屏/手机视频常见） | Phase 1：检测到 VFR 时 smart 模式 UI 警示；段 A 转码用 `-fps_mode passthrough` 保留原时间戳。Phase 2 专项：按包时间戳重写，拼接后 Verifier 校验帧数 |
| R4 | 段间毫秒级缝隙/重复 | B 段实际起点反推 A 段 `-t`（§3.4），Verifier 校验总时长 ±1 帧 |
| R5 | HEVC 等预览不支持 | 播放前探测 `canPlayType`，不支持时提示"无法预览但可剪切"；后续代理文件方案 |
| R6 | 超长文件关键帧扫描慢 | demux 级扫描本就秒级 + 结果缓存；扫描异步不阻塞 UI |
| R7 | MP4 avcC 与段 A 编码器不一致 | 默认 MP4 + 参数对齐（主流播放器可容忍）；提供 MKV 输出选项 |

---

## 8. 里程碑

| 阶段 | 内容 | 预估 |
|---|---|---|
| **P0 地基** | electron-vite 脚手架、二进制打包、IPC 骨架、ProbeService | 2~3 天 |
| **P1 吸附剪切** | 关键帧扫描+缓存、planner(snap)、执行器(copy)、时间轴 v1（无缩略图）、任务面板 | 3~5 天 |
| **P2 smart cut** | 两段式管线、硬件编码器探测与 fallback、起点校准、Verifier、参数对齐重试 | 1.5~2 周 |
| **P3 体验** | 缩略图、波形、多片段队列导出、MKV、VFR 专项 | 持续 |
| **P4 多功能** | 合并、音轨提取、字幕轨保留等"各种视频功能" | 按需 |

参考实现：**LosslessCut**（MIT，关键帧扫描/时间戳/ffmpeg 封装直接借鉴）、Kdenlive smart cut。

---

## 9. 测试策略

- planner / 进度解析 / 时间码换算：纯函数单测（vitest）。
- 执行管线集成测试：用 `tests/fixtures` 小样本（含 CFR、VFR、无音频三种），断言输出时长/帧数/流参数。
- 手工矩阵：Win + Intel/NVIDIA/AMD 各一，验证硬件编码器探测与 fallback。
