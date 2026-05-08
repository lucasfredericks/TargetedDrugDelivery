#!/usr/bin/env python3
"""
Generate a printable 6"x3" puzzle reference card from a puzzle JSON file.

Shows color-coded receptor concentrations for each of the 4 tissues in a 2x2
grid matching the physical screen layout:

    [ Tissue 0 | Tissue 1 ]
    [ Tissue 2 | Tissue 3 ]

Usage:
    python generate_puzzle_card.py puzzle.json
    python generate_puzzle_card.py puzzle.json output.png
    python generate_puzzle_card.py puzzle.json --dpi 150
"""

import json
import sys
import argparse
from pathlib import Path

try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError:
    print("Pillow not found. Install it with:  pip install Pillow")
    sys.exit(1)


# ── Color definitions ────────────────────────────────────────────────────────

def _rgb_to_cmyk(r, g, b):
    """Convert 0-255 RGB to a Pillow CMYK tuple (0-255 per channel, 255 = full ink)."""
    r_, g_, b_ = r / 255, g / 255, b / 255
    k = 1 - max(r_, g_, b_)
    if k >= 1.0:
        return (0, 0, 0, 255)
    s = 1 - k
    return (round((s - r_) / s * 255),
            round((s - g_) / s * 255),
            round((s - b_) / s * 255),
            round(k * 255))

# Receptor indices 0-5 match config.py LIGAND_COLORS order
LIGAND_COLORS = ["Red", "Blue", "Green", "Purple", "Orange", "Yellow"]
LIGAND_CMYK = [
    _rgb_to_cmyk(255,   0,   4),   # 0 Red    — #FF0004 (matches display.js)
    _rgb_to_cmyk(  0,   0, 255),   # 1 Blue   — #0000FF
    _rgb_to_cmyk(  0, 143,   0),   # 2 Green  — #008F00
    _rgb_to_cmyk(128,  0,  255),   # 3 Purple — #8000ff
    _rgb_to_cmyk(255,  79,   0),   # 4 Orange — #FF4F00
    _rgb_to_cmyk(248, 237,   0),   # 5 Yellow — #F8ED00
]

# Layout / palette
BG           = _rgb_to_cmyk(255, 255, 255)
PANEL_BG     = _rgb_to_cmyk(252, 252, 252)
PANEL_BORDER = _rgb_to_cmyk(190, 190, 190)
TITLE_BG     = _rgb_to_cmyk(235, 235, 235)
TITLE_FG     = _rgb_to_cmyk( 30,  30,  30)
LABEL_FG     = _rgb_to_cmyk( 80,  80,  80)
GHOST_FILL   = _rgb_to_cmyk(240, 240, 240)   # empty/max-size ghost circle
GHOST_OUTLINE= _rgb_to_cmyk(210, 210, 210)


# ── Font loading ─────────────────────────────────────────────────────────────

def _load_font(size, bold=False):
    """Try several common font paths; fall back to PIL default."""
    candidates = []
    if bold:
        candidates = [
            "arialbd.ttf", "Arial Bold.ttf",
            "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
            "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
            "/System/Library/Fonts/Helvetica.ttc",
        ]
    else:
        candidates = [
            "arial.ttf", "Arial.ttf",
            "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
            "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
            "/System/Library/Fonts/Helvetica.ttc",
        ]
    for path in candidates:
        try:
            return ImageFont.truetype(path, size)
        except (IOError, OSError):
            continue
    return ImageFont.load_default()


# ── Panel renderer ────────────────────────────────────────────────────────────

def draw_panel(draw, x, y, w, h, tissue, font_title, font_label):
    """Render one tissue panel with 6 proportional colored circles."""
    border = 2

    # Panel background + border
    draw.rectangle([x, y, x + w - 1, y + h - 1],
                   fill=PANEL_BG, outline=PANEL_BORDER, width=border)

    # Title bar
    title_h = max(28, int(h * 0.18))
    draw.rectangle([x + border, y + border, x + w - border - 1, y + title_h],
                   fill=TITLE_BG)
    draw.text((x + w // 2, y + border + title_h // 2),
              tissue["name"].upper(),
              fill=TITLE_FG, font=font_title, anchor="mm")
    draw.line([(x + border, y + title_h + 1), (x + w - border - 1, y + title_h + 1)],
              fill=PANEL_BORDER, width=1)

    # Circle area — 6 columns below the title
    receptors = tissue["receptors"]
    pad_x  = max(6, int(w * 0.025))
    pad_y  = max(4, int(h * 0.04))

    # Measure label height so we can reserve space at the bottom
    lbl_bb  = font_label.getbbox("Mg")   # ascender + descender
    lbl_h   = lbl_bb[3] - lbl_bb[1] + 2

    area_x = x + border + pad_x
    area_y = y + title_h + border + pad_y
    area_w = w - border * 2 - pad_x * 2
    area_h = h - title_h - border * 2 - pad_y * 2

    n      = 6
    col_w  = area_w / n

    # Max radius: limited by column width and the circle-only height
    circle_area_h = area_h - lbl_h - pad_y
    max_r = min(col_w / 2 - 2, circle_area_h / 2)
    max_r = max(max_r, 4)

    # Vertical center for circles (anchor at center of circle area, not lbl zone)
    circle_cy = int(area_y + circle_area_h / 2)

    for i in range(n):
        val = receptors[i] if i < len(receptors) else 0.0
        val = max(0.0, min(1.0, val))
        r   = max(3, int(max_r * val))

        col_cx = int(area_x + (i + 0.5) * col_w)

        # Ghost circle — shows max size for visual reference
        gr = int(max_r)
        draw.ellipse(
            [col_cx - gr, circle_cy - gr, col_cx + gr, circle_cy + gr],
            fill=GHOST_FILL, outline=GHOST_OUTLINE, width=1
        )

        # Colored filled circle
        if val > 0:
            draw.ellipse(
                [col_cx - r, circle_cy - r, col_cx + r, circle_cy + r],
                fill=LIGAND_CMYK[i]
            )

        # Color name label below circles
        lbl_y = area_y + circle_area_h + pad_y // 2 + lbl_h // 2
        draw.text((col_cx, lbl_y), LIGAND_COLORS[i],
                  fill=LABEL_FG, font=font_label, anchor="mm")


# ── Main generator ────────────────────────────────────────────────────────────

def generate_card(puzzle: dict, output_path: str, dpi: int = 300, fmt: str = "pdf"):
    # Render at 3× then downsample for anti-aliased circles and text
    SCALE    = 3
    rdpi     = dpi * SCALE

    CARD_W   = int(6.0  * rdpi)
    CARD_H   = int(3.0  * rdpi)
    footer_h = int(0.30 * rdpi)
    W, H     = CARD_W, CARD_H + footer_h

    img  = Image.new("CMYK", (W, H), BG)
    draw = ImageDraw.Draw(img)

    tissues = puzzle.get("tissues", [])
    if len(tissues) < 4:
        print(f"Warning: expected 4 tissues, got {len(tissues)}")

    pt         = rdpi / 72.0
    font_title = _load_font(int(9.5 * pt), bold=True)
    font_label = _load_font(int(7.0 * pt), bold=False)

    margin = int(0.10 * rdpi)
    gap    = int(0.08 * rdpi)
    cell_w = (CARD_W - margin * 2 - gap) // 2
    cell_h = (CARD_H - margin * 2 - gap) // 2

    positions = [
        (margin,                margin),
        (margin + cell_w + gap, margin),
        (margin,                margin + cell_h + gap),
        (margin + cell_w + gap, margin + cell_h + gap),
    ]

    for i, tissue in enumerate(tissues[:4]):
        cx, cy = positions[i]
        draw_panel(draw, cx, cy, cell_w, cell_h, tissue,
                   font_title, font_label)

    # Black cut border at exactly 6"×3"
    border_px = max(2, int(0.007 * rdpi))
    draw.rectangle([0, 0, CARD_W - 1, CARD_H - 1],
                   outline=(0, 0, 0, 255), width=border_px)

    # Puzzle name centered in the footer strip, outside the border
    puzzle_name = puzzle.get("id", "")
    if puzzle_name:
        font_footer = _load_font(int(8.5 * pt), bold=True)
        draw.text((W // 2, CARD_H + footer_h // 2), puzzle_name,
                  fill=TITLE_FG, font=font_footer, anchor="mm")

    # Downsample to target resolution
    final_w = int(6.0 * dpi)
    final_h = int((3.0 + 0.30) * dpi)
    img = img.resize((final_w, final_h), Image.Resampling.LANCZOS)

    if fmt == "pdf":
        img.save(output_path, format="PDF", resolution=dpi)
    else:
        img.save(output_path, dpi=(dpi, dpi))
    print(f"Saved {output_path}  ({final_w} x {final_h} px @ {dpi} DPI)")


# ── CLI ───────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="Generate a 6\"×3\" printable puzzle reference card."
    )
    parser.add_argument("puzzle_json", help="Path to puzzle JSON file")
    parser.add_argument("output", nargs="?",
                        help="Output PNG path (default: <puzzle_id>_card.png)")
    parser.add_argument("--dpi", type=int, default=300,
                        help="Output resolution in DPI (default: 300)")
    parser.add_argument("--format", choices=["pdf", "png"], default="pdf",
                        help="Output format (default: pdf)")
    args = parser.parse_args()

    with open(args.puzzle_json) as f:
        puzzle = json.load(f)

    ext = args.format
    if args.output:
        out = args.output
    else:
        puzzle_id = puzzle.get("id", Path(args.puzzle_json).stem)
        out = f"{puzzle_id}_card.{ext}"

    generate_card(puzzle, out, dpi=args.dpi, fmt=args.format)


if __name__ == "__main__":
    main()
