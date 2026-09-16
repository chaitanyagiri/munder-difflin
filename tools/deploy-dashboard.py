import argparse
import base64
import hashlib
import json
import pathlib
import shutil
import sys
import time

sys.path.insert(0, r"C:/Users/chrom/AppData/Local/hermes/scripts")
from md_shot import Session, page_targets

SOURCE = pathlib.Path(__file__).resolve().parents[1] / "out/renderer"
TARGET = pathlib.Path(r"C:/Users/chrom/AppData/Local/Programs/munder-difflin/resources/app/out/renderer")
EVIDENCE = pathlib.Path(r"C:/Users/chrom/Desktop/strategy upgrade/ui-evidence")


def evaluate(session, expression):
    result = session.send("Runtime.evaluate", expression=expression, returnByValue=True, awaitPromise=True)
    if result.get("exceptionDetails"):
        raise RuntimeError(str(result["exceptionDetails"]))
    return result.get("result", {}).get("value")


def probe(session):
    return evaluate(session, """(async () => {
      if (document.body.innerText.includes('SELECT A HARNESS CONFIG') && document.body.innerText.includes('HarnessAgents')) {
        [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'open')?.click();
      }
      const main = document.querySelector('main[aria-label="Company dashboard"]');
      const composer = document.querySelector('#md-company-message');
      const rect = composer?.getBoundingClientRect();
      const panel = document.querySelector('section[aria-label="Company chat"]')?.getBoundingClientRect();
      const missing = [];
      for (const n of document.querySelectorAll('script[src],link[rel="stylesheet"]')) {
        try { const r = await fetch(n.src || n.href); if (!r.ok) missing.push(n.src || n.href); }
        catch { missing.push(n.src || n.href); }
      }
      return { mounted: !!main, chat: !!document.querySelector('.md-messages'),
        composer_visible: !!rect && !!panel && rect.top >= panel.top && rect.bottom <= panel.bottom && rect.bottom <= innerHeight && rect.width > 100,
        chat_readable: (document.querySelector('.md-messages')?.clientHeight ?? 0) >= 80,
        no_horizontal_overflow: document.documentElement.scrollWidth <= innerWidth,
        assets_resolve: missing.length === 0, missing, width: innerWidth, height: innerHeight,
        feed: document.querySelector('.md-feed-status')?.innerText,
        scripts: [...document.scripts].filter(n => n.src).map(n => n.src) };
    })()""")


def screenshot(session, name):
    result = session.send("Page.captureScreenshot", format="png")
    path = EVIDENCE / name
    path.write_bytes(base64.b64decode(result["data"]))
    return str(path)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--inspect", action="store_true")
    args = parser.parse_args()
    if not (SOURCE / "index.html").is_file() or not (TARGET / "index.html").is_file():
        raise RuntimeError("source or installed renderer is missing")
    targets = [t for t in page_targets() if "/resources/app/out/renderer/" in t.get("url", "")]
    if len(targets) != 1:
        raise RuntimeError("expected exactly one installed Munder renderer")
    EVIDENCE.mkdir(parents=True, exist_ok=True)
    session = Session(targets[0]["webSocketDebuggerUrl"])
    backup = None
    try:
        if not args.inspect:
            backup = EVIDENCE / ("renderer-backup-" + time.strftime("%Y%m%d-%H%M%S"))
            shutil.copytree(TARGET, backup)
            shutil.copytree(SOURCE, TARGET, dirs_exist_ok=True)
            session.send("Page.reload", ignoreCache=True)
        deadline = time.monotonic() + 40
        while True:
            report = probe(session)
            passed = all(report.get(key) is True for key in
                         ("mounted", "chat", "composer_visible", "chat_readable", "no_horizontal_overflow", "assets_resolve"))
            if passed or time.monotonic() >= deadline:
                break
            time.sleep(.5)
        if not passed:
            raise RuntimeError(json.dumps(report))
        time.sleep(1)
        report["screenshot"] = screenshot(session, "dashboard-after.png")
        report["backup"] = str(backup) if backup else None
        report["index_sha256"] = hashlib.sha256((TARGET / "index.html").read_bytes()).hexdigest()
        report["source_matches_installed"] = (SOURCE / "index.html").read_bytes() == (TARGET / "index.html").read_bytes()
        (EVIDENCE / "deployment-report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
        print(json.dumps(report, indent=2))
    except Exception:
        if backup:
            shutil.copytree(backup, TARGET, dirs_exist_ok=True)
            session.send("Page.reload", ignoreCache=True)
        raise
    finally:
        session.close()


if __name__ == "__main__":
    main()
