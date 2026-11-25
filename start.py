"""Install local dependencies and launch the API and web UI together."""

import argparse
import hashlib
import socket
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
import webbrowser
from pathlib import Path


ROOT = Path(__file__).resolve().parent
FRONTEND = ROOT / "frontend"
SITE_URL = "http://127.0.0.1:5173/projects"


def command(name):
    found = shutil.which(name)
    if not found:
        raise RuntimeError(f"Не найдена команда {name}. Установите её и добавьте в PATH.")
    return found


def prepare():
    uv = command("uv")
    node = command("node")
    npm = command("npm")
    command("ffmpeg")
    command("ffprobe")
    print("[Lumir] Устанавливаю или проверяю Python-зависимости…", flush=True)
    subprocess.run([uv, "sync", "--python", "3.13", "--extra", "ml", "--locked"], cwd=ROOT, check=True)

    lockfile = FRONTEND / "package-lock.json"
    digest = hashlib.sha256(lockfile.read_bytes()).hexdigest()
    stamp = FRONTEND / "node_modules" / ".lumir-lock-sha256"
    if not stamp.exists() or stamp.read_text().strip() != digest:
        print("[Lumir] Устанавливаю зависимости сайта…", flush=True)
        subprocess.run([npm, "ci"], cwd=FRONTEND, check=True)
        stamp.write_text(digest)
    return node


def check_ports():
    for port in (8000, 5173):
        with socket.socket() as connection:
            if connection.connect_ex(("127.0.0.1", port)) == 0:
                raise RuntimeError(f"Порт {port} уже занят. Остановите ранее запущенный Lumir или другую программу на этом порту.")


def wait_for_site(processes, timeout=30):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        for name, process in processes:
            if process.poll() is not None:
                raise RuntimeError(f"{name} завершился с кодом {process.returncode}. Проверьте сообщение выше.")
        ready = True
        for url in ("http://127.0.0.1:8000/version", SITE_URL):
            try:
                with urllib.request.urlopen(url, timeout=1) as response:
                    ready = ready and response.status == 200
            except (urllib.error.URLError, TimeoutError):
                ready = False
        if ready:
            return
        time.sleep(0.4)
    raise RuntimeError("Сайт не запустился за 30 секунд. Проверьте сообщения серверов выше.")


def stop(processes):
    for _, process in processes:
        if process.poll() is None:
            process.terminate()
    for _, process in processes:
        if process.poll() is None:
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()


def main():
    parser = argparse.ArgumentParser(description="Запустить Lumir Dub Translator локально")
    parser.add_argument("--no-browser", action="store_true", help="не открывать браузер автоматически")
    args = parser.parse_args()
    processes = []
    try:
        check_ports()
        node = prepare()
        api = ROOT / ".venv" / ("Scripts/lumir-api.exe" if sys.platform == "win32" else "bin/lumir-api")
        if not api.is_file():
            raise RuntimeError(f"Не найден сервер {api}. Попробуйте выполнить: uv sync --python 3.13 --extra ml")
        processes.append(("Backend", subprocess.Popen([str(api)], cwd=ROOT)))
        processes.append(("Frontend", subprocess.Popen([node, str(FRONTEND / "node_modules/vite/bin/vite.js"), "--host", "127.0.0.1"], cwd=FRONTEND)))
        wait_for_site(processes)
        print(f"[Lumir] Готово: {SITE_URL}\n[Lumir] Для остановки нажмите Ctrl+C.", flush=True)
        if not args.no_browser:
            webbrowser.open(SITE_URL)
        while True:
            for name, process in processes:
                if process.poll() is not None:
                    raise RuntimeError(f"{name} завершился с кодом {process.returncode}.")
            time.sleep(1)
    except KeyboardInterrupt:
        print("\n[Lumir] Останавливаю серверы…", flush=True)
    except (RuntimeError, subprocess.CalledProcessError) as exc:
        print(f"[Lumir] Ошибка: {exc}", file=sys.stderr, flush=True)
        return 1
    finally:
        stop(processes)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
