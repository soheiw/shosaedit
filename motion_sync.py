"""Paired CSV sync over an existing mounted share; no robot/control operations.

All network filesystem work runs in a disposable subprocess, off the HTTP thread.
The existing TD calibration JSON is deliberately never read or written.
"""
from __future__ import annotations

import base64
import csv
import hashlib
import io
import json
import math
import os
from pathlib import Path
import queue
import re
import subprocess
import sys
import threading
import time
import unicodedata
import uuid

DEFAULT_ROOT = "/Volumes/B2J_rehersal/Recorded_movements"
MAX_BYTES = 2 * 1024 * 1024
MAX_ROWS = 10000
WIDTHS = {"L": 8, "R": 9}
PORTS = {"L": "COM14", "R": "COM15"}


def _hash(raw):
    return hashlib.sha256(raw).hexdigest()


def _name(value):
    if not isinstance(value, str):
        raise ValueError("Motion name must be text")
    value = unicodedata.normalize("NFC", value).strip()
    if value.lower().endswith(".csv"):
        value = value[:-4].strip()
    if (not value or len(value) > 140 or value in (".", "..")
            or re.search(r'[\\/:*?"<>|\x00-\x1f]', value)
            or value.endswith((".", " "))):
        raise ValueError("Invalid motion filename")
    if value.split(".")[0].upper() in {"CON", "PRN", "AUX", "NUL", *[f"COM{i}" for i in range(1, 10)], *[f"LPT{i}" for i in range(1, 10)]}:
        raise ValueError("Reserved motion filename")
    return value


def _validate_rows(rows, width):
    if not isinstance(rows, list) or not 1 <= len(rows) <= MAX_ROWS:
        raise ValueError("CSV must have 1–10000 frames")
    for row in rows:
        if not isinstance(row, list) or len(row) != width:
            raise ValueError(f"Expected {width} motor columns")
        if any(type(x) is not int or not -(2**31) <= x < 2**31 for x in row):
            raise ValueError("CSV motor values must be signed 32-bit integers")
    return rows


def _parse(raw, width):
    if not raw or len(raw) > MAX_BYTES:
        raise ValueError("CSV exceeds size limit or is empty")
    result = []
    for row in csv.reader(io.StringIO(raw.decode("utf-8-sig"))):
        if not row or any(not re.fullmatch(r"[+-]?\d+", x.strip()) for x in row):
            raise ValueError("Expected headerless integer CSV")
        result.append([int(x) for x in row])
        if len(result) > MAX_ROWS:
            raise ValueError("Too many CSV frames")
    return _validate_rows(result, width)


def _encode(rows, width):
    _validate_rows(rows, width)
    buf = io.StringIO(newline="")
    csv.writer(buf, lineterminator="\r\n").writerows(rows)
    raw = buf.getvalue().encode("utf-8")
    if len(raw) > MAX_BYTES:
        raise ValueError("CSV exceeds size limit")
    return raw


def _validate_snapshot(value):
    def finite(x):
        return type(x) in (int, float) and math.isfinite(x)
    def vector(value, width):
        return isinstance(value, list) and len(value) == width and all(finite(x) and abs(x) <= 2147483647 for x in value)
    if (not isinstance(value, dict) or type(value.get("version")) is not int or value.get("version") != 1
            or not finite(value.get("resolution")) or not 0 < value["resolution"] <= 1000000):
        raise ValueError("Invalid calibration snapshot version/resolution")
    for side, width in WIDTHS.items():
        data = value.get(side)
        ids = list(range(1, 10)) if side == "R" else list(range(11, 19))
        if (not isinstance(data, dict) or data.get("ids") != ids
                or any(type(x) is not int for x in data.get("ids", []))
                or not vector(data.get("zero"), width)
                or any(abs(x) > 2147483647 for x in data["zero"])
                or not isinstance(data.get("joints"), list) or len(data["joints"]) != 8):
            raise ValueError("Invalid calibration IDs, zeros or joints")
        for joint in data["joints"]:
            if (not isinstance(joint, dict) or not vector(joint.get("pivot"), 3)
                    or not vector(joint.get("axis"), 3) or math.hypot(*joint["axis"]) < 1e-6
                    or not finite(joint.get("gain")) or abs(joint["gain"]) > 100
                    or type(joint.get("motor")) is not int or not -1 <= joint["motor"] < width):
                raise ValueError("Invalid calibration joint mapping")
        if "rest" in data and (not vector(data["rest"], width)
                or any(type(x) is not int or abs(x) > 2147483647 for x in data["rest"])):
            raise ValueError("Invalid calibration rest pose")
    # The caller's snapshot is kept verbatim; this is validation, not a rewrite.
    json.dumps(value, allow_nan=False)
    return value


def _safe_file(folder, path):
    # Reject symlinks escaping the selected share/COM directory.
    return path.resolve().parent == folder.resolve() and path.is_file()


def _read_stable(path):
    before = path.stat()
    if before.st_size > MAX_BYTES:
        raise ValueError("File exceeds size limit")
    raw = path.read_bytes()
    after = path.stat()
    if (before.st_size, before.st_mtime_ns, before.st_ino) != (after.st_size, after.st_mtime_ns, after.st_ino):
        raise ValueError("File changed while reading")
    return raw, {"size": after.st_size, "mtimeNs": after.st_mtime_ns,
                 "sha256": _hash(raw), "path": str(path)}


def _scan(root):
    root = Path(root)
    pairs = {}
    for side, port in PORTS.items():
        folder = root / port
        if not folder.is_dir():
            raise FileNotFoundError(f"Share folder unavailable: {port}")
        seen = set()
        for p in folder.iterdir():
            if p.suffix.casefold() != ".csv" or not _safe_file(folder, p):
                continue
            try:
                name = _name(p.stem)
                key = name.casefold()
                if key in seen:
                    pairs.setdefault(key, {})["invalid"] = "Case-insensitive filename conflict"
                    continue
                seen.add(key)
                raw, info = _read_stable(p)
                _parse(raw, WIDTHS[side])
                pairs.setdefault(key, {}).update({side: {"raw": base64.b64encode(raw).decode(), **info}, "name": name})
            except (ValueError, UnicodeError, OSError, csv.Error) as exc:
                pairs.setdefault(p.stem.casefold(), {})["invalid"] = str(exc)
    ready, pending = [], []
    for key, pair in sorted(pairs.items()):
        if pair.get("invalid") or any(s not in pair for s in WIDTHS):
            pending.append({"name": pair.get("name", key), "reason": pair.get("invalid", "Waiting for both arms")})
            continue
        # This optional sidecar belongs only to ShosaEdit-produced CSVs.
        # Unrelated arm_models.json is never opened.
        sidecar = root / (pair["name"] + ".shosa-sync.json")
        try:
            if _safe_file(root, sidecar):
                raw, _ = _read_stable(sidecar)
                meta = json.loads(raw)
                expected = {s: pair[s]["sha256"] for s in WIDTHS}
                if (isinstance(meta, dict) and meta.get("format") == "shosa-sync-csv" and meta.get("version") == 1
                        and meta.get("hashes") == expected and isinstance(meta.get("calibrationSnapshot"), dict)):
                    _validate_snapshot(meta["calibrationSnapshot"])
                    pair["capturedCalibrationSnapshot"] = meta["calibrationSnapshot"]
        except (ValueError, UnicodeError, OSError):
            pass
        ready.append(pair)
    return {"pairs": ready, "pending": pending}


def _publish(root, payload):
    root = Path(root)
    name = _name(payload.get("name"))
    if not isinstance(payload.get("calibrationSnapshot"), dict):
        raise ValueError("A captured calibration snapshot is required for publishing")
    _validate_snapshot(payload["calibrationSnapshot"])
    # Verify JSON serializability and reject NaN/Infinity, without modifying it.
    snapshot = json.loads(json.dumps(payload["calibrationSnapshot"], allow_nan=False))
    data = {s: _encode(payload.get(s), width) for s, width in WIDTHS.items()}
    for port in PORTS.values():
        if not (root / port).is_dir():
            raise FileNotFoundError(f"Share folder unavailable: {port}")
    hashes = {s: _hash(raw) for s, raw in data.items()}
    # Never overwrite any existing file, including a case-only name match.
    for suffix in range(10000):
        stem = name if suffix == 0 else f"{name} ({suffix + 1})"
        matches = {}
        conflict = False
        for side, port in PORTS.items():
            files = [p for p in (root / port).iterdir() if p.name.casefold() == (stem + ".csv").casefold()]
            if len(files) > 1:
                conflict = True
            if files:
                p = files[0]
                if not _safe_file(root / port, p) or p.read_bytes() != data[side]:
                    conflict = True
                matches[side] = p
        sidecar = root / (stem + ".shosa-sync.json")
        meta = {"format": "shosa-sync-csv", "version": 1, "name": stem, "fps": 30,
                "hashes": hashes, "calibrationSnapshot": snapshot}
        metadata = (json.dumps(meta, ensure_ascii=False, allow_nan=False, indent=2) + "\n").encode("utf-8")
        if sidecar.exists() and (not _safe_file(root, sidecar) or sidecar.read_bytes() != metadata):
            conflict = True
        if conflict:
            continue
        if len(matches) == 2 and sidecar.exists():
            return {"name": stem, "status": "unchanged", "hashes": hashes,
                    "paths": {s: str(p) for s, p in matches.items()}}
        created = []
        try:
            for side, port in PORTS.items():
                if side in matches:
                    continue
                path = root / port / (stem + ".csv")
                # Exclusive creation handles a simultaneous external writer.
                with path.open("xb") as f:
                    created.append(path)
                    f.write(data[side])
                    f.flush()
                    os.fsync(f.fileno())
            if not sidecar.exists():
                with sidecar.open("xb") as f:
                    created.append(sidecar)
                    f.write(metadata)
                    f.flush()
                    os.fsync(f.fileno())
            for side, port in PORTS.items():
                path = matches.get(side, root / port / (stem + ".csv"))
                if path.read_bytes() != data[side]:
                    raise OSError("Published CSV verification failed")
            if sidecar.read_bytes() != metadata:
                raise OSError("Published calibration metadata verification failed")
            return {"name": stem, "status": "published", "hashes": hashes,
                    "paths": {s: str(matches.get(s, root / PORTS[s] / (stem + ".csv"))) for s in WIDTHS}}
        except BaseException:
            # Never clean up someone else's files or any pre-existing data.
            for p in reversed(created):
                try:
                    p.unlink()
                except OSError:
                    pass
            raise
    raise ValueError("No unused motion filename found")


def _worker(request):
    if request["operation"] == "scan":
        from managed_sync import sync_managed
        sync_managed(request["root"], Path(__file__).parent / ".motion-sync", _encode, _validate_snapshot)
        return _scan(request["root"])
    if request["operation"] == "publish":
        return _publish(request["root"], request["payload"])
    raise ValueError("Unknown sync operation")


class MotionSync:
    def __init__(self, cache_dir=None, worker_timeout=30, poll_interval=5):
        self.cache_dir = Path(cache_dir or Path(__file__).parent / ".motion-sync")
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self.worker_timeout = worker_timeout
        self.poll_interval = poll_interval
        self._lock = threading.RLock()
        self._event = threading.Event()
        self._stop = threading.Event()
        self._jobs = queue.Queue()
        self._observed = {}
        self._motions = {}
        self._config = {"root": DEFAULT_ROOT, "enabled": False, "mode": "pull"}
        self._status = {"online": False, "busy": False, "lastScan": None, "lastError": None,
                        "pending": [], "publishes": [], "lastPublish": None}
        self._epoch = 0
        self._proc = None
        self._orphan = None
        self._job_records = {}
        self._load_cache()
        self._thread = threading.Thread(target=self._loop, name="shosa-motion-sync", daemon=True)
        self._thread.start()
        if self._config["enabled"]:
            self._event.set()

    def _load_cache(self):
        # Loading local cache must never touch the network share.
        try:
            config = json.loads((self.cache_dir / "settings.json").read_text())
            if (isinstance(config.get("root"), str) and os.path.isabs(config["root"])
                    and "\x00" not in config["root"] and type(config.get("enabled")) is bool
                    and config.get("mode") in ("pull", "both")):
                self._config = {k: config[k] for k in ("root", "enabled", "mode")}
        except (OSError, ValueError, TypeError):
            pass
        try:
            for p in self.cache_dir.glob("sync-*.json"):
                entry = json.loads(p.read_text())
                if isinstance(entry, dict) and entry.get("id") == p.stem:
                    self._motions[p.stem] = entry
        except (OSError, ValueError):
            pass
        try:
            for p in (self.cache_dir / "outbox").glob("publish-*.json"):
                job = json.loads(p.read_text())
                if job.get("jobId") != p.stem or not isinstance(job.get("payload"), dict):
                    continue
                self._job_records[p.stem] = job
                # Restart never silently replays a queued or interrupted export.
                status = job.get("status", "error")
                if status not in ("published", "unchanged", "cancelled"):
                    status = "error"
                job["status"] = status
                self._status["publishes"].append({"jobId": p.stem, "name": job["payload"].get("name", ""),
                    "status": status, "error": job.get("error", "Retry required after restart") if status == "error" else None})
            self._status["publishes"] = self._status["publishes"][-30:]
        except (OSError, ValueError, TypeError):
            pass

    def _save_local(self, path, value):
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_suffix(path.suffix + ".tmp")
        temporary.write_text(json.dumps(value, ensure_ascii=False, allow_nan=False), encoding="utf-8")
        temporary.replace(path)

    def get_status(self):
        with self._lock:
            return json.loads(json.dumps({**self._config, **self._status,
                "synced": len(self._motions), "motions": len(self._motions), "queued": self._jobs.qsize()}))

    def configure(self, changes):
        if not isinstance(changes, dict):
            raise ValueError("Sync configuration must be an object")
        with self._lock:
            new = {**self._config, **{k: changes[k] for k in ("root", "enabled", "mode") if k in changes}}
            if not isinstance(new["root"], str) or not os.path.isabs(new["root"]) or "\x00" in new["root"]:
                raise ValueError("An absolute mounted-share folder is required")
            if type(new["enabled"]) is not bool or new["mode"] not in ("pull", "both"):
                raise ValueError("Invalid sync mode")
            if new != self._config:
                self._epoch += 1
                self._observed.clear()
            self._config = new
            self._save_local(self.cache_dir / "settings.json", new)
            self._status["lastError"] = None
            if not new["enabled"]:
                self._status["online"] = False
            self._event.set()
        return self.get_status()

    def scan_now(self):
        self._event.set()
        return self.get_status()

    def poll(self):
        return self.scan_now()

    def list_motions(self):
        with self._lock:
            return [{k: v for k, v in m.items() if k not in ("R", "L", "calibrationSnapshot")}
                    for m in sorted(self._motions.values(), key=lambda m: m["name"].casefold())]

    def read_motion(self, motion_id):
        with self._lock:
            if motion_id not in self._motions:
                raise KeyError("Synced motion not found")
            return json.loads(json.dumps(self._motions[motion_id]))

    def publish(self, payload):
        # Fast local validation before queuing any network operation.
        if not isinstance(payload, dict):
            raise ValueError("Motion must be an object")
        _name(payload.get("name"))
        for s, width in WIDTHS.items():
            _validate_rows(payload.get(s), width)
        if not isinstance(payload.get("calibrationSnapshot"), dict):
            raise ValueError("A captured calibration snapshot is required for publishing")
        _validate_snapshot(payload["calibrationSnapshot"])
        serialized = json.dumps(payload, ensure_ascii=False, allow_nan=False)
        if len(serialized) > 5 * MAX_BYTES:
            raise ValueError("Motion exceeds size limit")
        with self._lock:
            if not self._config["enabled"] or self._config["mode"] != "both":
                raise ValueError("Enable bidirectional sync before publishing")
            if self._jobs.qsize() >= 20:
                raise ValueError("Too many pending exports; wait before saving another")
            job_id = "publish-" + uuid.uuid4().hex
            job = {"jobId": job_id, "payload": json.loads(serialized), "root": self._config["root"], "epoch": self._epoch}
            self._job_records[job_id] = {**job, "status": "queued"}
            self._save_local(self.cache_dir / "outbox" / (job_id + ".json"), self._job_records[job_id])
            self._jobs.put(job)
            self._status["publishes"].append({"jobId": job_id, "name": payload["name"], "status": "queued"})
            self._status["publishes"] = self._status["publishes"][-30:]
            self._event.set()
        return {"jobId": job_id, "status": "queued"}

    def retry_publish(self, job_id):
        with self._lock:
            record = self._job_records.get(job_id)
            if not record:
                raise KeyError("Publish job not found")
            if (not self._config["enabled"] or self._config["mode"] != "both"
                    or self._config["root"] != record["root"]):
                raise ValueError("Re-enable bidirectional sync for the original share before retrying")
            if record.get("status") in ("queued", "writing", "published", "unchanged"):
                raise ValueError("This publish job does not need a retry")
            record.update(epoch=self._epoch, status="queued", error=None)
            self._save_local(self.cache_dir / "outbox" / (job_id + ".json"), record)
            self._jobs.put(dict(record))
            self._set_job(job_id, status="queued", error=None)
            self._event.set()
        return {"jobId": job_id, "status": "queued"}

    def _call_worker(self, request):
        if self._orphan is not None:
            if self._orphan.poll() is None:
                raise TimeoutError("Previous shared-folder request is still stopping; will retry")
            self._orphan.communicate(timeout=.1)
            self._orphan = None
        p = subprocess.Popen([sys.executable, str(Path(__file__).resolve()), "--worker"],
                             stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        with self._lock:
            self._proc = p
        try:
            out, err = p.communicate(json.dumps(request, allow_nan=False), timeout=self.worker_timeout)
            if p.returncode:
                raise OSError("Shared-folder worker failed")
            response = json.loads(out)
            if not response.get("ok"):
                raise OSError(response.get("error", "Shared-folder operation failed"))
            return response["result"]
        except subprocess.TimeoutExpired:
            p.kill()
            # Never block indefinitely waiting for a network filesystem syscall.
            try:
                p.communicate(timeout=0.5)
            except subprocess.TimeoutExpired:
                self._orphan = p
            raise TimeoutError("Shared folder timed out; will retry")
        finally:
            with self._lock:
                if self._proc is p:
                    self._proc = None

    def _ingest(self, result, root, epoch):
        with self._lock:
            if epoch != self._epoch or not self._config["enabled"]:
                return
            pending = list(result["pending"])
            observed = {}
            for pair in result["pairs"]:
                name = pair["name"]
                key = name.casefold()
                signature = json.dumps({s: {k: pair[s][k] for k in ("size", "mtimeNs", "sha256")} for s in WIDTHS}, sort_keys=True)
                observed[key] = signature
                if self._observed.get(key) != signature:
                    pending.append({"name": name, "reason": "Waiting for two stable scans"})
                    continue
                source = {s: {k: pair[s][k] for k in ("path", "size", "mtimeNs", "sha256")} for s in WIDTHS}
                snapshot = pair.get("capturedCalibrationSnapshot")
                if snapshot is not None:
                    _validate_snapshot(snapshot)
                content_revision = json.dumps({"hashes": {s: source[s]["sha256"] for s in WIDTHS},
                    "calibrationSnapshot": snapshot}, sort_keys=True, ensure_ascii=False, allow_nan=False)
                motion_id = "sync-" + _hash((root + "\n" + key + "\n" + content_revision).encode())[:24]
                old = self._motions.get(motion_id)
                if old and old.get("source") == source and old.get("calibrationSnapshot") == snapshot:
                    continue
                entry = {"format": "augmented-arms-motion", "version": 1, "fps": 30,
                         "id": motion_id, "name": name, "exportStem": name, "source": source,
                         "revision": _hash(content_revision.encode()),
                         "importedAt": time.time(), "calibrationRequired": snapshot is None}
                for side, width in WIDTHS.items():
                    raw = base64.b64decode(pair[side]["raw"], validate=True)
                    if _hash(raw) != source[side]["sha256"]:
                        raise ValueError("Shared CSV hash mismatch")
                    entry[side] = _parse(raw, width)
                    folder = self.cache_dir / motion_id
                    folder.mkdir(exist_ok=True)
                    (folder / (PORTS[side] + ".csv")).write_bytes(raw)
                if snapshot is not None:
                    entry["calibrationSnapshot"] = snapshot
                    entry["capturedCalibrationSnapshot"] = snapshot
                temp = self.cache_dir / (motion_id + ".tmp")
                temp.write_text(json.dumps(entry, ensure_ascii=False, allow_nan=False), encoding="utf-8")
                temp.replace(self.cache_dir / (motion_id + ".json"))
                self._motions[motion_id] = entry
            self._observed = observed
            self._status.update(online=True, lastError=None, lastScan=time.time(), pending=pending)

    def _set_job(self, job_id, **changes):
        with self._lock:
            if job_id in self._job_records:
                self._job_records[job_id].update(changes)
                self._save_local(self.cache_dir / "outbox" / (job_id + ".json"), self._job_records[job_id])
            for job in self._status["publishes"]:
                if job["jobId"] == job_id:
                    job.update(changes)
                    self._status["lastPublish"] = dict(job)
                    break

    def _loop(self):
        while not self._stop.is_set():
            self._event.wait(self.poll_interval)
            self._event.clear()
            if self._stop.is_set():
                break
            with self._lock:
                config, epoch = dict(self._config), self._epoch
                enabled = config["enabled"]
                self._status["busy"] = enabled
            if not enabled:
                continue
            try:
                try:
                    job = self._jobs.get_nowait()
                except queue.Empty:
                    job = None
                if job:
                    if job["epoch"] != epoch or config["mode"] != "both":
                        self._set_job(job["jobId"], status="cancelled", error="Sync settings changed")
                    else:
                        self._set_job(job["jobId"], status="writing")
                        try:
                            result = self._call_worker({"operation": "publish", "root": job["root"], "payload": job["payload"]})
                            self._set_job(job["jobId"], **result)
                        except (OSError, ValueError, TimeoutError) as exc:
                            self._set_job(job["jobId"], status="error", error=str(exc))
                            raise
                    if not self._jobs.empty():
                        self._event.set()
                result = self._call_worker({"operation": "scan", "root": config["root"]})
                self._ingest(result, config["root"], epoch)
            except (OSError, ValueError, TimeoutError) as exc:
                with self._lock:
                    if epoch == self._epoch:
                        self._observed.clear()
                        self._status.update(online=False, lastError=str(exc), lastScan=time.time())
            finally:
                with self._lock:
                    self._status["busy"] = False

    def close(self):
        self._stop.set()
        self._event.set()
        with self._lock:
            if self._proc:
                self._proc.kill()
            if self._orphan and self._orphan.poll() is None:
                self._orphan.kill()
        self._thread.join(timeout=1)


if __name__ == "__main__" and "--worker" in sys.argv:
    try:
        result = _worker(json.load(sys.stdin))
        print(json.dumps({"ok": True, "result": result}, ensure_ascii=False, allow_nan=False))
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
