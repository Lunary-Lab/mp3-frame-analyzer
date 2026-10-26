#!/usr/bin/env python3
"""Regenerate original short fixtures with installed libmp3lame (test-only).

No truncation: each fixture contains all bytes from encode_buffer + normal flush.
The expected physical count comes from lame_get_frameNum, independently checked
by walking the configured fixed bitrate span and each encoder-written padding bit.
This is an encoder-configured oracle, not free-format size inference.
"""
import base64
import ctypes as c
import ctypes.util
import hashlib
import json
import math
from pathlib import Path

lib = c.CDLL(ctypes.util.find_library('mp3lame') or 'libmp3lame.so.0')
lib.lame_init.restype = c.c_void_p
lib.get_lame_version.restype = c.c_char_p
for name in ('lame_set_in_samplerate', 'lame_set_out_samplerate', 'lame_set_num_channels',
             'lame_set_mode', 'lame_set_brate', 'lame_set_free_format',
             'lame_set_error_protection', 'lame_set_bWriteVbrTag'):
    getattr(lib, name).argtypes = [c.c_void_p, c.c_int]
for name in ('lame_init_params', 'lame_get_frameNum', 'lame_close'):
    getattr(lib, name).argtypes = [c.c_void_p]
lib.lame_encode_buffer.argtypes = [c.c_void_p, c.POINTER(c.c_short), c.POINTER(c.c_short),
                                   c.c_int, c.POINTER(c.c_ubyte), c.c_int]
lib.lame_encode_flush.argtypes = [c.c_void_p, c.POINTER(c.c_ubyte), c.c_int]
fixtures = []
for rate in (32000, 44100, 48000):
    for channels in (1, 2):
        for crc in (False, True):
            for kbps in (128, 400):
                for samples in (0, 1000):
                    encoder = lib.lame_init()
                    assert encoder
                    try:
                        settings = dict(in_samplerate=rate, out_samplerate=rate,
                                        num_channels=channels, mode=3 if channels == 1 else 0,
                                        brate=kbps, free_format=1, error_protection=int(crc),
                                        bWriteVbrTag=0)
                        for key, value in settings.items():
                            assert getattr(lib, 'lame_set_' + key)(encoder, value) >= 0
                        assert lib.lame_init_params(encoder) >= 0
                        pcm = (c.c_short * max(1, samples))()
                        for i in range(samples):
                            pcm[i] = int(12000 * math.sin(2 * math.pi * 440 * i / rate))
                        output = (c.c_ubyte * 16384)()
                        length = lib.lame_encode_buffer(encoder, pcm, pcm, samples, output, len(output))
                        assert length >= 0
                        flush = lib.lame_encode_flush(encoder, c.cast(c.byref(output, length), c.POINTER(c.c_ubyte)), len(output) - length)
                        assert flush >= 0
                        data = bytes(output[:length + flush])
                        expected = lib.lame_get_frameNum(encoder)
                    finally:
                        lib.lame_close(encoder)
                    offsets = []
                    offset = 0
                    base = 144000 * kbps // rate
                    while offset < len(data):
                        assert data[offset] == 255 and data[offset + 1] & 254 == 250
                        assert data[offset + 2] >> 4 == 0
                        offsets.append(offset)
                        offset += base + ((data[offset + 2] >> 1) & 1)
                    assert offset == len(data) and len(offsets) == expected
                    fixtures.append(dict(rate=rate, channels=channels, crc=crc, kbps=kbps,
                                         pcmSamples=samples, frames=expected, offsets=offsets,
                                         sha256=hashlib.sha256(data).hexdigest(),
                                         base64=base64.b64encode(data).decode()))
manifest = dict(encoder='libmp3lame ' + lib.get_lame_version().decode(),
                method='lame_encode_buffer then lame_encode_flush; no Xing, no trimming',
                fixtures=fixtures)
Path('tests/fixtures/short-free-format.json').write_text(json.dumps(manifest, indent=2) + '\n')
print(f'Generated and independently span-checked {len(fixtures)} normal-flush files')
