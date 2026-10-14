"""
姿勢卡：每張是「名稱 + 一整段描述」，點一下把描述放進正面提示詞（一次一張）。
官方的寫在 poses.json（跟著 Yomu 更新）；自己新增的存在 user/yomu_poses.json，更新 Yomu 不會蓋掉。
維護者（user/yomu_settings.json 的 "maintainer": true）可以改官方的、把自己的設為官方；
其他人改 poses.json 會讓「更新 Yomu」的 git pull 失敗，所以不開放。

  GET  /yomu/api/poses                           {official, mine, maintainer}
  POST /yomu/api/poses  {mine, official?}        存自己的；維護者也可以存官方的
"""
import json
import os

from aiohttp import web

import folder_paths

from .civitai_browser import load_settings

OFFICIAL_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "poses.json")
MINE_PATH = os.path.join(folder_paths.get_user_directory(), "yomu_poses.json")


def _clean(poses):
    """名稱可以空著（之後再取）；描述不能空"""
    return [{"name": str(p.get("name") or "").strip(), "text": str(p["text"]).strip()} for p in poses if str(p.get("text") or "").strip()]


def _read(path):
    if not os.path.isfile(path):
        return []
    with open(path, "r", encoding="utf-8") as f:
        return _clean(json.load(f))


def _write(path, poses):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        json.dump(poses, f, ensure_ascii=False, indent=2)
        f.write("\n")


def register(routes):
    @routes.get("/yomu/api/poses")
    async def poses(request):
        return web.json_response({"official": _read(OFFICIAL_PATH), "mine": _read(MINE_PATH), "maintainer": bool(load_settings().get("maintainer"))})

    @routes.post("/yomu/api/poses")
    async def save_poses(request):
        body = await request.json()
        if "official" in body:
            if not load_settings().get("maintainer"):
                return web.json_response({"ok": False, "msg": "只有維護者可以改官方姿勢"}, status=403)
            _write(OFFICIAL_PATH, _clean(body["official"]))
        _write(MINE_PATH, _clean(body.get("mine", [])))
        return web.json_response({"ok": True})
