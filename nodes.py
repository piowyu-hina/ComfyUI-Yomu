"""Yomu 自用小節點"""
import torch

import comfy.utils
import comfy.model_management as model_management


class YomuResampleFrames:
    """把影格序列從 src_fps 重取樣到 dst_fps（取最近的一格）。MMAudio 的取樣節點假設輸入是 25fps。"""
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "images": ("IMAGE",),
            "src_fps": ("FLOAT", {"default": 16.0, "min": 1.0, "max": 240.0, "step": 0.01}),
            "dst_fps": ("FLOAT", {"default": 25.0, "min": 1.0, "max": 240.0, "step": 0.01}),
        }}
    RETURN_TYPES = ("IMAGE",)
    FUNCTION = "resample"
    CATEGORY = "Yomu"

    def resample(self, images, src_fps, dst_fps):
        n = images.shape[0]
        duration = n / src_fps
        count = max(1, int(round(duration * dst_fps)))
        idx = torch.clamp((torch.arange(count, dtype=torch.float32) * (src_fps / dst_fps)).round().long(), 0, n - 1)
        return (images[idx],)


class YomuUpscaleFrames:
    """影片影格逐段用 ESRGAN 放大再縮到指定倍率。
    核心的 ImageUpscaleWithModel 會把整批 4 倍大的結果留在記憶體（幾百格 ×4 倍 = 十幾 GB），
    這裡一次只放大 chunk 格、馬上縮回目標尺寸，記憶體只剩目標大小。"""
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "images": ("IMAGE",),
            "upscale_model": ("UPSCALE_MODEL",),
            "scale_by": ("FLOAT", {"default": 2.0, "min": 1.0, "max": 4.0, "step": 0.05}),
            "chunk": ("INT", {"default": 4, "min": 1, "max": 64}),
        }}
    RETURN_TYPES = ("IMAGE",)
    FUNCTION = "upscale"
    CATEGORY = "Yomu"

    def upscale(self, images, upscale_model, scale_by, chunk):
        device = upscale_model.patcher.load_device
        memory_required = (512 * 512 * 3) * images.element_size() * max(upscale_model.scale, 1.0) * 384.0
        memory_required += images[:chunk].nelement() * images.element_size()
        model_management.load_models_gpu([upscale_model.patcher], memory_required=memory_required, force_full_load=True)
        n, h, w = images.shape[0], images.shape[1], images.shape[2]
        tw, th = int(round(w * scale_by / 2) * 2), int(round(h * scale_by / 2) * 2)
        pbar = comfy.utils.ProgressBar(n)
        out = []
        tile = 512
        for i in range(0, n, chunk):
            batch = images[i:i + chunk].movedim(-1, -3).to(device)
            while True:
                try:
                    s = comfy.utils.tiled_scale(batch, lambda a: upscale_model(a.float()), tile_x=tile, tile_y=tile, overlap=32,
                                                upscale_amount=upscale_model.scale, output_device=device)
                    break
                except Exception as e:
                    model_management.raise_non_oom(e)
                    tile //= 2
                    if tile < 128:
                        raise e
            s = comfy.utils.common_upscale(s, tw, th, "lanczos", "disabled")   # 放大模型固定 4x，縮回目標倍率
            out.append(torch.clamp(s.movedim(-3, -1), 0, 1).to(model_management.intermediate_device()))
            pbar.update(min(chunk, n - i))
        return (torch.cat(out, dim=0),)


class YomuFramesDuration:
    """影格數 ÷ fps = 秒數（給 MMAudio 的 duration 用，fps 可以是連線）"""
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"images": ("IMAGE",), "fps": ("FLOAT", {"default": 16.0, "min": 0.01, "max": 240.0, "step": 0.01})}}
    RETURN_TYPES = ("FLOAT",)
    FUNCTION = "calc"
    CATEGORY = "Yomu"

    def calc(self, images, fps):
        return (round(images.shape[0] / max(0.01, float(fps)), 2),)


NODE_CLASS_MAPPINGS = {"YomuResampleFrames": YomuResampleFrames, "YomuUpscaleFrames": YomuUpscaleFrames, "YomuFramesDuration": YomuFramesDuration}
NODE_DISPLAY_NAME_MAPPINGS = {"YomuResampleFrames": "Yomu 影格重取樣", "YomuUpscaleFrames": "Yomu 影格放大", "YomuFramesDuration": "Yomu 影格秒數"}
