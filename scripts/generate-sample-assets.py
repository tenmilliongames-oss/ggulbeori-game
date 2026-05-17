from __future__ import annotations

import math
import shutil
import subprocess
import sys
import wave
from pathlib import Path

from PIL import Image, ImageColor, ImageDraw, ImageFilter, ImageFont


ROOT = Path(__file__).resolve().parents[1]
PROJECT_NAME = sys.argv[1] if len(sys.argv) > 1 else "sample"
PROJECT_ROOT = ROOT / "public" / "projects" / PROJECT_NAME
RESOURCE_ROOT = PROJECT_ROOT / "resources"

SIZE = (1280, 720)
PUZZLE_SIZE = (900, 540)
LEVEL_THUMBNAIL_SIZE = (214, 214)
PUZZLE_IMAGE_EXTENSIONS = (".webp", ".png", ".jpg", ".jpeg")


def ensure_dir(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    return path


def load_font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    windows_fonts = Path("C:/Windows/Fonts")
    candidates = [
        windows_fonts / ("arialbd.ttf" if bold else "arial.ttf"),
        windows_fonts / ("segoeuib.ttf" if bold else "segoeui.ttf"),
    ]
    for candidate in candidates:
        if candidate.exists():
            return ImageFont.truetype(str(candidate), size=size)
    return ImageFont.load_default()


FONT_H1 = load_font(72, bold=True)
FONT_H2 = load_font(38, bold=True)
FONT_BODY = load_font(28, bold=False)
FONT_LABEL = load_font(24, bold=True)


def hex_rgba(value: str, alpha: int = 255) -> tuple[int, int, int, int]:
    rgb = ImageColor.getrgb(value)
    return rgb[0], rgb[1], rgb[2], alpha


def make_canvas(size: tuple[int, int], color: str) -> Image.Image:
    return Image.new("RGBA", size, hex_rgba(color))


def save(image: Image.Image, relative_path: str) -> None:
    target = RESOURCE_ROOT / relative_path
    ensure_dir(target.parent)
    if target.exists():
        return
    image.save(target)


def draw_gradient_background(image: Image.Image, top: str, bottom: str) -> None:
    draw = ImageDraw.Draw(image)
    width, height = image.size
    top_rgb = ImageColor.getrgb(top)
    bottom_rgb = ImageColor.getrgb(bottom)
    for y in range(height):
        blend = y / max(height - 1, 1)
        color = tuple(int(top_rgb[i] * (1 - blend) + bottom_rgb[i] * blend) for i in range(3))
        draw.line((0, y, width, y), fill=color)


def add_glow_circle(image: Image.Image, center: tuple[int, int], radius: int, color: str, blur: int) -> None:
    glow = Image.new("RGBA", image.size, (0, 0, 0, 0))
    glow_draw = ImageDraw.Draw(glow)
    x, y = center
    glow_draw.ellipse((x - radius, y - radius, x + radius, y + radius), fill=hex_rgba(color, 140))
    glow = glow.filter(ImageFilter.GaussianBlur(blur))
    image.alpha_composite(glow)


def centered_text(draw: ImageDraw.ImageDraw, box: tuple[int, int, int, int], text: str, font: ImageFont.ImageFont, fill: str) -> None:
    left, top, right, bottom = box
    bbox = draw.multiline_textbbox((0, 0), text, font=font, spacing=10, align="center")
    text_width = bbox[2] - bbox[0]
    text_height = bbox[3] - bbox[1]
    x = left + (right - left - text_width) / 2
    y = top + (bottom - top - text_height) / 2
    draw.multiline_text((x, y), text, font=font, fill=fill, spacing=10, align="center")


def create_backgrounds() -> None:
    title = make_canvas(SIZE, "#06111f")
    draw_gradient_background(title, "#08131f", "#163b5d")
    add_glow_circle(title, (220, 130), 170, "#4fd1ff", 60)
    add_glow_circle(title, (1060, 560), 210, "#ff7bcb", 80)
    add_glow_circle(title, (860, 180), 110, "#34d399", 40)
    draw = ImageDraw.Draw(title)
    draw.rounded_rectangle((52, 48, 1228, 672), radius=40, outline=hex_rgba("#ffffff", 42), width=3)
    draw.line((100, 610, 1180, 610), fill=hex_rgba("#ffffff", 55), width=2)
    save(title, "images/backgrounds/title-bg.png")

    puzzle_bg = make_canvas(SIZE, "#0b1220")
    draw_gradient_background(puzzle_bg, "#0c1630", "#060b15")
    add_glow_circle(puzzle_bg, (170, 620), 180, "#4f8cff", 72)
    add_glow_circle(puzzle_bg, (1120, 110), 150, "#f97316", 62)
    draw = ImageDraw.Draw(puzzle_bg)
    for x in range(0, SIZE[0], 80):
        draw.line((x, 0, x + 120, SIZE[1]), fill=hex_rgba("#ffffff", 18), width=1)
    save(puzzle_bg, "images/backgrounds/puzzle-bg.png")


def create_cards() -> None:
    intro = Image.open(RESOURCE_ROOT / "images/backgrounds/title-bg.png").copy()
    draw = ImageDraw.Draw(intro)
    draw.rounded_rectangle((230, 140, 1050, 590), radius=44, fill=hex_rgba("#0d1b2f", 210), outline=hex_rgba("#9bd9ff", 120), width=4)
    centered_text(draw, (280, 215, 1000, 340), "SPOT THE DIFFERENCE", FONT_H1, "#f8fafc")
    centered_text(draw, (290, 360, 990, 455), "Sample intro card PNG\nReplace this with your own design.", FONT_H2, "#fde68a")
    centered_text(draw, (330, 500, 950, 550), "Excel controls timing. PNG controls look.", FONT_BODY, "#cbd5e1")
    save(intro, "images/ui/intro-card.png")
    save(intro, "images/ui/cards/title-card-frame.png")

    timeout = Image.open(RESOURCE_ROOT / "images/backgrounds/title-bg.png").copy()
    draw = ImageDraw.Draw(timeout)
    draw.rounded_rectangle((260, 160, 1020, 560), radius=44, fill=hex_rgba("#1a1022", 220), outline=hex_rgba("#ff7bcb", 140), width=4)
    centered_text(draw, (300, 230, 980, 340), "TIME IS UP", FONT_H1, "#ffffff")
    centered_text(draw, (300, 365, 980, 455), "Swap this PNG later.\nThe program only places it on the timeline.", FONT_H2, "#ffd3e9")
    centered_text(draw, (340, 495, 940, 545), "Next step card or answer card can use the same pattern.", FONT_BODY, "#dbeafe")
    save(timeout, "images/ui/timeout-card.png")
    save(timeout, "images/ui/cards/timeout-card-frame.png")


def create_ui() -> None:
    ensure_dir(RESOURCE_ROOT / "images/ui/hud")
    ensure_dir(RESOURCE_ROOT / "images/ui/panels")
    ensure_dir(RESOURCE_ROOT / "images/ui/cards")
    ensure_dir(RESOURCE_ROOT / "images/ui/markers")
    ensure_dir(RESOURCE_ROOT / "images/ui/countdown")

    for name, left_color, right_color, accent in [
        ("hud-blue.png", "#2246c7", "#3b82f6", "#a5f3fc"),
        ("hud-teal.png", "#0f766e", "#14b8a6", "#bbf7d0"),
    ]:
        image = make_canvas((1280, 96), left_color)
        draw_gradient_background(image, left_color, right_color)
        draw = ImageDraw.Draw(image)
        draw.rounded_rectangle((14, 12, 1266, 82), radius=26, outline=hex_rgba("#ffffff", 70), width=2)
        draw.ellipse((28, 18, 82, 72), fill=hex_rgba(accent, 210))
        draw.ellipse((1198, 22, 1246, 70), fill=hex_rgba("#ffffff", 60))
        save(image, f"images/ui/{name}")
        save(image, f"images/ui/hud/{name}")

    hud_scene_specs = [
        ("step-1-hud.png", "#2246c7", "#3b82f6", "STEP 1", "Find the three differences."),
        ("answer-1-hud.png", "#2246c7", "#3b82f6", "STEP 1", "Answer reveal"),
        ("step-2-hud.png", "#0f766e", "#14b8a6", "STEP 2", "Folder scan detects total steps."),
    ]
    for file_name, left_color, right_color, title, subtitle in hud_scene_specs:
        image = make_canvas((1280, 96), left_color)
        draw_gradient_background(image, left_color, right_color)
        draw = ImageDraw.Draw(image)
        draw.rounded_rectangle((14, 12, 1266, 82), radius=26, outline=hex_rgba("#ffffff", 70), width=2)
        draw.rounded_rectangle((26, 18, 190, 74), radius=20, fill=hex_rgba("#08131f", 70))
        draw.rounded_rectangle((214, 22, 1050, 70), radius=18, fill=hex_rgba("#08131f", 42))
        draw.text((42, 34), title, font=FONT_LABEL, fill="#f8fafc")
        centered_text(draw, (248, 22, 1048, 68), subtitle, FONT_BODY, "#f8fafc")
        save(image, f"images/ui/hud/{file_name}")

    badge = Image.new("RGBA", (96, 96), (0, 0, 0, 0))
    badge_draw = ImageDraw.Draw(badge)
    badge_draw.ellipse((6, 6, 90, 90), fill=hex_rgba("#fb923c", 255), outline=hex_rgba("#fff1d6", 230), width=4)
    badge_draw.ellipse((18, 18, 78, 78), fill=hex_rgba("#fdba74", 255))
    badge_draw.arc((8, 8, 88, 88), start=-35, end=205, fill=hex_rgba("#7c2d12", 180), width=4)
    save(badge, "images/ui/timer-badge.png")
    save(badge, "images/ui/hud/timer-badge.png")

    for value in range(0, 121):
        digit = Image.new("RGBA", (88, 88), (0, 0, 0, 0))
        draw = ImageDraw.Draw(digit)
        centered_text(draw, (0, 0, 88, 88), str(value), FONT_H2, "#0f172a")
        save(digit, f"images/ui/countdown/{value}.png")

    frame = Image.new("RGBA", (560, 560), (0, 0, 0, 0))
    frame_draw = ImageDraw.Draw(frame)
    frame_draw.rounded_rectangle((10, 10, 550, 550), radius=42, fill=hex_rgba("#f8fafc", 255), outline=hex_rgba("#0f172a", 255), width=8)
    frame_draw.rounded_rectangle((26, 26, 534, 534), radius=30, outline=hex_rgba("#94a3b8", 150), width=3)
    frame_draw.ellipse((34, 34, 92, 92), fill=hex_rgba("#dbeafe", 120))
    frame_draw.ellipse((468, 34, 526, 92), fill=hex_rgba("#e2e8f0", 110))
    frame_draw.ellipse((34, 468, 92, 526), fill=hex_rgba("#e2e8f0", 110))
    frame_draw.ellipse((468, 468, 526, 526), fill=hex_rgba("#dbeafe", 120))
    save(frame, "images/ui/puzzle-frame.png")
    save(frame, "images/ui/panels/puzzle-panel-frame.png")


def create_effects() -> None:
    ring = Image.new("RGBA", (256, 256), (0, 0, 0, 0))
    glow = Image.new("RGBA", ring.size, (0, 0, 0, 0))
    glow_draw = ImageDraw.Draw(glow)
    glow_draw.ellipse((36, 36, 220, 220), outline=hex_rgba("#ff63d5", 160), width=22)
    glow = glow.filter(ImageFilter.GaussianBlur(10))
    ring.alpha_composite(glow)
    draw = ImageDraw.Draw(ring)
    draw.ellipse((46, 46, 210, 210), outline=hex_rgba("#ff4fd8", 255), width=12)
    draw.ellipse((62, 62, 194, 194), outline=hex_rgba("#ffffff", 110), width=4)
    save(ring, "images/effects/answer-marker-ring.png")
    save(ring, "images/ui/markers/answer-marker.png")

    glow = Image.new("RGBA", (1280, 180), (0, 0, 0, 0))
    glow_draw = ImageDraw.Draw(glow)
    for index in range(10):
        alpha = max(0, 120 - index * 6)
        glow_draw.rounded_rectangle(
            (40 + index * 12, 16 + index * 5, 1240 - index * 12, 164 - index * 5),
            radius=36,
            outline=hex_rgba("#7dd3fc", alpha),
            width=4,
        )
    save(glow, "images/effects/glow-strip-cyan.png")


def draw_puzzle_panel(draw: ImageDraw.ImageDraw, left: int, top: int, width: int, height: int, palette: tuple[str, str, str], variant: int) -> None:
    base, accent, accent_two = palette
    draw.rounded_rectangle((left, top, left + width, top + height), radius=30, fill=hex_rgba(base, 255))
    draw.rectangle((left + 32, top + 45, left + width - 42, top + 120), fill=hex_rgba("#ffffff", 52))
    draw.rectangle((left + 64, top + 165, left + width - 64, top + 220), fill=hex_rgba(accent, 220))
    draw.polygon(
        [
            (left + 140, top + 320),
            (left + 230, top + 230),
            (left + 340, top + 345),
            (left + 300, top + 470),
            (left + 180, top + 470),
        ],
        fill=hex_rgba(accent_two, 255),
    )
    draw.ellipse((left + 425, top + 210, left + 555, top + 340), fill=hex_rgba("#f8fafc", 255), outline=hex_rgba("#1e293b", 150), width=4)
    draw.rectangle((left + 500, top + 360, left + 650, top + 450), fill=hex_rgba("#0f172a", 255))
    draw.rectangle((left + 695, top + 205, left + 805, top + 510), fill=hex_rgba("#f59e0b", 255))
    draw.ellipse((left + 720, top + 100, left + 820, top + 200), fill=hex_rgba("#fde68a", 255))
    if variant == 1:
        draw.rectangle((left + 500, top + 360, left + 650, top + 430), fill=hex_rgba("#0f172a", 255))
        draw.ellipse((left + 715, top + 94, left + 838, top + 215), fill=hex_rgba("#fca5a5", 255))
        draw.polygon(
            [
                (left + 190, top + 318),
                (left + 242, top + 230),
                (left + 338, top + 344),
                (left + 292, top + 470),
                (left + 175, top + 458),
            ],
            fill=hex_rgba("#f472b6", 255),
        )


def create_puzzles() -> None:
    definitions = [
        (1, ("#12263d", "#38bdf8", "#8b5cf6")),
        (2, ("#1f2937", "#22c55e", "#f97316")),
    ]
    for step, palette in definitions:
        for variant in [0, 1]:
            image = make_canvas(PUZZLE_SIZE, "#0f172a")
            draw_gradient_background(image, "#0f172a", "#111827")
            draw = ImageDraw.Draw(image)
            draw_puzzle_panel(draw, 24, 24, 852, 492, palette, variant)
            label = f"STEP {step} {'LEFT' if variant == 0 else 'RIGHT'}"
            draw.rounded_rectangle((34, 34, 250, 84), radius=22, fill=hex_rgba("#ffffff", 35))
            draw.text((52, 50), label, font=FONT_LABEL, fill="#f8fafc")
            filename = f"{step}.png" if variant == 0 else f"{step}-1.png"
            save(image, f"images/puzzles/{filename}")


def create_level_thumbnails_for_dir(puzzle_dir: Path, thumbnail_dir: Path) -> None:
    if not puzzle_dir.exists():
        return

    ensure_dir(thumbnail_dir)
    sources_by_step: dict[int, Path] = {}
    for source in sorted(puzzle_dir.iterdir(), key=lambda path: path.name.lower()):
        if not source.is_file() or source.suffix.lower() not in PUZZLE_IMAGE_EXTENSIONS:
            continue
        if "-" in source.stem or not source.stem.isdigit():
            continue
        step = int(source.stem)
        if step not in sources_by_step or source.suffix.lower() == ".webp":
            sources_by_step[step] = source

    for step, source in sorted(sources_by_step.items()):
        target = thumbnail_dir / f"level-{step}.webp"
        if target.exists() and target.stat().st_mtime >= source.stat().st_mtime:
            continue

        with Image.open(source) as image:
            thumbnail = image.convert("RGB")
            width, height = thumbnail.size
            crop_size = min(width, height)
            left = (width - crop_size) // 2
            top = (height - crop_size) // 2
            thumbnail = thumbnail.crop((left, top, left + crop_size, top + crop_size))
            thumbnail = thumbnail.resize(LEVEL_THUMBNAIL_SIZE, Image.Resampling.LANCZOS)
            thumbnail.save(target, format="WEBP", quality=78, method=6)


def create_level_thumbnails() -> None:
    create_level_thumbnails_for_dir(
        RESOURCE_ROOT / "images/puzzles",
        RESOURCE_ROOT / "images/level-thumbnails",
    )

    styles_dir = RESOURCE_ROOT / "styles"
    if not styles_dir.exists():
        return

    for style_dir in sorted((path for path in styles_dir.iterdir() if path.is_dir()), key=lambda path: path.name):
        create_level_thumbnails_for_dir(
            style_dir / "puzzles",
            style_dir / "level-thumbnails",
        )


def write_wave_file(path: Path, samples: list[float], sample_rate: int = 44100) -> None:
    ensure_dir(path.parent)
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(sample_rate)
        frames = bytearray()
        for sample in samples:
            clamped = max(-1.0, min(1.0, sample))
            frames.extend(int(clamped * 32767).to_bytes(2, byteorder="little", signed=True))
        handle.writeframes(bytes(frames))


def create_audio() -> None:
    sample_rate = 44100

    bgm_seconds = 6.0
    bgm_samples: list[float] = []
    for index in range(int(sample_rate * bgm_seconds)):
        t = index / sample_rate
        envelope = 0.4 + 0.25 * math.sin(math.tau * t / bgm_seconds)
        tone = (
            math.sin(math.tau * 220 * t)
            + 0.6 * math.sin(math.tau * 277.18 * t)
            + 0.4 * math.sin(math.tau * 329.63 * t)
        ) / 2.0
        shimmer = 0.15 * math.sin(math.tau * 3 * t)
        bgm_samples.append((tone * envelope + shimmer) * 0.25)
    write_wave_file(RESOURCE_ROOT / "audio/bgm/sample-bgm.wav", bgm_samples, sample_rate)

    chime_seconds = 1.4
    chime_samples: list[float] = []
    for index in range(int(sample_rate * chime_seconds)):
        t = index / sample_rate
        decay = math.exp(-3.4 * t)
        tone = math.sin(math.tau * 784 * t) + 0.55 * math.sin(math.tau * 1174 * t)
        chime_samples.append(tone * decay * 0.28)
    write_wave_file(RESOURCE_ROOT / "audio/sfx/reveal-chime.wav", chime_samples, sample_rate)

    tick_seconds = 0.35
    tick_samples: list[float] = []
    for index in range(int(sample_rate * tick_seconds)):
        t = index / sample_rate
        decay = math.exp(-10.5 * t)
        tone = math.sin(math.tau * 1200 * t) + 0.3 * math.sin(math.tau * 1800 * t)
        tick_samples.append(tone * decay * 0.22)
    write_wave_file(RESOURCE_ROOT / "audio/sfx/countdown-hit.wav", tick_samples, sample_rate)


def create_video() -> None:
    video_path = RESOURCE_ROOT / "videos/backgrounds/ambient-pan.mp4"
    ensure_dir(video_path.parent)
    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-f",
            "lavfi",
            "-i",
            f"color=c=#102a43:s={SIZE[0]}x{SIZE[1]}:d=4:r=30",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-movflags",
            "+faststart",
            str(video_path),
        ],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


def main() -> None:
    ensure_dir(RESOURCE_ROOT)
    create_backgrounds()
    create_cards()
    create_ui()
    create_effects()
    create_level_thumbnails()
    create_audio()
    create_video()
    hud_bar_path = RESOURCE_ROOT / "images/ui/hud/hud-bar.png"
    if not hud_bar_path.exists():
        shutil.copyfile(
            RESOURCE_ROOT / "images/ui/hud/hud-blue.png",
            hud_bar_path,
        )
    print(f"Generated sample assets for {PROJECT_NAME}")


if __name__ == "__main__":
    main()
