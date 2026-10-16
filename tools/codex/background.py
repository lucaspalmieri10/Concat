# SPDX-License-Identifier: AGPL-3.0-or-later
"""Isolated CPU matting worker. JSON stdin/stdout; only FFmpeg writes media.

RVM follows PeterL1n/RobustVideoMatting/documentation/inference.md.
ISNet preprocessing follows Concat's concat-vision/src/segment.rs.
No network, shell execution, or changes to the Concat application.
"""
from collections import deque
from fractions import Fraction
from pathlib import Path
import json
import math
import os
import subprocess
import sys
import threading
import time

import numpy as np
import onnxruntime as ort
from PIL import Image, ImageOps

HIDDEN = subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0


class Process:
    def __init__(self, args, **kwargs):
        self.log = deque(maxlen=60)
        self.proc = subprocess.Popen(args, stderr=subprocess.PIPE, creationflags=HIDDEN, **kwargs)
        self.thread = threading.Thread(target=self.collect, daemon=True)
        self.thread.start()

    def collect(self):
        for line in iter(self.proc.stderr.readline, b''):
            self.log.append(line.decode('utf-8', errors='replace').strip()[:500])

    def finish(self):
        code = self.proc.wait(timeout=60)
        self.thread.join(timeout=2)
        if code:
            raise RuntimeError(f'FFmpeg returned {code}: ' + '\n'.join(self.log))

    def stop(self):
        if self.proc.poll() is None:
            self.proc.kill()
            self.proc.wait(timeout=10)
        self.thread.join(timeout=2)


class Segmenter:
    def __init__(self, folder, subject):
        self.subject = subject
        options = ort.SessionOptions()
        options.intra_op_num_threads = min(os.cpu_count() or 2, 4)
        options.inter_op_num_threads = 1
        options.log_severity_level = 3
        model = 'rvm-mobilenetv3.onnx' if subject == 'person' else 'isnet-general-use.onnx'
        self.session = ort.InferenceSession(str(Path(folder) / model), sess_options=options, providers=['CPUExecutionProvider'])
        self.state = [np.zeros((1, 1, 1, 1), dtype=np.float32) for _ in range(4)]

    def alpha(self, image):
        if self.subject == 'person':
            scale = min(512 / max(image.size), 1)
            width, height = [max(64, round(side * scale / 16) * 16) for side in image.size]
            pixels = np.asarray(image.resize((width, height), Image.Resampling.BILINEAR), dtype=np.float32) / 255
            inputs = {'src': np.ascontiguousarray(pixels.transpose(2, 0, 1)[None]), 'downsample_ratio': np.array([1], dtype=np.float32)}
            inputs.update({f'r{i+1}i': state for i, state in enumerate(self.state)})
            alpha, *self.state = self.session.run(['pha', 'r1o', 'r2o', 'r3o', 'r4o'], inputs)
            alpha = np.clip(alpha[0, 0], 0, 1)
        else:
            pixels = np.asarray(image.resize((1024, 1024), Image.Resampling.BILINEAR), dtype=np.float32)
            pixels = pixels / max(float(pixels.max()), 1e-6) - 0.5
            alpha = self.session.run(['output_image'], {'input_image': np.ascontiguousarray(pixels.transpose(2, 0, 1)[None])})[0][0, 0]
            alpha = (alpha - alpha.min()) / max(float(alpha.max() - alpha.min()), 1e-6)
        mask = Image.fromarray(np.rint(alpha * 255).astype(np.uint8))
        return mask.resize(image.size, Image.Resampling.BILINEAR)


def probe(ffprobe, path):
    result = subprocess.run([ffprobe, '-v', 'error', '-show_streams', '-show_format', '-of', 'json', path], capture_output=True, creationflags=HIDDEN, timeout=30, check=True)
    return json.loads(result.stdout)


def read_frame(stream, size):
    pieces = bytearray()
    while len(pieces) < size:
        chunk = stream.read(size - len(pieces))
        if not chunk:
            if pieces:
                raise RuntimeError('Incomplete decoded video frame')
            return None
        pieces.extend(chunk)
    return bytes(pieces)


def main(config):
    started = time.monotonic()
    source, output = Path(config['input']), Path(config['output'])
    if not source.is_absolute() or not source.is_file() or not output.is_absolute():
        raise ValueError('Use absolute local file paths')
    if output.exists() or not output.parent.is_dir():
        raise ValueError('Output must be a new file in an existing folder')
    subject = config.get('subject', 'person')
    if subject not in ('person', 'object'):
        raise ValueError('Invalid subject')
    ffmpeg = config['ffmpeg']
    common = [ffmpeg, '-nostdin', '-hide_banner', '-loglevel', 'error', '-n']
    segmenter = Segmenter(config['models'], subject)
    statistics = {'min': 255, 'max': 0, 'sum': 0.0, 'pixels': 0}

    def remove(image):
        original_alpha = image.getchannel('A') if image.mode == 'RGBA' else None
        rgb = image.convert('RGB')
        mask = np.asarray(segmenter.alpha(rgb))
        if original_alpha is not None:
            mask = np.rint(mask.astype(np.float32) * np.asarray(original_alpha) / 255).astype(np.uint8)
        statistics['min'] = min(statistics['min'], int(mask.min()))
        statistics['max'] = max(statistics['max'], int(mask.max()))
        statistics['sum'] += float(mask.sum(dtype=np.float64))
        statistics['pixels'] += mask.size
        return np.dstack((np.asarray(rgb), mask)).tobytes()

    if output.suffix.lower() == '.png':
        with Image.open(source) as image:
            image = ImageOps.exif_transpose(image).convert('RGBA')
            if image.width * image.height > 25_000_000:
                raise ValueError('Resize images larger than 25 megapixels first')
            width, height = image.size
            raw = remove(image)
        result = subprocess.run(common + ['-f', 'rawvideo', '-pixel_format', 'rgba', '-video_size', f'{width}x{height}', '-i', 'pipe:0', '-frames:v', '1', '-c:v', 'png', str(output)], input=raw, capture_output=True, creationflags=HIDDEN, timeout=60)
        if result.returncode:
            raise RuntimeError(result.stderr.decode('utf-8', errors='replace')[-6000:])
        count, fps, has_audio = 1, None, False
    elif output.suffix.lower() == '.mov':
        info = probe(str(Path(ffmpeg).with_name('ffprobe.exe' if os.name == 'nt' else 'ffprobe')), str(source))
        stream = next((s for s in info['streams'] if s['codec_type'] == 'video'), None)
        if stream is None:
            raise ValueError('Input has no video stream')
        width, height = stream['width'], stream['height']
        rotation = next((s.get('rotation', 0) for s in stream.get('side_data_list', []) if 'rotation' in s), int(stream.get('tags', {}).get('rotate', 0)))
        if abs(rotation) % 180 == 90:
            width, height = height, width
        edge = int(config.get('maxEdge', 1280))
        if not 64 <= edge <= 4096:
            raise ValueError('maxEdge must be 64..4096')
        scale = min(edge / max(width, height), 1)
        width, height = [max(2, round(side * scale / 2) * 2) for side in (width, height)]
        try:
            rate = Fraction(stream.get('avg_frame_rate', '0/1'))
            if rate <= 0:
                rate = Fraction(stream.get('r_frame_rate', '30/1'))
        except (ValueError, ZeroDivisionError):
            rate = Fraction(30)
        fps = Fraction(str(config['fps'])) if 'fps' in config else min(rate, Fraction(30))
        if not 1 <= fps <= 60:
            raise ValueError('Frame rate must be 1..60')
        start = float(config.get('start', 0))
        duration = config.get('duration')
        if not math.isfinite(start) or start < 0:
            raise ValueError('Invalid start')
        if duration is not None and (not math.isfinite(float(duration)) or float(duration) <= 0):
            raise ValueError('Invalid duration')
        source_opts = (['-ss', str(start)] if start else [])
        duration_opts = ['-t', str(duration)] if duration is not None else []
        has_audio = any(s['codec_type'] == 'audio' for s in info['streams'])
        decoder = encoder = None
        count = 0
        try:
            decoder = Process(common + source_opts + ['-i', str(source)] + duration_opts + ['-map', '0:v:0', '-an', '-sn', '-vf', f'scale={width}:{height},fps={fps}', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], stdout=subprocess.PIPE, stdin=subprocess.DEVNULL)
            encode = common + ['-f', 'rawvideo', '-pixel_format', 'rgba', '-video_size', f'{width}x{height}', '-framerate', str(fps), '-i', 'pipe:0']
            if has_audio:
                encode += source_opts + ['-i', str(source), '-map', '0:v:0', '-map', '1:a:0', '-c:a', 'pcm_s16le', '-af', 'apad', '-shortest']
            else:
                encode += ['-map', '0:v:0', '-an']
            encode += duration_opts + ['-c:v', 'qtrle', '-pix_fmt', 'argb', '-map_metadata', '-1', '-movflags', '+faststart', str(output)]
            encoder = Process(encode, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL)
            while True:
                raw = read_frame(decoder.proc.stdout, width * height * 3)
                if raw is None:
                    break
                if time.monotonic() - started > 1700:
                    raise TimeoutError('Processing exceeded 28 minutes; process a shorter clip')
                image = Image.frombytes('RGB', (width, height), raw)
                encoder.proc.stdin.write(remove(image))
                count += 1
                if count == 1 or count % 30 == 0:
                    print(json.dumps({'frames': count, 'elapsedSeconds': round(time.monotonic() - started, 1)}), file=sys.stderr, flush=True)
            decoder.finish()
            if not count:
                raise ValueError('No frames decoded for this range')
            encoder.proc.stdin.close()
            encoder.finish()
        finally:
            for process in (decoder, encoder):
                if process:
                    process.stop()
    else:
        raise ValueError('Use PNG for an image or MOV for a video with transparency')
    size = output.stat().st_size
    if not size:
        raise RuntimeError('Empty output')
    return {'output': str(output), 'bytes': size, 'subject': subject, 'frames': count, 'width': width, 'height': height, 'fps': float(fps) if fps else None, 'duration': float(count / fps) if fps else None, 'audioPreserved': has_audio, 'transparency': True, 'alphaMin': statistics['min'], 'alphaMax': statistics['max'], 'foregroundFraction': round(statistics['sum'] / (statistics['pixels'] * 255), 4), 'elapsedSeconds': round(time.monotonic() - started, 2), 'engine': f'onnxruntime-{ort.__version__}-cpu'}


if __name__ == '__main__':
    try:
        print(json.dumps(main(json.load(sys.stdin)), ensure_ascii=True), flush=True)
    except Exception as error:
        print(str(error), file=sys.stderr, flush=True)
        raise SystemExit(1)
