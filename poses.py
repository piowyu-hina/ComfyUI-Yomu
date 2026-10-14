"""
姿勢卡：每張是「名稱 + 一整段描述」，點一下把描述放進正面提示詞（一次一張）。
官方的寫在 poses.json（跟著 Yomu 更新）；自己新增的存在 user/yomu_poses.json，更新 Yomu 不會蓋掉。

  GET  /yomu/api/poses                 {official: [...], mine: [...]}
  POST /yomu/api/poses  {mine: [...]}  存自己的姿勢卡
"""
import json
import os

from aiohttp import web

import folder_paths

OFFICIAL_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "poses.json")
MINE_PATH = os.path.join(folder_paths.get_user_directory(), "yomu_poses.json")


def _read(path):
    if not os.path.isfile(path):
        return []
    with open(path, "r", encoding="utf-8") as f:
        return [{"name": str(p["name"]), "text": str(p["text"])} for p in json.load(f) if p.get("name") and p.get("text")]


def register(routes):
    @routes.get("/yomu/api/poses")
    async def poses(request):
        return web.json_response({"official": _read(OFFICIAL_PATH), "mine": _read(MINE_PATH)})

    @routes.post("/yomu/api/poses")
    async def save_poses(request):
        mine = [{"name": str(p["name"]).strip(), "text": str(p["text"]).strip()}
                for p in (await request.json()).get("mine", []) if str(p.get("name", "")).strip() and str(p.get("text", "")).strip()]
        os.makedirs(os.path.dirname(MINE_PATH), exist_ok=True)
        with open(MINE_PATH, "w", encoding="utf-8") as f:
            json.dump(mine, f, ensure_ascii=False, indent=2)
        return web.json_response({"ok": True, "mine": mine})
