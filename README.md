# @commonworks/dsh-video-str

让 DSH Agent 直接「读」视频网站的字幕：给出一个视频链接，Agent 就能拿到带时间轴的台词文本，用来总结、检索、引用、导出 SRT。

不必下载视频，也不必跑语音识别 —— 只要该站点本身有字幕，插件就把它的文本取出来。

```
用户：这个视频讲了什么？https://www.bilibili.com/video/BVxxxxxxxxx
Agent → video_subtitle_get(url)          # 一次完成：识别站点 → 元信息 → 列字幕轨 → 取字幕
      → video_subtitle_text(cacheKey)    # 压缩纯文本，用于总结
      → 回答
```

---

## 目录

- [快速开始](#快速开始)
- [工具一览](#工具一览)
- [支持的站点与真实能力](#支持的站点与真实能力)
- [B 站字幕需要登录（最重要的一条）](#b-站字幕需要登录最重要的一条)
- [给其他站点兜底](#给其他站点兜底)
- [配置项](#配置项)
- [架构](#架构)
- [开发与测试](#开发与测试)
- [已知限制](#已知限制)

---

## 快速开始

```bash
# 从 npm 安装（推荐）
dsh plugin --profile web add @commonworks/dsh-video-str
```

也可以装本地 checkout：

```bash
dsh plugin --profile web add link:F:/code/video-srt
# 或从任意目录：
dsh plugin --profile web add link:<本包的绝对路径>
```

安装会把 `@commonworks/dsh-video-str` 追加到 `dsh.profile.bundles`。**新装的插件需要重启 DSH 才会生效**（同一 profile 下已安装插件的 config 改动是热更新的，但新增依赖不是）。

确认已挂载：

```bash
dsh --profile web --dump-config | findstr video-str
# - id: video-srt
#   name: '@commonworks/dsh-video-str'
```

重启后，任何会话都能看到 `video_subtitle_*` 工具，系统提示里也会出现该插件的使用说明。

## 工具一览

| 工具 | 用途 |
| --- | --- |
| `video_subtitle_get` | **首选入口**。识别站点 → 读元信息 → 列字幕轨 → 取最优字幕 → 返回元信息、规模统计和开头片段。返回的 `cacheKey` 供其余工具复用。 |
| `video_subtitle_info` | 只读元信息与字幕轨列表，不下载字幕。用来先确认「有没有字幕、有哪些语言」。 |
| `video_subtitle_read` | 按页码 / 时间窗 / 字幕序号读一段窗口。**长字幕不要整段读**，用这个分页。 |
| `video_subtitle_search` | 关键词或正则检索，返回命中位置、时间戳和上下文。回答「第几分钟提到 X」用这个。 |
| `video_subtitle_text` | 压缩纯文本：可去时间戳、可合并成一段、可限制字数，并报告是否被截断。 |
| `video_subtitle_export` | 把字幕写成工作区文件：`srt` / `vtt` / `txt` / `lrc` / `json`。 |
| `video_subtitle_parse` | 解析「已经拿到手」的字幕内容：直接贴文本、读工作区文件、或给一个字幕文件 URL。 |
| `video_site_detect` | 报告某个地址由哪个适配器处理、能不能抓字幕、不能的话原因是什么。 |
| `video_subtitle_sites` | 列出全部适配站点、哪些能真正返回字幕、cookie 配置状态。 |
| `video_subtitle_login` | **扫码登录**。为需要登录的站点（目前是 B 站）生成二维码，并在后台盯着它：用户扫码确认后插件**自动唤醒 Agent** 保存登录态，不用让用户回报「扫完了」，也不用反复轮询。`action` 取 `start` / `poll` / `status` / `logout`。 |

`video_subtitle_get` 与 `_parse` 都接受一个字幕文件的**直链**，这是绕开站点限制的通用出路：

### 一次典型的「长视频总结」

```
1. video_subtitle_get(url)                       → cacheKey, 规模（条数/字数/时长）, 开头 12 条
2. video_subtitle_text(cacheKey, maxChars=60000) → 若 truncated=false 直接总结
   若 truncated=true：
3. video_subtitle_read(cacheKey, page=1..N)      → 逐页读，边读边记要点
   或 video_subtitle_search(cacheKey, "关键词")   → 只取相关片段
4. video_subtitle_export(cacheKey, format="srt") → 需要落盘时导出
```

## 支持的站点与真实能力

**这张表是 2025 年逐站在真实网络上审计过的结论，不是愿望清单。** 审计脚本是 `tools/audit-sites.mjs`，任何人都可以重跑复核。

三列的含义是递进的：**元信息**（标题/时长能不能读出来）、**字幕轨**（能不能列出一条真实可下载的字幕）、**凭据**（要不要登录）。

| 站点 | 元信息 | 字幕轨 | 机制 | 实测说明 |
| --- | --- | --- | --- | --- |
| **哔哩哔哩** | ✅ | ✅ 需登录 | `x/web-interface/view` → `x/player/wbi/v2` → `subtitle_url` | 唯一实测真能拿到字幕的站点。内置 WBI 签名；支持 BV/av/`?p=N`/`b23.tv` 短链/番剧 `ep`·`ss`/课程。元信息匿名可读，**字幕列表需要 SESSDATA**。 |
| **腾讯视频** | ✅ | ❌ | `h5vv6.video.qq.com/getvinfo` → `sfl.fi[]` | 元信息实测可读（真实标题 + 时长）。签名字段 `cKey` 已实现，但**字幕轨在多个真实样本上恒为 0 条**，不要指望它。 |
| **芒果TV** | ✅ | ❌ | `pcweb.api.mgtv.com/video/title` → 每轨 `info` → `.srt` | 元信息实测可读。`video/title` **确实返回真字幕列表**（实测 18 轨，含简体中文/English/ภาษาไทย），但每轨的 `vod.do` 地址在 `pcweb.api.mgtv.com` 上不存在（`No handler found`），取不到 `.srt`。插件因此不把它们当作可用轨道。 |
| **优酷** | ✅ 偶发空壳 | ❌ | — | 元信息实测可读（真实标题 + 时长，重复 8 次全部成功），但审计中**出现过 1 次返回空壳**，所以标为「偶发」。字幕是播放器用私有命令拉取的外挂 `.ass`，接口不返回。 |
| **通用兜底** | ✅ | ✅ | 直链字幕文件 / HLS `#EXT-X-MEDIA:TYPE=SUBTITLES` / DASH 文本轨 / 页面状态扫描 | 对**任何**站点生效。扫描出的候选会**逐个下载验证**，不是字幕的一律排除——不验证就列表的话，优酷的导航 JSON 会被当成字幕轨。 |
| 抖音 | ⚠️ 不保证 | ❌ | — | 需要 `a_bogus` 签名 + `ttwid`/`msToken`，由 VM 混淆 JS 生成；首页是纯前端渲染，服务端拿不到视频地址。 |
| 西瓜视频 | ⚠️ 不保证 | ❌ | — | 页面主体为空 + JSVMP 混淆脚本，接口签名与抖音同源。 |
| 快手 | ⚠️ 不保证 | ❌ | — | 需要 `__NS_sig3`；其视频详情 GraphQL 查询**根本没有字幕字段**（`caption` 是作品文案）。 |
| 微博视频 | ⚠️ 不保证 | ❌ | — | 匿名请求被「新浪访客系统」拦截跳转；站点本身不提供字幕轨。 |
| AcFun | ❌ | ❌ | 通用页面扫描 | 实测两个真实视频页：HTML 里**连视频 id 都不出现**（纯前端渲染空壳），标题、时长都读不到，页面扫描也没扫到任何字幕。插件会如实说明，不会瞎猜。 |

> **爱奇艺已从支持列表中移除。** 实测它的视频页返回 200 + 62KB HTML，但里面一个 `og:` 标签都没有、视频 id 出现 0 次，标题只是站点默认值——纯前端空壳，服务端既拿不到字幕也拿不到元信息。声称支持它没有依据。它的链接现在走通用兜底，会如实报告「扫不到字幕」。相关调研记录保留在 [docs/cn-video-subtitle-spec.md](docs/cn-video-subtitle-spec.md)。

另外，通用兜底同样适用于 YouTube、Vimeo 等非中国站点（YouTube 的 timedtext JSON 形状已支持）。

## B 站字幕需要登录（最重要的一条）

这是 B 站最容易误导人的地方：

> 未登录访客请求字幕列表，接口返回的是 **HTTP 200 + `code: 0` + `subtitles: []`**，
> 与「这个视频确实没有字幕」**完全相同**。

唯一的区分依据是响应里的 **`need_login_subtitle`** 字段。插件会读它，并把两种情况分开报告：

```
接口返回 need_login_subtitle = true：该视频存在字幕，但只有登录后才返回字幕列表。
这不是"没有字幕"，用 video_subtitle_login 扫码登录，或配置 SESSDATA 后重试。
```

### 怎么配置

推荐**扫码登录**，其次才是手动填 SESSDATA。优先级是 `cookies.bilibili` > 环境变量 > 扫码保存的 session —— 显式配置永远压过自动来源。

#### A. 扫码登录（推荐，不用碰开发者工具）

```
video_subtitle_login(action="start")   → 返回二维码图片（写在工作区）和 qrKey
   （把图片给用户，用 B 站手机客户端扫码，在手机上点「确认登录」）
   ↓ 插件在后台每 2–3 秒查一次这个码，用户确认或二维码过期时会自动开新一轮通知 Agent
video_subtitle_login(action="poll", key="<start 的 qrKey>")   → 手动兜底：立刻查一次并保存登录态
video_subtitle_login(action="status")  → 查看当前生效的登录态来源
video_subtitle_login(action="logout")  → 删除扫码保存的登录态
```

自动等待是默认行为，因为「扫码三秒钟、等三分钟」如果交给模型轮询，用户就得为一次
`poll` 多付一整轮对话。只有在 watcher 随进程重启丢失、或用户明确要求时，才需要手动
`poll`（`start` 的返回里带 `watching: true`）。

原理是 B 站官方的 web 扫码接口（`passport.bilibili.com/x/passport-login/web/qrcode/*`），纯服务端 HTTP，不需要浏览器、不需要 geetest。所以它在无头的 Node 宿主里也能用。

登录态写在 `$DSH_HOME/video-srt/session.json`（没有 `DSH_HOME` 时是 `~/.dsh/video-srt/session.json`），文件权限 `0600`。SESSDATA 大约 6 个月过期，过期后重新扫一次即可。

> 注意：如果配置或环境变量里已经有一份 B 站 cookie，它的优先级更高，扫码结果不会生效。`action="status"` 会告诉你当前实际生效的是哪一份。

#### B. 插件配置（DSH 设置面板里该插件条目，或在 profile 的 `cordis.patch.yml` 里覆盖）

```yaml
- id: video-srt
  config:
    cookies:
      bilibili: "SESSDATA=你的值"
```

#### C. 环境变量（密钥不进配置文件）

```powershell
$env:DSH_VIDEO_SRT_BILIBILI_COOKIE = "SESSDATA=你的值"
```

命名规则是 `DSH_VIDEO_SRT_<站点ID>_COOKIE`，例如 `DSH_VIDEO_SRT_QQ_COOKIE`、`DSH_VIDEO_SRT_MGTV_COOKIE`。

手动填的话，SESSDATA 从浏览器开发者工具 → Application → Cookies → `bilibili.com` 里复制。只填 **SESSDATA** 就够了（`bili_jct` 是 CSRF 用的，读字幕不需要）。

## 给其他站点兜底

任何站点都能通过「字幕文件地址」这条路走通。在浏览器里打开视频 → 开发者工具 → Network → 筛选 `vtt` / `srt` / `subtitle` → 复制请求 URL，然后：

```
video_subtitle_get(url="<视频页地址>", directUrl="<复制到的字幕地址>")
# 或者直接：
video_subtitle_parse(url="<复制到的字幕地址>")
# 或者已经有文本了：
video_subtitle_parse(text="<粘贴 SRT/VTT/ASS/LRC/JSON>")
```

HLS 站点尤其好办：把 `.m3u8` 主播放列表地址交进来，插件会读 `#EXT-X-MEDIA:TYPE=SUBTITLES`，再把分片里的 WebVTT 拼起来。

## 配置项

全部字段都是 `.volatile()`，在 DSH 设置面板里改**即时生效**（不需要重启，也不需要重载）。

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关。关闭时完全不注册任何工具。 |
| `announceToAgent` | `true` | 是否在系统提示里向模型介绍这些工具。 |
| `cookies` | `{}` | 按站点 ID 的 cookie 头，如 `{ bilibili: "SESSDATA=..." }`。 |
| `cookieEnv` | `true` | 是否回落到 `DSH_VIDEO_SRT_<SITE>_COOKIE` 环境变量。 |
| `requestTimeoutMs` | `15000` | 单次请求超时。 |
| `requestRetries` | `2` | 瞬时失败（超时/429/5xx）的重试次数，指数退避。 |
| `minRequestIntervalMs` | `200` | 同一主机的请求最小间隔，避免触发频控。 |
| `cacheTtlSeconds` | `600` | 会话内字幕缓存时长。B 站字幕链接里的 `auth_key` 只有分钟级有效期，缓存因此偏短。 |
| `maxCaptionChars` | `120000` | 单次工具结果的字数上限。 |
| `defaultReadLimit` | `80` | `video_subtitle_read` 默认每页条数。 |

## 架构

```
index.js                     插件入口：注册工具、系统提示、配置、会话缓存
lib/
  subtitle.js                字幕格式层：SRT/VTT/ASS/LRC/JSON 解析、归一化、序列化、检索、切片
  http.js                    传输层：浏览器身份、cookie 合并、超时、限速、重试、代理
  page-scan.js               通用发现：<track> / 页面状态 / HLS / DASH / 直链，含「像不像字幕」判定
  sites.js                   适配器注册表与路由
  sites/
    bilibili.js              完整实现（含 WBI 签名、PGC、AI 字幕、多 P）
    mgtv.js                  完整实现（tk2 签名）
    qq.js                    完整实现（AES cKey 签名）
    generic.js               通用兜底（直链 / HLS / DASH / 页面扫描 + 候选探针）
    base.js                  适配器共用件（页面获取、扫描桥接、元信息读取、诚实空结果）
    unsupported.js           无法服务端抓取的站点的适配器工厂
    youku.js douyin.js ixigua.js kuaishou.js weibo.js acfun.js
  login.js                   B 站扫码登录：申请二维码、轮询状态、从两种来源提取 SESSDATA
  watcher.js                 扫码后台等待循环：确认 / 过期 / 网络抖动 / 主动停止，时钟可注入
  wake.js                    唤醒问话的 Agent（Agent.followup）；宿主包缺失时手工构造同形消息
  qr.js                      二维码渲染：qrcode-generator 出矩阵，PNG 由 node:zlib 手写
  session.js                 登录态持久化（0600，$DSH_HOME 优先）
```

设计上的三个要点：

1. **一切归一到 `SubtitleDocument`。** 适配器只负责产出 `{from, to, text}` 三元组，检索、分页、导出、去重、序列化全部自动继承。
2. **无法抓取的站点也要给出具体原因。** 返回「优酷的字幕是外挂 `.ass`，接口不返回」远好过返回「不支持」——模型可以把这句话如实转告用户。
3. **扫描结果必须被验证。** 通用扫描和「无法抓取」适配器找到的候选地址，都会先下载并确认「像字幕」才作为轨道提供，否则记录为排除原因。这条规则是审计中补上的：曾经候选未经校验就列表，导致优酷页面状态里的导航路径（`detail`、`planet`）被当成 2 条字幕轨，唯一一条 cue 的内容是 CSS `html { min-width: 1239px; }`。

## 开发与测试

```bash
npm install          # @deepseek-ai/schemastery（由 profile 提供）与 qrcode-generator（零依赖）
npm test             # node --test，127 个用例，全部离线
```

测试分六层：

- `test/subtitle.test.mjs` — 格式层。每个解析器都喂给它最容易出错的那种输入：零长度 cue、含逗号的 ASS 文本、双语 cue 里的换行、带标记的 WebVTT、协议相对地址、错误标注格式的 JSON。
- `test/sites.test.mjs` — 适配器与签名。MD5/WBI 用官方测试向量逐位校验（`mixinKey`、`w_rid` 都与文档一致）；cookie 合并、URL 升级、站点路由、`Host` 伪装防护。
- `test/transport.test.mjs` — 端到端，跑在真实的本地 HTTP 服务器上：走真实传输层、真实扫描器、真实工具实现，只有「视频网站」是假的。
- `test/login.test.mjs` — 扫码登录。把全局 `fetch` 换成假响应，因此真实传输层仍然在跑：轮询状态机（未扫码 / 已扫未确认 / 失效 / 成功）、SESSDATA 的两种来源、session 文件损坏容错与掩码、PNG/矩阵结构、cookie 来源优先级，以及「`start` 之后后台自己等到确认并唤醒 Agent」这条端到端路径。
- `test/watcher.test.mjs` — 后台等待循环，用假时钟驱动：确认只报一次、无人扫码按截止时间超时、服务端报失效、请求失败退避重试、`stop()` 之后两个回调都不再触发。
- `test/wake.test.mjs` — 唤醒：没有 Agent 时安静返回、消息以 user 角色带 id 进 `followup`、宿主拒绝时不把异常抛进登录流程。

还有一项针对**真实 DSH 运行时**的验证（不在 `npm test` 里，因为它需要宿主提供的 `@deepseek-ai/*` 包）：

```bash
node tools/verify-runtime.mjs
```

它把插件挂到真正的 `ToolRuntime` 与 `SystemPrompt` 上，因此能验证桩件验证不了的东西：每个工具定义都通过注册表自己的 schema 检查、每个 canonical value 都通过输出 schema 校验、`execute → output.render` 产出的就是模型会看到的内容、参数确实是裸 JSON Schema（而不是被 `defineTool` 编译过的对象）、系统提示段落能注册/渲染/释放。

需要真实网络的验证脚本在 `tools/`：

```bash
node tools/audit-sites.mjs          # 逐站审计：元信息 / 字幕轨 / 能否下载，支持 site=url 指定地址
node tools/probe-login.mjs          # B站扫码登录全链路（需要真人扫码）
node tools/probe-adapter-bili.mjs   # B站：元信息、need_login_subtitle、番剧 ms→s 换算
node tools/probe-adapter-qq.mjs     # 腾讯：默认参数即可跑通签名与 getvinfo
node tools/probe-qq-hunt.mjs        # 扫描腾讯各频道，寻找带公开字幕的视频
```

`tools/audit-sites.mjs` 是上面那张能力表的来源。它按「元信息 → 字幕轨 → 实际下载」三级验证，首页抓不到内容链接的站点可以这样指定地址：

```bash
node tools/audit-sites.mjs "mgtv=https://www.mgtv.com/b/755558/22865682.html"
```

`docs/cn-video-subtitle-spec.md` 是支撑这些适配器的调研文档：各站点接口、签名算法、错误码、可达性，每条结论都标注了证据等级（文档 / 代码 / 实测）以及未能验证的部分。

## 已知限制

- **注册表不强制 `required`。** DSH 的工具注册表只在模型侧把 `required` 列表交给 provider 的 function-calling schema；调用时并不会拦截缺失参数（那是 `defineTool` 定义的附加校验）。本插件的工具都是普通定义，所以每个工具自身都会对缺失/非法输入给出可读的报错。已验证：`video_site_detect` 缺 `url` 时返回「url 是必需的」。
- **B 站字幕需要登录**（见上）。没有 SESSDATA 时只能拿到元信息 —— 但插件会明确告诉你「需要登录」，不会谎报「没有字幕」。推荐用 `video_subtitle_login` 扫码，不必再去开发者工具里翻 cookie。
- **只有 B 站真能拿到字幕。** 腾讯视频 / 芒果TV / 优酷能拿到元信息但列不出可用字幕轨；AcFun / 抖音 / 西瓜 / 快手 / 微博视频 连元信息都不保证。这是 `tools/audit-sites.mjs` 逐站实测的结论，不是推测。
- **腾讯视频**的 `sfl.fi[]` 字幕字段从未观察到非空样本（多个真实视频均为 0 条）。签名与元信息信封已实测通过。
- **芒果TV** 的 `video/title` 确实返回真字幕列表（实测 18 轨，含简体中文/English/泰语），但每轨的 `vod.do` 地址在 `pcweb.api.mgtv.com` 上不存在（`No handler found`），`player/video` 响应里也没有 `stream_domain`，因此取不到 `.srt`。插件探测一条失败后即判定整组不可用，不列出下载不了的轨道。
- **腾讯 PGC / 会员内容**需要 `vqq_vusession` 之类的登录 cookie。不过公开内容也没观测到字幕，所以这条只作为「若有字幕，会员轨还需要登录」的说明，不代表公开内容一定有。
- **代理**：Node 的全局 `fetch` 会忽略 `HTTPS_PROXY`；插件在检测到代理环境变量时会自动挂载 undici 的 `EnvHttpProxyAgent`，但如果你用的是 PAC 或需要认证的代理，可能需要自行配置。
- **通用页面扫描**只读取服务端返回的 HTML。纯前端渲染（CSR）页面里由 JS 生成的字幕地址扫不到，这时请用浏览器开发者工具取出字幕地址。
- **空壳页会被识别出来，而不是把站点标题当成视频标题。** 爱奇艺 / 抖音 / 西瓜这类页面会返回 200 + 几十 KB HTML，但里面一个 `og:` 标签都没有，连视频 id 都不出现，`<title>` 只是站点自己的默认标题（例如「爱奇艺-在线视频网站-海量正版高清视频在线观看」）。插件判定为空壳后，标题显示「未能解析标题」、时长显示「未知」，并在说明里讲清楚；`video_subtitle_get` 的报错也会带上这条原因，不会只丢一句 cmd5x 签名。
- **扫码登录只覆盖 B 站。** 腾讯 / 芒果没有公开的扫码接口；它们的字幕大多不需要登录，只有会员内容才要，收益太低。其他站点仍走配置或环境变量。
- **登录态是磁盘上的凭据。** `session.json` 以 `0600` 写入，`action="status"` 只回显掩码后的值；但如果你所在的环境连本地凭据文件都不接受，就继续用环境变量而不必用扫码。
- **二维码 180 秒失效。** `action="start"` 每次都会生成新的 `qrKey`，旧的作废（旧的后台等待也会被停掉，避免两个码各自报警）；确认或过期时插件会自己唤醒 Agent，Agent 收到「已失效」的通知后再生成新码即可。

## 许可证

随本仓库所在项目一同授权。
