# 参考实现与调研材料

这个目录里的东西**不是本插件的一部分**，只是支撑 `lib/sites/*.js` 里那些适配器的证据。保留它们是为了让每一条「这个站点为什么能 / 不能抓到字幕」的结论都可追溯，而不是只能相信注释。

## 为什么会有这些文件

调研阶段的结论必须能核对。例如 `lib/sites/qq.js` 里的 `cKey` 签名（AES-128-CBC + 空白填充 + 固定 key/iv）不是猜的，是从 `tencent.py` 读出来、再用 Node 复现并在真实接口上验证过的。谁要改这个签名，就应该能直接看到原始实现。

## `../cn-video-subtitle-spec.md`

调研主文档。每条结论都标注了证据等级：

- **[DOC]** — 出自文档，附出处
- **[CODE]** — 读自下列某个参考实现
- **[LIVE]** — 本次调研中真实发过请求并观察到结果

未能验证的部分明确标记为 **unverified**，而不是补一个看起来合理的答案。文档里也记录了若干**流传很广但实测为假**的说法（例如 `x/v2/subtitle/web/view` 实际返回 404、`?ep_id=` 直接请求 UGC 接口返回 `-400`、请求头并不是 B 站的门槛），这些正是当初差点写错的地方。

## 文件来源

| 文件 | 来源 | 用途 |
| --- | --- | --- |
| `tencent.py`, `mgtv.py`, `youku.py`, `iqiyi.py`, `douyin-detail.md`, `kuaishou-video_detail.graphql`, `ixigua.py`, `weibo.py`, `cctv.py` | [`yt-dlp/yt-dlp`](https://github.com/yt-dlp/yt-dlp) 的 extractor | 腾讯 `cKey` 签名、芒果 `tk2`、优酷接口字段、爱奇艺 `cmd5x` 链路、快手 GraphQL 查询 |
| `bilibili_2.py`, `common.py` | `yt-dlp` 的 bilibili extractor 与共用件 | B 站请求链与字幕字段 |
| `bili_ai_cli.py`, `bili_ai_subtitle_to_srt.py` | 第三方 B 站 AI 字幕脚本 | 交叉验证字幕 JSON 的 `body[]` 形状 |
| `vqq.py` | 腾讯视频相关脚本 | 交叉验证 `getvinfo` 参数 |
| `zwmap-spec.html` | 公开的某个接口文档页存档 | 参考 |

外部项目各自的许可证适用于这些文件；本项目只把它们当作参考资料，不链接、不复制其代码进运行时。

## 与运行时实现的关系

`lib/` 下的适配器是**独立实现**，没有引用这里任何文件。这里的 Python / GraphQL / HTML 只是被阅读过的证据。改动适配器时，请把这里当作可以核对的事实来源，而不是可以复制粘贴的代码库。
