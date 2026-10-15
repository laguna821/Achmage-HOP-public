"""Generate rhwp metric entries for fonts HOP users have but rhwp's table lacks (P4, rhwp patch 0001).

Without an entry rhwp estimates Hangul at 1.0 em; 한림고딕체 is 0.94 em and 한림명조체 0.97 em, so lines break
earlier than in Hancom Office. The output mirrors rhwp's font-metric-gen fragment (same Latin ranges, zero for
missing glyphs, advance widths in font units) with HOP_ prefixes, and only numbers leave the font files.
A face whose Hangul syllables are not all one width uses the exact 19x21x28 identity encoding.

Usage: python scripts/achmage/gen-hop-font-metrics.py --fonts DIR --out font_metrics_hop.rs
"""
import argparse
import hashlib
from pathlib import Path

from fontTools.ttLib import TTFont  # local build tool only

GOTHIC = ['한림고딕체', 'Hallym Gothic', '한림고딕']
# (file, [(name, bold attribute)]) — the names documents use for the face. Hallym documents name faces by family plus
# style ("한림고딕체 Regular"), so those full names are entries too; a face named "... Bold" is bold without the attribute.
# Only faces whose line breaks were checked against Hancom Office 2024 are listed. 한림명조체 is left out on purpose:
# Hancom 2024 lays it out as if its Hangul were 1.0 em (not the file's 0.97 em), which rhwp's fallback already matches
# line for line, while the file metrics broke lines later than Hancom (compared on printouts, 2026-10-15).
# There are no bold-attribute entries: each Hallym file registers its own legacy family ("한림고딕체 Regular",
# "한림고딕체 Bold", ...; name ID 1, all style "Regular"), so a bold run has no bold sibling and Hancom 2024 prints it
# with the regular outlines and widths plus a 0.02 em stroke (on printouts, turning bold off moved
# no glyph). Without a bold entry rhwp falls back to the regular widths with bold_fallback, which draws that stroke.
FACES = [
    ('HallymGothic-Regular.ttf', [(n, False) for n in GOTHIC + ['한림고딕체 Regular', 'Hallym Gothic Regular']]),
    ('HallymGothic-Bold.ttf', [('한림고딕체 Bold', False), ('Hallym Gothic Bold', False)]),
    ('HallymGothic-Medium.ttf', [('한림고딕체 Medium', False), ('Hallym Gothic Medium', False)]),
]
# Same ranges, in the same order, as rhwp src/tools/font_metric_gen.rs extract_latin_ranges.
RANGES = [(0x0020, 0x007E), (0x00A0, 0x00FF), (0x2000, 0x206F), (0x2200, 0x22FF), (0x3000, 0x303F),
          (0x3130, 0x318F), (0xFF00, 0xFF5E)]


def rust_array(values):
    return '[' + ', '.join(str(v) for v in values) + ']'


def face_source(index, path):
    font = TTFont(path, lazy=True)
    cmap, hmtx, em = font.getBestCmap(), font['hmtx'], font['head'].unitsPerEm
    width = lambda code: hmtx[cmap[code]][0] if code in cmap else 0
    prefix, out = f'HOP_FONT_{index}', []
    ranges = []
    for start, end in RANGES:
        widths = [width(c) for c in range(start, end + 1)]
        if any(widths):
            ranges.append((start, end, widths))
    for i, (_, _, widths) in enumerate(ranges):
        out.append(f'static {prefix}_LATIN_{i}: [u16; {len(widths)}] = {rust_array(widths)};')
    out.append(f'static {prefix}_LATIN_RANGES: [LatinRange; {len(ranges)}] = [')
    for i, (start, end, _) in enumerate(ranges):
        out.append(f'    LatinRange {{ start: 0x{start:04X}, end: 0x{end:04X}, widths: &{prefix}_LATIN_{i} }},')
    out.append('];')
    syllables = [width(c) for c in range(0xAC00, 0xD7A4)]
    if len(set(syllables)) == 1:
        groups, maps, widths = (1, 1, 1), ([0] * 19, [0] * 21, [0] * 28), syllables[:1]
    else:
        groups, maps, widths = (19, 21, 28), (list(range(19)), list(range(21)), list(range(28))), syllables
    for part, values in zip(('CHO', 'JUNG', 'JONG'), maps):
        out.append(f'static {prefix}_HANGUL_{part}: [u8; {len(values)}] = {rust_array(values)};')
    out.append(f'static {prefix}_HANGUL_WIDTHS: [u16; {len(widths)}] = {rust_array(widths)};')
    out.append(f'static {prefix}_HANGUL: HangulMetric = HangulMetric {{ cho_groups: {groups[0]}, jung_groups: {groups[1]}, '
               f'jong_groups: {groups[2]}, cho_map: &{prefix}_HANGUL_CHO, jung_map: &{prefix}_HANGUL_JUNG, '
               f'jong_map: &{prefix}_HANGUL_JONG, widths: &{prefix}_HANGUL_WIDTHS }};')
    return '\n'.join(out), em, hashlib.sha256(path.read_bytes()).hexdigest(), syllables[0]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--fonts', required=True, type=Path)
    parser.add_argument('--out', required=True, type=Path)
    args = parser.parse_args()
    data, entries, provenance = [], [], []
    for index, (file, names) in enumerate(FACES):
        source, em, digest, hangul = face_source(index, args.fonts / file)
        data.append(source)
        provenance.append(f'// {index}: {file} sha256={digest} em={em} hangul={hangul}')
        for name, bold in names:
            entries.append(f'    FontMetric {{ name: "{name}", bold: {str(bold).lower()}, italic: false, em_size: {em}, '
                           f'latin_ranges: &HOP_FONT_{index}_LATIN_RANGES, hangul: Some(&HOP_FONT_{index}_HANGUL) }},')
    header = ['// HOP font metrics (rhwp patch 0001): advance widths of Hallym Gothic, checked line by line against Hancom 2024.',
              '// Generated by HOP scripts/achmage/gen-hop-font-metrics.py from font files on the build machine; only numbers,',
              '// no glyph data. Chained after generated and overlay metrics, so existing names keep priority.',
              *provenance, '']
    text = '\n'.join(header + data + [f'static HOP_FONT_METRICS: [FontMetric; {len(entries)}] = [', *entries, '];', ''])
    args.out.write_text(text, encoding='utf-8', newline='\n')
    print(f'{len(FACES)} faces, {len(entries)} entries -> {args.out}')


if __name__ == '__main__':
    main()
