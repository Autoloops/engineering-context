import json
import os
import re
import shlex
import shutil
import subprocess
import tarfile
import urllib.request
from pathlib import Path


ALLOWED_GIT_SUBCOMMANDS = {
    "branch",
    "status",
    "diff",
    "remote",
    "rev-parse",
    "ls-files",
    "grep",
}

BLOCKED_GIT_SUBCOMMANDS = {
    "clone",
    "fetch",
    "pull",
    "log",
    "show",
    "reflog",
    "blame",
    "bisect",
}

BLOCKED_EXECUTABLES = {
    "curl",
    "wget",
    "gh",
}

FORBIDDEN_COMMAND_MARKERS = [
    "git fetch",
    "git pull",
    "git log",
    "git show",
    "git reflog",
    "git blame",
    "git bisect",
    "git clone",
    "curl ",
    "wget ",
]

FORBIDDEN_NETWORK_MARKERS = [
    "urllib.request",
    "urlopen(",
    "urlretrieve(",
    "requests.get(",
    "requests.post(",
    "http.client.httpconnection",
    "http.client.httpsconnection",
    "fetch(",
]

FORBIDDEN_HOST_REPO_MARKERS = [
    "../repo",
]


def materialize_base_snapshot(target_dir: Path, repo: str, base_commit: str, timeout_seconds: int = 300) -> Path:
    """Download the exact base_commit source tree, then create one local commit."""
    target_dir = target_dir.resolve()
    repo_dir = target_dir / "repo"
    if repo_dir.exists():
        ensure_synthetic_remote(repo_dir, repo)
        return repo_dir

    target_dir.mkdir(parents=True, exist_ok=True)
    archive_path = target_dir / "base-source.tar.gz"
    extract_dir = target_dir / "base-source"
    archive_url = f"https://codeload.github.com/{repo}/tar.gz/{base_commit}"
    download(archive_url, archive_path, timeout_seconds=timeout_seconds)
    if extract_dir.exists():
        shutil.rmtree(extract_dir)
    extract_dir.mkdir(parents=True, exist_ok=True)
    with tarfile.open(archive_path, "r:gz") as archive:
        archive.extractall(extract_dir, filter="data")
    roots = [path for path in extract_dir.iterdir() if path.is_dir()]
    if len(roots) != 1:
        raise RuntimeError(f"Expected one archive root in {extract_dir}, found {len(roots)}")
    roots[0].rename(repo_dir)

    run(["git", "init", "-q"], repo_dir, timeout_seconds=60)
    ensure_synthetic_remote(repo_dir, repo)
    run(["git", "add", "-A"], repo_dir, timeout_seconds=120)
    run(
        [
            "git",
            "-c",
            "user.email=swe-context-eval@example.invalid",
            "-c",
            "user.name=SWE Context Eval",
            "commit",
            "-q",
            "--no-gpg-sign",
            "-m",
            f"base snapshot {base_commit}",
        ],
        repo_dir,
        timeout_seconds=120,
    )
    write_json(
        target_dir / "snapshot-safety.json",
        {
            "repo": repo,
            "base_commit": base_commit,
            "history": "commit-archive-no-git-history",
            "synthetic_git_repo": True,
            "synthetic_remote_url": synthetic_remote_url(repo),
            "allowed_git_commands": sorted(ALLOWED_GIT_SUBCOMMANDS),
            "blocked_git_commands": sorted(BLOCKED_GIT_SUBCOMMANDS),
            "blocked_executables": sorted(BLOCKED_EXECUTABLES),
        },
    )
    return repo_dir


def synthetic_remote_url(repo: str) -> str:
    return f"greplica-eval://swe-context/{repo}"


def ensure_synthetic_remote(repo_dir: Path, repo: str) -> None:
    """Give copied snapshots the same Greplica repo identity without real history."""
    remote_url = synthetic_remote_url(repo)
    result = subprocess.run(["git", "remote", "get-url", "origin"], cwd=repo_dir, text=True, capture_output=True, timeout=30)
    if result.returncode == 0:
        run(["git", "remote", "set-url", "origin", remote_url], repo_dir, timeout_seconds=30)
    else:
        run(["git", "remote", "add", "origin", remote_url], repo_dir, timeout_seconds=30)


def codex_leak_flags() -> list[str]:
    return ["--config", 'web_search="disabled"', "--ignore-user-config"]


def benchmark_isolation_prompt(allow_greplica: bool = False) -> str:
    greplica_line = (
        "You may use the provided local Greplica command only for navigation."
        if allow_greplica
        else "Do not use Greplica commands or Greplica memory."
    )
    return f"""Benchmark isolation rules:
- Solve only from the materialized repository snapshot, the problem statement, and local test execution.
- {greplica_line}
- Do not use web search, browsers, remote URLs, GitHub raw/API/codeload pages, package registries, release notes, changelogs, StackOverflow, or any other internet source.
- Do not use network access through shell tools or language runtimes, including curl, wget, gh, Python urllib/requests/http.client, Node fetch/http/https, or similar APIs.
- Do not inspect git history or future repository state. Avoid git log, git show, git blame, git reflog, git fetch, git pull, bisect, remotes, tags, or branches beyond the current synthetic base snapshot.
- If blocked by missing dependencies or tests, reason from the local files and report the limitation. Do not work around it by looking up upstream fixes.
"""


def guarded_env(target_dir: Path, base_env: dict | None = None) -> dict:
    env = dict(base_env or os.environ)
    guard_dir = install_command_guards(target_dir)
    env["PATH"] = f"{guard_dir}{os.pathsep}{env.get('PATH', '')}"
    return env


def install_command_guards(target_dir: Path) -> Path:
    guard_dir = target_dir / "tool-guards"
    guard_dir.mkdir(parents=True, exist_ok=True)
    real_git = shutil.which("git")
    if not real_git:
        raise RuntimeError("git not found on PATH")

    blocked_cases = "\n".join(f"  {name}) block git \"$@\" ;;" for name in sorted(BLOCKED_GIT_SUBCOMMANDS))
    write_executable(
        guard_dir / "git",
        f"""#!/bin/sh
block() {{
  echo "benchmark tool guard: $* is disabled" >&2
  exit 126
}}

case "$1" in
{blocked_cases}
esac

exec {shlex.quote(real_git)} "$@"
""",
    )
    for executable in sorted(BLOCKED_EXECUTABLES):
        write_executable(
            guard_dir / executable,
            f"""#!/bin/sh
echo "benchmark tool guard: {executable} is disabled" >&2
exit 126
""",
        )
    return guard_dir


def audit_transcript(transcript_path: Path, tool_guard_active: bool = False) -> dict:
    violations = []
    blocked = []
    if not transcript_path.exists():
        return {"tainted": False, "violations": violations, "blocked": blocked}

    for line_no, line in enumerate(transcript_path.read_text(errors="replace").splitlines(), 1):
        try:
            event = json.loads(line)
        except Exception:
            event = {"raw": line}
        text = json.dumps(event, ensure_ascii=False).lower()

        compact_text = compact(text)
        if (
            '"type":"web_search"' in compact_text
            or '"name":"web_search"' in compact_text
            or '"tool":"web_search"' in compact_text
        ):
            violations.append(violation(line_no, "web_search", excerpt(text)))

        if '"type":"mcp_tool_call"' in compact_text:
            violations.append(violation(line_no, "mcp_tool_call", excerpt(text)))

        command = extract_command(event)
        if command:
            if command_in_progress(event):
                continue
            command_violation = audit_command(command)
            if command_violation:
                target = blocked if command_blocked(event, command, command_violation, tool_guard_active) else violations
                target.append(violation(line_no, command_violation, command))
            continue

        if '"type":"browser"' in compact_text or '"type":"open_url"' in compact_text:
            violations.append(violation(line_no, "browser_or_open_url", excerpt(text)))

    return {"tainted": bool(violations), "violations": violations[:50], "blocked": blocked[:50]}


def audit_command(command: str) -> str | None:
    normalized = " ".join(command.lower().split())
    if normalized.startswith("git "):
        parts = normalized.split()
        subcommand = parts[1] if len(parts) > 1 else ""
        if subcommand in BLOCKED_GIT_SUBCOMMANDS:
            return f"forbidden_git:{subcommand or 'unknown'}"
    executable = normalized.split()[0] if normalized else ""
    if executable in BLOCKED_EXECUTABLES:
        return f"forbidden_command:{executable}"
    for marker in FORBIDDEN_COMMAND_MARKERS:
        if marker in normalized:
            return f"forbidden_command:{marker.strip()}"
    if ("http://" in normalized or "https://" in normalized) and any(
        marker in normalized for marker in FORBIDDEN_NETWORK_MARKERS
    ):
        return "forbidden_network_access"
    for marker in FORBIDDEN_HOST_REPO_MARKERS:
        if marker in normalized:
            return "forbidden_host_repo_access"
    if "/users/" in normalized and re.search(r"/repo(?:/|\\s|['\"`)]|$)", normalized):
        return "forbidden_host_repo_access"
    return None


def guarded_command(command: str) -> bool:
    normalized = " ".join(command.lower().split())
    if re.search(r"(^|[;&|('\"` ])git +(clone|fetch|pull|log|show|reflog|blame|bisect)\b", normalized):
        return True
    if re.search(r"(^|[;&|('\"` ])(curl|wget|gh)\b", normalized):
        return True
    return False


def command_blocked(event, command: str, violation_kind: str, tool_guard_active: bool) -> bool:
    if guard_blocked(event) or (tool_guard_active and guarded_command(command)):
        return True
    if violation_kind == "forbidden_host_repo_access":
        text = json.dumps(event, ensure_ascii=False).lower()
        return "no such file or directory" in text or "can't read" in text
    return False


def extract_command(event) -> str | None:
    if not isinstance(event, dict):
        return None
    item = event.get("item")
    if isinstance(item, dict) and isinstance(item.get("command"), str):
        return item["command"]
    payload = event.get("payload")
    if isinstance(payload, dict):
        item = payload.get("item")
        if isinstance(item, dict) and isinstance(item.get("command"), str):
            return item["command"]
    return None


def guard_blocked(event) -> bool:
    return "benchmark tool guard:" in json.dumps(event, ensure_ascii=False).lower()


def command_in_progress(event) -> bool:
    if not isinstance(event, dict):
        return False
    if event.get("type") == "item.started":
        return True
    item = event.get("item")
    if isinstance(item, dict) and item.get("status") == "in_progress":
        return True
    payload = event.get("payload")
    if isinstance(payload, dict):
        item = payload.get("item")
        if isinstance(item, dict) and item.get("status") == "in_progress":
            return True
    return False


def violation(line_no: int, kind: str, evidence: str) -> dict:
    return {"line": line_no, "kind": kind, "evidence": evidence[:1000]}


def excerpt(text: str) -> str:
    return text[:1000]


def compact(text: str) -> str:
    return "".join(text.split())


def run(command: list[str], cwd: Path, timeout_seconds: int) -> None:
    result = subprocess.run(command, cwd=cwd, timeout=timeout_seconds)
    if result.returncode != 0:
        raise RuntimeError(f"Command failed: {' '.join(command)}")


def download(url: str, path: Path, timeout_seconds: int) -> None:
    with urllib.request.urlopen(url, timeout=timeout_seconds) as response, path.open("wb") as handle:
        shutil.copyfileobj(response, handle)


def write_json(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, default=str) + "\n")


def write_executable(path: Path, text: str) -> None:
    path.write_text(text)
    path.chmod(0o755)
