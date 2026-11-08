"""Command line interface for downloading Bilibili AI subtitles as SRT."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen


BILIBILI_VIEW_API = "https://api.bilibili.com/x/web-interface/view"
BILIBILI_NAV_API = "https://api.bilibili.com/x/web-interface/nav"
BILIBILI_PLAYER_API = "https://api.bilibili.com/x/player/v2"
BILIBILI_PLAYER_WBI_API = "https://api.bilibili.com/x/player/wbi/v2"
DEFAULT_USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/125.0.0.0 Safari/537.36"
)
WBI_MIXIN_KEY_ENC_TAB = (
    46,
    47,
    18,
    2,
    53,
    8,
    23,
    32,
    15,
    50,
    10,
    31,
    58,
    3,
    45,
    35,
    27,
    43,
    5,
    49,
    33,
    9,
    42,
    19,
    29,
    28,
    14,
    39,
    12,
    38,
    41,
    13,
    37,
    48,
    7,
    16,
    24,
    55,
    40,
    61,
    26,
    17,
    0,
    1,
    60,
    51,
    30,
    4,
    22,
    25,
    54,
    21,
    56,
    59,
    6,
    63,
    57,
    62,
    11,
    36,
    20,
    34,
    44,
    52,
)
DEFAULT_WBI_BROWSER_PARAMS = {
    "isGaiaAvoided": "false",
    "web_location": "1315873",
    "dm_img_list": (
        '[{"x":2122,"y":353,"z":0,"timestamp":3,"k":101,"type":0},'
        '{"x":2885,"y":672,"z":25,"timestamp":112,"k":99,"type":0}]'
    ),
    "dm_img_str": "V2ViR0wgMS4wIChPcGVuR0wgRVMgMi4wIENocm9taXVtKQ",
    "dm_cover_img_str": (
        "QU5HTEUgKEFwcGxlLCBBTkdMRSBNZXRhbCBSZW5kZXJlcjogQXBwbGUgTTQsIFVuc3BlY2lmaWVkIFZlcnNpb24p"
        "R29vZ2xlIEluYy4gKEFwcGxlKQ"
    ),
    "dm_img_inter": (
        '{"ds":[{"t":2,"c":"YnB4LXBsYXllci1sb2FkaW5nLXBhbmVsIGJweC1zdGF0ZS1sb2FkaW","p":[580,54,685],'
        '"s":[435,4614,2642]}],"wh":[5579,4828,97],"of":[424,848,424]}'
    ),
}


class BilibiliSubtitleError(RuntimeError):
    """Raised when subtitle discovery or conversion fails."""


@dataclass(frozen=True)
class VideoPage:
    page: int
    cid: int
    part: str


@dataclass(frozen=True)
class VideoInfo:
    aid: int
    bvid: str
    title: str
    pages: list[VideoPage]


def request_json(url: str, referer: str | None = None, cookie: str | None = None, retries: int = 3) -> dict[str, Any]:
    headers = {
        "User-Agent": DEFAULT_USER_AGENT,
        "Accept": "application/json, text/plain, */*",
    }
    if referer:
        headers["Referer"] = referer
    if cookie:
        headers["Cookie"] = cookie

    last_error: Exception | None = None
    for attempt in range(1, retries + 1):
        request = Request(url, headers=headers)
        try:
            with urlopen(request, timeout=30) as response:
                charset = response.headers.get_content_charset() or "utf-8"
                return json.loads(response.read().decode(charset))
        except HTTPError as exc:
            raise BilibiliSubtitleError(f"HTTP {exc.code}: {url}") from exc
        except URLError as exc:
            last_error = exc
            if attempt < retries:
                time.sleep(attempt)
                continue
            raise BilibiliSubtitleError(f"请求失败: {exc.reason}") from exc
        except json.JSONDecodeError as exc:
            raise BilibiliSubtitleError(f"响应不是合法 JSON: {url}") from exc

    raise BilibiliSubtitleError(f"请求失败: {last_error}")


def extract_bvid(video_url: str) -> str:
    match = re.search(r"(BV[0-9A-Za-z]+)", video_url)
    if not match:
        raise BilibiliSubtitleError("链接里没有找到 BV 号")
    return match.group(1)


def bilibili_api_get(endpoint: str, params: dict[str, Any], referer: str, cookie: str | None) -> dict[str, Any]:
    api_url = f"{endpoint}?{urlencode(params)}"
    payload = request_json(api_url, referer=referer, cookie=cookie)
    if payload.get("code") != 0:
        message = payload.get("message") or payload.get("msg") or "未知错误"
        raise BilibiliSubtitleError(f"Bilibili API 返回错误: {message}")
    data = payload.get("data")
    if not isinstance(data, dict):
        raise BilibiliSubtitleError("Bilibili API 响应缺少 data")
    return data


def get_url_file_stem(url: str) -> str:
    filename = url.rsplit("/", 1)[-1].split(".", 1)[0]
    if not filename:
        raise BilibiliSubtitleError("无法解析 WBI key")
    return filename


def get_wbi_mixin_key(cookie: str | None) -> str:
    payload = request_json(BILIBILI_NAV_API, referer="https://www.bilibili.com/", cookie=cookie)
    data = payload.get("data")
    wbi_img = data.get("wbi_img") if isinstance(data, dict) else None
    if not isinstance(wbi_img, dict):
        if payload.get("code") != 0:
            message = payload.get("message") or payload.get("msg") or "未知错误"
            raise BilibiliSubtitleError(f"获取 WBI key 失败: {message}")
        raise BilibiliSubtitleError("获取 WBI key 失败: 响应缺少 wbi_img")

    img_url = str(wbi_img.get("img_url") or "")
    sub_url = str(wbi_img.get("sub_url") or "")
    raw_key = get_url_file_stem(img_url) + get_url_file_stem(sub_url)
    return "".join(raw_key[index] for index in WBI_MIXIN_KEY_ENC_TAB)[:32]


def sign_wbi_params(params: dict[str, Any], cookie: str | None) -> dict[str, Any]:
    signed_params = {key: str(value) for key, value in params.items() if value is not None}
    signed_params["wts"] = str(int(time.time()))
    mixin_key = get_wbi_mixin_key(cookie)
    filtered_params = {
        key: "".join(char for char in value if char not in "!'()*")
        for key, value in signed_params.items()
    }
    query = urlencode(sorted(filtered_params.items()))
    signed_params["w_rid"] = hashlib.md5(f"{query}{mixin_key}".encode("utf-8")).hexdigest()
    return signed_params


def get_subtitles_from_player_data(data: dict[str, Any]) -> list[dict[str, Any]]:
    subtitle = data.get("subtitle")
    subtitles = subtitle.get("subtitles") if isinstance(subtitle, dict) else None
    if isinstance(subtitles, list):
        return subtitles
    return []


def get_video_info(bvid: str, referer: str, cookie: str | None) -> VideoInfo:
    data = bilibili_api_get(BILIBILI_VIEW_API, {"bvid": bvid}, referer, cookie)
    aid = data.get("aid")
    if not isinstance(aid, int):
        raise BilibiliSubtitleError("没有找到有效 aid")
    title = str(data.get("title") or bvid)
    pages = data.get("pages")
    if not isinstance(pages, list) or not pages:
        raise BilibiliSubtitleError("没有找到视频分 P 信息")

    video_pages: list[VideoPage] = []
    for index, page_data in enumerate(pages, start=1):
        if not isinstance(page_data, dict):
            continue
        cid = page_data.get("cid")
        if not isinstance(cid, int):
            raise BilibiliSubtitleError(f"p={index} 没有有效 cid")
        part = str(page_data.get("part") or f"p{index}")
        video_pages.append(VideoPage(page=index, cid=cid, part=part))

    if not video_pages:
        raise BilibiliSubtitleError("没有找到有效的视频分 P")
    return VideoInfo(aid=aid, bvid=bvid, title=title, pages=video_pages)


def select_video_pages(all_pages: list[VideoPage], page: int | None) -> list[VideoPage]:
    if page is None:
        return all_pages
    if page < 1:
        raise BilibiliSubtitleError("分 P 参数必须大于等于 1")
    if page > len(all_pages):
        raise BilibiliSubtitleError(f"该视频只有 {len(all_pages)} 个分 P，无法选择 p={page}")
    return [all_pages[page - 1]]


def normalize_subtitle_url(url: str) -> str:
    if url.startswith("//"):
        return f"https:{url}"
    return url


def choose_subtitle_url(
    subtitles: list[dict[str, Any]],
    preferred_lang: str | None,
) -> tuple[str, dict[str, Any]]:
    if not subtitles:
        raise BilibiliSubtitleError(
            "没有找到字幕。这个视频分 P 可能没有 AI 字幕，或需要登录 Cookie 才能看到字幕列表。"
        )

    candidates = [item for item in subtitles if item.get("subtitle_url")]
    if preferred_lang:
        lang_matches = [item for item in candidates if item.get("lan") == preferred_lang]
        if lang_matches:
            candidates = lang_matches

    ai_ready = [item for item in candidates if item.get("ai_status") in (None, 2) or item.get("ai_type")]
    if ai_ready:
        candidates = ai_ready

    if not candidates:
        raise BilibiliSubtitleError("字幕列表中没有可下载的 subtitle_url")

    subtitle = candidates[0]
    return normalize_subtitle_url(str(subtitle["subtitle_url"])), subtitle


def discover_subtitle_url(
    video_url: str,
    video_info: VideoInfo,
    video_page: VideoPage,
    preferred_lang: str | None,
    cookie: str | None,
) -> tuple[str, dict[str, Any]]:
    wbi_params = sign_wbi_params(
        {
            "aid": video_info.aid,
            "cid": video_page.cid,
            **DEFAULT_WBI_BROWSER_PARAMS,
        },
        cookie,
    )
    data = bilibili_api_get(
        BILIBILI_PLAYER_WBI_API,
        wbi_params,
        video_url,
        cookie,
    )
    subtitles = get_subtitles_from_player_data(data)

    if not subtitles:
        data = bilibili_api_get(
            BILIBILI_PLAYER_API,
            {"bvid": video_info.bvid, "cid": video_page.cid},
            video_url,
            cookie,
        )
        subtitles = get_subtitles_from_player_data(data)

    if data.get("need_login_subtitle") is True and not subtitles:
        raise BilibiliSubtitleError("播放器接口提示 need_login_subtitle=true，需要登录 Cookie 才能查看字幕列表。")

    subtitle_url, subtitle_meta = choose_subtitle_url(subtitles, preferred_lang)
    return subtitle_url, subtitle_meta


def format_srt_timestamp(seconds: float) -> str:
    total_ms = max(0, int(round(seconds * 1000)))
    ms = total_ms % 1000
    total_seconds = total_ms // 1000
    sec = total_seconds % 60
    total_minutes = total_seconds // 60
    minute = total_minutes % 60
    hour = total_minutes // 60
    return f"{hour:02}:{minute:02}:{sec:02},{ms:03}"


def subtitle_json_to_srt(payload: dict[str, Any]) -> str:
    body = payload.get("body")
    if not isinstance(body, list):
        raise BilibiliSubtitleError("字幕 JSON 中没有 body 数组")

    blocks: list[str] = []
    for item in body:
        if not isinstance(item, dict):
            continue
        try:
            start = float(item["from"])
            end = float(item["to"])
        except (KeyError, TypeError, ValueError):
            continue

        content = str(item.get("content", "")).strip()
        if not content:
            continue
        if end < start:
            end = start

        blocks.append(
            "\n".join(
                [
                    str(len(blocks) + 1),
                    f"{format_srt_timestamp(start)} --> {format_srt_timestamp(end)}",
                    content,
                ]
            )
        )

    if not blocks:
        raise BilibiliSubtitleError("body 中没有可转换的字幕条目")
    return "\n\n".join(blocks) + "\n"


def safe_filename(value: str) -> str:
    filename = re.sub(r"[\\/:*?\"<>|\s]+", "_", value.strip())
    return filename.strip("._") or "subtitle"


def page_filename(video_page: VideoPage, total_pages: int) -> str:
    width = max(2, len(str(total_pages)))
    return f"{video_page.page:0{width}d}_{safe_filename(video_page.part)}.srt"


def series_output_dir(args: argparse.Namespace, video_info: VideoInfo) -> Path:
    if args.output:
        return Path(args.output)
    return Path(args.output_dir) / safe_filename(video_info.title)


def output_path_for_page(args: argparse.Namespace, video_info: VideoInfo, video_page: VideoPage, series_download: bool) -> Path:
    default_name = page_filename(video_page, len(video_info.pages))
    if series_download:
        return series_output_dir(args, video_info) / default_name
    if args.output:
        output = Path(args.output)
        if output.exists() and output.is_dir():
            return output / default_name
        return output
    return Path(args.output_dir) / default_name


def should_skip_output(output: Path, overwrite: bool) -> bool:
    return output.exists() and output.stat().st_size > 0 and not overwrite


def download_page_subtitle(
    source_url: str,
    video_info: VideoInfo,
    video_page: VideoPage,
    output: Path,
    args: argparse.Namespace,
) -> bool:
    if should_skip_output(output, args.overwrite):
        print(f"跳过已存在: {output}", flush=True)
        return True

    subtitle_url, subtitle_meta = discover_subtitle_url(
        source_url,
        video_info,
        video_page,
        args.lang,
        args.cookie,
    )
    if args.print_url:
        lang_doc = subtitle_meta.get("lan_doc") or subtitle_meta.get("lan") or "unknown"
        print(f"p{video_page.page} 字幕 URL ({lang_doc}): {subtitle_url}", flush=True)

    subtitle_payload = request_json(subtitle_url, referer=source_url, cookie=args.cookie)
    srt_content = subtitle_json_to_srt(subtitle_payload)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(srt_content, encoding="utf-8")
    print(f"已写入: {output}", flush=True)
    return True


def convert_direct_subtitle_url(source_url: str, args: argparse.Namespace) -> None:
    if args.page is not None:
        raise BilibiliSubtitleError("直接字幕 JSON 链接不支持 --page")

    output = Path(args.output) if args.output else Path(args.output_dir) / "subtitle.srt"
    if should_skip_output(output, args.overwrite):
        print(f"跳过已存在: {output}", flush=True)
        return
    if args.print_url:
        print(f"字幕 URL: {source_url}", flush=True)

    subtitle_payload = request_json(source_url, referer=source_url, cookie=args.cookie)
    srt_content = subtitle_json_to_srt(subtitle_payload)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(srt_content, encoding="utf-8")
    print(f"已写入: {output}", flush=True)


def normalize_cookie(cookie: str) -> str:
    cookie = cookie.strip()
    if cookie.lower().startswith("cookie:"):
        cookie = cookie.split(":", 1)[1].strip()
    return re.sub(r"\s*;\s*", "; ", cookie).strip()


def read_cookie(args: argparse.Namespace) -> str | None:
    if args.cookie:
        return normalize_cookie(args.cookie)

    cookie_file = Path(args.cookie_file)
    if cookie_file.exists():
        cookie = normalize_cookie(cookie_file.read_text(encoding="utf-8"))
        if cookie:
            return cookie

    env_cookie = os.getenv("BILI_COOKIE")
    if env_cookie:
        return normalize_cookie(env_cookie)
    return None


def validate_cookie(cookie: str) -> str:
    payload = request_json(BILIBILI_NAV_API, referer="https://www.bilibili.com/", cookie=cookie)
    data = payload.get("data")
    if not isinstance(data, dict) or data.get("isLogin") is not True:
        raise BilibiliSubtitleError("Cookie 验证失败：未识别到有效登录态。")

    username = data.get("uname") or data.get("name") or data.get("mid") or "已登录账号"
    return str(username)


def setup_cookie(cookie_file: Path) -> str:
    print("需要 Bilibili Cookie 才能获取字幕列表。", flush=True)
    print("请在浏览器登录 Bilibili 后复制请求 Cookie，然后粘贴到这里。", flush=True)
    try:
        cookie = normalize_cookie(input("Cookie: "))
    except EOFError as exc:
        raise BilibiliSubtitleError("未读取到 Cookie。可使用 --cookie-file、--cookie 或 BILI_COOKIE。") from exc

    if not cookie:
        raise BilibiliSubtitleError("Cookie 为空。")

    username = validate_cookie(cookie)
    cookie_file.write_text(cookie + "\n", encoding="utf-8")
    print(f"Cookie 验证通过：{username}", flush=True)
    print(f"已保存到: {cookie_file}", flush=True)
    return cookie


def ensure_video_cookie(args: argparse.Namespace) -> str:
    cookie = read_cookie(args)
    cookie_file = Path(args.cookie_file)

    if cookie:
        try:
            username = validate_cookie(cookie)
            print(f"Cookie 验证通过：{username}", flush=True)
            return cookie
        except BilibiliSubtitleError:
            if args.cookie or args.no_cookie_setup:
                raise
            print("已有 Cookie 无效，将重新设置。", flush=True)

    if args.no_cookie_setup:
        raise BilibiliSubtitleError("缺少有效 Cookie。请提供 --cookie-file、--cookie 或 BILI_COOKIE。")
    return setup_cookie(cookie_file)


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="bili-ai-subtitle",
        description="从 Bilibili 视频链接下载 AI 字幕，并转换为 SRT 文件。",
    )
    parser.add_argument("url", help="Bilibili 视频链接，或 aisubtitle.hdslb.com 字幕 JSON 链接")
    parser.add_argument("-o", "--output", help="输出路径。整套下载时作为输出目录；单个分 P 或直接字幕 URL 时可作为文件路径。")
    parser.add_argument("--output-dir", default=".", help="输出目录。默认当前目录。")
    parser.add_argument("--page", "-p", type=int, help="只下载指定分 P。默认下载整个系列。")
    parser.add_argument("--lang", help="优先选择的字幕语言，例如 zh-CN。默认选择接口返回的第一个可用字幕。")
    parser.add_argument("--cookie", help="可选 Bilibili Cookie；优先级最高。")
    parser.add_argument("--cookie-file", default="cookie.txt", help="Cookie 文件路径。默认读取当前目录的 cookie.txt。")
    parser.add_argument("--no-cookie-setup", action="store_true", help="缺少 Cookie 时不进入交互式设置，直接失败。")
    parser.add_argument("--print-url", action="store_true", help="打印解析得到的字幕 JSON URL。")
    parser.add_argument("--overwrite", action="store_true", help="覆盖已存在的 SRT。默认跳过已存在且非空的文件，用于断点续下。")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_arg_parser()
    args = parser.parse_args(argv)

    try:
        source_url = args.url
        if "aisubtitle.hdslb.com" in source_url:
            args.cookie = read_cookie(args)
            convert_direct_subtitle_url(source_url, args)
            return 0

        args.cookie = ensure_video_cookie(args)
        bvid = extract_bvid(source_url)
        video_info = get_video_info(bvid, source_url, args.cookie)
        selected_pages = select_video_pages(video_info.pages, args.page)
        series_download = args.page is None and len(video_info.pages) > 1
        print(f"准备下载 {len(selected_pages)}/{len(video_info.pages)} 个分 P", flush=True)
        if series_download:
            output_dir = series_output_dir(args, video_info)
            output_dir.mkdir(parents=True, exist_ok=True)
            print(f"输出目录: {output_dir}", flush=True)

        failed = 0
        for video_page in selected_pages:
            output = output_path_for_page(args, video_info, video_page, series_download)
            try:
                download_page_subtitle(source_url, video_info, video_page, output, args)
            except BilibiliSubtitleError as exc:
                failed += 1
                print(f"p{video_page.page} 失败: {exc}", file=sys.stderr)

        if failed:
            print(f"完成，但有 {failed} 个分 P 下载失败。", file=sys.stderr)
            return 1
        return 0
    except BilibiliSubtitleError as exc:
        print(f"错误: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
