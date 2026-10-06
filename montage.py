import sys
from PIL import Image
out, maxh, *names = sys.argv[1], int(sys.argv[2]), *sys.argv[3:]
ims = []
for n in names:
    im = Image.open(f"scripts/shots/{n}.png").convert("RGB")
    if n.startswith("m-"): im = im.resize((im.width // 2, im.height // 2), Image.LANCZOS)
    ims.append(im.crop((0, 0, im.width, min(im.height, maxh))))
w = sum(i.width for i in ims) + 16 * (len(ims) - 1); h = max(i.height for i in ims)
sheet = Image.new("RGB", (w, h), "#888")
x = 0
for i in ims: sheet.paste(i, (x, 0)); x += i.width + 16
sheet.save(f"scripts/shots/_{out}.png"); print(out, sheet.size)
