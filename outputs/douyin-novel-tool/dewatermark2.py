import os
from PIL import Image, ImageDraw

d = r"D:\WebWork\AI\pi-agent\outputs\douyin-novel-tool"
plans = [
    ("01_brand-symbol-vertical.png", (20, 16, 38)),
    ("02_live-bg-horizontal.png",    (14, 10, 26)),
    ("03_preview-cover-vertical.png",(20, 16, 38)),
    ("04_outro-vertical.png",        (20, 16, 38)),
    ("05_writing-coach-cover-vertical.png", (255, 247, 236)),
    ("06_monetization-cover-vertical.png",  (242, 244, 247)),
]

for name, rgb in plans:
    p = os.path.join(d, name)
    img = Image.open(p).convert("RGBA")
    w, h = img.size
    # Fully cover the "图片由AI生成" watermark line at bottom-right.
    x1 = int(w * 0.38)
    y1 = int(h * 0.93)
    x2 = int(w * 0.995)
    y2 = int(h * 0.998)
    draw = ImageDraw.Draw(img)
    draw.rectangle([x1, y1, x2, y2], fill=rgb + (255,))
    img.convert("RGB").save(p, "PNG")
    print("watermark fully covered:", name, f"rect=({x1},{y1})-({x2},{y2})")

print("DONE")
