"""
姿勢卡：每張是「名稱 + 一整段描述」，點一下把描述放進正面提示詞（一次一張）。
只有自己的，存在 user/yomu_poses.json，更新 Yomu 不會蓋掉。

  GET  /yomu/api/poses                 [...]
  POST /yomu/api/poses  [...]          存整份清單
"""
import json
import os

from aiohttp import web

import folder_paths

POSES_PATH = os.path.join(folder_paths.get_user_directory(), "yomu_poses.json")


def _clean(poses):
    """名稱可以空著（之後再取）；描述不能空"""
    return [{"name": str(p.get("name") or "").strip(), "text": str(p["text"]).strip()} for p in poses if str(p.get("text") or "").strip()]


def register(routes):
    @routes.get("/yomu/api/poses")
    async def poses(request):
        if not os.path.isfile(POSES_PATH):
            return web.json_response([])
        with open(POSES_PATH, "r", encoding="utf-8") as f:
            return web.json_response(_clean(json.load(f)))

    @routes.post("/yomu/api/poses")
    async def save_poses(request):
        os.makedirs(os.path.dirname(POSES_PATH), exist_ok=True)
        with open(POSES_PATH, "w", encoding="utf-8") as f:
            json.dump(_clean(await request.json()), f, ensure_ascii=False, indent=2)
        return web.json_response({"ok": True})
