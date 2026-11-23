#!/usr/bin/env python3
"""Render a synthetic orbit video of a 3D "flower head" for spatial-pipeline testing.

Licence: CC0 1.0 (public domain dedication). The scene, the procedural textures and this
renderer were written for kubus Node testing; no third-party image, model or footage is used.

The scene is a signed-distance-field flower (bulb, two rings of petals, stem, leaves, ground)
with 3D procedural textures, sphere-traced on the GPU with PyTorch. A camera circles the
object once. To behave like hand-held footage, a share of frames can be blurred and the
camera can hold still at the start, which exercises the blur and duplicate filters.

Run inside the spatial worker image (it has torch, OpenCV and ffmpeg):

    python render_synthetic_orbit.py --out orbit.mp4 --seconds 20 --fps 15
"""
import argparse
import math
import pathlib
import subprocess
import tempfile

import cv2
import numpy as np
import torch

DEVICE = "cuda" if torch.cuda.is_available() else "cpu"


def rot_y(angle):
    c, s = math.cos(angle), math.sin(angle)
    return torch.tensor([[c, 0, s], [0, 1, 0], [-s, 0, c]], dtype=torch.float32, device=DEVICE)


def rot_z(angle):
    c, s = math.cos(angle), math.sin(angle)
    return torch.tensor([[c, -s, 0], [s, c, 0], [0, 0, 1]], dtype=torch.float32, device=DEVICE)


def build_primitives():
    """(kind, centre, rotation, radii, material) rows. Material: 0 ground, 1 bulb, 2 petal, 3 green."""
    items = []
    items.append(("ellipsoid", (0.0, 0.35, 0.0), torch.eye(3, device=DEVICE), (0.42, 0.34, 0.42), 1))
    for ring, (count, tilt, reach, offset) in enumerate([(12, 0.55, 0.62, 0.0), (9, 0.95, 0.5, math.pi / 9)]):
        for index in range(count):
            angle = offset + index * 2 * math.pi / count
            rotation = rot_y(angle) @ rot_z(-tilt)
            centre = rot_y(angle) @ torch.tensor([reach * math.cos(tilt), 0.35 + reach * math.sin(tilt) * 0.55, 0.0], device=DEVICE)
            items.append(("ellipsoid", tuple(centre.tolist()), rotation, (0.34, 0.07, 0.15), 2))
    items.append(("capsule", ((0.0, -1.0, 0.0), (0.0, 0.1, 0.0)), None, (0.07,), 3))
    for angle, side in [(0.6, 1), (3.4, -1)]:
        rotation = rot_y(angle) @ rot_z(0.5 * side)
        centre = rot_y(angle) @ torch.tensor([0.32, -0.55, 0.0], device=DEVICE)
        items.append(("ellipsoid", tuple(centre.tolist()), rotation, (0.3, 0.04, 0.12), 3))
    return items


PRIMITIVES = None


def ellipsoid(p, centre, rotation, radii):
    local = (p - torch.tensor(centre, device=DEVICE)) @ rotation
    scaled = local / torch.tensor(radii, device=DEVICE)
    k0 = torch.linalg.norm(scaled, dim=-1)
    k1 = torch.linalg.norm(scaled / torch.tensor(radii, device=DEVICE), dim=-1)
    return k0 * (k0 - 1.0) / torch.clamp(k1, min=1e-6)


def capsule(p, a, b, radius):
    a_t = torch.tensor(a, device=DEVICE)
    b_t = torch.tensor(b, device=DEVICE)
    pa, ba = p - a_t, b_t - a_t
    h = torch.clamp((pa @ ba) / (ba @ ba), 0.0, 1.0)
    return torch.linalg.norm(pa - h[:, None] * ba, dim=-1) - radius[0]


def distances(p):
    """Per-primitive distances (N, K) with the ground plane first."""
    columns = [p[:, 1] + 1.0]
    for kind, centre, rotation, radii, _material in PRIMITIVES:
        columns.append(ellipsoid(p, centre, rotation, radii) if kind == "ellipsoid" else capsule(p, centre[0], centre[1], radii))
    return torch.stack(columns, dim=-1)


def smooth_min(d, k=0.08):
    # Polynomial smooth minimum folded over the columns.
    result = d[:, 0]
    for index in range(1, d.shape[1]):
        h = torch.clamp(0.5 + 0.5 * (d[:, index] - result) / k, 0.0, 1.0)
        result = d[:, index] * (1 - h) + result * h - k * h * (1 - h)
    return result


def scene_distance(p):
    d = distances(p)
    # The ground stays a hard union; the flower parts blend.
    return torch.minimum(d[:, 0], smooth_min(d[:, 1:]))


def hash3(ix, iy, iz):
    value = torch.sin(ix * 127.1 + iy * 311.7 + iz * 74.7) * 43758.5453
    return value - torch.floor(value)


def value_noise(p):
    base = torch.floor(p)
    f = p - base
    f = f * f * (3 - 2 * f)
    ix, iy, iz = base[:, 0], base[:, 1], base[:, 2]
    def corner(dx, dy, dz):
        return hash3(ix + dx, iy + dy, iz + dz)
    x00 = corner(0, 0, 0) * (1 - f[:, 0]) + corner(1, 0, 0) * f[:, 0]
    x10 = corner(0, 1, 0) * (1 - f[:, 0]) + corner(1, 1, 0) * f[:, 0]
    x01 = corner(0, 0, 1) * (1 - f[:, 0]) + corner(1, 0, 1) * f[:, 0]
    x11 = corner(0, 1, 1) * (1 - f[:, 0]) + corner(1, 1, 1) * f[:, 0]
    y0 = x00 * (1 - f[:, 1]) + x10 * f[:, 1]
    y1 = x01 * (1 - f[:, 1]) + x11 * f[:, 1]
    return y0 * (1 - f[:, 2]) + y1 * f[:, 2]


def fbm(p, octaves=5):
    total = torch.zeros(p.shape[0], device=DEVICE)
    amplitude = 0.5
    for _ in range(octaves):
        total = total + amplitude * value_noise(p)
        p = p * 2.03 + 11.7
        amplitude *= 0.5
    return total


def colour(p, material):
    noise = fbm(p * 6.0)
    fine = fbm(p * 28.0, 3)
    out = torch.zeros_like(p)
    ground = material == 0
    checker = ((torch.floor(p[:, 0] * 2.5) + torch.floor(p[:, 2] * 2.5)) % 2)[:, None]
    ground_colour = torch.stack([0.25 + 0.3 * noise, 0.45 + 0.35 * noise, 0.2 + 0.2 * noise], dim=-1) * (0.75 + 0.25 * checker)
    ground_colour = ground_colour + 0.25 * (fine > 0.8).float()[:, None]
    bulb = material == 1
    dots = (torch.sin(p[:, 0] * 38) * torch.sin(p[:, 1] * 38) * torch.sin(p[:, 2] * 38) > 0.35).float()
    bulb_colour = torch.stack([0.9 - 0.2 * dots, 0.7 - 0.35 * dots, 0.1 + 0.05 * noise], dim=-1)
    petal = material == 2
    radius = torch.linalg.norm(p[:, [0, 2]], dim=-1)
    angle = torch.atan2(p[:, 2], p[:, 0])
    veins = 0.5 + 0.5 * torch.sin(angle * 54 + radius * 9)
    petal_colour = torch.stack([0.92 - 0.1 * veins, 0.35 + 0.25 * radius - 0.1 * veins, 0.55 + 0.2 * noise], dim=-1)
    green = material == 3
    green_colour = torch.stack([0.1 + 0.15 * noise, 0.45 + 0.3 * fine, 0.12 + 0.1 * noise], dim=-1)
    out[ground] = ground_colour[ground]
    out[bulb] = bulb_colour[bulb]
    out[petal] = petal_colour[petal]
    out[green] = green_colour[green]
    return out


def render_frame(origin, target, width, height, vertical_fov_degrees=42.0):
    forward = target - origin
    forward = forward / torch.linalg.norm(forward)
    right = torch.linalg.cross(forward, torch.tensor([0.0, 1.0, 0.0], device=DEVICE))
    right = right / torch.linalg.norm(right)
    up = torch.linalg.cross(right, forward)
    scale = math.tan(math.radians(vertical_fov_degrees) / 2)
    ys, xs = torch.meshgrid(torch.arange(height, device=DEVICE), torch.arange(width, device=DEVICE), indexing="ij")
    u = ((xs.float() + 0.5) / width * 2 - 1) * scale * width / height
    v = (1 - (ys.float() + 0.5) / height * 2) * scale
    directions = forward[None, None] + u[..., None] * right + v[..., None] * up
    directions = (directions / torch.linalg.norm(directions, dim=-1, keepdim=True)).reshape(-1, 3)
    n = directions.shape[0]
    t = torch.zeros(n, device=DEVICE)
    hit = torch.zeros(n, dtype=torch.bool, device=DEVICE)
    active = torch.ones(n, dtype=torch.bool, device=DEVICE)
    for _ in range(90):
        idx = torch.nonzero(active).squeeze(-1)
        if idx.numel() == 0:
            break
        point = origin + directions[idx] * t[idx, None]
        d = scene_distance(point)
        close = d < 0.0015
        far = t[idx] > 14.0
        hit[idx[close]] = True
        t[idx] = t[idx] + d
        active[idx[close | far]] = False
    out = torch.zeros(n, 3, device=DEVICE)
    # Sky: a soft gradient with faint cloud noise so the background is not a perfect flat colour.
    sky_t = (directions[:, 1] * 0.5 + 0.5)[:, None]
    out[:] = (1 - sky_t) * torch.tensor([0.82, 0.88, 0.95], device=DEVICE) + sky_t * torch.tensor([0.42, 0.62, 0.9], device=DEVICE)
    idx = torch.nonzero(hit).squeeze(-1)
    if idx.numel():
        point = origin + directions[idx] * t[idx, None]
        d_all = distances(point)
        # Ground wins by distance; among flower parts the nearest primitive decides the material.
        nearest = torch.argmin(d_all, dim=-1)
        materials = torch.zeros_like(nearest)
        table = torch.tensor([0] + [item[4] for item in PRIMITIVES], device=DEVICE)
        materials = table[nearest]
        eps = 0.003
        normal = torch.stack([
            scene_distance(point + torch.tensor([eps, 0, 0], device=DEVICE)) - scene_distance(point - torch.tensor([eps, 0, 0], device=DEVICE)),
            scene_distance(point + torch.tensor([0, eps, 0], device=DEVICE)) - scene_distance(point - torch.tensor([0, eps, 0], device=DEVICE)),
            scene_distance(point + torch.tensor([0, 0, eps], device=DEVICE)) - scene_distance(point - torch.tensor([0, 0, eps], device=DEVICE)),
        ], dim=-1)
        normal = normal / torch.clamp(torch.linalg.norm(normal, dim=-1, keepdim=True), min=1e-6)
        light = torch.tensor([0.5, 0.8, 0.35], device=DEVICE)
        light = light / torch.linalg.norm(light)
        diffuse = torch.clamp(normal @ light, 0.0, 1.0)
        shade = 0.38 + 0.72 * diffuse
        out[idx] = colour(point, materials) * shade[:, None]
    image = (out.reshape(height, width, 3).clamp(0, 1) * 255).byte().cpu().numpy()
    return image


def main():
    global PRIMITIVES
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", required=True)
    parser.add_argument("--seconds", type=float, default=20.0)
    parser.add_argument("--fps", type=int, default=15)
    parser.add_argument("--width", type=int, default=1280)
    parser.add_argument("--height", type=int, default=720)
    parser.add_argument("--radius", type=float, default=3.6)
    parser.add_argument("--elevation", type=float, default=24.0, help="degrees above the horizon")
    parser.add_argument("--blur-fraction", type=float, default=0.08, help="share of frames to blur like hand-held shake")
    parser.add_argument("--hold-seconds", type=float, default=0.8, help="camera holds still this long at the start")
    parser.add_argument("--seed", type=int, default=7)
    args = parser.parse_args()
    PRIMITIVES = build_primitives()
    rng = np.random.default_rng(args.seed)
    frames = int(args.seconds * args.fps)
    hold = int(args.hold_seconds * args.fps)
    target = torch.tensor([0.0, 0.1, 0.0], device=DEVICE)
    with tempfile.TemporaryDirectory() as temp:
        folder = pathlib.Path(temp)
        for index in range(frames):
            progress = max(0, index - hold) / max(1, frames - hold - 1)
            azimuth = progress * 2 * math.pi
            elevation = math.radians(args.elevation + 6.0 * math.sin(progress * 4 * math.pi))
            distance = args.radius * (1.0 + 0.04 * math.sin(progress * 6 * math.pi))
            origin = torch.tensor([
                distance * math.cos(elevation) * math.cos(azimuth),
                distance * math.sin(elevation),
                distance * math.cos(elevation) * math.sin(azimuth),
            ], device=DEVICE)
            image = render_frame(origin, target, args.width, args.height)
            if index >= hold and rng.random() < args.blur_fraction:
                kernel = int(rng.integers(9, 21)) | 1
                image = cv2.GaussianBlur(image, (kernel, kernel), 0)
            cv2.imwrite(str(folder / f"{index:05d}.png"), cv2.cvtColor(image, cv2.COLOR_RGB2BGR))
            if index % 30 == 0:
                print(f"rendered {index}/{frames}", flush=True)
        subprocess.run([
            "ffmpeg", "-y", "-v", "error", "-framerate", str(args.fps), "-i", str(folder / "%05d.png"),
            "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart", args.out,
        ], check=True)
    print(f"wrote {args.out}: {frames} frames, {frames / args.fps:.1f} s")


if __name__ == "__main__":
    main()
