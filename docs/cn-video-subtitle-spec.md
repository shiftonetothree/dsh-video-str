# Subtitle & Metadata Extraction Contract — Chinese Video Platforms

**Target implementer:** Node.js ≥ 20, global `fetch`, no browser. All shapes below are traceable to a cited source; each is tagged **[DOC]** (verified from a documentation/spec source), **[CODE]** (reported by third-party code, cited by repo+file), or **[LIVE]** (verified in this research by an actual HTTP probe, with the observed output quoted).

> **Critical sourcing note.** The authoritative community reference `SocialSisterYi/bilibili-API-collect` was **taken down**: the default branch is now literally named `deprecated` and contains only `README.md` + `reason.jpg` (verified via the GitHub API). All `[DOC]` citations below therefore point at the maintained contributor mirrors **`pskdje/bilibili-API-collect`** and **`xiaoyv404/bilibili-API-collect`**, which carry the same `docs/` tree. See [Sources](#sources).

---

## Part 0 — Quick reference: which calls actually need what

| Call | WBI sign? | Cookies? | Verdict |
|---|---|---|---|
| `GET /x/web-interface/view` | no | no | anonymous OK **[LIVE]** |
| `GET /x/web-interface/wbi/view` | **not enforced** | no | anonymous OK **[LIVE]** |
| `GET /x/player/v2` | no | **SESSDATA for non-empty `subtitles[]`** | anonymous returns `200 code:0` + `subtitles:[]` **[LIVE]** |
| `GET /x/player/wbi/v2` | **advisory** | **SESSDATA for non-empty `subtitles[]`** | anonymous unsigned returned `code:0` in testing **[LIVE]**; sign anyway |
| `GET /x/player/wbi/playurl` | **yes** | SESSDATA for ≥720P | `-352`/`401` when wrong **[CODE yt-dlp]** |
| subtitle CDN JSON (`aisubtitle.hdslb.com` / `i0.hdslb.com`) | no | no | plain GET; `auth_key` is time-limited **[CODE]** |
| `GET /x/frontend/finger/spi` | no | no | `buvid3`/`buvid4` **[LIVE]** |
| `GET /x/web-interface/nav` | no | no | returns WBI keys even when `code:-101` **[LIVE]** |

**Bottom line for Bilibili:** full metadata is reachable **without login**; the **subtitle list is the only login-gated step** for UGC. Everything else in the chain is anonymous.

---

# Part 1 — Bilibili (哔哩哔哩)

## 1.1 Video identity: parsing ids out of URLs

### 1.1.1 Identifier glossary

| Id | Type | Meaning | Where it comes from |
|---|---|---|---|
| `bvid` | string | `BV1...` archive id (modern) | URL, or `data.bvid` |
| `aid` | number | numeric archive id (legacy `av`) | URL, or `data.aid` |
| `cid` | number | **per-part** content id — the id subtitles are keyed on | `data.pages[].cid` |
| `ep_id` | number | PGC *episode* id (`ep...`) | `/bangumi/play/ep...` URL |
| `season_id` | number | PGC *season* id (`ss...`) | `/bangumi/play/ss...` URL |
| `media_id` | number | PGC *media* id (`md...`) | `/bangumi/media/md...` URL |

`aid`/`bvid` identify a **whole submission**; `cid` identifies **one part**. Subtitles are attached to `cid`.

### 1.1.2 URL forms to accept

| URL form | Extraction |
|---|---|
| `https://www.bilibili.com/video/BV1MU411S7iJ` | `bvid = BV1MU411S7iJ`; part = 1 |
| `https://www.bilibili.com/video/BV1MU411S7iJ/?p=2` | `bvid`; **part = 2** |
| `https://www.bilibili.com/video/av170001` | `aid = 170001` |
| `https://m.bilibili.com/video/BV1MU411S7iJ` | same as `www` — host is irrelevant, path is `/video/<id>` |
| `https://b23.tv/BV1MU411S7iJ` | **short link → HTTP 302** |
| `https://b23.tv/av170001` | **short link → HTTP 302** |
| `https://www.bilibili.com/bangumi/play/ep606591` | `ep_id = 606591` (**PGC**) |
| `https://www.bilibili.com/bangumi/play/ss42290` | `season_id = 42290` (**PGC**) |
| `https://www.bilibili.com/bangumi/media/md28220978` | `media_id = 28220978` |
| `https://www.bilibili.com/festival/<slug>?bvid=BV...` | `bvid` from the **query string** **[CODE]** `bilibili.py` `_VALID_URL` |

**Short-link resolution — verified [LIVE]:**

```
GET https://b23.tv/BV1MU411S7iJ   → 302, Location: https://www.bilibili.com/video/BV1MU411S7iJ
GET https://b23.tv/av170001       → 302, Location: https://www.bilibili.com/video/av170001
```

Implementation: `fetch(shortUrl, { redirect: 'manual' })` and read the `location` header, then re-parse. `b23.tv` redirects do **not** need cookies. Do **not** use `redirect:'follow'` — the landing page is a large HTML document, and the redirect target is what you want.

### 1.1.3 UGC vs PGC — what actually differs

This is the single most common source of bugs. Verified by live probing **[LIVE]**:

| | UGC (`/video/BV...`) | PGC (`/bangumi/play/ep...`) |
|---|---|---|
| Metadata endpoint | `/x/web-interface/view?bvid=` or `?aid=` | `/pgc/view/web/season?ep_id=` or `?season_id=` |
| Response envelope key | `data` | **`result`** (not `data`!) |
| Title field | `data.title` | `result.season_title` (season) / `result.episodes[].title` + `long_title` (episode) |
| Owner | `data.owner.name` / `.mid` | `result.up_info` — **often absent** |
| Part list | `data.pages[]` (`page` is 1-based) | `result.episodes[]` (`ep_id`, **no `page` number**) |
| `cid` | `data.pages[N-1].cid` | `result.episodes[N-1].cid` |
| **Player call** | `?bvid=|aid=` **+ `cid`** | `?ep_id=` **+ `cid`** (see 1.3.2 — `ep_id` alone fails) |
| `?p=N` | yes | no — episodes are separate URLs |

**PGC media→season→episode resolution:** `/pgc/view/web/season` accepts `season_id` **or** `ep_id` and always returns the **whole season** with `result.season_id`, `result.media_id`, and `result.episodes[]`. So one call resolves any of `ep_id`/`season_id`, and you can enumerate episodes from it. For `media_id` (from `/bangumi/media/md...`) use `GET https://api.bilibili.com/pgc/review/user?media_id=<md>` → `result.media.season_id` **[DOC]**.

> **Trap [LIVE]:** a `/video/BV...` URL can point at PGC content. In that case `data.redirect_url` is present and populates the `av`/`bv` → `ep` redirect **[DOC]**. Detect `data.redirect_url` (or `data.is_ogv`) and switch to the PGC path. In my probe of `BV1MU411S7iJ`, `redirect_url` was `undefined` but `season_id: 3541247` was present — `season_id` on a `/video/` response is **not** sufficient to conclude PGC.

---

## 1.2 Step 1 — video metadata: `GET /x/web-interface/view`

```
GET https://api.bilibili.com/x/web-interface/view?bvid=BV1MU411S7iJ
GET https://api.bilibili.com/x/web-interface/view?aid=1906473802
```

**Query params [DOC]** (`docs/video/info.md`)

| Param | Type | Required | Note |
|---|---|---|---|
| `aid` | num | one of `aid`/`bvid` | 稿件 avid |
| `bvid` | str | one of `aid`/`bvid` | 稿件 bvid |

Auth: `Cookie(SESSDATA)` — "限制游客访问的视频需要登录" (videos restricted to guests need login) **[DOC]**. Anonymous works for ordinary videos **[LIVE]**.

A WBI-signed twin exists at `https://api.bilibili.com/x/web-interface/wbi/view` **[DOC]**. **Verified [LIVE]: it accepted an unsigned request and returned `code:0`** — so signing is currently not enforced here. Sign it anyway for forward-compatibility (it costs nothing).

**Envelope [DOC]:**

```jsonc
{ "code": 0, "message": "OK", "ttl": 1, "data": { /* ... */ } }
```

`code` values for this endpoint **[DOC]**: `0` success, `-400` bad request, `-403` insufficient permission, `-404` no such video, `62002` 稿件不可见 (archive not visible), `62004` 稿件审核中 (under review), `62012` 仅UP主自己可见 (only the uploader can see it).

**`data` fields you need [DOC] + [LIVE]:**

| Field | Type | Use |
|---|---|---|
| `bvid` | str | canonical id |
| `aid` | num | canonical numeric id |
| `cid` | num | **1P cid** — equals `pages[0].cid` |
| `videos` | num | part count (default 1) |
| `title` | str | title |
| `desc` | str | description |
| `pic` | str | cover URL (**http**, not https) |
| `duration` | num | **total** duration of all parts, seconds |
| `pubdate`, `ctime` | num | Unix seconds |
| `owner` | obj | `{ mid, name, face }` |
| `pages` | array | part list — **the cid source** |
| `subtitle` | obj | `{ allow_submit, list[] }` — usually `list: []` anonymous **[LIVE]** |
| `stat` | obj | `{ view, danmaku, reply, favorite, coin, share, like, ... }` |
| `dimension` | obj | `{ width, height, rotate }` of 1P |
| `redirect_url` | str | **present only for PGC-backed videos** — redirect to `ep` |
| `is_ogv` | bool | PGC indicator |
| `season_id` | num | present for collection/PGC-backed videos |
| `ugc_season` | obj | collection info (`sections[].episodes[]`) — each episode carries its own `aid`/`cid`/`bvid`/`pages` |
| `staff` | array | collaboration credits (absent for solo videos) |

**`data.pages[]` [DOC]:**

| Field | Type | Note |
|---|---|---|
| `cid` | num | **part cid — the value subtitles are keyed on** |
| `page` | num | **1-based** part number |
| `part` | str | part title |
| `duration` | num | part duration, seconds |
| `from` | str | `vupload` (Bilibili), `hunan` (MangoTV), `qq` (Tencent) |
| `vid` | str | off-site video id (only for off-site parts) |
| `weblink` | str | off-site jump URL |
| `dimension` | obj | `{ width, height, rotate }` |

**Selecting the `cid` for `?p=N` — the exact rule:**

```js
const p = Number(new URL(url).searchParams.get('p') ?? 1);   // 1-based, default 1
if (!Number.isInteger(p) || p < 1 || p > data.pages.length) throw new Error('part out of range');
const { cid } = data.pages[p - 1];                            // pages[] is 0-indexed, page is 1-based
```

Do **not** use `data.cid` when `?p` is present — `data.cid` is always 1P. Note that `page` is not guaranteed contiguous in hostile responses; prefer matching `pages[i].page === p` with a fallback to index arithmetic.

**Live verification [LIVE]:**

```
GET /x/web-interface/view?bvid=BV1MU411S7iJ
→ code 0, aid 1906473802, cid 1625992822, videos 1, duration 181
  owner "Session小胡" mid 645769214
  pages [{ cid: 1625992822, page: 1, part: "Linux小寄巧: ...", duration: 181 }]
  subtitle { allow_submit: false, list: [] }

GET /x/web-interface/view?bvid=BV1bK411W797        (23-part video)
→ videos 23, pages[2].cid = 191559859, pages[2].part = "Ambivalent World/战场原+神原"
```

---

## 1.3 Step 2 — subtitle track list: `GET /x/player/v2` or `/x/player/wbi/v2`

```
GET https://api.bilibili.com/x/player/wbi/v2?aid=1906473802&cid=1625992822&w_rid=<md5>&wts=<ts>
GET https://api.bilibili.com/x/player/v2?aid=1906473802&cid=1625992822
```

**Query params [DOC]** (`docs/video/player.md`)

| Param | Type | Required | Note |
|---|---|---|---|
| `aid` | num | one of `aid`/`bvid` | |
| `bvid` | str | one of `aid`/`bvid` | |
| `cid` | num | **yes** | |
| `season_id` | num | no | PGC season |
| `ep_id` | num | no | PGC episode |
| `w_rid` | str | no (see below) | WBI signature |
| `wts` | num | no (see below) | Unix seconds |

### 1.3.1 Response path to the subtitle list

```
data.subtitle.subtitles[]        ← the track list
```

**`data.subtitle` object [DOC] + [LIVE]:**

| Field | Type | Note |
|---|---|---|
| `allow_submit` | bool | whether the viewer may submit CC |
| `lan` | str | **streamer-selected default** language, `""` when none |
| `lan_doc` | str | display name of the default |
| `subtitles` | array | **`[]` when not logged in** **[DOC]**: "不登录为 `[]`" |
| `subtitle_position` | null/obj | observed present in live responses, not in older docs **[LIVE]** |
| `font_size_type` | num | observed present in live responses **[LIVE]** |

**Every field of a `subtitles[]` entry [DOC]** (`docs/video/player.md`):

| Field | Type | Meaning |
|---|---|---|
| `id` | num | subtitle id (int64) |
| `id_str` | str | same value as a **string** — "和 id 不一样" (differs from `id`); **use `id_str`**, JS `Number` loses precision at this magnitude (e.g. `13643112644608002`) |
| `lan` | str | language tag, e.g. `zh-Hans`, `zh-CN`, `en-US`, `ai-zh` |
| `lan_doc` | str | display name, e.g. `中文（简体）`, `中文（自动生成）` |
| `is_lock` | bool | **locked track — see 1.7** |
| `subtitle_url` | str | JSON file URL — **may be protocol-relative** |
| `type` | num | observed `0` for submitted CC, `1` for AI-generated **[DOC example]** |
| `ai_status` | num | AI subtitle state — see 1.8 |
| `ai_type` | num | AI subtitle type; `0` in observed data |

In the **`view`** response the equivalent list is `data.subtitle.list[]` and carries `author` too **[DOC]**:

| Field | Type |
|---|---|
| `id`, `lan`, `lan_doc`, `is_lock`, `subtitle_url` | as above |
| `author_mid` | num |
| `author` | obj `{ mid, name, sex, face, sign, rank, birthday, is_fake_account, is_deleted, in_reg_audit, is_senior_member, name_render }` |
| `id_str`, `ai_type`, `ai_status` | observed in the doc's own example **[DOC]** |

> **Observed real example [DOC, `docs/video/info.md` example]:** a video whose `subtitle.list[]` contained exactly one entry with `lan: "ai-zh"`, `lan_doc: "中文（自动生成）"`, `is_lock: false`, **`subtitle_url: ""`**, `type: 1`, `ai_status: 2`. **This is the "AI subtitle still generating" state — an entry can exist with an empty URL and must be skipped.**

### 1.3.2 `ep_id` quirk — verified, and it contradicts the doc

**[DOC]** lists `ep_id`/`season_id` as optional params on `/x/player/v2`, implying `?ep_id=<n>` should work. **My live probes say otherwise [LIVE]:**

```
GET /x/player/v2?ep_id=606591                    → code -400  请求错误
GET /x/player/v2?ep_id=606591&cid=772096113      → code -400  请求错误
GET /x/player/wbi/v2?ep_id=606591&cid=772096113  → code -400  请求错误
GET /x/player/v2?season_id=42290&ep_id=606591&cid=772096113 → code -400
GET /x/player/v2?aid=300876247&cid=772096113     → code 0    OK   ✓
```

**Working rule: for PGC, resolve `ep_id` → `aid` via `/pgc/view/web/season`, then call the player endpoint with `aid` + `cid`.** `2024-08-30` doc examples themselves use `aid=60977932&cid=106101299` for a bangumi episode, not `ep_id` — consistent with my finding.

Also verified **[LIVE]**: `/x/player/v2?aid=<aid>` **without `cid`** → `-400`. `cid` is unconditionally required.

### 1.3.3 The `subtitle_url` must be upgraded to `https:`

`subtitle_url` is frequently **protocol-relative**, e.g. **[DOC example]**:

```
"subtitle_url": "//aisubtitle.hdslb.com/bfs/subtitle/c49b18a284739d99df1e3723cdf72c0c82db98e0.json?auth_key=1725003260-5d0391a07f4f47f6960f60cf5045dff3-0-fc16c1f67a6b41edcb2a89d5e0c9bfdd"
```

A bare `fetch('//aisubtitle...')` **fails** — Node interprets it as a protocol-relative URL with no base. Normalize:

```js
const abs = (u) => (u.startsWith('//') ? `https:${u}` : u);
```

This exact normalization is what the reference implementations do **[CODE `bili_ai_subtitle/src/bili_ai_subtitle/cli.py` `normalize_subtitle_url()`]**.

Note the `auth_key` query string: it is a **time-limited signature** of the form
`<unix_ts>-<32 hex>-0-<32 hex>`. It expires within minutes; fetch the JSON promptly after listing. **Do not truncate the URL** — dropping the trailing `-0-<32hex>` yields `403` **[CODE]**.

---

## 1.4 Step 3 — the subtitle JSON body

Plain `GET` on the resolved `subtitle_url`. Send a `Referer` for safety **[CODE]**.

**Top-level shape — tiered by confidence:**

| Field | Type | Confidence |
|---|---|---|
| `body` | array | **[DOC]** — this is the only field ever read in practice |
| `font_size` | number | **unverified** — reported as `0.4` |
| `font_color` | string | **unverified** — reported as `"#FFFFFF"` |
| `background_alpha` | number | **unverified** — reported as `0.5` |
| `background_color` | string | **unverified** |
| `Stroke` | string | **unverified** (capital `S`) |

> **Honesty note on the presentation fields.** Three independent sources repeat the same six-field `{font_size, font_color, background_alpha, background_color, Stroke, body}` shape, but I could **not** verify them against a primary source: the official `bilibili-API-collect` docs do not document the subtitle *file* format at all, and I could not fetch a live subtitle file because every reachable video's `subtitles[]` is empty without SESSDATA. **The only field any real implementation reads is `body`.** Parse the rest defensively (ignore unknowns; treat missing presentation fields as optional). Do not build logic that depends on them.

**A `body[]` entry — this part is well-established:**

| Field | Type | Unit | Note |
|---|---|---|---|
| `from` | number (float) | **seconds** | start time |
| `to` | number (float) | **seconds** | end time |
| `location` | number (int) | — | vertical position hint; observed `2` |
| `content` | string | — | the text |

Corroboration across independent implementations:

- **[CODE `hudawei996/downkyi`, `src/DownKyi.Core/BiliApi/Models/Json/Subtitle.cs`]** declares exactly `float From`, `float To`, `int Location`, `string Content` mapped to `"from"`, `"to"`, `"location"`, `"content"`.
- **[CODE `nanashi-1/bilibili-extractor-lib`, `subtitle.rs`]** declares `JsonSubtitle { body: Vec<JsonSubtitleBody> }` with `JsonSubtitleBody { from: f32, to: f32, content: String }` — note it *omits* `location` entirely and still deserializes real files, so `location` must be treated as optional.
- **[CODE `yt-dlp/yt_dlp/extractor/bilibili.py` `json2srt()`]** iterates `json_data.get('body')` and reads only `line["from"]`, `line["to"]`, `line["content"]`.

**Seconds, float — confirmed.** `yt-dlp` converts with `srt_subtitles_timecode(line["from"])` directly, treating it as seconds.

**Realistic minimal schema (what to write):**

```jsonc
{
  "font_size": 0.4,              // optional, unverified
  "font_color": "#FFFFFF",       // optional, unverified
  "background_alpha": 0.5,       // optional, unverified
  "background_color": "#9C27B0", // optional, unverified
  "Stroke": "1.5",               // optional, unverified (capital S)
  "body": [
    { "from": 10.24, "to": 13.5, "location": 2, "content": "这是字幕内容" }
  ]
}
```

### Can `content` contain newlines or entities?

**Newlines: yes, in practice.** Bilingual CC subtitles use a newline to separate the two languages within one cue. Practical consequence: **when writing SRT, emit `content` verbatim and do not re-write internal newlines as cue separators** — write a single blank line to terminate each cue, then the raw `content` (which may itself be two lines).

**HTML entities: not observed.** No source I found performs entity decoding on `content`, and `yt-dlp` writes it straight through to SRT **[CODE]**. The Chinese-commentary `yt-dlp` path unescapes nothing. Treat `content` as **plain text**; do not `html-unescape` (that would corrupt literal `&amp;`-looking text) and do not strip tags, but do `.trim()` for the empty-content skip check, as the reference CLI does **[CODE `bili_ai_cli.py`: `content = str(item.get("content", "")).strip()`]**. Note that `title`/`desc` from the **`view`** endpoint *are* raw HTML-bearing strings on other endpoints (e.g. search results contain `<em class="keyword">`), but that does not apply to subtitle `content`.

**Sorting / filtering:** `body` is normally already time-ordered. Sort by `from` defensively; drop entries with empty `content` after trimming. `yt-dlp` guards with `l['content'] and l['from'] and l['to']` **[CODE `bilibili.py` BiliIntlBaseIE.json2srt]**.

---

## 1.5 WBI signature scheme (2023+ `w_rid` / `wts`)

**Status [DOC]** (`docs/misc/sign/wbi.md`): since March 2023 the Bilibili web frontend signs certain REST calls by adding `w_rid` and `wts` to the query string. It is described as an independent web risk-control measure. When `w_rid`/`wts` are missing or wrong, WBI-protected endpoints respond with a **`v_voucher`** challenge instead of the payload:

```json
{"code":0,"message":"0","ttl":1,"data":{"v_voucher":"voucher_******"}}
```

**This is the signature-detection signal** — `{"code":0, ... "data":{"v_voucher": ...}}` means "you were treated as unsigned", *not* success. Always check for it.

### 1.5.1 Step 1 — obtain `img_key` / `sub_key`

```
GET https://api.bilibili.com/x/web-interface/nav
```

**Verified [LIVE]:**

```json
{"code":-101,"message":"账号未登录","ttl":1,
 "data":{"isLogin":false,
   "wbi_img":{"img_url":"https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png",
              "sub_url":"https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png"}}}
```

**[DOC]** explicitly states: **`code:-101` (not logged in) still returns both keys** — so do **not** treat `-101` as failure here. `img_url`/`sub_url` look like PNG URLs but are **disguised live tokens**: "无需且不能试图访问这两个 url" (there is no need and no ability to visit them). Derive the keys by taking the **basename without the `.png` extension**:

```js
const key = (u) => u.slice(u.lastIndexOf('/') + 1, u.lastIndexOf('.'));
const img_key = key(data.wbi_img.img_url);   // "7cd084941338484aae1ad9425b84077c"
const sub_key = key(data.wbi_img.sub_url);   // "4932caff0ff746eab6f01bf08b70ac45"
```

**[DOC]** notes the keys are **shared site-wide and rotate daily** → **cache them** with a refresh (the doc recommends caching; `yt-dlp` uses a **30-second** cache and comments "exact expire timeout is unclear" **[CODE `bilibili.py`: `_WBI_KEY_CACHE_TIMEOUT = 30`]**). A sane compromise for a library: cache for 1 hour, refresh on any signing failure, and always re-fetch once before surfacing an error.

An alternative source for the same keys is the `bili_ticket` endpoint (`img`/`sub` fields) **[DOC]**, and `yt-dlp` additionally spawns a *third* path — some pages embed `wbiImgKey`/`wbiSubKey` in SSR `__INITIAL_STATE__` **[DOC]**, "具体可用性与区别尚不明确" (availability and difference unclear). **Use `/nav`; ignore the others.**

### 1.5.2 Step 2 — the `mixinKeyEncTab` permutation (all 64 indices)

**[DOC]**. Concatenate `img_key + sub_key` to get `raw_wbi_key` (length 64 hex chars), then take `raw_wbi_key[mixinKeyEncTab[i]]` for `i = 0..63` and **keep the first 32 characters**.

```rust
// [DOC] docs/misc/sign/wbi.md — verbatim
const MIXIN_KEY_ENC_TAB: [u8; 64] = [
    46, 47, 18,  2, 53,  8, 23, 32, 15, 50, 10, 31, 58,  3, 45, 35, 27, 43,  5, 49,
    33,  9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48,  7, 16, 24, 55, 40,
    61, 26, 17,  0,  1, 60, 51, 30,  4, 22, 25, 54, 21, 56, 59,  6, 63, 57, 62, 11,
    36, 20, 34, 44, 52,
];
```

As one line (copy-paste ready):

```js
const MIXIN_KEY_ENC_TAB = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52];
```

**Test vector [DOC], independently reproduced in this research [LIVE]:**

```
img_key  = "7cd084941338484aae1ad9425b84077c"
sub_key  = "4932caff0ff746eab6f01bf08b70ac45"
mixinKey = "ea1db124af3c7062474693fa704f4ff8"     ✓ matched exactly
```

### 1.5.3 Step 3 — `w_rid` = md5(query + mixin_key)

Algorithm **[DOC]**, in order:

1. Set `wts` = current Unix time in **seconds** (integer).
2. Sort all params (including `wts`) by **key ascending**.
3. **Remove the characters `!`, `'`, `(`, `)`, `*` from every value.** (The doc's Python demo literally does `''.join(filter(lambda chr: chr not in "!'()*", str(v)))`; the Go demo marks this "必要性存疑?" — necessity doubtful — but every implementation does it, so do it.)
4. Percent-encode key and value with **`encodeURIComponent` semantics**: uppercase hex, and **space → `%20`, NOT `+`**. The doc is explicit that some libraries get this wrong both ways.
5. Join as `k=v&k=v...`.
6. `w_rid = md5(query + mixin_key)` as lowercase hex.
7. Append `w_rid` and `wts` to the **original, unsorted** query. **[DOC]**: "目前看来无需对原始请求参数排序" — no need to sort the real request.

**Test vector 1 [DOC] — reproduced exactly [LIVE]:**

```
input  {foo:'114', bar:'514', zab:1919810}, wts=1702204169
sortQuery = "bar=514&foo=114&wts=1702204169&zab=1919810"
w_rid     = "8f6f2b5b3d485fe1886cec6a0be8c5d4"    ✓ MATCH
final     = "bar=514&foo=114&zab=1919810&w_rid=8f6f2b5b3d485fe1886cec6a0be8c5d4&wts=1702204169"
```

**Test vector 2 [DOC] — encoding rules, reproduced exactly [LIVE]:**

```
input {foo:'one one four', bar:'五一四', baz:1919810}, wts=1702204169
sortQuery = "bar=%E4%BA%94%E4%B8%80%E5%9B%9B&baz=1919810&foo=one%20one%20four&wts=1702204169"   ✓ MATCH
```

### 1.5.4 Which endpoints require WBI

| Endpoint | WBI | Evidence |
|---|---|---|
| `/x/player/wbi/playurl` | **required** | `-352`/`401` otherwise **[CODE yt-dlp]** |
| `/x/space/wbi/acc/info` | **required** | `v_voucher` otherwise **[DOC]** |
| `/x/player/wbi/v2` | advisory | returned `code:0` unsigned **[LIVE]**; sign anyway |
| `/x/web-interface/wbi/view` | advisory | returned `code:0` unsigned **[LIVE]** |
| `/x/web-interface/view` | no | non-WBI twin |
| `/x/player/v2` | no | non-WBI twin |
| `/x/web-interface/nav` | no | it *issues* the keys |

**Design guidance:** implement `wbiSign()` unconditionally and route every `/wbi/`-path request through it; keep the unsigned twin as a fallback. Detecting "signature rejected" = response contains `data.v_voucher`, **or** `code === -352`.

### 1.5.5 Complete, self-contained Node ≥20 implementation

```js
// wbi.mjs — Node >= 20, no dependencies beyond node:crypto
import { createHash } from 'node:crypto';

const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
  61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
  36, 20, 34, 44, 52,
];

const md5 = (s) => createHash('md5').update(s, 'utf8').digest('hex');
const BILI_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Referer: 'https://www.bilibili.com/',
  Origin: 'https://www.bilibili.com',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
};

// --- WBI keys -------------------------------------------------------------
let wbiCache = { key: null, ts: 0 };
const WBI_TTL_MS = 60 * 60 * 1000; // keys rotate daily; 1h is safe

async function getMixinKey({ cookie } = {}) {
  if (wbiCache.key && Date.now() - wbiCache.ts < WBI_TTL_MS) return wbiCache.key;
  const res = await fetch('https://api.bilibili.com/x/web-interface/nav', {
    headers: { ...BILI_HEADERS, ...(cookie ? { Cookie: cookie } : {}) },
  });
  const json = await res.json();
  // NOTE: code -101 (not logged in) still carries usable keys.
  const wbi = json?.data?.wbi_img;
  if (!wbi?.img_url || !wbi?.sub_url) {
    throw new Error(`WBI key fetch failed: code=${json?.code} msg=${json?.message}`);
  }
  const stem = (u) => u.slice(u.lastIndexOf('/') + 1, u.lastIndexOf('.'));
  const raw = stem(wbi.img_url) + stem(wbi.sub_url);
  const mixin = MIXIN_KEY_ENC_TAB.map((n) => raw[n]).join('').slice(0, 32);
  wbiCache = { key: mixin, ts: Date.now() };
  return mixin;
}

// --- signing --------------------------------------------------------------
/**
 * Returns a signed query string. `wts` and `w_rid` are appended in the
 * ORIGINAL param order, per the docs ("无需对原始请求参数排序").
 */
export async function wbiSign(params, { cookie } = {}) {
  const mixinKey = await getMixinKey({ cookie });
  const wts = Math.round(Date.now() / 1000);

  const forHash = { ...params, wts };
  const sortedQuery = Object.keys(forHash)
    .sort()
    .map((k) => {
      const v = String(forHash[k]).replace(/[!'()*]/g, ''); // doc-mandated filter
      return `${encodeURIComponent(k)}=${encodeURIComponent(v)}`;
    })
    .join('&');

  const w_rid = md5(sortedQuery + mixinKey);

  const original = Object.keys(params).map(
    (k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(params[k]))}`,
  );
  return [...original, `wts=${wts}`, `w_rid=${w_rid}`].join('&');
}

/** Signed fetch helper; detects the v_voucher "treated as unsigned" challenge. */
export async function wbiFetch(path, params, { cookie } = {}) {
  const query = await wbiSign(params, { cookie });
  const url = `https://api.bilibili.com${path}?${query}`;
  const res = await fetch(url, {
    headers: { ...BILI_HEADERS, ...(cookie ? { Cookie: cookie } : {}) },
  });
  const json = await res.json();
  if (json?.data?.v_voucher) {
    wbiCache = { key: null, ts: 0 }; // force key refresh on next call
    throw new Error('WBI signature rejected (v_voucher challenge) — keys may have rotated');
  }
  return json;
}
```

**Verified end-to-end [LIVE]:** the above produced

```
https://api.bilibili.com/x/player/wbi/v2?aid=1906473802&cid=1625992822&w_rid=0c89a39644037d16420451c0a11bdf55&wts=1792149764
→ {"code":0,"message":"OK", ...}
```

### 1.5.6 Bonus: `dm_img_*` browser-fingerprint params

Requests originating from the real web player also carry `dm_img_list`, `dm_img_str`, `dm_cover_img_str`, `dm_img_inter`, `web_location`, and `isGaiaAvoided`. `yt-dlp` synthesises plausible values (`dm_img_str`/`dm_cover_img_str` are base64 of random printable strings; `dm_img_inter` is compact JSON `{ds:[],wh:[...],of:[...]}` computed from a randomly-chosen common screen resolution) **[CODE `bilibili.py` `_dm_params`]**. The `bili_ai_subtitle` CLI hardcodes one fixed plausible set **[CODE]**.

**These are currently optional** — my anonymous requests with **zero** `dm_img_*` params succeeded on `view`, `player/v2`, and signed `player/wbi/v2` **[LIVE]**. Include them only if you start seeing `-352`; if you do synthesize them, note `yt-dlp`'s comment that `dm_img_list`/`dm_img_inter.ds` "come from mousemove/click events" and leaving them empty "should allow playing the video without any mousemove/click".

---

## 1.6 Required HTTP headers per call, and what breaks without them

Baseline header set **[CODE `bili_ai_subtitle` `request_json()`, `yt-dlp` `_HEADERS`]**:

```js
const headers = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Referer': 'https://www.bilibili.com/',          // or the specific video page
  'Origin': 'https://www.bilibili.com',            // for API calls; omit on the CDN GET
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
};
```

**Honest finding on header sensitivity [LIVE]:** for the anonymous read path, headers are **weaker than folklore suggests**. I probed `/x/web-interface/view` three ways and **all three returned `code:0`**:

| Headers sent | Result |
|---|---|
| Full browser set (UA + Referer + Origin + Accept + Accept-Language) | `code:0` |
| **Bare UA only** (no Referer, no Origin, no Accept) | `code:0` |
| **Empty headers** (undici's default `node` UA) | `code:0` |

So plain `fetch(url)` with **no headers at all** worked for `view`. That said, headers *are* required elsewhere and are cheap insurance:

| Call | Header requirement |
|---|---|
| `/x/web-interface/view`, `/x/web-interface/nav` | not enforced in testing **[LIVE]**; send anyway |
| `/x/player/v2`, `/x/player/wbi/v2` | `Referer` recommended; **the real risk here is the missing SESSDATA cookie, not headers** |
| `/x/player/wbi/playurl` | `Referer` matters (stream URLs are Referer-gated) **[DOC]** |
| Subtitle CDN JSON (`aisubtitle.hdslb.com`, `i0.hdslb.com`) | **`Referer` strongly recommended [CODE]** — the reference CLI passes the video URL as `Referer` when fetching the subtitle JSON |
| `https://www.bilibili.com/` (buvid bootstrap) | **UA-sensitive** — see 1.7 |

### 1.6.1 Error-code reference

**Common codes [DOC]** (`docs/misc/errcode.md`):

| Code | Meaning |
|---|---|
| `-1` | app does not exist / banned |
| `-2` | Access Key wrong |
| `-3` | API checksum key wrong |
| `-4` | caller lacks permission for this Method |
| `-101` | **account not logged in** |
| `-102` | account banned |
| `-105` | wrong captcha |
| `-106` | account is not a full member / in probation |
| `-108`, `-110`, `-114` | phone number not bound |
| `-111` | **csrf check failed** (i.e. bad/missing `bili_jct`) |
| `-112` | system upgrading |
| `-113`, `-115` | real-name verification required |
| `-304` | no changes |
| `-307` | collision redirect |
| **`-352`** | **风控校验失败 (UA 或 wbi 参数不合法)** — "risk control validation failed (UA or wbi params invalid)" |
| `-400` | **请求错误** — bad request |
| `-401` | unauthenticated (or illegal request) |
| `-403` | **访问权限不足** — insufficient access permission |
| `-404` | 啥都木有 — nothing here |
| `-405` | method not supported |
| `-409` | conflict |
| `-412` | **请求被拦截 (客户端 ip 被服务端风控)** — request intercepted, client IP risk-controlled |
| `-500` | server error |
| `-503` | overloaded, temporarily unavailable |
| `-504` | service call timeout |
| `-509` | **超出限制** — limit exceeded |
| `-625` | too many failed logins |
| `-658` | token expired |
| `-688` | **geographic region restricted** |
| `-689` | **copyright restricted** |
| `-799` | **请求过于频繁，请稍后再试** — too frequent, retry later |
| `-8888` | server blew up |

**Video-specific codes [DOC]** (`docs/video/info.md`), returned via the `/x/web-interface/view` root `code`:

| Code | Meaning |
|---|---|
| `62002` | 稿件不可见 — archive not visible |
| `62004` | 稿件审核中 — archive under review |
| `62012` | 仅UP主自己可见 — visible only to the uploader |

**Codes the user asked about, answered directly:**

- **`-400`** — malformed request. In practice for this chain it almost always means **a missing or wrong required param**: I reproduced it with `?ep_id=` only, with `?ep_id=&cid=`, and with **no `cid`** on `/x/player/v2` **[LIVE]**.
- **`-403`** — insufficient permission (e.g. paid/PGC-only content, or a subtitle CDN URL that was truncated / whose `auth_key` expired).
- **`-404`** — no such object (deleted video, wrong `cid`).
- **`-352`** — **risk control**: bad `User-Agent` **or invalid `w_rid`/`wts`**. This is *the* WBI failure signal in the common-code table. Also the practical signature of an expired `img_key`/`sub_key` pair.
- **`62002` / `62004`** — the video exists but is **not publicly visible** (invisible / under review). Both are terminal; retrying will not help.
- **`-412`** — IP-level risk control. Seen on search and playback endpoints. Fix = add cookies, slow down, or change IP **[CODE]**.
- **`-799`** — explicit rate limit; back off.

### 1.6.2 How to interpret `is_lock: true` and empty `subtitles[]`

These are **different conditions** and must be reported separately.

**`is_lock: true`** — the track exists but the viewer may not fetch it. **[DOC `docs/video/player.md` example]** shows entries with `is_lock: true` and a *populated* `subtitle_url` containing an `auth_key`. Mechanism: Bilibili issues an `auth_key`-signed URL whose signature is bound to the requesting session. If the viewer is not entitled, the CDN GET returns **403** even though the URL is listed. Practical rules:
- Do not treat `is_lock: true` as "no subtitle".
- Attempt the download and map a **403 on the CDN** to "locked subtitle — login or entitlement required".
- `is_lock: false` does **not** guarantee success either (the AI-generation case below).

**Empty `subtitles: []`** — ambiguous; distinguish by context:

| Situation | Signal | Cause |
|---|---|---|
| Not logged in | `data.need_login_subtitle === true` and `subtitles: []` | **Login required.** **[DOC]** `need_login_subtitle` = "是否必须登陆才能查看字幕" |
| Not logged in, video is public | `need_login_subtitle === false`, `subtitles: []` | Either the video genuinely has no CC, **or** Bilibili is hiding the list from anonymous callers |
| Logged in, `subtitles: []` | — | **No CC has been submitted and no AI subtitle has been generated.** Terminal |
| `subtitles[]` non-empty but `subtitle_url: ""` | `ai_status: 2` | **AI subtitle not ready yet** — skip this entry, keep the others |

**[LIVE] reproduction of the login gate:**

```
GET /x/player/v2?aid=60977932&cid=106101299      (a video that has CC)
→ code 0, need_login_subtitle = true, subtitle.subtitles = []

GET /x/player/v2?aid=1906473802&cid=1625992822   (video with no CC)
→ code 0, need_login_subtitle = false, subtitle.subtitles = []
```

Note both return `HTTP 200` with `code: 0`. **You cannot detect the login gate from the HTTP status or `code` — you must inspect `need_login_subtitle`.** This is the single most important diagnostic in the whole Bilibili chain.

---

## 1.7 Cookies and authentication

### 1.7.1 What each cookie buys you

| Cookie | Effect |
|---|---|
| **`SESSDATA`** | **The one that matters.** Populates `data.subtitle.subtitles[]` on `/x/player/v2` and `/x/player/wbi/v2`, including **AI subtitles (`ai-zh`)**. Also enables ≥720P playurl. **[DOC]** says the `view` endpoint uses `Cookie(SESSDATA)`; `yt-dlp` gates subtitle reporting on `self._get_cookies(...).get('SESSDATA')` **[CODE]** |
| `bili_jct` | CSRF token. **Not needed for read/extract paths** — only for state-changing POSTs (which `-111` guards). Do not require it |
| `buvid3` | Anonymous device id; helps avoid risk control. See below |
| `buvid4` | Second-generation device id, same purpose |
| `b_nut` | Timestamp paired with `buvid3` |

**`SESSDATA` requirement is stated plainly by a working implementation [CODE `bili_ai_subtitle` README]:** "Bilibili 通常需要登录态才能返回字幕列表" — Bilibili normally requires a logged-in session to return the subtitle list. It also reports that anonymous API calls yield **0** AI subtitles, and that the signed-in player must be made to load the subtitle before the CDN URL can be captured.

**Cookie format:** pass as `Cookie: SESSDATA=<value>` (plus `buvid3=...; b_nut=...` if you have them). `SESSDATA` values contain `%` escapes and `,`/`*` — **do not URL-decode or re-encode**; pass verbatim. Netscape `cookies.txt` is the interchange format most tooling accepts **[CODE]**.

### 1.7.2 `buvid3` / `buvid4` — are they needed?

**Endpoints [DOC]** (`docs/misc/buvid3_4.md`), both verified working anonymously **[LIVE]**:

```
GET https://api.bilibili.com/x/frontend/finger/spi
→ {"code":0,"message":"ok",
   "data":{"b_3":"D9656DA8-9BEF-F464-5B72-C4849AFD336379044infoc",
           "b_4":"F6E0FD4B-520C-1902-4F7B-E461D8D1F5AB79044-024072309-666onEZSnlHVPjoRp4kDYg=="}}

GET https://api.bilibili.com/x/web-frontend/getbuvid          → {"code":0,"data":{"buvid":"..."}}   (buvid3 only)
```

**[LIVE] observed `spi` response:** `b_3: "4BE6FE32-08CE-DC0A-B1ED-5A539EDCA5ED84964infoc"`, `b_4: "A06580E9-83F0-D440-8393-AF3F98C30A7A84964-026101619-bt98Yhdz+3DAzCshDS6yVA=="`.

`buvid3`/`buvid4` must then be **manually placed into the Cookie header** **[DOC]** (there is no `Set-Cookie` on the `spi` response). **[DOC]** also advises generating your own rather than copying the doc's example values.

**Alternative bootstrap from response headers [DOC]** — `GET`/`HEAD https://www.bilibili.com/` with a `User-Agent` that does **not** contain the substrings `curl`, `python`, `awa`, and not repeated rapidly for the same UA. `Set-Cookie` then carries `buvid3` and `b_nut`:

```http
set-cookie: buvid3=805E4894-96A2-0684-6F00-C6EA1FFB911023315infoc; path=/; expires=...; domain=.bilibili.com
set-cookie: b_nut=1721975923; path=/; expires=...; domain=.bilibili.com
```

Rules **[DOC]**: no cookies → `b_nut` = current Unix seconds; only `buvid3` → `b_nut` = `100`; only `b_nut` → same as no cookies; both → **no `Set-Cookie` at all**.

**Verdict for a Node server-side library:** **not required** for the metadata and subtitle paths — every call in my probe chain succeeded with **zero** buvid cookies **[LIVE]**. They are **risk-control mitigation**: fetch them once at startup, persist them, and attach them if you observe `-352`/`-412`. Note the UA-blacklist rule above is a real trap: if you bootstrap buvid via the homepage, do **not** send a UA containing `python`/`curl`.

### 1.7.3 What is reachable **without** login — a precise inventory

Verified by anonymous probe **[LIVE]**:

| Reachable anonymous | Not reachable anonymous |
|---|---|
| `aid`, `bvid`, `cid` for every part | **the subtitle track list** (`subtitles[]` is always `[]`) |
| `title`, `desc`, `pic`, `duration`, `pubdate` | AI subtitles (`ai-zh`) |
| `owner { mid, name, face }` | multi-language CC tracks |
| `pages[]` including per-part `duration`/`part` | ≥720P streams (via playurl) |
| `stat` (views, likes, coins, …) | anything behind PGC paywall |
| `ugc_season`, `staff`, `dimension`, `rights` | |
| PGC season/episode metadata (title, cid, aid, bvid, duration, cover) | |
| `dim`/`view_points`/`bgm_info` from `player/v2` | |
| `need_login_subtitle` flag (**the diagnostic**) | |
| `buvid3`/`buvid4` | |
| WBI keys | |

**So: metadata without login, subtitles with login.** If your product must work anonymously, degrade to "subtitle unavailable — login required" using `need_login_subtitle`, and consider ASR/OCR fallback.

---

## 1.8 AI subtitles (`ai-zh`) / the `ypy`/`ai_subtitle` route

There is **no separate AI-subtitle endpoint** in the normal chain. AI subtitles appear as **ordinary entries in the same `data.subtitle.subtitles[]` array**, distinguished by `lan === "ai-zh"` (or `lan_doc === "中文（自动生成）"`).

**Fields that describe AI state:**

| Field | Values | Meaning |
|---|---|---|
| `lan` | `"ai-zh"` | AI-generated Chinese |
| `lan_doc` | `"中文（自动生成）"` | display name **[DOC example]** |
| `type` | `1` for AI, `0` for submitted CC | **[DOC example]** shows `type: 1` with `lan: "ai-zh"` |
| `ai_status` | `0` = no AI subtitle; `1` = has AI subtitle; `2` = **generating** | **[CODE `bfftp0502/bilibili-video-summary` `references/api.md`]**: "`ai_status`：0=无 AI 字幕，1=有 AI 字幕，2=生成中" |
| `ai_type` | `0` observed | AI subtitle type |
| `subtitle_url` | **`""` while generating** | **[DOC example]** — must be skipped |
| `is_lock` | `false` for AI in the doc example | AI tracks are typically unlocked |

**Practical selection algorithm:**

```js
function pickSubtitle(subtitles, preferred = ['zh-Hans','zh-CN','zh-Hant','zh-HK','ai-zh','en-US']) {
  const usable = subtitles.filter((s) => s.subtitle_url && s.lan);          // drop generating
  if (!usable.length) return null;
  for (const lang of preferred) {
    const hit = usable.find((s) => s.lan === lang);
    if (hit) return hit;
  }
  // Prefer human CC (type 0) over AI (type 1) at equal preference.
  return usable.find((s) => s.type === 0) ?? usable[0];
}
```

Note the `ai_status` semantics: one reference treats "ready" as `ai_status` in `(null, 2)` **or** truthy `ai_type` **[CODE `bili_ai_cli.py`]**, which is **inconsistent** with the other source's `2 = generating`. Given the **[DOC]** example that pairs `ai_status: 2` with `subtitle_url: ""`, **the safe rule is to ignore `ai_status` entirely and gate on `subtitle_url` being non-empty.** That is robust under either interpretation.

### 1.8.1 `x/player/v2` vs `x/player/wbi/v2` — the real differences

| | `/x/player/v2` | `/x/player/wbi/v2` |
|---|---|---|
| WBI params **documented** | no | yes (`w_rid`, `wts`) |
| WBI params **enforced** | n/a | **no, in my testing** **[LIVE]** |
| Response structure | **identical** for `subtitle` | **identical** |
| Non-subtitle extras | same | same |
| Relative risk of `-352` | lower | higher if you sign wrong |

**Both returned byte-identical `subtitle` objects in my probes, signed and unsigned [LIVE].** Recommended strategy — **try `player/wbi/v2` signed, fall back to `player/v2` unsigned**, exactly as the reference CLI does:

```js
let data = await wbiFetch('/x/player/wbi/v2', { aid, cid }, { cookie });
let subtitles = data?.data?.subtitle?.subtitles ?? [];
if (!subtitles.length) {
  const fb = await fetch(`https://api.bilibili.com/x/player/v2?aid=${aid}&cid=${cid}`, { headers });
  subtitles = (await fb.json())?.data?.subtitle?.subtitles ?? [];
}
```

**[CODE `bili_ai_cli.py` `discover_subtitle_url()` implements exactly this wbi→plain fallback.]**

### 1.8.2 The `x/v2/subtitle/web/view` endpoint — does not exist

A widely-circulated third-party reference documents an AI-subtitle endpoint:

```
GET https://api.bilibili.com/x/v2/subtitle/web/view
    ?oid=<aid>&pid=<aid>&context_ext={"video_type":1}&type=1
    &cur_production_type=0&preferred_language=ai-zh&playlist_switch=0
```

**[CODE `bfftp0502/bilibili-video-summary` `references/api.md`]** claims it requires login cookies and returns `data.subtitle.subtitles[]`.

**My live probe [LIVE] returned `HTTP 404` with an HTML error page — the path does not exist on `api.bilibili.com`.**

```
GET /x/v2/subtitle/web/view?oid=60977932&pid=60977932&type=1&preferred_language=ai-zh
→ 404  <!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN">...
```

**Do not implement this endpoint.** The same source's own "AI subtitle" guidance ultimately falls back to capturing the CDN URL from a logged-in browser via CDP — which is consistent with "there is no server-side AI-subtitle list endpoint beyond `player/v2`".

### 1.8.3 What you cannot do without a browser

For AI subtitles on videos where the anonymous `subtitles[]` is empty even though a signed-in browser shows `ai-zh`, that reference reports the *only* reliable route is to let a **logged-in browser page load the subtitle**, then capture the `aisubtitle.hdslb.com` URL from the network layer (CDP `pageAssets`, or a page-context `fetch`) **[CODE]**. The `auth_key` on those URLs is minute-scale, so capture → download must be immediate **[CODE]**.

**This is a real limitation and should be stated to users:** a pure server-side Node client with a valid `SESSDATA` gets AI subtitles via `player/wbi/v2` in the normal case; when it does not, there is no documented server-side fallback, and the pragmatic escape hatch is a headless browser with the user's session.

---

## 1.9 Rate limits and backoff

**Honest statement: Bilibili publishes no rate limit for these REST endpoints.** The only official frequency document I could find is the **mini-program** (小程序) API spec, which covers completely different APIs (`bl.login`, `bl.getSession`, `bl.getUserInfo`, `bl.getUserProfile`, `bl.getSetting`) and states, for those only, **≤ 4 calls/second/user** and daily totals ≤ 2× mini-program PV **[DOC]**.

**That document does not apply to `api.bilibili.com/x/...`.** Do not cite it as a rate limit for this chain.

What *is* documented/observed:

| Signal | Meaning | Action |
|---|---|---|
| `-799` | 请求过于频繁 | explicit rate limit → back off |
| `-412` | IP risk-controlled | back off longer; add cookies; consider IP change |
| `-352` | risk control / bad WBI | refresh WBI keys; verify UA |
| `-509` | 超出限制 | limit exceeded |
| `HTTP 429` | standard | back off |

**Recommendation for the implementer:**

- **Serialize** per-host requests; do not fan out 20 parallel subtitle fetches.
- Keep a floor of **~1 request/second** to `api.bilibili.com`; subtitle CDN GETs can be slightly more aggressive.
- Retry with **exponential backoff + jitter**, ~3 attempts, base 1 s → 2 s → 4 s, and only on `-412`, `-352`, `-799`, `-509`, `HTTP 429`, and 5xx. **Never retry `62002`, `62004`, `62012`, `-404`, `-403`, `-689`** — those are terminal.
- The reference CLI uses a minimal 3-attempt retry at 1 s/2 s with **no** jitter **[CODE `bili_ai_cli.py`: `time.sleep(attempt)`]**; `yt-dlp` treats `401`/`352` as "please wait and try later" and marks them `expected=True` (i.e. it does *not* hammer) **[CODE `bilibili.py`]**.
- **Cache WBI keys** (≥30 s, ≤24 h) and **cache the subtitle JSON** by its URL — the `auth_key` varies per session, so key the cache on the `bfs/subtitle/<sha1>.json` path component, not the full URL.

---

## 1.10 Complete end-to-end Node ≥20 snippet (view → player → subtitle JSON)

Self-contained; assumes `wbi.mjs` from §1.5.5 is in scope. Tested shape against the live API.

```js
// bili-subtitle.mjs — Node >= 20
import { wbiFetch } from './wbi.mjs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const H = {
  'User-Agent': UA,
  Referer: 'https://www.bilibili.com/',
  Origin: 'https://www.bilibili.com',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
};
const j = async (url, extra = {}) => {
  const r = await fetch(url, { headers: { ...H, ...extra } });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
  return r.json();
};
const abs = (u) => (u?.startsWith('//') ? `https:${u}` : u);

// ---- 1. URL parsing ------------------------------------------------------
function parseBiliUrl(input) {
  const u = new URL(input);
  const p = Number(u.searchParams.get('p') ?? 1);
  if (/\/video\/(BV[0-9A-Za-z]+)/.test(u.pathname))
    return { kind: 'ugc', bvid: RegExp.$1, p };
  if (/\/video\/av(\d+)/i.test(u.pathname)) return { kind: 'ugc', aid: Number(RegExp.$1), p };
  if (/\/bangumi\/play\/ep(\d+)/.test(u.pathname)) return { kind: 'pgc', ep_id: Number(RegExp.$1) };
  if (/\/bangumi\/play\/ss(\d+)/.test(u.pathname)) return { kind: 'pgc', season_id: Number(RegExp.$1) };
  const qbvid = u.searchParams.get('bvid');
  if (qbvid) return { kind: 'ugc', bvid: qbvid, p };
  throw new Error(`unrecognized Bilibili URL: ${input}`);
}

/** Follow b23.tv short links manually (302). */
async function resolveShort(input) {
  if (!/^https?:\/\/b23\.tv\//i.test(input)) return input;
  const r = await fetch(input, { headers: { 'User-Agent': UA }, redirect: 'manual' });
  const loc = r.headers.get('location');
  if (!loc) throw new Error(`b23.tv did not redirect: ${input}`);
  return loc;
}

// ---- 2. metadata + cid selection ----------------------------------------
async function getTarget(input, { cookie } = {}) {
  const url = await resolveShort(input);
  const ref = parseBiliUrl(url);
  const cookieHeader = cookie ? { Cookie: cookie } : {};

  if (ref.kind === 'ugc') {
    const q = ref.bvid ? `bvid=${ref.bvid}` : `aid=${ref.aid}`;
    const res = await j(`https://api.bilibili.com/x/web-interface/view?${q}`, cookieHeader);
    if (res.code !== 0) throw new Error(`view failed: ${res.code} ${res.message}`);

    // PGC-backed video → switch to the PGC path.
    if (res.data.redirect_url || res.data.is_ogv) {
      const ep = /ep(\d+)/.exec(res.data.redirect_url ?? '')?.[1];
      if (ep) return getTarget(`https://www.bilibili.com/bangumi/play/ep${ep}`, { cookie });
    }

    const page = res.data.pages.find((x) => x.page === ref.p) ?? res.data.pages[ref.p - 1];
    if (!page) throw new Error(`part p=${ref.p} not found`);
    return {
      aid: res.data.aid,
      bvid: res.data.bvid,
      cid: page.cid,
      title: res.data.title,
      partTitle: page.part,
      desc: res.data.desc,
      duration: page.duration,
      totalDuration: res.data.duration,
      owner: res.data.owner,             // { mid, name, face }
      cover: res.data.pic,
      pages: res.data.pages,
      stat: res.data.stat,
      pageUrl: `https://www.bilibili.com/video/${res.data.bvid}?p=${ref.p}`,
    };
  }

  // PGC: one call resolves ep_id OR season_id and returns the whole season.
  const q = ref.ep_id ? `ep_id=${ref.ep_id}` : `season_id=${ref.season_id}`;
  const res = await j(`https://api.bilibili.com/pgc/view/web/season?${q}`, cookieHeader);
  if (res.code !== 0) throw new Error(`pgc season failed: ${res.code} ${res.message}`);
  const season = res.result;                                   // NOTE: .result, not .data
  const ep = ref.ep_id
    ? season.episodes.find((e) => e.ep_id === ref.ep_id)
    : season.episodes[0];
  if (!ep) throw new Error('episode not found in season');
  return {
    aid: ep.aid,                       // needed: player/v2 rejects bare ep_id
    bvid: ep.bvid,
    cid: ep.cid,
    epId: ep.ep_id,
    seasonId: season.season_id,
    title: `${season.season_title} - ${ep.title} ${ep.long_title ?? ''}`.trim(),
    partTitle: ep.long_title,
    desc: season.evaluate,
    duration: Math.round((ep.duration ?? 0) / 1000),   // PGC duration is MILLISECONDS
    owner: season.up_info,
    cover: ep.cover,
    pageUrl: `https://www.bilibili.com/bangumi/play/ep${ep.ep_id}`,
  };
}

// ---- 3. subtitle list ----------------------------------------------------
async function listSubtitles({ aid, bvid, cid, pageUrl }, { cookie } = {}) {
  const cookieHeader = cookie ? { Cookie: cookie } : {};
  let payload;
  try {
    payload = await wbiFetch('/x/player/wbi/v2', { aid, cid }, { cookie });
    } catch {
    payload = await j(
      `https://api.bilibili.com/x/player/v2?aid=${aid}&cid=${cid}`,
      { ...cookieHeader, Referer: pageUrl },
    );
  }
  if (payload.code !== 0) throw new Error(`player/v2 failed: ${payload.code} ${payload.message}`);

  const d = payload.data ?? {};
  const subs = d.subtitle?.subtitles ?? [];
  if (!subs.length) {
    return {
      subtitles: [],
      needLogin: d.need_login_subtitle === true,
      reason: d.need_login_subtitle === true
        ? 'login required (need_login_subtitle=true) — provide SESSDATA'
        : 'no CC and no AI subtitle for this part',
    };
  }
  return {
    subtitles: subs.map((s) => ({
      id: s.id_str ?? String(s.id),   // use id_str: id exceeds Number.MAX_SAFE_INTEGER
      lan: s.lan,
      lanDoc: s.lan_doc,
      isLock: s.is_lock,
      type: s.type,
      aiStatus: s.ai_status,
      aiType: s.ai_type,
      url: abs(s.subtitle_url),        // protocol-relative → https:
      ready: Boolean(s.subtitle_url),  // false while AI is still generating
    })),
    needLogin: false,
    viewPoints: d.view_points ?? [],
  };
}

// ---- 4. subtitle JSON → cues -------------------------------------------
async function fetchSubtitles(subtitle, { pageUrl } = {}) {
  if (!subtitle.ready) throw new Error('subtitle_url is empty (AI generation pending?)');
  const r = await fetch(subtitle.url, {
    headers: { 'User-Agent': UA, Referer: pageUrl ?? 'https://www.bilibili.com/' },
  });
  if (r.status === 403) throw new Error('subtitle CDN 403 — is_lock/entitlement, or auth_key expired/truncated');
  if (!r.ok) throw new Error(`subtitle CDN HTTP ${r.status}`);
  const doc = await r.json();
  const body = Array.isArray(doc?.body) ? doc.body : [];
  return body
    .filter((c) => c && typeof c.from === 'number' && typeof c.to === 'number')
    .map((c) => ({
      from: c.from,                    // seconds, float
      to: c.to,                        // seconds, float
      location: c.location ?? null,    // optional
      content: String(c.content ?? ''),// may contain \n (bilingual)
    }))
    .filter((c) => c.content.trim() !== '')
    .sort((a, b) => a.from - b.from);
}

// ---- 5. naive SRT writer ------------------------------------------------
const tcode = (s) => {
  const ms = Math.max(0, Math.round(s * 1000));
  const h = String(Math.floor(ms / 3600000)).padStart(2, '0');
  const m = String(Math.floor(ms / 60000) % 60).padStart(2, '0');
  const sec = String(Math.floor(ms / 1000) % 60).padStart(2, '0');
  return `${h}:${m}:${sec},${String(ms % 1000).padStart(3, '0')}`;
};
export const toSrt = (cues) =>
  cues.map((c, i) => `${i + 1}\n${tcode(c.from)} --> ${tcode(c.to)}\n${c.content}\n`).join('\n');

// ---- driver -------------------------------------------------------------
export async function extractBilibili(input, { cookie, lang } = {}) {
  const meta = await getTarget(input, { cookie });
  const list = await listSubtitles(meta, { cookie });
  if (!list.subtitles.length) return { meta, ...list, cues: [] };

  const pick =
    (lang && list.subtitles.find((s) => s.lan === lang && s.ready)) ??
    list.subtitles.find((s) => s.ready && s.type === 0) ??
    list.subtitles.find((s) => s.ready) ??
    list.subtitles.find((s) => s.type === 0) ??
    list.subtitles[0];

  const cues = await fetchSubtitles(pick, { pageUrl: meta.pageUrl });
  return { meta, subtitles: list.subtitles, chosen: pick, cues };
}

// Example:
// const r = await extractBilibili('https://www.bilibili.com/video/BV1MU411S7iJ', { cookie: process.env.BILI_SESSDATA });
// console.log(r.meta.title, r.subtitles.length, r.cues.length);
```

**What this returns anonymous, right now, for `BV1MU411S7iJ`** (matches my live probe): full `meta` — `aid: 1906473802`, `cid: 1625992822`, title, owner, duration, cover, stat — and `subtitles: []` with a precise `reason` string.

---

# Part 2 — Secondary platforms

Framing for all of Part 2: **"implementable server-side" means a plain Node `fetch` with hand-computed parameters reproduces the request.** If the signature requires executing obfuscated JavaScript, it is not.

## 2.1 腾讯视频 (v.qq.com)

**Player API [CODE `yt-dlp/yt_dlp/extractor/tencent.py`]:**

```
GET https://h5vv6.video.qq.com/getvinfo?<params>
```

The response is **not** JSON — it is a JS assignment. Parse with `/QZOutputJson=(.*)/s` then `JSON.parse` after stripping a trailing `;` **[CODE]**.

**Params [CODE `tencent.py` `_get_video_api_response()`]:**

```
vid            <video id>            e.g. q326831cny0
cid            <series id>           e.g. 7ce5noezvafma27  (empty for standalone videos)
cKey           <AES-encrypted ckey>  ← the signature; see below
encryptVer     8.1
spcaptiontype  '1' for vtt, '0' for srt   ← SUBTITLE FORMAT SELECTOR
spsrt          '2'                        ← "Enable subtitles"
sphls          '2' | dtype '3'            ← HLS
defn           <quality>            e.g. hd, shd, fhd
sphttps        '1'
otype          json
spwm           '1'
hevclv         28                   (HEVC)
drm            40                   (DRM)
spvideo        4
spsfrhdr       100
host           v.qq.com
referer        v.qq.com
ehost          <the page URL>
appVer         3.5.57
platform       10901
guid           <16 random [0-9a-z]>
flowid         <32 random [0-9a-z]>
```

**The `cKey` signature — fully reconstructible server-side. Verified live [LIVE]:**

`ckey = AES-128-CBC(whitespace-padded plaintext).hex().upper()`

- **key** = `4f 6b da a3 9e 2f 8c b0 7f 5e 72 2d 9e de f3 14`  (= `b'Ok\xda\xa3\x9e/\x8c\xb0\x7f^r-\x9e\xde\xf3\x14'`)
- **iv** = `01 50 4a f3 56 e6 19 cf 2e 42 bb a6 8c 3f 70 f9` (= `b'\x01PJ\xf3V\xe6\x19\xcf.B\xbb\xa6\x8c?p\xf9'`)
- **padding** = pycryptodome `padding_mode='whitespace'`: pad with `0x20` bytes, **last pad byte = pad length** (not PKCS#7)

Plaintext **[CODE]**:

```
payload = f'{vid}|{int(time.time())}|mg3c3b04ba|{appVer}|{guid}|{platform}|{page_url[:48]}|{ua.lower()[:48]}||Mozilla|Netscape|Windows x86_64|00|'
plain   = f'|{sum(map(ord, payload))}|{payload}'
```

Note the URL and the lowercased UA are each **truncated to 48 characters**, and the checksum is the **sum of Unicode code points** of `payload`, delimited by `|` on both sides.

**I implemented this in Node from the yt-dlp description and it worked [LIVE]:**

```
ckey = 6C52F2205D2BE9645D5B4ADCA7026B94...813BA76745E390822FB5DE142A7A3A6325515343A548A48313B478F675D
GET https://h5vv6.video.qq.com/getvinfo?...&cKey=<36 above>
→ HTTP 200, len 3562, top keys:
  dltype, em, exem, fl, fp2p, hs, ls, ip, preview, s, sfl, tstid, testbucket, tm,
  ret_valid_tm, vl, abtest, code, signature, login
→ s: "o", em: 0    (success; em != 0 is an error code)
```

**Subtitle data location [CODE]** — two independent paths, both in the same response:

1. **`sfl.fi[]`** — native subtitle files:

```js
for (const sub of apiResponse?.sfl?.fi ?? []) {
  subtitles[sub.lang.toLowerCase()] = [{
    url: sub.url,
    ext: sub.captionType === 1 ? 'srt' : 'vtt',
    protocol: sub.url.endsWith('.m3u8') ? 'm3u8_native' : 'http',
  }];
}
```

`yt-dlp` requests `spcaptiontype='1'` (vtt) for non-`ld`/`sd`/`hd` qualities and `'0'` (srt) for the first call — i.e. **the format is chosen per-request via `spcaptiontype`** **[CODE]**.

2. **HLS `#EXT-X-MEDIA:TYPE=SUBTITLES` renditions** inside the returned `m3u8` — `yt-dlp` calls `_extract_m3u8_formats_and_subtitles(video_format['url'] + hls.pt)` and merges the result **[CODE]**.

**[LIVE] on my test video** `sfl` was `{"cnt":0}` (that video has no subtitles) — the field exists and is the container, but I could not observe a populated entry. **Mark the `sfl.fi[]` entry *field names* as reported-by-code, not verified.** The surrounding envelope and the `sfl` container are verified.

Also noteworthy: the video object carries a **`subtitlepeak`** field and per-format `cl`/`wl` (caption/subtitle language lists) **[LIVE, `vl.vi[0]` key list]**.

**Headers required:** `Referer: https://v.qq.com/`, browser `User-Agent` (the UA feeds directly into the `ckey` checksum, so **the UA you sign with must be the UA you send**).

**Cookies:** not required for the `getvinfo` call. `vqq_vusession`/`vqq_guid` only widen access to VIP/geo-restricted content. My probe succeeded with **no cookies** — but the response's `em: 85` / `code: "85.-12"` on the *unsigned* attempt shows the ckey is genuinely enforced (`em: 0` with a valid ckey) **[LIVE]**.

**Feasibility:** ✅ **server-side implementable.** The signature is a documented-by-code AES scheme with fixed key/iv, and I reproduced it end-to-end in Node.

## 2.2 优酷 (youku.com)

**Player API [CODE `yt-dlp/yt_dlp/extractor/youku.py`]:**

```
GET https://ups.youku.com/ups/get.json?vid=<vid>&ccode=0564&client_ip=192.168.1.1&utid=<cna>&client_ts=<unix_seconds>
```

- `vid` — the video id from `/v_show/id_<VID>.html`
- `ccode` — constant `0564`
- `utid` — the **`cna` cookie**, obtained by fetching `https://log.mmstat.com/eg.js` and taking the **`etag` response header with surrounding quotes stripped** **[CODE]**:

```python
_, urlh = self._download_webpage_handle('https://log.mmstat.com/eg.js', video_id, 'Retrieving cna info')
cna = urlh.headers['etag'][1:-1]          # etag is  '"foobar"'  →  foobar
```

- Advertised cookies **[CODE]**: `__ysuid` (format `{unix_seconds}{3 random letters}`) and `xreferrer=http://www.youku.com`, both set on `youku.com`.
- `client_ip` is literally hardcoded to `192.168.1.1` — it is decorative.

**[LIVE]: the endpoint works anonymously and returns HTTP 200 with a large JSON object.**

```
data keys: controller, error, playlog, remoteDebug, uploader, ups, user, video
video keys: audioOnly, category_id, category_letter_id, close_ceremony_video, ctype,
            drm_type, encodeid, id, is_child_content_blacklist, limited, logo, privacy,
            seconds, source, subcategories, svip_ahead, svip_free, tags, title, type,
            uid, userid, username, videoid_play, weburl
```

### The honest finding: **no subtitle field exists in this response**

I searched the **entire** `data` object for any key matching `subtitle` / `caption` / `cc` — **zero matches** **[LIVE]**. And `yt-dlp`'s Youku extractor **does not implement subtitle extraction at all** — it returns only `formats` from `data.stream[].m3u8_url` **[CODE]**. (It *does* note `<ExtractorError> /play/get.json contains streams with "channel_type":"tail"`, i.e. a second, older data path exists.)

**Where Youku subtitles actually come from:** Youku's own engineering blog documents the subtitle pipeline as **external `.ass` files** downloaded by the player's `subtitle sourcer`, cached locally, and rendered client-side — "目前优酷使用的外挂字幕采用的是 ass 格式" (currently Youku's external subtitles use the ass format) **[DOC]** ([阿里云开发者社区: 优酷外挂字幕技术实践](https://developer.aliyun.com/article/761751)). It confirms the player has a **"subtitle cmd"** channel and a **"设置 subtitle url"** (set subtitle URL) command, but the blog does **not** publish the endpoint that returns that URL.

**`_m_h5_tk` token flow:** Youku's H5 APIs (`acs.youku.com/h5/mtop.*`) use the standard Alibaba MTop scheme: the first request returns a `_m_h5_tk` cookie shaped `<token>_<timestamp>`, and the caller must then compute `sign = md5(token + '&' + t + '&' + appKey + '&' + data)` and retry with `t` and `sign`, plus `_m_h5_tk`/`_m_h5_tk_enc` cookies. **I could not verify a specific Youku endpoint that returns subtitle data via this flow.** I am stating this as *known mechanism, unverified applicability* rather than inventing an endpoint.

**Feasibility:** ⚠️ **Partially.** `ups/get.json` is trivially implementable server-side and yields rich metadata + stream URLs — **but not subtitles**. Subtitle retrieval would require locating the private `subtitle url` command endpoint (not documented publicly) or driving the player. **Do not promise Youku subtitles from a server-side Node script.**

## 2.3 爱奇艺 (iqiyi.com)

**This is the hardest of the three and the honest answer is "not implementable server-side."**

**Player API [CODE `yt-dlp/yt_dlp/extractor/iqiyi.py`]:**

```
GET https://cache-video.iq.com/dash?<params>&vf=<cmd5x(dash_path)>
GET https://cache.m.iqiyi.com/jp/tmts/<tvid>/<video_id>/
GET https://cache.video.qiyi.com/jp/avlist/<album_id>/<page_num>/<PAGE_SIZE>/
GET https://pcw-api.iq.com/api/vtype?batch=1&platformId=3&modeCode=...&langCode=...&deviceId=<QC005 cookie>
```

**[LIVE]:** `https://cache.video.iqiyi.com/jp/tmts/1/1/` returns `var tvInfoJs=` (14 bytes) — i.e. it is a **JSONP-style `var` assignment**, requiring `strip_jsonp`. It responds, but with an empty payload for bogus ids.

**The signature chain — this is why it is not server-side implementable:**

1. **`cmd5x`** — a heavily obfuscated JavaScript function. `yt-dlp` extracts it **from the player bundle itself** by regex on a decompiled webpack module:

   ```python
   self._search_regex(r',\s*(function\s*\([^\)]*\)\s*{\s*var _qda.+_qdc\(\)\s*})\s*,', ...)
   ```

   It then walks `https://stc.iqiyipic.com/_next/static/chunks/webpack-*.js` to find the module chunk containing the string `'vms request'` **[CODE `_extract_vms_player_js()`]**.

2. **`authKey = cmd5x(cmd5x('') + tm + '' + tvid)`** — i.e. the signature depends on the output of the obfuscated function applied to itself **[CODE]**.

3. **`vf = cmd5x(dash_path)`** appended to the final URL **[CODE]**.

4. **Execution requires PhantomJS**: `yt-dlp` runs the extracted function via `PhantomJSwrapper(self, timeout=120_000).get(...)` with the comment `note2='Executing signature code (this may take a couple minutes)'` **[CODE]**. That is a **headless JS runtime**, i.e. a browser.

5. The full query also carries **`dfp`** (an iQiyi device fingerprint cookie), `k_uid` (32 random hex), `qdy`, `qds`, `qdsign`-family params, `bop` (`{"version":"10.0","dfp":...}`), and a large `k_ft1`/`k_ft4`/`k_ft5`/`k_ft7` rights bitmask **[CODE]**.

**Where the subtitles actually are — this part is clean [CODE `iqiyi.py`]:**

```python
for sub_format in api_response['program']['stl']:
    lang = self._LID_TAGS.get(str(sub_format.get('lid')), sub_format.get('_name'))
    subtitles[lang] = [{
        'ext':   format_ext,                # 'srt' or 'vtt'
        'url':   urljoin(api_response.get('dstl', 'http://meta.video.iqiyi.com'), sub_format[format_key]),
    } for format_key, format_ext in [('srt', 'srt'), ('webvtt', 'vtt')] if sub_format.get(format_key)]
```

So: **`program.stl[]`** with per-entry `lid` (language id) and **`srt`** and/or **`webvtt`** relative paths, resolved against **`program.dstl`** (default host `http://meta.video.iqiyi.com`). Language id map **[CODE]**: `1`=zh-CN, `2`=en… the extractor's `_LID_TAGS` maps `'2'`→? / `'3'`→en / `'4'`→ko / `'5'`→ja / `'18'`→th / `'21'`→my / `'23'`→vi / `'24'`→id / `'26'`→es / `'27'`→pt / `'28'`→ar.

**Cookies [CODE]:** `QC005` (device id, read via `self._get_cookie('QC005','')` and sent as `deviceId`), `dfp` (device fingerprint), `mod` (default `intl`), `lang` (default `en_us`), `I00002` (URL-encoded JSON holding `uid`). A `P00001` login cookie is the conventional iQiyi auth cookie.

**Feasibility:** ❌ **Not implementable server-side.** The subtitle *URLs* are trivially parseable once you have the `dash` response — but **obtaining that response requires executing obfuscated JS to compute `cmd5x`/`authKey`/`vf`**, which requires a JS engine (PhantomJS in the reference implementation; a headless Chromium in practice). Report this as browser-required, or use a paid/third-party API.

## 2.4 芒果TV (mgtv.com)

**Two-step flow, both endpoints `pcweb.api.mgtv.com`. Fully implementable server-side — I verified both steps live.**

### Step 1 — player info (yields `pm2`, needed later)

```
GET https://pcweb.api.mgtv.com/player/video?tk2=<tk2>&video_id=<id>&type=pch5
```

**`tk2` is generated entirely client-side [CODE `yt-dlp/yt_dlp/extractor/mgtv.py`]:**

```python
tk2 = base64.urlsafe_b64encode(f'did={uuid4()}|pno=1030|ver=0.3.0301|clit={int(time.time())}'.encode())[::-1]
```

i.e. build the string, **base64url-encode it, then reverse the resulting characters**. No secret, no server round-trip.

**[LIVE] — reproduced in Node and it works:**

```
tk2 = 0gDN5QTMykzNx0Ddpx2Y8FDMzAjLz4CM9IXZ2xHMzATM98mbwxnYkNWMyETM3cTMxcTL0MDN40iZyIGNtIjNwcTLycDO5EzMygTPklGZ

GET .../player/video?tk2=<above>&video_id=15588271&type=pch5
→ HTTP 200, code 200, msg ""
  data keys: atc, share, user, stream_quality, drm, frame, points, info, penc, adParams
  info: { thumb, trialtime, title: "春日迟迟再出发 沉浸版第1期：...", partName: "...",
          duration: "4026", drmFlag: "0", ... }
  atc.pm2: "ttBW5~COk6jD_i2Hz8tOiqorfvAoYGHagt5pER19w125z374_~jf7qkPC~6Stq8bvE..."
```

Without `tk2` it returns `{"msg":"参数错误","code":30001}` **[LIVE]** — so `tk2` is genuinely required.

### Step 2 — stream source (needs `pm2` from step 1)

```
GET https://tinker.glb.mgtv.com/player/getSource
    ?_support=10000000&tk2=<tk2>&pm2=<atc.pm2>&video_id=<id>&type=pch5
    &auth_mode=1&cxid=&supportMse=1&src=intelmgtv&abroad=10&allowedRC=1
```

Returns `data.stream_domain` (a domain, e.g. `https://...mgtv.com`) and `data.stream[]` **[CODE]**.

### Step 3 — subtitles

```
GET https://pcweb.api.mgtv.com/video/title?videoId=<video_id>          ← subtitle track list
GET <stream_domain><sub.url>                                            ← per-track JSON
GET <that JSON's .info field>                                           ← the actual .srt
```

Extraction logic **[CODE `mgtv.py` `_get_subtitles()`]**:

```python
info = self._download_json(f'https://pcweb.api.mgtv.com/video/title?videoId={video_id}', video_id)['data']
for sub in info['title']:
    locale = sub.get('captionSimpleName') or 'en'
    sub = self._download_json(f'{domain}{sub["url"]}', video_id)
    sub_url = sub.get('info')       # → the .srt URL
    subtitles[locale] = [{'url': sub_url, 'name': sub.get('name'), 'ext': 'srt'}]
```

**So the chain is: `video/title` → `data.title[].url` → per-track JSON → its **`info`** field = the `.srt` URL. Extension is always `srt`.**

**[LIVE]:** `GET https://pcweb.api.mgtv.com/video/title?videoId=15588271` returned `{"data":{"partId":"15588271","title":[]},"code":200,"msg":""}` — `HTTP 200`, `code 200`, and an **empty `title[]`** (that particular video has no subtitle translations). The endpoint and envelope are confirmed; the populated-entry field names are **[CODE]**-only.

**Error code observed [LIVE]:** `30001` = 参数错误. `40005` on a 401 means **geo-restricted** **[CODE]**.

**Feasibility:** ✅ **Server-side implementable.** `tk2` is a pure client-side transformation with no secret, and I reproduced it live. This is the best-behaved of the Chinese commercial platforms.

## 2.5 抖音 (douyin.com)

**Endpoint (conventional) [CODE, widely used in `Douyin_TikTok_Download_API` v4 and similar]:**

```
GET https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=<id>&device_platform=webapp&aid=6383
```

**Signature/anti-bot — this is the blocker.** Douyin requires `a_bogus` (the current generation; earlier `X-Bogus`), plus `msToken`, and cookies `ttwid`, `__ac_nonce`/`__ac_signature`, and `s_v_web_id`. `a_bogus` is produced by **obfuscated, VM-protected JavaScript**; the ecosystem's serious implementations do not reimplement it in a server language — they run it in a browser or in a JS engine.

The leading project's own README states it plainly **[DOC `Evil0ctal/Douyin_TikTok_Download_API`]**: v5 uses a **headless browser to mint guest identities** ("A headless browser mints guest identities, and the pool tops itself up when usable ones run low"), uses **`wreq` browser TLS fingerprint emulation**, and implements `a_bogus`, `X-Bogus`, `X-Gnarly`, `X-Dynosaur` "in pure Python, **with a browser fallback**". v4 required manually pasting browser cookies into `config.yaml`. It also warns the baked-in cookie "expired long ago, so Douyin endpoints answer `400` until you put your own in".

**[LIVE] — anonymous probe is blocked outright:**

```
GET https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=7126745726494821640&device_platform=webapp&aid=6383
Referer: https://www.douyin.com/
→ HTTP 403, body: "Blocked by ArgusSecurityPlugin Uifid Not Found"
```

`Uifid Not Found` — Douyin rejects the request before it even evaluates the signature, because no `ttwid`/`uifid` cookie is present.

**Subtitle data:** Douyin CC captions, when exposed, live under the video object in the aweme detail response (fields in the `video` → caption/`cla_info` family). **I could not verify the exact JSON path from any primary or third-party source I could fetch** — the one search hit naming `caption_infos` traces to the **CapCut** project (`capcut-mate`), *not* Douyin, so I will not present it as a Douyin field. **Mark Douyin subtitle field paths as not found.**

**Cookies needed:** `ttwid`, `msToken`, `s_v_web_id`, `__ac_nonce`, plus `odin_tt`/`passport_csrf_token` for richer responses.

**Feasibility:** ❌ **Not realistically implementable as a pure server-side Node script.** Requires a browser (or a reversed `a_bogus` VM, which is a research project in itself, not a library feature).

## 2.6 快手 (kuaishou.com)

**Endpoint [CODE `NanmiCoder/MediaCrawler`, `media_platform/kuaishou/graphql/video_detail.graphql`]:**

```
POST https://www.kuaishou.com/graphql
Content-Type: application/json
```

with the GraphQL operation **`visionVideoDetail`** (variables `photoId`, `type`, `page`, `webPageArea`). **[LIVE]:** the endpoint answers `HTTP 200` with `{"result":2,"error_msg":null,"request_id":"..."}` for a bogus `photoId` — so the transport is open but **`result: 2` signals a rejected/invalid request** (needs a real `photoId` and a valid signature).

**The query document [CODE, fetched verbatim]** selects `photo { id duration caption likeCount coverUrl photoUrl ... manifest { ... } }`. **Note carefully: `caption` here is the video's *description text*, not a caption/subtitle track**, and the manifest selection contains **only `adaptationSet`/`representation` video entries — no text or subtitle tracks.** **There is no subtitle field in the canonical Kuaishou video-detail GraphQL query.** **[LIVE] agrees: nothing subtitle-like is exposed.**

**Signature:** `__NS_sig3` (`sig3`, ~56 chars) **[CODE/blog]** plus the `did`/`didv` device cookies; `__NS_sig3` is computed by obfuscated JS. My unsigned probe got `result: 2` rather than data.

**Feasibility:** ❌ **Not implementable server-side**, and **separately there is no evidence Kuaishou exposes CC subtitle tracks at all** via the documented web GraphQL surface. Report "no subtitle API found; caption text only".

## 2.7 西瓜视频 (ixigua.com)

**Status: unprotected page, but no subtitle extraction exists anywhere in the reference tooling.**

**[LIVE]:** `GET https://www.ixigua.com/6996881461559165471` returned `HTTP 200` and **72,914 bytes of HTML whose `<body>` is empty** — the payload is delivered by an **obfuscated JS VM** (`window._$jsvmprt`, a JSVMP interpreter). This is a deliberate anti-scraping design: the interesting state is not in the HTML.

**yt-dlp's extractor [CODE `yt_dlp/extractor/ixigua.py`, 3,375 bytes — the whole file]** does **not** handle subtitles. It pulls `main_url` values out of a JSON blob and **base64-decodes** them:

```python
for media in traverse_obj(json_data, (..., *path, lambda _, v: v['main_url'])):
    'url': base64.b64decode(media['main_url']).decode(),
```

There is **no `_get_subtitles`**, no `.srt`/`.vtt` handling, and no `subtitle` field access. Searching the file for `subtitle` yields **zero matches**.

**Signature:** `_signature` / `X-Bogus` are required for the `/api/` endpoints and are produced by the same JSVMP — see the reverse-engineering writeup [[西瓜视频X-Bougs参数细节逆向分析](https://www.bilibili.com/video/BV1kx421y7k4/)].

**Feasibility:** ❌ **Not implementable server-side.** Subtitle support would be research-grade work, and it is plausible Xigua simply does not expose CC tracks.

## 2.8 微博视频 (weibo.com/tv)

**Endpoint [CODE `yt_dlp/extractor/weibo.py` `WeiboVideoIE`]:**

```
POST https://weibo.com/tv/api/component?page=/tv/show/<oid>
Content-Type: application/x-www-form-urlencoded
Referer: <the video page URL>
body: data={"Component_Play_Playinfo":{"oid":"<oid>"}}
```

Note the **double-JSON** body: a form field literally named `data` whose value is a JSON object with a single key `Component_Play_Playinfo`.

Response path **[CODE]**: `data.Component_Play_Playinfo`.

**The live player flow is `weibo.com/tv` → `url_result('https://weibo.com/0/<mid>', WeiboIE)`**, i.e. it hands off to the main Weibo extractor, which is what actually yields the media. The main extractor reads `page_info` / `playinfo` state from the page **[CODE]**.

**[LIVE] — the anonymous request is rejected by the visitor system:**

```
POST https://weibo.com/tv/api/component?page=/tv/show/Nse4S9TTU
Referer: https://weibo.com/tv/show/Nse4S9TTU
→ HTTP 200, Content-Type text/html, body = the "Sina Visitor System" anti-bot interstitial
   (<title>Sina Visitor System</title>, loads passport.sinaimg.cn/js/fp/1.2.1.umd.js)
```

**Redirects to a `Sina Visitor System` page instead of JSON** is the key observable: Weibo gates anonymous API access behind device fingerprinting. A logged-in session needs the `SUB` cookie (and `SUBP`); `XSRF-TOKEN` is needed for state-changing calls.

**Subtitles:** yt-dlp's Weibo extractor has **no subtitle handling** — searching `weibo.py` for `subtitle|srt|vtt` yields zero relevant matches. Weibo video CC is not a documented feature of the web player.

**Feasibility:** ❌ **Not implementable anonymously server-side** without a valid `SUB` session and passing the visitor-system fingerprint; and **there is no evidence of an accessible subtitle track** even when authenticated.

## 2.9 央视网 (tv.cctv.com / cntv.cn) and 网易公开课

### 央视网 (CCTV)

**Endpoint [CODE `yt_dlp/extractor/cctv.py`]:**

```
GET http://vdn.apps.cntv.cn/api/getHttpVideoInfo.do?pid=<guid>&url=<page url>&idl=32&idlr=32&modifyed=false
```

`<guid>` is scraped from the page HTML with any of these regexes **[CODE]**:

```
var\s+guid\s*=\s*["']([\da-fA-F]+)
videoCenterId(?:["']\s*,|:)\s*["']([\da-fA-F]+)
changePlayer\s*\(\s*["']([\da-fA-F]+)
load[Vv]ideo\s*\(\s*["']([\da-fA-F]+)
var\s+initMyAray\s*=\s*["']([\da-fA-F]+)
var\s+ids\s*=\s*\[["']([\da-fA-F]+)
```

Response gives `title`, `video.lowChapters[]`/`video.chapters[].url`, and **`hls_url`** (the extractor strips `maxbr=\d+&?` from it) **[CODE]**.

**[LIVE]:** with a fabricated `pid`, the API returned `HTTP 200` and `{"ack":"no","status":"004","tip_num":"PT5","tip_msg":"该视频不存在，请观看其他视频"}` — the endpoint is live, anonymous, and returns a **Chinese JSON error object with `ack:"no"`** rather than an HTTP error. **Check `ack`, not the status code.**

**Subtitles:** yt-dlp's `cctv.py` (7,029 bytes) has **no subtitle handling** — searching for `subtitle|srt|vtt` finds only the `_VALID_URL` and the `vdn` API. CCTV does publish sidecar subtitle files in some players, but **I found no endpoint documentation and will not invent one**.

**Feasibility:** ⚠️ **Metadata + HLS: yes, server-side, today.** **Subtitles: no documented route found.** The HLS `hls_url` is worth parsing for `#EXT-X-MEDIA:TYPE=SUBTITLES` (§3.1) as a best-effort probe — that is the only plausible subtitle vector here.

### 网易公开课 (open.163.com)

**No dedicated extractor exists.** yt-dlp ships `netease.py` but it covers **NetEase Music** (`music.163.com`), **not** 公开课; my attempt to fetch an `netease.py` extractor returned the music one, and the jsDelivr file listing for `yt-dlp@master/yt_dlp/extractor/` shows `neteasemusic.py` and **no** open-course extractor. **I found no documented subtitle endpoint for 网易公开课.** Do not implement; treat as unsupported.

---

# Part 3 — Generic fallbacks that work across many sites

These should be **attempted first** for any site not in §2 — they are cheap, and for sites like Tencent/Mango they are what the real implementation ultimately consumes anyway.

## 3.1 HLS `.m3u8` with `#EXT-X-MEDIA:TYPE=SUBTITLES`

Per **RFC 8216 §4.3.4.1**, a master playlist may declare subtitle renditions:

```
#EXTM3U
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",DEFAULT=YES,AUTOSELECT=YES,FORCED=NO,LANGUAGE="en",URI="subs/en/index.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=2665726,RESOLUTION=1280x720,SUBTITLES="subs"
  720p/index.m3u8
```

**Parsing rules, per RFC 8216 and yt-dlp's implementation [CODE `yt_dlp/extractor/common.py` `_parse_m3u8_formats_and_subtitles()`]:**

| Rule | Detail |
|---|---|
| Required attributes | `TYPE`, `GROUP-ID`, `NAME` — **if any is missing, skip the tag entirely** |
| Subtitle match | `TYPE === 'SUBTITLES'` |
| `URI` | **REQUIRED for `TYPE=SUBTITLES`** (§4.3.4.2.1) — but "lack of URI has been spotted in the wild", so guard it |
| Format | An `.m3u8` subtitle URI is **always WebVTT** — RFC 8216 §3.1: "the only possible subtitle format m3u8 files may contain is WebVTT". So `.m3u8` → `ext: 'vtt'`, protocol `m3u8_native` |
| Language | `LANGUAGE` attribute; **default to `'und'`** (undetermined) when absent |
| Parse order | Parse **all `#EXT-X-MEDIA` lines before any `#EXT-X-STREAM-INF` lines** — master playlists in the wild (e.g. Nebula) put them out of order |

Node implementation:

```js
function parseHlsSubtitleRenditions(m3u8Text, baseUrl) {
  const subs = [];
  for (const raw of m3u8Text.split(/\r?\n/)) {
    if (!raw.startsWith('#EXT-X-MEDIA:')) continue;
    const attrs = {};
    // RFC 8216 attribute-list: NAME=VALUE, quoted strings may contain commas. Use a proper scan.
    const body = raw.slice('#EXT-X-MEDIA:'.length);
    const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
    let m;
    while ((m = re.exec(body))) attrs[m[1]] = m[2].replace(/^"|"$/g, '');
    if (attrs.TYPE !== 'SUBTITLES') continue;      // also skips VIDEO/AUDIO/CLOSED-CAPTIONS
    if (!attrs['GROUP-ID'] || !attrs.NAME) continue;
    if (!attrs.URI) continue;                      // required in theory, absent in the wild
    const url = new URL(attrs.URI, baseUrl).toString();
    const isPlaylist = url.includes('.m3u8');
    subs.push({
      language: attrs.LANGUAGE || 'und',           // yt-dlp defaults to 'und'
      name: attrs.NAME,
      groupId: attrs['GROUP-ID'],
      default: attrs.DEFAULT === 'YES',
      autoselect: attrs.AUTOSELECT === 'YES',
      forced: attrs.FORCED === 'YES',
      url,
      ext: isPlaylist ? 'vtt' : (url.split('.').pop().split('?')[0] || 'vtt'),
      needsPlaylistFetch: isPlaylist,              // fetch, then concatenate #EXTINF-less VTT cues
    });
  }
  return subs;
}
```

A subtitle media playlist is a sequence of WebVTT segments with `#EXT-X-TARGETDURATION` and `#EXTINF`; **fetch each segment URI and concatenate**, keeping one `WEBVTT` header. If the playlist instead contains a single `#EXT-X-MEDIA` with a direct `.vtt` URI, no fetch-merge is needed.

**Reality check:** the manifest is rarely reachable directly — you usually have to call the platform's player API first (Tencent `m3u8`, Mango `stream[].url`, Kuaishou `manifest.adaptationSet[].representation[].url`) to *get* the m3u8 URL. The generic parser is the **second** half of a site-specific first half.

## 3.2 Direct `.vtt` / `.srt` / `.ass` references in HTML or JSON state

Grep-scrape the raw page/state for subtitle file URLs. High-signal regexes:

```js
const SUBTITLE_URL_RE = [
  /https?:\\?\/\\?\/[^"'\\\s]+?\.(?:vtt|srt|ass|ssa)(?:\?[^"'\\\s]*)?/gi,  // absolute, JSON-escaped \/ included
  /["']([^"']+\.(?:vtt|srt|ass|ssa)(?:\?[^"']*)?)["']/gi,                    // quoted, may be relative
  /"subtitle[s]?(?:Url|URL|_url)"\s*:\s*"([^"]+)"/gi,                        // JSON keys
  /"webvtt"\s*:\s*"([^"]+)"/gi,                                             // iQiyi program.stl[].webvtt
  /"srt"\s*:\s*"([^"]+)"/gi,                                                // iQiyi program.stl[].srt
  /"info"\s*:\s*"(https?:[^"]+\.srt[^"]*)"/gi,                              // Mango per-track JSON → .srt
];
```

Rules that matter:

1. **Un-escape JSON-escaped slashes** (`https:\/\/...` → `https://...`) before use — this is ubiquitous in embedded state.
2. **Resolve relative URLs** against the page URL, using `dstl`/`dm3u8`-style base-host fields when the site provides one (iQiyi: `urljoin(program.dstl || 'http://meta.video.iqiyi.com', stl[i].srt)` **[CODE]**).
3. **`.ass`/`.ssa` are not WebVTT** — you need a real ASS parser (styles, `[Events]`, `Dialogue:` lines, `\N` line breaks, override tags `{\...}`). Youku's external subtitles are ASS **[DOC, Youku engineering blog]**. Do not hand-roll a regex; the override-tag grammar is large.
4. **Check the `Content-Type`** of a candidate URL before trusting the extension; CDNs mislabel.

## 3.3 `<track kind="subtitles">` elements

```html
<video ...>
  <track kind="subtitles" src="/subs/zh.vtt" srclang="zh" label="中文" default>
</video>
```

Parse with a real HTML parser (or a tolerant regex over `<track\b[^>]*>`), then extract `src`, `srclang`, `label`, `default`. Two caveats:
- `kind` ∈ {`subtitles`, `captions`, `descriptions`, `chapters`, `metadata`} — only the first two are what you want; `chapters` is not subtitles.
- `<track>` in a **static** HTML response usually points at a same-origin path; in **SPA** players (which is nearly all of these platforms) the `<track>` element is injected at runtime and **will not be present in the fetched HTML** — in that case it is a browser-only route.

## 3.4 JSON blobs in `window.__INITIAL_STATE__` / `__NEXT_DATA__` / player config

Extract the object, then deep-search for subtitle-shaped nodes:

```js
const STATE_PATTERNS = [
  /window\.__INITIAL_STATE__\s*=\s*(\{.*?\});/s,
  /window\.__INITIAL_DATA__\s*=\s*(\{.*?\});/s,
  /<script id="__NEXT_DATA__"[^>]*>(\{.*?\})<\/script>/s,
  /window\.__NUXT__\s*=\s*(\{.*?\});/s,
  /<script[^>]*>[^<]*window\.__(?:pinia|PINIA__)\s*=\s*(\{.*?\});/s,   // Tencent's Vue/Pinia state
  /<script[^>]*>[^<]*window\.__playinfo__\s*=\s*(\{.*?\})<\/script>/s, // Bilibili legacy player state
];
```

`window.__playinfo__` on Bilibili and `window.__pinia` on Tencent (`v.qq.com`) are both real **[CODE `tencent.py` `_get_webpage_metadata()` searches precisely for `<script[^>]*>[^<]*window\.__(?:pinia|PINIA__)\s*=`]**. Note that a JS object literal in HTML is **not** valid JSON (unquoted keys, single quotes, trailing commas) — you need a tolerant parser (`JSON5`-style) or a targeted regex, which is exactly why the extractors call a `js_to_json` transform **[CODE]**.

Then walk the tree for any object that looks like a subtitle track:

```js
function findSubtitleTracks(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) { node.forEach((n) => findSubtitleTracks(n, out)); return out; }
  const urlish = (v) => typeof v === 'string' && /\.(vtt|srt|ass|ssa|m3u8)(\?|$)/i.test(v);
  const keys = Object.keys(node);
  const hasOurKeys = ['subtitle_url','subtitleUrl','webvtt','srt','sub_url']
    .some((k) => typeof node[k] === 'string' && urlish(node[k]));
  const hasLang = ['lan','lang','language','srclang','locale','captionSimpleName']
    .some((k) => typeof node[k] === 'string');
  if (hasOurKeys || (urlish(node.url) && hasLang)) {
    out.push({
      lang: node.lan ?? node.lang ?? node.language ?? node.srclang ?? node.locale
            ?? node.captionSimpleName ?? 'und',
      label: node.lan_doc ?? node.name ?? node.label ?? null,
      url: node.subtitle_url ?? node.subtitleUrl ?? node.webvtt ?? node.srt
           ?? node.sub_url ?? node.url ?? node.info,
    });
  }
  for (const k of keys) findSubtitleTracks(node[k], out);
  return out;
}
```

**Generic-fallback feasibility:** search page HTML/state → ⚠️ works for SSR'd pages, **fails for JSVMP/SPA players** (Xigua, Douyin, Kuaishou, Weibo all failed to yield state in my probes **[LIVE]**). HLS rendition parsing → ✅ works whenever you can obtain the master playlist. `<track>` → ⚠️ static pages only.

---

# Part 4 — Difficulty / feasibility table

| Site | Endpoint known? | Signature needed? | Cookie needed? | Implementable server-side? |
|---|---|---|---|---|
| **Bilibili** metadata | ✅ `x/web-interface/view` **[LIVE]** | ❌ not enforced | ❌ no | ✅ **yes** |
| **Bilibili** subtitle list | ✅ `x/player[/wbi]/v2` **[LIVE]** | ⚠️ WBI (advisory; implement it) | ✅ **`SESSDATA` — yes** | ✅ **yes, with SESSDATA** |
| **Bilibili** subtitle file | ✅ `subtitle_url` CDN **[LIVE]** | ❌ no | ❌ no | ✅ **yes** (`auth_key` expires fast) |
| **Bilibili** AI subtitle (`ai-zh`) | ⚠️ same `subtitles[]`, gated | ⚠️ WBI | ✅ `SESSDATA` | ⚠️ **usually yes; browser fallback when the list stays empty** |
| **腾讯视频** | ✅ `h5vv6.video.qq.com/getvinfo` **[LIVE]** | ✅ `cKey` AES-128-CBC — **fully reproducible** | ❌ no | ✅ **yes** (subtitle field names are code-reported) |
| **优酷** metadata | ✅ `ups.youku.com/ups/get.json` **[LIVE]** | ⚠️ `utid` = `cna` from `log.mmstat.com` etag | ⚠️ `__ysuid`, `xreferrer` | ✅ **yes** |
| **优酷** subtitles | ❌ **not found** | — | — | ❌ **no** — external `.ass`, endpoint undocumented |
| **爱奇艺** metadata | ✅ `cache-video.iq.com/dash` **[CODE]** | ✅ **`cmd5x`/`authKey`/`vf` — obfuscated JS** | ✅ `QC005`, `dfp`, `P00001` | ❌ **no** — needs PhantomJS/headless Chromium |
| **爱奇艺** subtitles | ✅ `program.stl[].srt`/`.webvtt` @ `program.dstl` **[CODE]** | inherits the above | inherits | ❌ **no** (trivial *once* you have the response) |
| **芒果TV** | ✅ `pcweb.api.mgtv.com` ×2 + `tinker.glb.mgtv.com` **[LIVE]** | ✅ `tk2` base64url+reverse — **no secret** | ⚠️ geo only | ✅ **yes** — the best of the commercial set |
| **抖音** | ⚠️ `aweme/v1/web/aweme/detail/` | ✅ **`a_bogus` + `msToken` — VM-obfuscated JS** | ✅ `ttwid`, `s_v_web_id`, `__ac_nonce` | ❌ **no** — needs a browser (403 `Uifid Not Found` anonymous **[LIVE]**) |
| **快手** | ✅ `www.kuaishou.com/graphql` **[LIVE]** | ✅ **`__NS_sig3` — obfuscated JS** | ✅ `did`/`didv` | ❌ **no** — and **no subtitle track in the GraphQL schema at all** |
| **西瓜视频** | ❌ page is a JSVMP blob **[LIVE]** | ✅ `_signature`/`X-Bogus` — JSVMP | ✅ `__ac_nonce` | ❌ **no** — and no subtitle support in any reference tooling |
| **微博视频** | ✅ `weibo.com/tv/api/component` **[LIVE]** | ✅ visitor-system device fingerprint | ✅ **`SUB`**, `SUBP`, `XSRF-TOKEN` | ❌ **no** anonymous (Sina Visitor System interstitial **[LIVE]**); no subtitle feature |
| **央视网** metadata | ✅ `vdn.apps.cntv.cn/api/getHttpVideoInfo.do` **[LIVE]** | ❌ no | ❌ no | ✅ **yes** (check `ack`, not HTTP status) |
| **央视网** subtitles | ❌ **not found** | — | — | ❌ **no** — try §3.1 on `hls_url` as best effort |
| **网易公开课** | ❌ **not found** — no extractor exists | — | — | ❌ **no** |
| **Generic HLS `TYPE=SUBTITLES`** | ✅ RFC 8216 | ❌ no | ❌ no | ✅ **yes** (needs the master playlist URL) |
| **Generic `.vtt`/`.srt`/`.ass` scrape** | ✅ regex | ❌ no | ❌ no | ✅ **yes** on SSR pages; ❌ on SPA/JSVMP |
| **Generic `<track kind="subtitles">`** | ✅ HTML | ❌ no | ❌ no | ⚠️ **static pages only** |
| **Generic `__INITIAL_STATE__`/`__NEXT_DATA__`** | ✅ | ❌ no | ❌ no | ⚠️ **SSR only** |

**Summary judgement.** Of the nine secondary platforms, exactly **two** are cleanly implementable server-side for subtitles: **芒果TV** (client-side `tk2` with no secret) and **腾讯视频** (fixed-key AES `cKey`, reproduced live in Node). **优酷** is implementable for metadata but has **no discoverable subtitle endpoint**. **爱奇艺, 抖音, 快手, 西瓜视频, and 微博** all require executing obfuscated/VM-protected JavaScript, and for **快手, 西瓜视频, and 微博** there is additionally **no evidence that a CC subtitle track is exposed on the web at all** — so even a browser-based implementation may find nothing to extract. **央视网** gives metadata and HLS but no documented subtitle route. **网易公开课** has no extractor anywhere in the ecosystem.

---

# Part 5 — Implementation checklist / risk register

1. **Never trust `code: 0` alone on Bilibili.** Check `data.v_voucher` (WBI challenge), `data.need_login_subtitle` (login gate), and empty `subtitles[]` (three distinct causes). This is the #1 correctness trap.
2. **Use `id_str`, not `id`.** Bilibili subtitle ids exceed `Number.MAX_SAFE_INTEGER` (`13643112644608002`). `JSON.parse` silently corrupts `id`; `id_str` is the safe form and the API provides it precisely for this.
3. **Always normalize `//host/path` → `https://host/path`** for `subtitle_url`.
4. **Fetch the subtitle JSON immediately** after listing — `auth_key` is minute-scale, and a truncated URL yields `403`.
5. **Cache WBI keys, not WBI signatures.** Keys are stable for a day; `wts` must be fresh per request. Refresh keys on any `-352`/`v_voucher`.
6. **The UA you sign Tencent's `cKey` with must be the UA you send** — it feeds the checksum.
7. **Distinguish terminal from retryable errors.** Terminal: `62002`, `62004`, `62012`, `-403`, `-404`, `-689`, PGC paywall. Retryable: `-352`, `-412`, `-799`, `-509`, 429, 5xx.
8. **Do not implement `x/v2/subtitle/web/view`** — it 404s **[LIVE]**.
9. **Do not implement bare `?ep_id=` on `x/player/v2`** — it `-400`s **[LIVE]**; resolve `ep_id` → `aid` first.
10. **PGC durations are milliseconds** (`ep.duration: 1441000` for an 1441-second episode **[LIVE]**) while UGC `duration` is seconds. Normalize before use — this silently produces 1000× wrong timings.
11. **Respect the platform/vendor boundary.** None of the identified routes are documented public APIs; several are reverse-engineered. State that plainly in the library's README and gate features behind the feasibility table in Part 4 rather than promising uniform support.

---

# Sources

**Bilibili — authoritative docs (mirrors of the taken-down `SocialSisterYi/bilibili-API-collect`; upstream repo default branch is now `deprecated` and empty):**
- [pskdje/bilibili-API-collect](https://github.com/pskdje/bilibili-API-collect) — contributor mirror, `master` synced 2026-01-28. The `[DOC]` citations above resolve to raw files in this tree:
  - [`docs/video/info.md`](https://raw.githubusercontent.com/pskdje/bilibili-API-collect/master/docs/video/info.md) — `/x/web-interface/view`, error codes `62002`/`62004`/`62012`, `pages[]`, `subtitle.list[]`
  - [`docs/video/player.md`](https://raw.githubusercontent.com/pskdje/bilibili-API-collect/master/docs/video/player.md) — `/x/player/wbi/v2`, `data.subtitle.subtitles[]` field table, `need_login_subtitle`, the `//aisubtitle.hdslb.com/...auth_key=...` example
  - [`docs/misc/sign/wbi.md`](https://raw.githubusercontent.com/pskdje/bilibili-API-collect/master/docs/misc/sign/wbi.md) — WBI scheme, `MIXIN_KEY_ENC_TAB`, test vectors, multi-language demos, `v_voucher`
  - [`docs/misc/errcode.md`](https://raw.githubusercontent.com/pskdje/bilibili-API-collect/master/docs/misc/errcode.md) — the common error-code table (`-352`, `-400`, `-403`, `-404`, `-412`, `-509`, `-799`, `-111`, `-688`, `-689`, …)
  - [`docs/misc/buvid3_4.md`](https://raw.githubusercontent.com/pskdje/bilibili-API-collect/master/docs/misc/buvid3_4.md) — `x/frontend/finger/spi`, `x/web-frontend/getbuvid`, homepage `Set-Cookie` rules
  - [`docs/bangumi/info.md`](https://raw.githubusercontent.com/pskdje/bilibili-API-collect/master/docs/bangumi/info.md) — `/pgc/view/web/season`, `/pgc/review/user`, episode field table
  - [`docs/video/videostream_url.md`](https://raw.githubusercontent.com/pskdje/bilibili-API-collect/master/docs/video/videostream_url.md) — `/x/player/wbi/playurl`, WBI required, quality/format tables
- [xiaoyv404/bilibili-API-collect](https://github.com/xiaoyv404/bilibili-API-collect) and [alittlehuaji/bilibili-api-collect-mirror](https://github.com/alittlehuaji/bilibili-api-collect-mirror) — additional mirrors confirming the same `docs/` tree
- [BACNext/BACNext](https://github.com/BACNext/BACNext) — successor project
- Take-down context: [ithome.com report](https://www.ithome.com/0/917/481.htm), [ifeng tech report](https://tech.ifeng.com/c/8qJ6eBQuxXV)

**Bilibili — third-party implementations (`[CODE]`):**
- [yt-dlp/yt-dlp — `yt_dlp/extractor/bilibili.py`](https://raw.githubusercontent.com/yt-dlp/yt-dlp/master/yt_dlp/extractor/bilibili.py) — `_get_subtitles()` (`x/player/wbi/v2`), `json2srt()`, `_get_wbi_key()` with the 64-entry table, `_sign_wbi()`, `_WBI_KEY_CACHE_TIMEOUT = 30`, `_dm_params` fingerprint synthesis, `_HEADERS`
- [yt-dlp/yt-dlp — `yt_dlp/extractor/common.py`](https://raw.githubusercontent.com/yt-dlp/yt-dlp/master/yt_dlp/extractor/common.py) — `_parse_m3u8_formats_and_subtitles()`, `EXT-X-MEDIA`/`TYPE=SUBTITLES` handling and the WebVTT-only rule
- [wnma3mz/bili_ai_subtitle](https://github.com/wnma3mz/bili_ai_subtitle) — `src/bili_ai_subtitle/cli.py`: WBI signing, `normalize_subtitle_url()` (`//` → `https:`), the wbi→plain `player/v2` fallback, `need_login_subtitle` handling, `ai_status`/`ai_type` selection, `body` conversion
- [bfftp0502/bilibili-video-summary — `references/api.md`](https://raw.githubusercontent.com/bfftp0502/bilibili-video-summary/main/bilibili-video-summary/references/api.md) — `ai_status` semantics (0/1/2), the (non-existent) `x/v2/subtitle/web/view` claim, `-412`/`-352` notes, the subtitle JSON example
- [hudawei996/downkyi — `Subtitle.cs`](https://github.com/hudawei996/downkyi/blob/49895b8b7f9ac9787972639423d0c8dad91e8196/src/DownKyi.Core/BiliApi/Models/Json/Subtitle.cs) — `from`/`to`/`location`/`content` types
- [nanashi-1/bilibili-extractor-lib — `subtitle.rs`](https://docs.rs/bilibili-extractor-lib/latest/src/bilibili_extractor_lib/subtitle.rs.html) — `JsonSubtitle`/`JsonSubtitleBody` structs (note: no `location`), SRT/SSA/VTT conversions
- [WINFMEMZ2020/bilibili_ccconvert](https://github.com/WINFMEMZ2020/bilibili_ccconvert) — CC → SRT tool
- [socialsisteryi/bilibili-API-collect WBI discussions](https://github.com/SocialSisterYi/bilibili-API-collect/issues/631) — original reverse-engineering issue (linked from the doc)

**Secondary platforms (`[CODE]` unless noted):**
- [yt-dlp/yt-dlp — `yt_dlp/extractor/tencent.py`](https://cdn.jsdelivr.net/gh/yt-dlp/yt-dlp@master/yt_dlp/extractor/tencent.py) — `h5vv6.video.qq.com/getvinfo`, `_get_ckey()` AES params, `sfl.fi[]`, `spcaptiontype`/`spsrt`
- [yt-dlp/yt-dlp — `yt_dlp/extractor/youku.py`](https://cdn.jsdelivr.net/gh/yt-dlp/yt-dlp@master/yt_dlp/extractor/youku.py) — `ups.youku.com/ups/get.json`, `cna` from `log.mmstat.com` etag, `__ysuid`/`xreferrer`
- [yt-dlp/yt-dlp — `yt_dlp/extractor/iqiyi.py`](https://cdn.jsdelivr.net/gh/yt-dlp/yt-dlp@master/yt_dlp/extractor/iqiyi.py) — `_DASH_JS` with `cmd5x`/`authKey`/`vf`, PhantomJSwrapper execution, `program.stl[]`/`dstl` subtitle extraction, `_LID_TAGS`
- [yt-dlp/yt-dlp — `yt_dlp/extractor/mgtv.py`](https://cdn.jsdelivr.net/gh/yt-dlp/yt-dlp@master/yt_dlp/extractor/mgtv.py) — `tk2` construction, `pcweb.api.mgtv.com/player/video`, `tinker.glb.mgtv.com/player/getSource`, `_get_subtitles()` two-hop `.srt` resolution
- [yt-dlp/yt-dlp — `yt_dlp/extractor/ixigua.py`](https://cdn.jsdelivr.net/gh/yt-dlp/yt-dlp@master/yt_dlp/extractor/ixigua.py) — base64 `main_url`; **no subtitle support**
- [yt-dlp/yt-dlp — `yt_dlp/extractor/weibo.py`](https://cdn.jsdelivr.net/gh/yt-dlp/yt-dlp@master/yt_dlp/extractor/weibo.py) — `weibo.com/tv/api/component` post body and response path; **no subtitle support**
- [yt-dlp/yt-dlp — `yt_dlp/extractor/cctv.py`](https://cdn.jsdelivr.net/gh/yt-dlp/yt-dlp@master/yt_dlp/extractor/cctv.py) — `vdn.apps.cntv.cn/api/getHttpVideoInfo.do`, `guid` regexes; **no subtitle support**
- [NanmiCoder/MediaCrawler — `media_platform/kuaishou/graphql/video_detail.graphql`](https://cdn.jsdelivr.net/gh/NanmiCoder/MediaCrawler@main/media_platform/kuaishou/graphql/video_detail.graphql) — the canonical Kuaishou `visionVideoDetail` query (no subtitle fields)
- [Evil0ctal/Douyin_TikTok_Download_API](https://github.com/Evil0ctal/Douyin_TikTok_Download_API) — headless-browser identity minting, `wreq` TLS fingerprinting, pure-Python `a_bogus`/`X-Bogus` plus browser fallback; v4 cookie setup
- [idinging/douyin-abogus](https://github.com/idinging/douyin-abogus) — `a_bogus` reverse engineering
- [某手 __NS_sig3 算法 (56位) sig3 | js 逆向](https://cloud.tencent.com.cn/developer/article/2435516?policyId=1003) — Kuaishou `__NS_sig3`
- [西瓜视频 X-Bogus 参数细节逆向分析，插桩流程详解，JSVMP 算法还原](https://www.bilibili.com/video/BV1kx421y7k4/) — Xigua JSVMP + `_signature`
- [amagi (Rust) — `platforms/bilibili/sign/wbi.rs`](https://docs.rs/amagi/latest/src/amagi/platforms/bilibili/sign/wbi.rs.html) — independent WBI implementation

**Youku subtitles:**
- [优酷外挂字幕技术实践 — 阿里云开发者社区](https://developer.aliyun.com/article/761751) — **first-party** confirmation that Youku external subtitles are `.ass`, downloaded by a player-side `subtitle sourcer`, driven by a "set subtitle url" command. Documents the architecture but not the endpoint.

**HLS:**
- [RFC 8216 — HTTP Live Streaming](https://datatracker.ietf.org/doc/html/rfc8216) — §4.3.4.1 `EXT-X-MEDIA`, §4.3.4.2.1 (`URI` REQUIRED for `SUBTITLES`), §3.1 (m3u8 subtitle playlists are WebVTT only)
- [draft-pantos-hls-rfc8216bis — §4.4.6.1 EXT-X-MEDIA](https://datatracker.ietf.org/doc/draft-pantos-hls-rfc8216bis/) — second edition

**Bilibili official:**
- [接口调用频率规范 — bilibili 小程序文档](https://miniapp.bilibili.com/miniprogram-docs/framework/performance/api-frequency.html) — the **only** official rate-limit document; **applies to mini-program APIs only** (≤4 calls/s/user for `bl.login`/`bl.checkSession`/`bl.getSetting`/`bl.getUserInfo`/`bl.getUserProfile`), **not** to `api.bilibili.com/x/...`

**Research methodology note.** Every claim tagged **[LIVE]** was produced by executing an actual HTTP request from this session (Node 24, global `fetch`, `redirect: 'manual'` for the `b23.tv` check) against the live endpoints, anonymously and without cookies. Every claim tagged **[DOC]** is quoted from the documentation file cited beside it. Every claim tagged **[CODE]** is read from the named file in the named repository. Anything I could not establish from one of those three is marked **unverified** or **not found**, and I have deliberately not filled those gaps with plausible-looking endpoints.
