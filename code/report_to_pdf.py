"""report.md -> report.html -> report.pdf (Chrome headless). Course rule: PDF, 15 pages or fewer, every font 11pt or smaller (headings included).

    python code/report_to_pdf.py

ponytail: handles only what report.md uses (#-####, paragraphs, '- ' lists, pipe tables, images, **bold**, `code`, links).
Swap in pandoc if the report grows other Markdown.
"""
import html
import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'submission' if (ROOT / 'submission').exists() else ROOT  # repo layout, else zip root
import os, shutil  # noqa: E401
CHROME = os.environ.get('CHROME') or shutil.which('chrome') or shutil.which('google-chrome') or r'C:\Program Files\Google\Chrome\Application\chrome.exe'
CSS = """body{font-family:'Malgun Gothic',sans-serif;font-size:10pt;line-height:1.55;margin:0}
h1{font-size:11pt;margin:0 0 4px}h2{font-size:11pt;margin:18px 0 6px;border-bottom:1px solid #999}
h3{font-size:10.5pt;margin:12px 0 4px}h4{font-size:10pt;margin:10px 0 4px}p{margin:4px 0 8px;text-align:justify}
table{border-collapse:collapse;margin:6px 0 10px;font-size:9pt}th,td{border:1px solid #aaa;padding:2px 6px}th{background:#eee}
td:not(:first-child){text-align:right}img{max-width:100%;display:block;margin:6px auto}figcaption{text-align:center;font-size:9pt;margin-bottom:8px}
ul{margin:4px 0 8px 18px;padding:0}li{margin:2px 0}@page{size:A4;margin:18mm 16mm}"""


def inline(t):
    t = html.escape(t, quote=False)
    t = re.sub(r'\*\*(.+?)\*\*', r'<b>\1</b>', t)
    t = re.sub(r'`(.+?)`', r'<code>\1</code>', t)
    # web links stay clickable; local files become plain text, since Chrome would bake an absolute file:///C:/Users/... path into the PDF
    return re.sub(r'\[(.+?)\]\((.+?)\)', lambda m: f'<a href="{m[2]}">{m[1]}</a>' if m[2].startswith('http') else f'{m[1]}({m[2].split("/")[-1]})', t)


def convert(md):
    out, lines, i = [], md.splitlines(), 0
    while i < len(lines):
        ln = lines[i]
        if m := re.match(r'(#{1,4}) (.*)', ln):
            out.append(f'<h{len(m[1])}>{inline(m[2])}</h{len(m[1])}>')
        elif m := re.match(r'!\[(.*?)\]\((.*?)\)', ln):
            out.append(f'<figure><img src="{m[2]}"><figcaption>{inline(m[1])}</figcaption></figure>')
        elif ln.startswith('|'):
            rows = []
            while i < len(lines) and lines[i].startswith('|'):
                rows.append([c.strip() for c in lines[i].strip('|').split('|')]); i += 1
            i -= 1
            body = ''.join('<tr>' + ''.join(f'<td>{inline(c)}</td>' for c in r) + '</tr>' for r in rows[2:])
            out.append('<table><tr>' + ''.join(f'<th>{inline(c)}</th>' for c in rows[0]) + '</tr>' + body + '</table>')
        elif ln.startswith('- '):
            items = []
            while i < len(lines) and lines[i].startswith('- '):
                items.append(f'<li>{inline(lines[i][2:])}</li>'); i += 1
            i -= 1
            out.append('<ul>' + ''.join(items) + '</ul>')
        elif ln.strip():
            out.append(f'<p>{inline(ln)}</p>')
        i += 1
    return '\n'.join(out)


def main():
    page = f'<!doctype html><meta charset="utf-8"><title>report</title><style>{CSS}</style>{convert((OUT / "report.md").read_text(encoding="utf-8"))}'
    (OUT / 'report.html').write_text(page, encoding='utf-8')
    subprocess.run([CHROME, '--headless=new', '--disable-gpu', '--no-pdf-header-footer',
                    f'--print-to-pdf={OUT / "report.pdf"}', (OUT / 'report.html').as_uri()], check=True, capture_output=True)
    pdf = (OUT / 'report.pdf').read_bytes()
    print('pages', len(re.findall(rb'/Type\s*/Page[^s]', pdf)))


if __name__ == '__main__':
    main()
