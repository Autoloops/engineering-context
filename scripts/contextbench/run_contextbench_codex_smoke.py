#!/usr/bin/env python3
import argparse
import hashlib
import json
import os
import posixpath
import re
import shutil
import shlex
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MEMORY_WORKBENCH = Path(os.environ.get("CONTEXTBENCH_MEMORY_WORKBENCH", ROOT / "memory-workbench")).expanduser().resolve()
PYDEPS = Path(os.environ.get("CONTEXTBENCH_PYDEPS", MEMORY_WORKBENCH / "pydeps")).expanduser().resolve()
if PYDEPS.is_dir():
    sys.path.insert(0, str(PYDEPS))

import pandas as pd

from swe_eval_safety import audit_transcript, codex_leak_flags, guarded_env, materialize_base_snapshot


CONTEXTBENCH_ROOT = Path(os.environ.get("CONTEXTBENCH_ROOT", MEMORY_WORKBENCH / "contextbench-inspect")).expanduser().resolve()
GOLD_PARQUET = Path(os.environ.get("CONTEXTBENCH_GOLD_PARQUET", CONTEXTBENCH_ROOT / "data" / "full.parquet")).expanduser().resolve()
AGENT_CONTROL_ROOT = Path(
    os.environ.get("CONTEXTBENCH_AGENT_CONTROL_ROOT", MEMORY_WORKBENCH / "runs" / "contextbench-agent-controls")
).expanduser().resolve()
PUBLIC_DOCKER_CONFIG = Path(os.environ.get("CONTEXTBENCH_DOCKER_CONFIG", MEMORY_WORKBENCH / "docker-config-public")).expanduser().resolve()
GREPLICA_BUNDLE_ROOT = Path(os.environ.get("GREPLICA_BUNDLE_ROOT", MEMORY_WORKBENCH / "bundles" / "greplica-linux-bundle")).expanduser().resolve()
GREPLICA_CONTAINER_HOME = "/tmp/contextbench-greplica-home"
GREPLICA_CONTAINER_BUNDLE = "/tmp/contextbench-greplica-linux-amd64.tar.gz"
GREPLICA_CONTAINER_HOME_ARCHIVE = "/tmp/contextbench-greplica-home.tar.gz"
GREPLICA_CONTAINER_INSTALL_ROOT = "/opt"
GREPLICA_CONTAINER_INSTALL_DIR = "/opt/greplica"
CODEX_BUNDLE_ROOT = Path(os.environ.get("CODEX_BUNDLE_ROOT", MEMORY_WORKBENCH / "bundles" / "codex-linux-bundle")).expanduser().resolve()
CODEX_CONTAINER_BUNDLE = "/tmp/contextbench-codex-linux-x64.tgz"
CODEX_CONTAINER_INSTALL_DIR = "/opt/codex"
CODEX_CONTAINER_RUNTIME = "/root/contextbench-codex-runtime"
CODEX_CONTAINER_FINAL_MESSAGE = f"{CODEX_CONTAINER_RUNTIME}/final-message.txt"
CONTAINER_TOOL_GUARD_DIR = "/usr/local/bin"
DEFAULT_CONTAINER_PATH = (
    "/root/.cargo/bin:/usr/local/rustup/toolchains/1.85.0-x86_64-unknown-linux-gnu/bin:"
    "/usr/local/go/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--task", default="cli__cli-362")
    parser.add_argument("--model", default="gpt-5.4")
    parser.add_argument("--timeout", type=int, default=900)
    parser.add_argument("--run-root", default=str(MEMORY_WORKBENCH / "runs" / "contextbench-codex-smoke-runs"))
    parser.add_argument("--reuse-run", help="Refresh scoring/audit for an existing run directory without rerunning Codex")
    parser.add_argument("--execution-env", choices=["docker", "host"], default="docker")
    parser.add_argument("--docker-platform", default="linux/amd64")
    parser.add_argument("--docker-image", help="Override benchmark Docker image")
    parser.add_argument("--docker-cwd", help="Override benchmark container working directory")
    parser.add_argument("--docker-start-timeout", type=int, default=1800)
    parser.add_argument("--codex-sandbox", choices=["read-only", "workspace-write", "danger-full-access"], default="danger-full-access")
    parser.add_argument("--keep-container", action="store_true")
    parser.add_argument("--skip-task-pass-eval", action="store_true", help="Skip benchmark Docker test execution pass/fail scoring")
    parser.add_argument("--task-pass-timeout", type=int, default=900, help="Timeout in seconds for benchmark task pass/fail scoring")
    parser.add_argument("--allow-greplica", action="store_true", help="Allow a local Greplica graph inside the benchmark Docker container")
    parser.add_argument("--greplica-home", help="Existing host GREPLICA_HOME to copy into the benchmark container")
    parser.add_argument("--greplica-proposal", help="Proposal JSON used to seed a new sample Greplica home")
    parser.add_argument("--greplica-bundle", help="Prebuilt linux/amd64 Greplica CLI bundle tarball")
    parser.add_argument("--rebuild-greplica-bundle", action="store_true")
    args = parser.parse_args()

    if args.allow_greplica and args.execution_env != "docker":
        raise SystemExit("--allow-greplica currently requires --execution-env docker so Greplica runs inside the task container")

    row = load_task(args.task)
    if args.reuse_run:
        run_dir = Path(args.reuse_run).resolve()
        if not run_dir.is_dir():
            raise SystemExit(f"Run directory does not exist: {run_dir}")
        result = read_json(run_dir / "result.json") if (run_dir / "result.json").exists() else {}
        result["refresh_started_at"] = time.time()
    else:
        run_dir = Path(args.run_root).resolve() / f"{timestamp()}-{safe_name(row['original_inst_id'])}"
        run_dir.mkdir(parents=True, exist_ok=True)
        result = {"started_at": time.time()}

    result.update(
        {
            "task": row["original_inst_id"],
            "instance_id": row["instance_id"],
            "repo": row["repo"],
            "base_commit": row["base_commit"],
            "model": args.model,
            "run_dir": str(run_dir),
            "greplica_allowed": args.allow_greplica,
        }
    )

    greplica_session = result.get("greplica") if args.reuse_run else None

    try:
        docker_session = None
        if args.reuse_run:
            repo_dir = Path(result.get("repo_dir") or run_dir / "repo")
            transcript_path = Path(result.get("transcript_path") or run_dir / "agent-events.jsonl")
            final_path = Path(result.get("final_message_path") or run_dir / "final-message.txt")
            patch_path = Path(result.get("patch_path") or run_dir / "model.patch")
            agent_cwd = final_path.parent
            if not repo_dir.is_dir() or not transcript_path.exists() or not patch_path.exists():
                raise SystemExit(f"Existing run is missing repo/transcript/patch files: {run_dir}")
            generation = {**result.get("generation", {}), **collect_metrics(transcript_path)}
            patch = patch_path.read_text(errors="replace")
        else:
            repo_dir = materialize_base_snapshot(run_dir, row["repo"], row["base_commit"])
            if args.allow_greplica:
                ensure_greplica_eval_repo_identity(repo_dir, row)
                greplica_session = prepare_greplica_host_memory(
                    repo_dir=repo_dir,
                    run_dir=run_dir,
                    row=row,
                    host_home_override=args.greplica_home,
                    proposal_override=args.greplica_proposal,
                )
            if args.execution_env == "docker":
                docker_session = start_benchmark_container(
                    row=row,
                    repo_dir=repo_dir,
                    run_dir=run_dir,
                    image_override=args.docker_image,
                    cwd_override=args.docker_cwd,
                    platform=args.docker_platform,
                    start_timeout=args.docker_start_timeout,
                    extra_env=greplica_container_env() if args.allow_greplica else None,
                )
                docker_session["extra_tools"] = install_container_extra_tools(docker_session)
                if args.allow_greplica:
                    bundle_path = (
                        Path(args.greplica_bundle).resolve()
                        if args.greplica_bundle
                        else ensure_greplica_linux_bundle(rebuild=args.rebuild_greplica_bundle)
                    )
                    greplica_session["container"] = install_greplica_in_container(
                        session=docker_session,
                        host_home=Path(greplica_session["host_home"]),
                        bundle_path=bundle_path,
                        run_dir=run_dir,
                    )
                    write_json(run_dir / "greplica-session.json", greplica_session)
                codex_session = install_codex_in_container(
                    session=docker_session,
                    bundle_path=ensure_codex_linux_bundle(),
                    run_dir=run_dir,
                )
                docker_session["codex"] = codex_session
                docker_session["tool_guards"] = install_container_tool_guards(docker_session)
                write_json(run_dir / "docker-session.json", docker_session)
            transcript_path = run_dir / "agent-events.jsonl"
            agent_cwd = Path(docker_session["agent_cwd"]) if docker_session else repo_dir
            final_path = agent_cwd / "final-message.txt"
            generation = run_codex(
                cwd=agent_cwd,
                prompt=build_prompt(row, docker_session, greplica_session),
                model=args.model,
                transcript_path=transcript_path,
                final_path=final_path,
                timeout_seconds=args.timeout,
                docker_session=docker_session,
                sandbox=args.codex_sandbox,
            )
            patch = git(repo_dir, ["diff", "--binary"])
            patch_path = run_dir / "model.patch"
            patch_path.write_text(patch)

        trajectory = transcript_to_contextbench_trajectory(transcript_path, repo_dir, row, patch)
        pred_path = run_dir / "codex-contextbench-pred.jsonl"
        pred_path.write_text(json.dumps(trajectory, ensure_ascii=False) + "\n")

        cb_out_path = run_dir / "contextbench-results.jsonl"
        cb_eval = run_contextbench_evaluate(pred_path, cb_out_path, run_dir / "contextbench-repo-cache")
        cb_rows = read_jsonl(cb_out_path)
        task_pass = (
            {"skipped": True, "reason": "--skip-task-pass-eval"}
            if args.skip_task_pass_eval
            else run_task_pass_evaluate(
                row=row,
                patch=patch,
                run_dir=run_dir,
                image_override=args.docker_image,
                platform=args.docker_platform,
                timeout_seconds=args.task_pass_timeout,
            )
        )
        leak_audit = audit_transcript(transcript_path, tool_guard_active=True)
        boundary_audit = audit_task_boundary(
            transcript_path=transcript_path,
            agent_cwd=agent_cwd,
            repo_dir=repo_dir,
            docker_session=docker_session or result.get("environment"),
        )

        result.update(
            {
                "repo_dir": str(repo_dir),
                "transcript_path": str(transcript_path),
                "final_message_path": str(final_path),
                "patch_path": str(patch_path),
                "patch_chars": len(patch),
                "prediction_path": str(pred_path),
                "contextbench_result_path": str(cb_out_path),
                "generation": generation,
                "environment": docker_session or result.get("environment") or {"execution_env": "host"},
                "trajectory_summary": summarize_trajectory(trajectory),
                "trajectory_policy": trajectory.get("adapter_metadata", {}),
                "gold_hit_diagnostics": gold_hit_diagnostics(trajectory, row),
                "contextbench_evaluate": cb_eval,
                "contextbench_rows": cb_rows,
                "task_pass": task_pass,
                "leak_audit": leak_audit,
                "boundary_audit": boundary_audit,
                "valid_for_eval": (
                    generation.get("exit_code") == 0
                    and not generation.get("timed_out")
                    and not leak_audit.get("tainted")
                    and not boundary_audit.get("violations")
                ),
                "greplica": greplica_session,
            }
        )
    finally:
        if "docker_session" in locals() and docker_session and not args.keep_container:
            cleanup_benchmark_container(docker_session)
        if args.reuse_run:
            result["last_refreshed_at"] = time.time()
        else:
            result["finished_at"] = time.time()
            result["elapsed_seconds"] = round(result["finished_at"] - result["started_at"], 3)
        write_json(run_dir / "result.json", result)
        print(json.dumps(result, indent=2, default=str))

    return 0


def ensure_greplica_eval_repo_identity(repo_dir: Path, row: dict) -> None:
    remote = row.get("memory_remote_url") or f"greplica-eval://swe-context/{row['repo']}"
    if not (repo_dir / ".git").exists():
        run_capture(["git", "init"], cwd=repo_dir, env=os.environ.copy(), timeout_seconds=120)
    record = run_capture(["git", "config", "remote.origin.url", str(remote)], cwd=repo_dir, env=os.environ.copy(), timeout_seconds=120)
    if record["exit_code"] != 0:
        raise RuntimeError(f"Failed to set Greplica benchmark repo identity:\n{record['stderr_tail'] or record['stdout_tail']}")


def load_task(task_id: str) -> dict:
    df = pd.read_parquet(GOLD_PARQUET)
    matches = df[(df["original_inst_id"] == task_id) | (df["instance_id"] == task_id)]
    if len(matches) != 1:
        raise SystemExit(f"Expected exactly one task for {task_id}, found {len(matches)}")
    return matches.iloc[0].to_dict()


def prepare_greplica_host_memory(
    repo_dir: Path,
    run_dir: Path,
    row: dict,
    host_home_override: str | None,
    proposal_override: str | None,
) -> dict:
    host_home = run_dir / "greplica-home-host"
    if host_home.exists():
        shutil.rmtree(host_home)

    setup_commands: list[dict] = []
    source_home = None
    if host_home_override:
        source_home = Path(host_home_override).expanduser().resolve()
        if not source_home.is_dir():
            raise RuntimeError(f"Greplica home does not exist: {source_home}")
        shutil.copytree(source_home, host_home)
        mode = "provided"
        proposal_path = None
    else:
        host_home.mkdir(parents=True, exist_ok=True)
        mode = "sample"
        proposal_path = Path(proposal_override).expanduser().resolve() if proposal_override else run_dir / "sample-greplica.proposal.json"
        if proposal_override:
            if not proposal_path.is_file():
                raise RuntimeError(f"Greplica proposal does not exist: {proposal_path}")
        else:
            write_json(proposal_path, sample_greplica_proposal(row))

    model_cache = ensure_greplica_model_cache(host_home)
    env = greplica_host_env(host_home)

    setup_plan = []
    if proposal_path:
        setup_plan.append((["greplica", "install", "--platform", "codex", "--embedding", "local"], 300))
        setup_plan.append((["greplica", "proposal", "validate", str(proposal_path)], 120))
        setup_plan.append((["greplica", "proposal", "apply", str(proposal_path)], 300))
    else:
        setup_plan.append((["greplica", "graph", "read"], 120))
    setup_plan.append((["greplica", "graph", "context", graph_probe_query(row)], 300))

    for command, timeout_seconds in setup_plan:
        record = run_capture(command, cwd=repo_dir, env=env, timeout_seconds=timeout_seconds)
        setup_commands.append(record)
        if record["exit_code"] != 0:
            write_json(run_dir / "greplica-session.json", {
                "mode": mode,
                "host_home": str(host_home),
                "source_home": str(source_home) if source_home else None,
                "proposal_path": str(proposal_path) if proposal_path else None,
                "model_cache": model_cache,
                "setup_commands": setup_commands,
            })
            raise RuntimeError(f"Greplica host setup failed: {' '.join(command)}\n{record['stderr_tail'] or record['stdout_tail']}")

    session = {
        "mode": mode,
        "host_home": str(host_home),
        "source_home": str(source_home) if source_home else None,
        "proposal_path": str(proposal_path) if proposal_path else None,
        "model_cache": model_cache,
        "container_home": GREPLICA_CONTAINER_HOME,
        "setup_commands": setup_commands,
    }
    write_json(run_dir / "greplica-session.json", session)
    return session


def graph_probe_query(row: dict) -> str:
    repo = str(row.get("repo") or "")
    if repo == "fmtlib/fmt":
        return "formatting API formatter chrono width alignment fill"
    if repo == "cli/cli":
        return "pull request command navigation"
    return "current repo architecture important source locations"


def ensure_greplica_model_cache(host_home: Path) -> dict:
    target = host_home / "models"
    if target.exists():
        return {"path": str(target), "copied": False, "reason": "already_present", "bytes": directory_size(target)}

    source = Path.home() / ".greplica" / "models"
    if source.is_dir():
        shutil.copytree(source, target)
        return {"path": str(target), "copied": True, "source": str(source), "bytes": directory_size(target)}

    return {
        "path": str(target),
        "copied": False,
        "reason": f"default model cache not found at {source}",
        "bytes": 0,
    }


def greplica_host_env(host_home: Path) -> dict:
    env = os.environ.copy()
    env["GREPLICA_HOME"] = str(host_home)
    env["HF_HUB_OFFLINE"] = "1"
    env["TRANSFORMERS_OFFLINE"] = "1"
    return env


def greplica_container_env() -> dict[str, str]:
    return {
        "GREPLICA_HOME": GREPLICA_CONTAINER_HOME,
        "HF_HUB_OFFLINE": "1",
        "TRANSFORMERS_OFFLINE": "1",
    }


def sample_greplica_proposal(row: dict) -> dict:
    source_id = f"source.contextbench_greplica_smoke.{safe_name(row['original_inst_id']).lower()}"
    proposal = {
        "title": f"Sample ContextBench Greplica memory for {row['repo']}",
        "summary": (
            "Small broad navigation seed used only to verify the Greplica-enabled ContextBench runner. "
            "It is not a task-specific solution memory."
        ),
        "creates": {
            "components": [
                {
                    "id": "component.cli_pr_commands",
                    "name": "CLI pull request command surface",
                    "code_anchor": "command, pkg/cmd/pr",
                },
                {
                    "id": "component.cli_api_queries",
                    "name": "GitHub API and GraphQL helpers",
                    "code_anchor": "api, github, pkg/cmd/api",
                },
                {
                    "id": "component.cli_output_rendering",
                    "name": "Terminal output and formatting helpers",
                    "code_anchor": "utils, pkg/iostreams, command",
                },
            ],
            "flows": [
                {
                    "id": "flow.cli_pr_command_to_api",
                    "name": "PR command code resolves repository state, calls API helpers, and renders terminal output",
                }
            ],
            "claims": [
                {
                    "id": "claim.cli_pr_navigation",
                    "kind": "fact",
                    "text": (
                        "When investigating pull request behavior in cli/cli, inspect both the PR command surface "
                        "and the API/query helper layer because command behavior is commonly split across those boundaries."
                    ),
                    "truth": "unknown",
                    "intent": "intended",
                },
                {
                    "id": "claim.cli_output_navigation",
                    "kind": "fact",
                    "text": (
                        "User-facing CLI output usually combines command-specific rendering with shared terminal or "
                        "table formatting helpers, so output bugs often need both local command code and shared output utilities."
                    ),
                    "truth": "unknown",
                    "intent": "intended",
                },
            ],
            "sources": [
                {
                    "id": source_id,
                    "kind": "session",
                    "ref": f"contextbench-greplica-smoke:{row['original_inst_id']}",
                    "title": "ContextBench Greplica smoke-run sample seed",
                }
            ],
            "edges": [],
        },
    }
    edges = proposal["creates"]["edges"]
    for component_id in ["component.cli_pr_commands", "component.cli_api_queries", "component.cli_output_rendering"]:
        edges.append(edge("touches", "flow", "flow.cli_pr_command_to_api", "component", component_id))
    for target_type, target_id in [
        ("component", "component.cli_pr_commands"),
        ("component", "component.cli_api_queries"),
        ("flow", "flow.cli_pr_command_to_api"),
    ]:
        edges.append(edge("about", "claim", "claim.cli_pr_navigation", target_type, target_id))
    for target_type, target_id in [
        ("component", "component.cli_output_rendering"),
        ("flow", "flow.cli_pr_command_to_api"),
    ]:
        edges.append(edge("about", "claim", "claim.cli_output_navigation", target_type, target_id))
    for claim_id in ["claim.cli_pr_navigation", "claim.cli_output_navigation"]:
        edges.append(
            edge(
                "evidenced_by",
                "claim",
                claim_id,
                "source",
                source_id,
                {"reason": "Sample runner seed documents the broad navigation hint exposed to the Greplica arm."},
            )
        )
    return proposal


def edge(kind: str, from_type: str, from_id: str, to_type: str, to_id: str, metadata: dict | None = None) -> dict:
    value = {
        "id": edge_id(kind, from_type, from_id, to_type, to_id),
        "from_id": from_id,
        "from_type": from_type,
        "to_id": to_id,
        "to_type": to_type,
        "kind": kind,
    }
    if metadata is not None:
        value["metadata"] = metadata
    return value


def edge_id(kind: str, from_type: str, from_id: str, to_type: str, to_id: str) -> str:
    return f"edge_{slug(kind)}_{slug(from_type)}_{slug(from_id)}_{slug(to_type)}_{slug(to_id)}"


def slug(value: str) -> str:
    return re.sub(r"[^a-zA-Z0-9]+", "_", value).strip("_").lower()


def ensure_greplica_linux_bundle(rebuild: bool = False) -> Path:
    GREPLICA_BUNDLE_ROOT.mkdir(parents=True, exist_ok=True)
    bundle_path = GREPLICA_BUNDLE_ROOT / "greplica-linux-amd64.tar.gz"
    manifest_path = GREPLICA_BUNDLE_ROOT / "manifest.json"
    if bundle_path.exists() and not rebuild:
        return bundle_path

    build_script = r"""
set -eu
rm -rf /tmp/greplica-build /out/stage
mkdir -p /tmp/greplica-build/scripts /out/stage/greplica/bin /out/stage/greplica/app
cp --no-preserve=xattr /src/package.json /src/package-lock.json /src/tsconfig.json /src/tsconfig.build.json /tmp/greplica-build/
cp --no-preserve=xattr /src/scripts/check-node-version.js /tmp/greplica-build/scripts/check-node-version.js
cp --no-preserve=xattr /src/README.md /tmp/greplica-build/README.md
cp -a --no-preserve=xattr /src/apps /src/libs /src/skills /tmp/greplica-build/
cd /tmp/greplica-build
npm ci --no-audit --no-fund
npm run build
npm prune --omit=dev --no-audit --no-fund
cp /usr/local/bin/node /out/stage/greplica/bin/node
cp -a dist node_modules package.json README.md skills /out/stage/greplica/app/
cat > /out/stage/greplica/bin/greplica <<'EOF'
#!/bin/sh
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec "$SCRIPT_DIR/node" "$SCRIPT_DIR/../app/dist/apps/cli/main.js" "$@"
EOF
chmod +x /out/stage/greplica/bin/greplica
tar -C /out/stage -czf /out/greplica-linux-amd64.tar.gz greplica
"""
    command = [
        "docker",
        "run",
        "--rm",
        "--platform",
        "linux/amd64",
        "-v",
        f"{ROOT}:/src:ro",
        "-v",
        f"{GREPLICA_BUNDLE_ROOT}:/out",
        "node:22-bookworm",
        "/bin/sh",
        "-lc",
        build_script,
    ]
    record = run_capture(command, cwd=ROOT, env=docker_subprocess_env(), timeout_seconds=1800)
    manifest = {
        "bundle_path": str(bundle_path),
        "source_fingerprint": greplica_source_fingerprint(),
        "build": record,
    }
    write_json(manifest_path, manifest)
    if record["exit_code"] != 0 or not bundle_path.exists():
        raise RuntimeError(f"Failed to build Greplica linux bundle:\n{record['stderr_tail'] or record['stdout_tail']}")
    return bundle_path


def greplica_source_fingerprint() -> str:
    digest = hashlib.sha256()
    for rel in ["package.json", "package-lock.json", "tsconfig.json", "tsconfig.build.json"]:
        path = ROOT / rel
        digest.update(rel.encode())
        digest.update(path.read_bytes())
    return digest.hexdigest()


def install_greplica_in_container(session: dict, host_home: Path, bundle_path: Path, run_dir: Path) -> dict:
    if not bundle_path.is_file():
        raise RuntimeError(f"Greplica bundle does not exist: {bundle_path}")

    commands: list[dict] = []
    home_archive = run_dir / "greplica-home-container.tar.gz"
    archive_env = os.environ.copy()
    archive_env["COPYFILE_DISABLE"] = "1"
    archive_record = run_capture(
        ["tar", "-C", str(host_home), "-czf", str(home_archive), "."],
        cwd=ROOT,
        env=archive_env,
        timeout_seconds=300,
    )
    commands.append(archive_record)
    if archive_record["exit_code"] != 0:
        raise RuntimeError(f"Failed to archive Greplica home:\n{archive_record['stderr_tail'] or archive_record['stdout_tail']}")

    for source, target in [
        (bundle_path, GREPLICA_CONTAINER_BUNDLE),
        (home_archive, GREPLICA_CONTAINER_HOME_ARCHIVE),
    ]:
        record = run_capture(
            ["docker", "cp", str(source), f"{session['container_name']}:{target}"],
            cwd=ROOT,
            env=docker_subprocess_env(),
            timeout_seconds=300,
        )
        commands.append(record)
        if record["exit_code"] != 0:
            raise RuntimeError(f"Failed to copy {source} into container:\n{record['stderr_tail'] or record['stdout_tail']}")

    install_command = (
        "set -e; "
        f"rm -rf {shlex.quote(GREPLICA_CONTAINER_INSTALL_DIR)} {shlex.quote(GREPLICA_CONTAINER_HOME)}; "
        f"mkdir -p {shlex.quote(GREPLICA_CONTAINER_INSTALL_ROOT)} {shlex.quote(GREPLICA_CONTAINER_HOME)}; "
        f"tar --warning=no-unknown-keyword -xzf {shlex.quote(GREPLICA_CONTAINER_BUNDLE)} -C {shlex.quote(GREPLICA_CONTAINER_INSTALL_ROOT)}; "
        f"tar --warning=no-unknown-keyword -xzf {shlex.quote(GREPLICA_CONTAINER_HOME_ARCHIVE)} -C {shlex.quote(GREPLICA_CONTAINER_HOME)}; "
        "printf '%s\n' '#!/bin/sh' 'exec /opt/greplica/bin/greplica \"$@\"' > /usr/local/bin/greplica; "
        "chmod +x /usr/local/bin/greplica; "
        "chmod -R a+rX /opt/greplica \"$GREPLICA_HOME\"; "
        "greplica >/tmp/contextbench-greplica-help.txt"
    )
    install_record = docker_exec_capture(session, install_command, timeout_seconds=300)
    commands.append(install_record)
    if install_record["exit_code"] != 0:
        raise RuntimeError(f"Failed to install Greplica in container:\n{install_record['stderr_tail'] or install_record['stdout_tail']}")

    probe_record = docker_exec_capture(
        session,
        "greplica graph context 'pull request command navigation'",
        timeout_seconds=300,
    )
    commands.append(probe_record)
    if probe_record["exit_code"] != 0:
        raise RuntimeError(f"Greplica container probe failed:\n{probe_record['stderr_tail'] or probe_record['stdout_tail']}")

    return {
        "bundle_path": str(bundle_path),
        "home_archive": str(home_archive),
        "container_home": GREPLICA_CONTAINER_HOME,
        "container_install_dir": GREPLICA_CONTAINER_INSTALL_DIR,
        "commands": commands,
        "probe_stdout_tail": probe_record["stdout_tail"],
    }


def codex_cli_version() -> str:
    override = os.environ.get("CONTEXTBENCH_CODEX_VERSION")
    if override:
        if not re.fullmatch(r"\d+\.\d+\.\d+", override):
            raise RuntimeError(f"Invalid CONTEXTBENCH_CODEX_VERSION: {override}")
        return override
    process = subprocess.run(["codex", "--version"], text=True, capture_output=True, timeout=30)
    if process.returncode != 0:
        raise RuntimeError(f"Failed to detect Codex version: {process.stderr or process.stdout}")
    match = re.search(r"(\d+\.\d+\.\d+)", process.stdout or process.stderr or "")
    if not match:
        raise RuntimeError(f"Could not parse Codex version from: {process.stdout or process.stderr}")
    return match.group(1)


def ensure_codex_linux_bundle() -> Path:
    version = codex_cli_version()
    CODEX_BUNDLE_ROOT.mkdir(parents=True, exist_ok=True)
    bundle_path = CODEX_BUNDLE_ROOT / f"codex-{version}-linux-x64.tgz"
    manifest_path = CODEX_BUNDLE_ROOT / "manifest.json"
    if bundle_path.exists():
        return bundle_path

    with tempfile.TemporaryDirectory(prefix="contextbench-codex-pack-") as tmp:
        tmp_path = Path(tmp)
        command = [
            "npm",
            "pack",
            f"@openai/codex@{version}-linux-x64",
            "--pack-destination",
            str(tmp_path),
            "--silent",
        ]
        record = run_capture(command, cwd=ROOT, env=os.environ.copy(), timeout_seconds=600)
        candidates = sorted(tmp_path.glob("*.tgz"))
        manifest = {
            "version": version,
            "package": f"@openai/codex@{version}-linux-x64",
            "bundle_path": str(bundle_path),
            "pack": record,
        }
        write_json(manifest_path, manifest)
        if record["exit_code"] != 0 or len(candidates) != 1:
            raise RuntimeError(f"Failed to pack Linux Codex CLI:\n{record['stderr_tail'] or record['stdout_tail']}")
        shutil.copy2(candidates[0], bundle_path)
    return bundle_path


def install_codex_in_container(session: dict, bundle_path: Path, run_dir: Path) -> dict:
    if not bundle_path.is_file():
        raise RuntimeError(f"Codex bundle does not exist: {bundle_path}")

    commands: list[dict] = []
    copy_record = run_capture(
        ["docker", "cp", str(bundle_path), f"{session['container_name']}:{CODEX_CONTAINER_BUNDLE}"],
        cwd=ROOT,
        env=docker_subprocess_env(),
        timeout_seconds=300,
    )
    commands.append(copy_record)
    if copy_record["exit_code"] != 0:
        raise RuntimeError(f"Failed to copy Codex bundle into container:\n{copy_record['stderr_tail'] or copy_record['stdout_tail']}")

    install_command = (
        "set -e; "
        f"rm -rf {shlex.quote(CODEX_CONTAINER_INSTALL_DIR)}; "
        f"mkdir -p {shlex.quote(CODEX_CONTAINER_INSTALL_DIR)}; "
        f"tar --warning=no-unknown-keyword -xzf {shlex.quote(CODEX_CONTAINER_BUNDLE)} "
        f"--strip-components=1 -C {shlex.quote(CODEX_CONTAINER_INSTALL_DIR)}; "
        "codex_bin=$(find /opt/codex/vendor \\( -path '*/codex/codex' -o -path '*/bin/codex' \\) -type f | head -n 1); "
        "test -n \"$codex_bin\"; "
        "printf '%s\n' '#!/bin/sh' 'exec \"$CODEX_REAL_BIN\" \"$@\"' > /usr/local/bin/codex; "
        "sed -i \"s#\\$CODEX_REAL_BIN#$codex_bin#\" /usr/local/bin/codex; "
        "chmod +x /usr/local/bin/codex \"$codex_bin\"; "
        "codex --version"
    )
    install_record = docker_exec_capture(session, install_command, timeout_seconds=300)
    commands.append(install_record)
    if install_record["exit_code"] != 0:
        raise RuntimeError(f"Failed to install Codex in container:\n{install_record['stderr_tail'] or install_record['stdout_tail']}")

    return {
        "bundle_path": str(bundle_path),
        "container_bundle": CODEX_CONTAINER_BUNDLE,
        "container_install_dir": CODEX_CONTAINER_INSTALL_DIR,
        "runtime_dir": CODEX_CONTAINER_RUNTIME,
        "commands": commands,
        "version_probe": install_record["stdout_tail"],
    }


def install_container_tool_guards(session: dict) -> dict:
    command = f"""set -e
guard={shlex.quote(CONTAINER_TOOL_GUARD_DIR)}
mkdir -p "$guard"
real_git=/usr/bin/git
if [ ! -x "$real_git" ]; then
  real_git=$(PATH=/usr/bin:/bin command -v git || true)
fi
if [ -n "$real_git" ]; then
  cat > "$guard/git" <<EOF
#!/bin/sh
case "\\$1" in
  clone|fetch|pull|log|show|reflog|blame|bisect)
    echo "benchmark tool guard: git \\$1 is disabled" >&2
    exit 126
    ;;
esac
exec "$real_git" "\\$@"
EOF
  chmod +x "$guard/git"
fi
for exe in curl wget gh; do
  cat > "$guard/$exe" <<EOF
#!/bin/sh
echo "benchmark tool guard: $exe is disabled" >&2
exit 126
EOF
  chmod +x "$guard/$exe"
done
"""
    record = docker_exec_capture(session, command, timeout_seconds=120)
    if record["exit_code"] != 0:
        raise RuntimeError(f"Failed to install container tool guards:\n{record['stderr_tail'] or record['stdout_tail']}")
    return {
        "container_dir": CONTAINER_TOOL_GUARD_DIR,
        "install": record,
    }


def install_container_extra_tools(session: dict) -> dict:
    command = """set -e
if command -v rg >/dev/null 2>&1; then
  rg --version
  exit 0
fi
if command -v apt-get >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq --no-install-recommends ripgrep
elif command -v apk >/dev/null 2>&1; then
  apk add --no-cache ripgrep
elif command -v dnf >/dev/null 2>&1; then
  dnf install -y ripgrep
elif command -v yum >/dev/null 2>&1; then
  yum install -y ripgrep
else
  echo "No supported package manager found to install ripgrep" >&2
  exit 127
fi
rg --version
"""
    record = docker_exec_capture(session, command, timeout_seconds=300)
    if record["exit_code"] != 0:
        raise RuntimeError(f"Failed to install ripgrep in container:\n{record['stderr_tail'] or record['stdout_tail']}")
    return {
        "ripgrep": record,
    }


def prepare_container_codex_runtime(session: dict, run_dir: Path) -> dict:
    host_runtime = run_dir / "codex-runtime-container"
    if host_runtime.exists():
        shutil.rmtree(host_runtime)
    codex_home = host_runtime / "codex-home"
    home = host_runtime / "home"
    xdg_config_home = host_runtime / "xdg-config"
    xdg_data_home = host_runtime / "xdg-data"
    xdg_cache_home = host_runtime / "xdg-cache"
    for path in [codex_home, home, xdg_config_home, xdg_data_home, xdg_cache_home]:
        path.mkdir(parents=True, exist_ok=True)
    write_shell_path_profiles(home, container_agent_path(session))

    source_codex_home = Path(os.environ.get("CODEX_HOME") or Path.home() / ".codex").expanduser()
    source_auth = source_codex_home / "auth.json"
    if not source_auth.is_file():
        raise RuntimeError(f"Codex auth file not found: {source_auth}")
    auth_path = codex_home / "auth.json"
    shutil.copy2(source_auth, auth_path)
    auth_path.chmod(0o600)

    source_installation_id = source_codex_home / "installation_id"
    if source_installation_id.is_file():
        shutil.copy2(source_installation_id, codex_home / "installation_id")

    cleanup_record = docker_exec_capture(session, f"rm -rf {shlex.quote(CODEX_CONTAINER_RUNTIME)}", timeout_seconds=60)
    if cleanup_record["exit_code"] != 0:
        raise RuntimeError(f"Failed to clear container Codex runtime:\n{cleanup_record['stderr_tail'] or cleanup_record['stdout_tail']}")

    copy_record = run_capture(
        ["docker", "cp", f"{host_runtime}/.", f"{session['container_name']}:{CODEX_CONTAINER_RUNTIME}"],
        cwd=ROOT,
        env=docker_subprocess_env(),
        timeout_seconds=300,
    )
    try:
        auth_path.unlink()
    except FileNotFoundError:
        pass
    if copy_record["exit_code"] != 0:
        raise RuntimeError(f"Failed to copy Codex runtime into container:\n{copy_record['stderr_tail'] or copy_record['stdout_tail']}")

    return {
        "host_runtime": host_runtime,
        "container_runtime": CODEX_CONTAINER_RUNTIME,
        "container_codex_home": f"{CODEX_CONTAINER_RUNTIME}/codex-home",
        "container_home": f"{CODEX_CONTAINER_RUNTIME}/home",
        "container_xdg_config_home": f"{CODEX_CONTAINER_RUNTIME}/xdg-config",
        "container_xdg_data_home": f"{CODEX_CONTAINER_RUNTIME}/xdg-data",
        "container_xdg_cache_home": f"{CODEX_CONTAINER_RUNTIME}/xdg-cache",
        "container_auth_path": f"{CODEX_CONTAINER_RUNTIME}/codex-home/auth.json",
        "host_auth_copied_then_removed": not auth_path.exists(),
        "setup_commands": [cleanup_record, copy_record],
    }


def write_shell_path_profiles(home: Path, path_value: str) -> None:
    profile = (
        "# ContextBench agent runtime PATH.\n"
        f"export PATH={shlex.quote(path_value)}\n"
    )
    for name in [".bash_profile", ".profile", ".bashrc"]:
        target = home / name
        target.write_text(profile)
        target.chmod(0o644)


def docker_exec_capture(session: dict, command: str, timeout_seconds: int) -> dict:
    return run_capture(
        [
            "docker",
            "exec",
            "-i",
            "-w",
            session["container_cwd"],
            session["container_name"],
            "/bin/sh",
            "-lc",
            command,
        ],
        cwd=ROOT,
        env=docker_subprocess_env(),
        timeout_seconds=timeout_seconds,
    )


def run_capture(command: list[str], cwd: Path, env: dict | None = None, timeout_seconds: int = 300) -> dict:
    started = time.time()
    timed_out = False
    try:
        process = subprocess.run(
            command,
            cwd=cwd,
            env=env,
            text=True,
            capture_output=True,
            timeout=timeout_seconds,
        )
        exit_code = process.returncode
        stdout = process.stdout or ""
        stderr = process.stderr or ""
    except subprocess.TimeoutExpired as error:
        timed_out = True
        exit_code = None
        stdout = decode_timeout_output(error.stdout)
        stderr = decode_timeout_output(error.stderr) or str(error)
    return {
        "command": command,
        "cwd": str(cwd),
        "exit_code": exit_code,
        "timed_out": timed_out,
        "timeout_seconds": timeout_seconds,
        "elapsed_seconds": round(time.time() - started, 3),
        "stdout_tail": stdout[-4000:],
        "stderr_tail": stderr[-4000:],
    }


def decode_timeout_output(value) -> str:
    if value is None:
        return ""
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    return str(value)


def directory_size(path: Path) -> int:
    total = 0
    for item in path.rglob("*"):
        if item.is_file():
            try:
                total += item.stat().st_size
            except OSError:
                pass
    return total


def build_prompt(row: dict, docker_session: dict | None = None, greplica_session: dict | None = None) -> str:
    container_cwd = docker_session.get("container_cwd") if docker_session else "/testbed"
    greplica_allowed = bool(greplica_session)
    greplica_rule = (
        "Use the provided local Greplica graph-context command as the first repository-navigation step."
        if greplica_allowed
        else "Do not use Greplica commands or Greplica memory."
    )
    greplica_note = ""
    if greplica_allowed:
        greplica_note = f"""
## Greplica
Use Greplica as the first code-navigation step:
  `greplica graph context "<short task-language query preserving exact problem terms>"`

Build the query from the problem title/body wording. Preserve exact discriminating terms from the task, such as command names, flags, field names, config keys, output strings, error text, or named concepts.

Greplica maps task language to source locations. Not every returned claim is relevant, but when a claim matches the task, its anchor is the place where that memory was grounded.

Anchor strength:
- `file:start-end#symbol`: exact source starting point. Read that range/symbol first.
- `file:start-end`: read that range first, with small surrounding context only if needed.
- component/flow file anchors: broader fallback when no matching claim anchor exists.

Prefer matching claim anchors over component or flow anchors. If one or two matching claim anchors explain the task, inspect those anchored ranges before doing repository-wide search.

Current files remain authoritative: confirm what the anchored source currently says before editing. Use broad `rg` only when the matching claim anchors are missing, stale, unrelated, or insufficient to explain the task. Otherwise use narrow searches only for a specific cross-check, such as locating a unique callsite or existing test name.

Keep Greplica read-only:
- Use only `greplica graph context` during the task.
- Do not run `greplica doctor`, `greplica init`, `greplica install`, `greplica proposal`, bootstrap/update-memory skills, or any other memory mutation/setup command.
- Do not use Greplica to inspect git history, web content, GitHub, or any external corpus.
"""
    execution_note = f"""
## Execution Environment
- You are already running inside the materialized repository snapshot.
- The repository root is `{container_cwd}`.
- Use normal shell commands directly in this working tree.
- When reporting context paths, use absolute paths rooted at `{container_cwd}`.
"""

    return f"""You are solving one ContextBench issue-resolution task.

Benchmark isolation rules:
- Use only the materialized repository snapshot, the problem statement, and local test execution.
- {greplica_rule}
- Do not use LLM Wiki or any extra memory/document corpus.
- Do not use web search, browsers, remote URLs, GitHub raw/API/codeload pages, package registries, release notes, changelogs, StackOverflow, or any other internet source.
- Do not inspect Codex/global agent skills, plugins, tool registries, user configuration, host home directories, or benchmark harness internals.
- Do not inspect git history or future repository state. Avoid git log, git show, git blame, git reflog, git fetch, git pull, bisect, remotes, tags, or branches beyond the current synthetic base snapshot.
- If blocked by missing dependencies or tests, reason from local files and report the limitation. Do not work around it by looking up upstream fixes.

{execution_note}
{greplica_note}

Task instance: {row['instance_id']}
Original task: {row['original_inst_id']}
Repository: {row['repo']}
Base commit: {row['base_commit']}

Problem statement:
{row['problem_statement']}

<instructions>
# Task Instructions

## Overview
You're a software engineer fixing the issue described in the PR description above.
Make the smallest source-code change that fixes the task in a way that is general and consistent with the codebase.

## Important Boundaries
- MODIFY: regular source code files in the current working directory.
- DO NOT MODIFY: tests, project configuration files, lockfiles, CI files, or environment setup unless the PR description explicitly requires it.

## Recommended Workflow
1. Analyze the codebase by finding and reading relevant source files.
2. Create or run a local reproduction if practical.
3. Edit source code to resolve the issue.
4. Verify the fix with the benchmark container/tooling when possible.
5. Leave your changes in the working tree.

## Explore-context Marking, Required For Source Reads
When you read source code content from files, include a machine-parseable context block in your assistant message immediately before the tool call or command.

Only include this block when the command prints actual source file content or source line ranges. Do not include it for search-only commands like `rg`, `grep`, `find`, `ls`, `git status`, or for tests.
If you read source without this block, the benchmark transcript may still show the read, but your explicit trajectory will be incomplete.

Format:
<EXPLORE_CONTEXT>
File: {container_cwd}/path/to/file.ext
Lines: 10-40

File: {container_cwd}/path/to/another.ext
Lines: 80-120
</EXPLORE_CONTEXT>

Rules:
- Use absolute container paths rooted at `{container_cwd}`.
- Include only `File:` and `Lines:` entries.
- Line ranges must be positive integers and `start <= end`.
- The following tool call or shell command must print the declared line range(s).

## Final Context, Required Before Finishing
In your final response, include the exact source context used to understand and generate the patch as a `<PATCH_CONTEXT>` block.
This is mandatory. If the final response does not contain `<PATCH_CONTEXT>`, the run is considered to have no final context.
List only the specific source file ranges that you examined and used to create the patch.
Do not include broad background, memory-only hints, explanations, command output, tests, documentation-only files, or files that did not affect the patch.

Format:
<PATCH_CONTEXT>
File: {container_cwd}/path/to/file.ext
Lines: 10-40

File: {container_cwd}/path/to/another.ext
Lines: 80-120
</PATCH_CONTEXT>

Rules:
- Include only source file paths and line ranges in `<PATCH_CONTEXT>`.
- Do not include test files unless the task explicitly requires test edits.
- Do not include explanations, code snippets, command output, or test results inside `<PATCH_CONTEXT>`.
- Prefer precise ranges across the source files that actually shaped the patch over one tiny edited hunk or a broad file dump.
</instructions>
"""


def run_codex(
    cwd: Path,
    prompt: str,
    model: str,
    transcript_path: Path,
    final_path: Path,
    timeout_seconds: int,
    docker_session: dict | None = None,
    sandbox: str = "workspace-write",
) -> dict:
    if docker_session:
        return run_codex_in_container(
            prompt=prompt,
            model=model,
            transcript_path=transcript_path,
            final_path=final_path,
            timeout_seconds=timeout_seconds,
            docker_session=docker_session,
            sandbox=sandbox,
        )

    env = guarded_env(cwd)
    codex_runtime = prepare_child_codex_runtime(cwd)
    env["HOME"] = str(codex_runtime["home"])
    env["CODEX_HOME"] = str(codex_runtime["codex_home"])
    env["XDG_CONFIG_HOME"] = str(codex_runtime["xdg_config_home"])
    env["XDG_DATA_HOME"] = str(codex_runtime["xdg_data_home"])
    env["XDG_CACHE_HOME"] = str(codex_runtime["xdg_cache_home"])
    if docker_session:
        wrapper_dir = install_docker_tool_wrappers(cwd, docker_session)
        env["PATH"] = f"{wrapper_dir}{os.pathsep}{env.get('PATH', '')}"
        env["DOCKER_CONFIG"] = str(ensure_public_docker_config())
        env["CONTEXTBENCH_DOCKER_CONTAINER"] = docker_session["container_name"]
        env["CONTEXTBENCH_DOCKER_CWD"] = docker_session["container_cwd"]
    command = [
        "codex",
        "--disable",
        "plugins",
        "--disable",
        "browser_use",
        "--disable",
        "browser_use_external",
        "--disable",
        "multi_agent",
        "--disable",
        "image_generation",
        "--disable",
        "tool_suggest",
        "--ask-for-approval",
        "never",
        "exec",
        "--ephemeral",
        "--json",
        *codex_leak_flags(),
        "--ignore-rules",
        "--model",
        model,
        "--cd",
        str(cwd),
        "--sandbox",
        sandbox,
    ]
    socket_dirs = docker_socket_sandbox_dirs() if docker_session and sandbox == "workspace-write" else []
    for socket_dir in socket_dirs:
        command.extend(["--add-dir", str(socket_dir)])
    command.extend(
        [
            "--output-last-message",
            str(final_path),
            "-",
        ]
    )
    started = time.time()
    timed_out = False
    stderr = ""
    auth_path = Path(codex_runtime["auth_path"])
    stderr_path = transcript_path.with_name(transcript_path.stem + "-stderr.log")
    with transcript_path.open("w") as transcript:
        try:
            with stderr_path.open("w+") as stderr_file:
                process = subprocess.Popen(
                    command,
                    stdin=subprocess.PIPE,
                    stdout=transcript,
                    stderr=stderr_file,
                    text=True,
                    cwd=cwd,
                    env=env,
                )
                if process.stdin is None:
                    raise RuntimeError("Codex process did not expose stdin")
                process.stdin.write(prompt)
                process.stdin.close()
                # The CLI loads auth at startup; remove the temporary copy before
                # model-generated shell commands can inspect the runtime home.
                time.sleep(1.0)
                try:
                    auth_path.unlink()
                except FileNotFoundError:
                    pass
                try:
                    exit_code = process.wait(timeout=timeout_seconds)
                except subprocess.TimeoutExpired as error:
                    timed_out = True
                    process.kill()
                    process.wait(timeout=30)
                    exit_code = None
                    stderr = str(error)
                stderr_file.flush()
                stderr_file.seek(0)
                stderr = (stderr_file.read() or stderr)[-4000:]
        except subprocess.TimeoutExpired as error:
            timed_out = True
            exit_code = None
            stderr = str(error)
        except Exception as error:
            timed_out = False
            exit_code = None
            stderr = str(error)
    try:
        auth_path.unlink()
    except FileNotFoundError:
        pass
    metrics = collect_metrics(transcript_path)
    return {
        "command": command,
        "exit_code": exit_code,
        "timed_out": timed_out,
        "timeout_seconds": timeout_seconds,
        "sandbox": sandbox,
        "docker_socket_sandbox_dirs": [str(path) for path in socket_dirs],
        "child_codex_runtime": {
            "home": str(codex_runtime["home"]),
            "codex_home": str(codex_runtime["codex_home"]),
            "auth_copied_then_removed": not auth_path.exists(),
        },
        "stderr_path": str(stderr_path),
        "elapsed_seconds": round(time.time() - started, 3),
        "stderr": stderr,
        **metrics,
    }


def run_codex_in_container(
    prompt: str,
    model: str,
    transcript_path: Path,
    final_path: Path,
    timeout_seconds: int,
    docker_session: dict,
    sandbox: str = "workspace-write",
) -> dict:
    final_path.parent.mkdir(parents=True, exist_ok=True)
    runtime = prepare_container_codex_runtime(docker_session, transcript_path.parent)
    container_cwd = docker_session["container_cwd"]
    container_env = container_codex_environment(runtime, docker_session)

    command = [
        "docker",
        "exec",
        "-i",
    ]
    for key, value in container_env.items():
        command.extend(["-e", f"{key}={value}"])
    command.extend(
        [
            "-w",
            container_cwd,
            docker_session["container_name"],
            "codex",
            "--disable",
            "plugins",
            "--disable",
            "browser_use",
            "--disable",
            "browser_use_external",
            "--disable",
            "multi_agent",
            "--disable",
            "image_generation",
            "--disable",
            "tool_suggest",
            "--ask-for-approval",
            "never",
            "exec",
            "--ephemeral",
            "--json",
            *codex_leak_flags(),
            "--ignore-rules",
            "--model",
            model,
            "--cd",
            container_cwd,
            "--sandbox",
            sandbox,
        ]
    )
    if sandbox == "workspace-write":
        command.extend(["--add-dir", runtime["container_runtime"]])
    command.extend(["--output-last-message", CODEX_CONTAINER_FINAL_MESSAGE, "-"])

    started = time.time()
    timed_out = False
    stderr = ""
    stderr_path = transcript_path.with_name(transcript_path.stem + "-stderr.log")
    with transcript_path.open("w") as transcript:
        try:
            with stderr_path.open("w+") as stderr_file:
                process = subprocess.Popen(
                    command,
                    stdin=subprocess.PIPE,
                    stdout=transcript,
                    stderr=stderr_file,
                    text=True,
                    cwd=ROOT,
                    env=docker_subprocess_env(),
                )
                if process.stdin is None:
                    raise RuntimeError("Container Codex process did not expose stdin")
                process.stdin.write(prompt)
                process.stdin.close()
                time.sleep(1.0)
                auth_remove = docker_exec_capture(
                    docker_session,
                    f"rm -f {shlex.quote(runtime['container_auth_path'])}",
                    timeout_seconds=30,
                )
                try:
                    exit_code = process.wait(timeout=timeout_seconds)
                except subprocess.TimeoutExpired as error:
                    timed_out = True
                    process.kill()
                    process.wait(timeout=30)
                    exit_code = None
                    stderr = str(error)
                stderr_file.flush()
                stderr_file.seek(0)
                stderr = (stderr_file.read() or stderr)[-4000:]
        except subprocess.TimeoutExpired as error:
            timed_out = True
            exit_code = None
            stderr = str(error)
            auth_remove = {"error": str(error)}
        except Exception as error:
            timed_out = False
            exit_code = None
            stderr = str(error)
            auth_remove = {"error": str(error)}

    copy_final = run_capture(
        ["docker", "cp", f"{docker_session['container_name']}:{CODEX_CONTAINER_FINAL_MESSAGE}", str(final_path)],
        cwd=ROOT,
        env=docker_subprocess_env(),
        timeout_seconds=60,
    )
    if copy_final["exit_code"] != 0 and not final_path.exists():
        final_path.write_text("")
    metrics = collect_metrics(transcript_path)
    return {
        "command": command,
        "exit_code": exit_code,
        "timed_out": timed_out,
        "timeout_seconds": timeout_seconds,
        "sandbox": sandbox,
        "docker_socket_sandbox_dirs": [],
        "container_codex_runtime": {
            "runtime": runtime["container_runtime"],
            "codex_home": runtime["container_codex_home"],
            "home": runtime["container_home"],
            "auth_copied_then_removed": auth_remove.get("exit_code") == 0,
            "setup": [
                *runtime.get("setup_commands", []),
                auth_remove,
                copy_final,
            ],
        },
        "stderr_path": str(stderr_path),
        "elapsed_seconds": round(time.time() - started, 3),
        "stderr": stderr,
        **metrics,
    }


def container_codex_environment(runtime: dict, docker_session: dict) -> dict[str, str]:
    container_env = {
        "HOME": runtime["container_home"],
        "CODEX_HOME": runtime["container_codex_home"],
        "XDG_CONFIG_HOME": runtime["container_xdg_config_home"],
        "XDG_DATA_HOME": runtime["container_xdg_data_home"],
        "XDG_CACHE_HOME": runtime["container_xdg_cache_home"],
        "PATH": container_agent_path(docker_session),
    }
    for key, value in greplica_container_env().items():
        if key in docker_session.get("environment_variables", {}):
            container_env[key] = value
    return container_env


def container_agent_path(docker_session: dict) -> str:
    task_path = (docker_session.get("environment_variables", {}) or {}).get("PATH") or DEFAULT_CONTAINER_PATH
    parts = [CONTAINER_TOOL_GUARD_DIR]
    for part in task_path.split(":"):
        if part and part not in parts:
            parts.append(part)
    return ":".join(parts)


def prepare_child_codex_runtime(cwd: Path) -> dict[str, Path]:
    runtime = cwd / "codex-runtime"
    if runtime.exists():
        shutil.rmtree(runtime)
    codex_home = runtime / "codex-home"
    home = runtime / "home"
    xdg_config_home = runtime / "xdg-config"
    xdg_data_home = runtime / "xdg-data"
    xdg_cache_home = runtime / "xdg-cache"
    for path in [codex_home, home, xdg_config_home, xdg_data_home, xdg_cache_home]:
        path.mkdir(parents=True, exist_ok=True)

    source_codex_home = Path(os.environ.get("CODEX_HOME") or Path.home() / ".codex").expanduser()
    source_auth = source_codex_home / "auth.json"
    if not source_auth.is_file():
        raise RuntimeError(f"Codex auth file not found: {source_auth}")
    auth_path = codex_home / "auth.json"
    shutil.copy2(source_auth, auth_path)
    auth_path.chmod(0o600)

    source_installation_id = source_codex_home / "installation_id"
    if source_installation_id.is_file():
        shutil.copy2(source_installation_id, codex_home / "installation_id")

    return {
        "runtime": runtime,
        "codex_home": codex_home,
        "home": home,
        "xdg_config_home": xdg_config_home,
        "xdg_data_home": xdg_data_home,
        "xdg_cache_home": xdg_cache_home,
        "auth_path": auth_path,
    }


def audit_task_boundary(
    transcript_path: Path,
    agent_cwd: Path,
    repo_dir: Path,
    docker_session: dict | None,
) -> dict:
    allowed_host_roots = [agent_cwd.resolve()]
    is_docker = isinstance(docker_session, dict) and docker_session.get("execution_env") == "docker"
    if not is_docker:
        allowed_host_roots.append(repo_dir.resolve())
    container_cwd = docker_session.get("container_cwd", "/home") if is_docker else None

    host_path_re = re.compile(r"(?:/Users/[^/]+|/home/[^/]+|/private/tmp|/tmp)/[^\s\"'<>]+")
    violations = []

    for event in iter_events(transcript_path):
        item = event_item(event)
        if is_docker and isinstance(item, dict) and item.get("type") == "file_change":
            outside_changes = []
            for change in item.get("changes", []):
                path = change.get("path") if isinstance(change, dict) else None
                if not isinstance(path, str):
                    outside_changes.append(change)
                    continue
                if not container_path_is_relative_to(path, container_cwd):
                    outside_changes.append(change)
            if outside_changes:
                violations.append(
                    {
                        "kind": "file_change_outside_docker_workdir",
                        "changes": outside_changes,
                        "status": item.get("status"),
                    }
                )
        command = extract_completed_command(event)
        output = extract_output(event) if command else ""
        if not command:
            continue
        forbidden = forbidden_shell_invocation(command)
        if forbidden:
            violations.append({"kind": "forbidden_command", "command": command, "invocation": forbidden})
        for source, text in [("command", command), ("output", output)]:
            for match in host_path_re.findall(text):
                cleaned = match.rstrip(".,:;)]}")
                try:
                    candidate = Path(cleaned).resolve()
                except Exception:
                    continue
                if is_docker and source == "command" and str(candidate).startswith("/Users/"):
                    violations.append(
                        {
                            "kind": "host_absolute_path_in_docker_command",
                            "source": source,
                            "path": str(candidate),
                            "command": command,
                        }
                    )
                    continue
                if is_docker and cleaned.startswith(("/tmp/", "/private/tmp/")):
                    continue
                if not any(path_is_relative_to(candidate, root) for root in allowed_host_roots):
                    violations.append(
                        {
                            "kind": "host_path_outside_boundary",
                            "source": source,
                            "path": str(candidate),
                            "command": command,
                        }
                    )

    return {
        "mode": "docker_container_only" if is_docker else "host_repo",
        "allowed_host_roots": [str(path) for path in allowed_host_roots],
        "allowed_container_roots": [container_cwd] if container_cwd else [],
        "violations": violations[:100],
    }


def forbidden_shell_invocation(command: str) -> list[str] | None:
    """Detect actual forbidden commands without scanning natural-language args."""
    for argv in command_invocations(command):
        normalized = normalize_invocation(argv)
        if not normalized:
            continue
        exe = Path(normalized[0]).name.lower()
        if exe == "git" and len(normalized) > 1 and normalized[1].lower() in {
            "clone",
            "fetch",
            "pull",
            "log",
            "show",
            "reflog",
            "blame",
            "bisect",
        }:
            return normalized
        if exe in {"gh", "curl", "wget"}:
            return normalized
        if exe == "open" and any(arg.startswith(("http://", "https://")) for arg in normalized[1:]):
            return normalized
    return None


def command_invocations(command: str) -> list[list[str]]:
    scripts = [command]
    try:
        outer = shlex.split(command)
    except ValueError:
        outer = []
    if len(outer) >= 3 and Path(outer[0]).name in {"sh", "bash", "zsh"} and outer[1] in {"-c", "-lc"}:
        scripts.append(outer[2])

    invocations: list[list[str]] = []
    for script in scripts:
        invocations.extend(script_invocations(script))
    return invocations


def script_invocations(script: str) -> list[list[str]]:
    try:
        lexer = shlex.shlex(script, posix=True, punctuation_chars=";&|()")
        lexer.whitespace_split = True
        tokens = list(lexer)
    except ValueError:
        return []

    invocations: list[list[str]] = []
    segment: list[str] = []
    for token in tokens + [";"]:
        if any(ch in token for ch in ";&|()"):
            if segment:
                invocations.extend(expand_invocation(segment))
                segment = []
        else:
            segment.append(token)
    return invocations


def expand_invocation(argv: list[str]) -> list[list[str]]:
    if not argv:
        return []
    exe = Path(argv[0]).name
    if exe in {"sh", "bash", "zsh"} and len(argv) >= 3 and argv[1] in {"-c", "-lc"}:
        return script_invocations(argv[2])
    if argv[0] == "./bench" and len(argv) >= 2:
        return script_invocations(argv[1])
    return [argv]


def normalize_invocation(argv: list[str]) -> list[str]:
    normalized = list(argv)
    while normalized and re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", normalized[0]):
        normalized.pop(0)
    if normalized and Path(normalized[0]).name == "env":
        normalized.pop(0)
        while normalized and re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", normalized[0]):
            normalized.pop(0)
    return normalized


def path_is_relative_to(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def container_path_is_relative_to(path: str, root: str | None) -> bool:
    if not root:
        return False
    normalized_path = posixpath.normpath(path)
    normalized_root = posixpath.normpath(root)
    return normalized_path == normalized_root or normalized_path.startswith(normalized_root.rstrip("/") + "/")


def docker_socket_sandbox_dirs() -> list[Path]:
    dirs: list[Path] = []
    docker_host = os.environ.get("DOCKER_HOST", "")
    if docker_host.startswith("unix://"):
        dirs.append(Path(docker_host[len("unix://") :]).expanduser().parent)
    for candidate in [Path.home() / ".docker" / "run", Path("/var/run")]:
        if (candidate / "docker.sock").exists():
            dirs.append(candidate)
    unique: list[Path] = []
    seen = set()
    for path in dirs:
        resolved = str(path)
        if resolved not in seen:
            unique.append(path)
            seen.add(resolved)
    return unique


def ensure_public_docker_config() -> Path:
    PUBLIC_DOCKER_CONFIG.mkdir(parents=True, exist_ok=True)
    config_path = PUBLIC_DOCKER_CONFIG / "config.json"
    if not config_path.exists():
        config_path.write_text("{}\n")
    return PUBLIC_DOCKER_CONFIG


def docker_subprocess_env() -> dict:
    env = os.environ.copy()
    env["DOCKER_CONFIG"] = str(ensure_public_docker_config())
    return env


def collect_metrics(transcript_path: Path) -> dict:
    command_ids = set()
    function_call_ids = set()
    command_execution_events = 0
    command_execution_started = 0
    command_execution_completed = 0
    latest_usage = None
    for event in iter_events(transcript_path):
        item = event_item(event)
        if isinstance(item, dict) and item.get("type") == "command_execution":
            command_execution_events += 1
            item_id = item.get("id")
            if item_id:
                command_ids.add(item_id)
            if event.get("type") == "item.started":
                command_execution_started += 1
            elif event.get("type") == "item.completed":
                command_execution_completed += 1
        raw_item = item.get("raw_item") if isinstance(item, dict) else None
        if isinstance(raw_item, dict) and raw_item.get("type") == "function_call":
            call_id = raw_item.get("call_id") or raw_item.get("id") or item.get("id")
            if call_id:
                function_call_ids.add(call_id)
        usage = event.get("usage") if isinstance(event, dict) else None
        if isinstance(usage, dict):
            latest_usage = usage
    input_tokens = latest_usage.get("input_tokens") if latest_usage else None
    cached_input_tokens = latest_usage.get("cached_input_tokens") if latest_usage else None
    output_tokens = latest_usage.get("output_tokens") if latest_usage else None
    reasoning_output_tokens = latest_usage.get("reasoning_output_tokens") if latest_usage else None
    return {
        "tool_calls": len(command_ids) + len(function_call_ids),
        "command_execution_events": command_execution_events,
        "command_execution_started": command_execution_started,
        "command_execution_completed": command_execution_completed,
        "unique_command_executions": len(command_ids),
        "unique_function_calls": len(function_call_ids),
        "input_tokens": input_tokens,
        "cached_input_tokens": cached_input_tokens,
        "output_tokens": output_tokens,
        "reasoning_output_tokens": reasoning_output_tokens,
        "total_tokens": input_tokens + output_tokens if isinstance(input_tokens, int) and isinstance(output_tokens, int) else None,
    }


def start_benchmark_container(
    row: dict,
    repo_dir: Path,
    run_dir: Path,
    image_override: str | None,
    cwd_override: str | None,
    platform: str,
    start_timeout: int,
    extra_env: dict[str, str] | None = None,
) -> dict:
    docker = docker_config_for_task(row, image_override=image_override, cwd_override=cwd_override, platform=platform)
    container_name = f"contextbench-codex-{safe_name(row['original_inst_id']).lower()}-{timestamp().lower()}"
    container_env = benchmark_container_env(row)
    if extra_env:
        container_env.update(extra_env)
    env_args = []
    for key, value in container_env.items():
        env_args.extend(["-e", f"{key}={value}"])
    command = [
        "docker",
        "run",
        "-d",
        "--name",
        container_name,
        "--platform",
        platform,
        "-v",
        f"{repo_dir}:{docker['container_cwd']}",
        "-w",
        docker["container_cwd"],
        *env_args,
        docker["image"],
        "/bin/sh",
        "-lc",
        "while true; do sleep 3600; done",
    ]
    started = time.time()
    try:
        process = subprocess.run(command, text=True, capture_output=True, timeout=start_timeout, env=docker_subprocess_env())
        start_timed_out = False
        stdout_tail = process.stdout[-4000:]
        stderr_tail = process.stderr[-4000:]
        return_code = process.returncode
    except subprocess.TimeoutExpired as error:
        start_timed_out = True
        stdout = error.stdout or ""
        stderr = error.stderr or ""
        stdout_tail = stdout[-4000:] if isinstance(stdout, str) else str(stdout)[-4000:]
        stderr_tail = stderr[-4000:] if isinstance(stderr, str) else str(stderr)[-4000:]
        return_code = None
    session = {
        "execution_env": "docker",
        "image": docker["image"],
        "image_source": docker["image_source"],
        "container_cwd": docker["container_cwd"],
        "container_name": container_name,
        "agent_cwd": str(AGENT_CONTROL_ROOT / run_dir.name),
        "platform": platform,
        "repo_mount": f"{repo_dir}:{docker['container_cwd']}",
        "start_command": command,
        "start_exit_code": return_code,
        "start_timed_out": start_timed_out,
        "start_timeout_seconds": start_timeout,
        "start_stdout_tail": stdout_tail,
        "start_stderr_tail": stderr_tail,
        "start_elapsed_seconds": round(time.time() - started, 3),
        "environment_variables": container_env,
        "tool_forwarding": "disabled; Codex runs inside the benchmark container.",
        "wrappers": forwarded_tools_for_language(row.get("language", "")),
        "fingerprint": {},
    }
    if start_timed_out:
        write_json(run_dir / "docker-session.json", session)
        raise RuntimeError(f"Docker container startup timed out after {start_timeout}s: {docker['image']}")
    if return_code != 0:
        write_json(run_dir / "docker-session.json", session)
        raise RuntimeError(f"Docker container failed to start: {stderr_tail or stdout_tail}")

    session["container_id"] = stdout_tail.strip()
    create_agent_control_dir(Path(session["agent_cwd"]), session)
    try:
        session["fingerprint"] = docker_fingerprint(session)
    except Exception as error:
        session["fingerprint"] = {"error": str(error)}
    write_json(run_dir / "docker-session.json", session)
    return session


def create_agent_control_dir(control_dir: Path, session: dict) -> None:
    control_dir.mkdir(parents=True, exist_ok=True)
    (control_dir / "README.txt").write_text(
        "This is the Codex control directory for a ContextBench run.\n"
        "Codex runs inside the benchmark container; this host directory only stores copied artifacts.\n"
    )


def cleanup_benchmark_container(session: dict) -> None:
    name = session.get("container_name")
    if not name:
        return
    subprocess.run(["docker", "rm", "-f", name], text=True, capture_output=True, timeout=60, env=docker_subprocess_env())


def docker_config_for_task(row: dict, image_override: str | None, cwd_override: str | None, platform: str) -> dict:
    if image_override:
        image = image_override
        source = "override"
    else:
        image, source = infer_contextbench_docker_image(row)
    if not image:
        raise RuntimeError(f"Could not infer Docker image for task {row.get('original_inst_id')}")
    container_cwd = cwd_override or infer_container_cwd(row, image)
    return {
        "image": image,
        "image_source": source,
        "container_cwd": container_cwd,
        "platform": platform,
    }


def infer_contextbench_docker_image(row: dict) -> tuple[str, str]:
    source = str(row.get("source") or "").lower()
    repo = str(row.get("repo") or "")
    original_id = str(row.get("original_inst_id") or "")
    instance_id = str(row.get("instance_id") or "")
    if source == "multi" or instance_id.lower().startswith("multi-swe-bench"):
        number = original_id.rsplit("-", 1)[-1] if "-" in original_id else ""
        if not number.isdigit():
            number = "".join(re.findall(r"\d+", original_id)[-1:])
        if "/" not in repo or not number:
            return "", "multi_swe_bench"
        org, name = repo.lower().split("/", 1)
        org_clean = org.replace(".", "_")
        repo_clean = name.replace(".", "_")
        return f"mswebench/{org_clean}_m_{repo_clean}:pr-{number}", "multi_swe_bench"

    if source == "poly":
        return f"ghcr.io/timesler/swe-polybench.eval.x86_64.{original_id}:latest", "polybench"

    docker_id = original_id.replace("__", "_1776_")
    return f"docker.io/swebench/sweb.eval.x86_64.{docker_id}:latest".lower(), "swebench_default"


def infer_container_cwd(row: dict, image: str) -> str:
    inspected = docker_image_workdir(image)
    if inspected and inspected != "/":
        return inspected
    source = str(row.get("source") or "").lower()
    repo = str(row.get("repo") or "")
    if source == "multi" and "/" in repo:
        return f"/home/{repo.split('/', 1)[1].replace('-', '_')}"
    return "/testbed"


def docker_image_workdir(image: str) -> str:
    try:
        result = subprocess.run(
            ["docker", "image", "inspect", image, "--format", "{{.Config.WorkingDir}}"],
            text=True,
            capture_output=True,
            timeout=30,
            env=docker_subprocess_env(),
        )
    except Exception:
        return ""
    if result.returncode != 0:
        return ""
    return result.stdout.strip()


def benchmark_container_env(row: dict) -> dict[str, str]:
    env = {
        "PATH": DEFAULT_CONTAINER_PATH,
        "PAGER": "cat",
        "MANPAGER": "cat",
        "LESS": "-R",
        "PIP_PROGRESS_BAR": "off",
        "TQDM_DISABLE": "1",
        "NPM_CONFIG_LOGLEVEL": "error",
        "NODE_ENV": "production",
        "MAVEN_OPTS": "-q",
        "CARGO_TERM_QUIET": "true",
        "RUSTFLAGS": "-Awarnings",
    }
    if str(row.get("language") or "").lower() in {"go", "golang"}:
        env["GO111MODULE"] = "on"
        env["GOFLAGS"] = "-vet=off"
    return env


def docker_fingerprint(session: dict) -> dict:
    image = session["image"]
    container = session["container_name"]
    cwd = session["container_cwd"]
    image_info = subprocess.run(
        ["docker", "image", "inspect", image, "--format", "{{.Id}} {{.Architecture}} {{.Os}}"],
        text=True,
        capture_output=True,
        timeout=30,
        env=docker_subprocess_env(),
    )
    tool_info = subprocess.run(
        [
            "docker",
            "exec",
            "-i",
            "-w",
            cwd,
            container,
            "/bin/sh",
            "-lc",
            "printf 'pwd=' && pwd; "
            "printf 'go=' && (go version 2>/dev/null || true); "
            "printf 'git=' && (git --version 2>/dev/null || true); "
            "printf 'node=' && (node --version 2>/dev/null || true); "
            "printf 'python=' && (python3 --version 2>/dev/null || python --version 2>/dev/null || true)",
        ],
        text=True,
        capture_output=True,
        timeout=60,
        env=docker_subprocess_env(),
    )
    return {
        "docker_version": subprocess.run(
            ["docker", "--version"], text=True, capture_output=True, env=docker_subprocess_env()
        ).stdout.strip(),
        "image_inspect_exit_code": image_info.returncode,
        "image_inspect": image_info.stdout.strip(),
        "tool_probe_exit_code": tool_info.returncode,
        "tool_probe_stdout": tool_info.stdout.strip(),
        "tool_probe_stderr_tail": tool_info.stderr[-2000:],
    }


def install_docker_tool_wrappers(target_dir: Path, session: dict) -> Path:
    wrapper_dir = target_dir / "docker-tool-wrappers"
    wrapper_dir.mkdir(parents=True, exist_ok=True)
    container = session["container_name"]
    cwd = session["container_cwd"]
    env_args = " ".join(shlex.quote(f"{key}={value}") for key, value in session.get("environment_variables", {}).items())
    for tool in session.get("wrappers", []):
        path = wrapper_dir / tool
        if tool == "git":
            script = (
                "#!/bin/sh\n"
                "case \"$1\" in\n"
                "  clone|fetch|pull|log|show|reflog|blame|bisect)\n"
                "    echo \"benchmark tool guard: git $1 is disabled\" >&2\n"
                "    exit 126\n"
                "    ;;\n"
                "esac\n"
                f"exec docker exec -i -w {shlex.quote(cwd)} {shlex.quote(container)} "
                f"/usr/bin/env {env_args} git \"$@\"\n"
            )
        else:
            script = (
                "#!/bin/sh\n"
                f"exec docker exec -i -w {shlex.quote(cwd)} {shlex.quote(container)} "
                f"/usr/bin/env {env_args} {shlex.quote(tool)} \"$@\"\n"
            )
        path.write_text(script)
        path.chmod(0o755)
    return wrapper_dir


def forwarded_tools_for_language(language: str) -> list[str]:
    base = [
        "cat",
        "cmake",
        "ctest",
        "find",
        "git",
        "grep",
        "head",
        "ls",
        "make",
        "nl",
        "rg",
        "sed",
        "tail",
    ]
    lang = (language or "").lower()
    if lang in {"go", "golang"}:
        return sorted(set(base + ["go", "gofmt"]))
    if lang in {"javascript", "typescript"}:
        return sorted(set(base + ["node", "npm", "npx", "pnpm", "yarn"]))
    if lang == "python":
        return sorted(set(base + ["python", "python3", "pip", "pip3", "pytest"]))
    if lang == "rust":
        return sorted(set(base + ["cargo", "rustc", "rustfmt"]))
    if lang == "java":
        return sorted(set(base + ["java", "javac", "mvn", "gradle"]))
    return sorted(set(base + ["go", "node", "npm", "python3", "pytest", "cargo", "mvn"]))


def transcript_to_contextbench_trajectory(transcript_path: Path, repo_dir: Path, row: dict, patch: str) -> dict:
    context = codex_context_from_transcript(transcript_path, repo_dir)
    steps = context["steps"]
    final = context["final"] or {"files": [], "spans": {}}
    return {
        "instance_id": row["instance_id"],
        "original_inst_id": row["original_inst_id"],
        "repo_url": row.get("repo_url") or "https://github.com/cli/cli.git",
        "commit": row["base_commit"],
        "traj_data": {
            "pred_steps": steps,
            "pred_files": final["files"],
            "pred_spans": final["spans"],
        },
        "model_patch": patch,
        "adapter_metadata": context["report"],
    }


def codex_context_from_transcript(transcript_path: Path, repo_dir: Path) -> dict:
    steps = []
    final_step = None
    explicit_step_count = 0
    command_step_count = 0
    patch_context_count = 0
    seen_command_ids = set()

    for event in iter_events(transcript_path):
        if is_agent_message_event(event):
            text = agent_message_text(event)
            for block in extract_tag_blocks(text, "EXPLORE_CONTEXT"):
                step = context_block_to_step(block, repo_dir)
                if append_step_if_new_read(steps, step):
                    explicit_step_count += 1
            for block in extract_tag_blocks(text, "PATCH_CONTEXT"):
                step = context_block_to_step(block, repo_dir)
                patch_context_count += 1
                if step["files"] or step["spans"]:
                    final_step = step

        command_id = command_execution_id(event)
        if command_id and command_id in seen_command_ids:
            continue
        command = extract_completed_command(event)
        if not command:
            continue
        if command_id:
            seen_command_ids.add(command_id)
        output = extract_output(event)
        step = command_to_step(command, output, repo_dir)
        if append_step_if_new_read(steps, step):
            command_step_count += 1

    return {
        "steps": steps,
        "final": final_step,
        "report": {
            "policy": "steps=explicit_EXPLORE_CONTEXT_plus_completed_source_read_commands; final=strict_last_PATCH_CONTEXT_only",
            "explicit_explore_steps": explicit_step_count,
            "command_read_steps": command_step_count,
            "total_steps": len(steps),
            "patch_context_blocks": patch_context_count,
            "final_context_present": bool(final_step and (final_step["files"] or final_step["spans"])),
        },
    }


def append_step_if_new_read(steps: list[dict], step: dict) -> bool:
    if not step or (not step.get("files") and not step.get("spans")):
        return False
    normalized = normalize_step(step)
    if steps and step_signature(steps[-1]) == step_signature(normalized):
        return False
    steps.append(normalized)
    return True


def normalize_step(step: dict) -> dict:
    return {
        "files": sorted(set(step.get("files", []))),
        "spans": merge_span_dict(step.get("spans", {})),
    }


def step_signature(step: dict) -> str:
    return json.dumps(normalize_step(step), sort_keys=True)


def context_blocks_to_steps(transcript_path: Path, repo_dir: Path) -> tuple[list[dict], dict | None]:
    steps = []
    final_step = None
    for event in iter_events(transcript_path):
        if not is_agent_message_event(event):
            continue
        text = agent_message_text(event)
        if not text:
            continue
        for block in extract_tag_blocks(text, "EXPLORE_CONTEXT"):
            step = context_block_to_step(block, repo_dir)
            if step["files"] or step["spans"]:
                steps.append(step)
        for block in extract_tag_blocks(text, "PATCH_CONTEXT"):
            step = context_block_to_step(block, repo_dir)
            if step["files"] or step["spans"]:
                final_step = step
    return steps, final_step


def is_agent_message_event(event) -> bool:
    item = event_item(event)
    if isinstance(item, dict) and item.get("type") == "agent_message":
        return True
    return False


def agent_message_text(event) -> str:
    item = event_item(event)
    if isinstance(item, dict) and isinstance(item.get("text"), str):
        return item["text"]
    return ""


def event_item(event) -> dict | None:
    if not isinstance(event, dict):
        return None
    item = event.get("item")
    if isinstance(item, dict):
        return item
    payload = event.get("payload")
    if isinstance(payload, dict):
        item = payload.get("item")
        if isinstance(item, dict):
            return item
    return None


def extract_tag_blocks(text: str, tag: str) -> list[str]:
    if not text:
        return []
    pattern = rf"<{re.escape(tag)}>\s*([\s\S]*?)\s*</{re.escape(tag)}>"
    return [match.group(1) for match in re.finditer(pattern, text, re.IGNORECASE)]


def context_block_to_step(block: str, repo_dir: Path) -> dict:
    files = set()
    spans = {}
    current_file = None
    for raw_line in block.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        if line.startswith("File:"):
            current_file = line[len("File:") :].strip()
            continue
        if line.startswith("Lines:") and current_file:
            match = re.match(r"(\d+)\s*-\s*(\d+)", line[len("Lines:") :].strip())
            if not match:
                continue
            rel = resolve_repo_path(current_file, repo_dir)
            if not rel:
                continue
            start, end = int(match.group(1)), int(match.group(2))
            if start > end:
                start, end = end, start
            files.add(rel)
            spans.setdefault(rel, []).append({"start": start, "end": end})
    return {"files": sorted(files), "spans": merge_span_dict(spans)}


def command_to_step(command: str, output: str, repo_dir: Path) -> dict:
    command = normalize_command_for_parsing(command)
    files = set()
    spans = {}

    def add_span(path: str, start: int | None = None, end: int | None = None) -> None:
        rel = resolve_repo_path(path, repo_dir)
        if not rel:
            return
        files.add(rel)
        if start is None or end is None:
            line_count = count_lines(repo_dir / rel)
            start_i, end_i = 1, max(1, line_count)
        else:
            start_i, end_i = max(1, start), max(start, end)
        spans.setdefault(rel, []).append({"start": start_i, "end": end_i})

    file_token = r"(?:'[^']+'|\"[^\"]+\"|[^\s|;&<>]+)"

    # sed -n '10,20p' file
    for m in re.finditer(rf"sed\s+-n\s+['\"]?(\d+),(\d+)p['\"]?\s+({file_token})", command):
        add_span(clean_shell_token(m.group(3)), int(m.group(1)), int(m.group(2)))

    # nl -ba file | sed -n '10,20p'
    for nl in re.finditer(rf"nl\s+[^|;&]*?\s+({file_token}).*?sed\s+-n\s+['\"]?(\d+),(\d+)p", command):
        add_span(clean_shell_token(nl.group(1)), int(nl.group(2)), int(nl.group(3)))

    # cat file
    for m in re.finditer(rf"(?:^|\s)cat\s+(?:-n\s+)?({file_token})", command):
        token = clean_shell_token(m.group(1))
        if token and not token.startswith("<"):
            add_span(token)

    # head -n N file / tail -n N file
    for m in re.finditer(rf"head\s+-n\s+(\d+)\s+({file_token})", command):
        add_span(clean_shell_token(m.group(2)), 1, int(m.group(1)))
    for m in re.finditer(rf"tail\s+-n\s+(\d+)\s+({file_token})", command):
        rel = resolve_repo_path(clean_shell_token(m.group(2)), repo_dir)
        if rel:
            total = count_lines(repo_dir / rel)
            add_span(rel, max(1, total - int(m.group(1)) + 1), total)

    # rg/grep output, e.g. path:123:matched text
    if re.search(r"(^|\s)(rg|grep)\b", command):
        for line in output.splitlines():
            m = re.match(r"([^:\s][^:]*):(\d+):", line)
            if m:
                line_no = int(m.group(2))
                add_span(m.group(1), line_no, line_no)

    return {"files": sorted(files), "spans": merge_span_dict(spans)}


def normalize_command_for_parsing(command: str) -> str:
    return (command or "").replace('\\"', '"').replace("\\'", "'")


def clean_shell_token(token: str) -> str:
    return (token or "").strip().strip("'\"").replace('\\"', '"').replace("\\'", "'")


def merge_steps(steps: list[dict]) -> dict:
    files = set()
    spans = {}
    for step in steps:
        files.update(step.get("files", []))
        for file, intervals in step.get("spans", {}).items():
            spans.setdefault(file, []).extend(intervals)
    return {"files": sorted(files), "spans": merge_span_dict(spans)}


def merge_span_dict(spans: dict) -> dict:
    result = {}
    for file, intervals in spans.items():
        sorted_intervals = sorted(intervals, key=lambda x: (x["start"], x["end"]))
        merged = []
        for item in sorted_intervals:
            if merged and item["start"] <= merged[-1]["end"] + 1:
                merged[-1]["end"] = max(merged[-1]["end"], item["end"])
            else:
                merged.append(dict(item))
        result[file] = merged
    return result


def run_contextbench_evaluate(pred_path: Path, out_path: Path, cache_dir: Path) -> dict:
    env = os.environ.copy()
    env["PYTHONPATH"] = f"{CONTEXTBENCH_ROOT}{os.pathsep}{PYDEPS}{os.pathsep}{env.get('PYTHONPATH', '')}"
    tmp_root = cache_dir / "tmp"
    if tmp_root.exists():
        shutil.rmtree(tmp_root)
    tmp_root.mkdir(parents=True, exist_ok=True)
    env["CONTEXTBENCH_TMP_ROOT"] = str(tmp_root)
    command = [
        sys.executable,
        "-m",
        "contextbench.evaluate",
        "--gold",
        str(GOLD_PARQUET),
        "--pred",
        str(pred_path),
        "--cache",
        str(cache_dir),
        "--out",
        str(out_path),
    ]
    started = time.time()
    process = subprocess.run(command, cwd=CONTEXTBENCH_ROOT, text=True, capture_output=True, env=env)
    return {
        "command": command,
        "exit_code": process.returncode,
        "elapsed_seconds": round(time.time() - started, 3),
        "stdout_tail": process.stdout[-4000:],
        "stderr_tail": process.stderr[-4000:],
    }


def run_task_pass_evaluate(
    row: dict,
    patch: str,
    run_dir: Path,
    image_override: str | None,
    platform: str,
    timeout_seconds: int,
) -> dict:
    eval_dir = run_dir / "task-pass-eval"
    eval_dir.mkdir(parents=True, exist_ok=True)
    patch_path = eval_dir / "model.patch"
    test_patch_path = eval_dir / "test.patch"
    stdout_path = eval_dir / "stdout.log"
    stderr_path = eval_dir / "stderr.log"
    patch_path.write_text(patch or "")
    test_patch_path.write_text(str(row.get("test_patch") or ""))

    docker_config = docker_config_for_task(row, image_override, None, platform)
    image = docker_config["image"]
    image_source = docker_config["image_source"]
    container_cwd = docker_config["container_cwd"]
    container_name = f"contextbench-pass-{safe_name(row['original_inst_id']).lower()}-{timestamp().lower()}"
    env_args = []
    for key, value in benchmark_container_env(row).items():
        env_args.extend(["-e", f"{key}={value}"])
    run_command = [
        "docker",
        "run",
        "-d",
        "--name",
        container_name,
        "--platform",
        platform,
        *env_args,
        image,
        "/bin/sh",
        "-lc",
        "while true; do sleep 3600; done",
    ]
    result = {
        "skipped": False,
        "source": "benchmark_image_scripts",
        "image": image,
        "image_source": image_source,
        "platform": platform,
        "container_name": container_name,
        "timeout_seconds": timeout_seconds,
        "patch_path": str(patch_path),
        "stdout_log": str(stdout_path),
        "stderr_log": str(stderr_path),
        "patch_chars": len(patch or ""),
        "resolved": False,
        "completed": False,
    }
    started = time.time()
    try:
        start = subprocess.run(
            run_command,
            cwd=ROOT,
            text=True,
            capture_output=True,
            timeout=300,
            env=docker_subprocess_env(),
        )
        result["start_exit_code"] = start.returncode
        result["start_stdout_tail"] = start.stdout[-4000:]
        result["start_stderr_tail"] = start.stderr[-4000:]
        if start.returncode != 0:
            result["status"] = "container_start_failed"
            return result

        copy = run_capture(
            ["docker", "cp", str(patch_path), f"{container_name}:/home/fix.patch"],
            cwd=ROOT,
            env=docker_subprocess_env(),
            timeout_seconds=300,
        )
        result["copy_patch"] = copy
        if copy["exit_code"] != 0:
            result["status"] = "copy_patch_failed"
            return result

        copy_test = run_capture(
            ["docker", "cp", str(test_patch_path), f"{container_name}:/home/test.patch"],
            cwd=ROOT,
            env=docker_subprocess_env(),
            timeout_seconds=300,
        )
        result["copy_test_patch"] = copy_test
        if copy_test["exit_code"] != 0:
            result["status"] = "copy_test_patch_failed"
            return result

        if image_source == "swebench_default":
            return run_swebench_default_task_pass(
                result=result,
                row=row,
                container_name=container_name,
                container_cwd=container_cwd,
                timeout_seconds=timeout_seconds,
                started=started,
                stdout_path=stdout_path,
                stderr_path=stderr_path,
            )

        if image_source == "multi_swe_bench" and str(row.get("repo") or "") == "fmtlib/fmt":
            return run_fmt_multi_task_pass(
                result=result,
                row=row,
                container_name=container_name,
                container_cwd=container_cwd,
                timeout_seconds=timeout_seconds,
                started=started,
                stdout_path=stdout_path,
                stderr_path=stderr_path,
            )

        check = docker_exec_capture(
            {
                "container_name": container_name,
                "container_cwd": "/home",
            },
            f"test -f /home/fix-run.sh && test -f /home/run.sh && test -f /home/test.patch && test -d {shlex.quote(container_cwd)}",
            timeout_seconds=60,
        )
        result["script_probe"] = check
        if check["exit_code"] != 0:
            result["status"] = "unsupported_benchmark_image"
            return result

        task_env = benchmark_container_env(row)
        env_prefix = " ".join(
            f"export {key}={shlex.quote(str(value))};"
            for key, value in task_env.items()
            if key in {"PATH", "GO111MODULE", "GOFLAGS", "PAGER", "MANPAGER", "LESS", "CARGO_TERM_QUIET", "RUSTFLAGS"}
        )
        command = (
            f"{env_prefix} "
            "set -u; "
            f"cd {shlex.quote(container_cwd)}; "
            "git reset --hard; "
            "git clean -fd; "
            f"git checkout {shlex.quote(str(row['base_commit']))}; "
            "bash /home/fix-run.sh"
        )
        exec_cmd = [
            "docker",
            "exec",
            "-i",
            "-w",
            "/home",
            container_name,
            "/bin/sh",
            "-c",
            command,
        ]
        timed_out = False
        try:
            with stdout_path.open("w") as stdout, stderr_path.open("w") as stderr:
                process = subprocess.run(
                    exec_cmd,
                    cwd=ROOT,
                    text=True,
                    stdout=stdout,
                    stderr=stderr,
                    timeout=timeout_seconds,
                    env=docker_subprocess_env(),
                )
            exit_code = process.returncode
        except subprocess.TimeoutExpired as error:
            timed_out = True
            exit_code = None
            stdout_path.write_text(decode_timeout_output(error.stdout))
            stderr_path.write_text(decode_timeout_output(error.stderr) or str(error))

        result.update(
            {
                "command": exec_cmd,
                "exit_code": exit_code,
                "timed_out": timed_out,
                "elapsed_seconds": round(time.time() - started, 3),
                "stdout_tail": stdout_path.read_text(errors="replace")[-4000:] if stdout_path.exists() else "",
                "stderr_tail": stderr_path.read_text(errors="replace")[-4000:] if stderr_path.exists() else "",
            }
        )
        if timed_out:
            result["status"] = "timed_out"
        elif exit_code == 0:
            result["status"] = "resolved"
            result["resolved"] = True
            result["completed"] = True
        else:
            result["status"] = classify_task_pass_failure(result["stdout_tail"], result["stderr_tail"])
            result["completed"] = True
        return result
    except Exception as error:
        result.update(
            {
                "status": "task_pass_eval_error",
                "error": str(error),
                "elapsed_seconds": round(time.time() - started, 3),
            }
        )
        return result
    finally:
        subprocess.run(
            ["docker", "rm", "-f", container_name],
            cwd=ROOT,
            text=True,
            capture_output=True,
            timeout=60,
            env=docker_subprocess_env(),
        )


def run_fmt_multi_task_pass(
    result: dict,
    row: dict,
    container_name: str,
    container_cwd: str,
    timeout_seconds: int,
    started: float,
    stdout_path: Path,
    stderr_path: Path,
) -> dict:
    targets = fmt_test_targets_from_patch(str(row.get("test_patch") or ""))
    if not targets:
        result["status"] = "unsupported_benchmark_image"
        result["reason"] = "fmt task has no inferable test targets"
        return result

    target_builds = " ".join(
        f"cmake --build . --target {shlex.quote(target)} -j2 &&" for target in targets
    )
    ctest_regex = "^(" + "|".join(re.escape(target) for target in targets) + ")$"
    command = (
        "set -u; "
        f"cd {shlex.quote(container_cwd)}; "
        "git reset --hard; "
        "git clean -fd; "
        f"git checkout {shlex.quote(str(row['base_commit']))}; "
        "git apply --whitespace=nowarn /home/test.patch; "
        "git apply --whitespace=nowarn /home/fix.patch; "
        "mkdir -p build; "
        "cd build; "
        "cmake ..; "
        f"{target_builds} "
        f"ctest -R {shlex.quote(ctest_regex)} --output-on-failure"
    )
    exec_cmd = [
        "docker",
        "exec",
        "-i",
        "-w",
        container_cwd,
        container_name,
        "/bin/bash",
        "-lc",
        command,
    ]
    timed_out = False
    try:
        with stdout_path.open("w") as stdout, stderr_path.open("w") as stderr:
            process = subprocess.run(
                exec_cmd,
                cwd=ROOT,
                text=True,
                stdout=stdout,
                stderr=stderr,
                timeout=timeout_seconds,
                env=docker_subprocess_env(),
            )
        exit_code = process.returncode
    except subprocess.TimeoutExpired as error:
        timed_out = True
        exit_code = None
        stdout_path.write_text(decode_timeout_output(error.stdout))
        stderr_path.write_text(decode_timeout_output(error.stderr) or str(error))

    stdout_tail = stdout_path.read_text(errors="replace")[-4000:] if stdout_path.exists() else ""
    stderr_tail = stderr_path.read_text(errors="replace")[-4000:] if stderr_path.exists() else ""
    result.update(
        {
            "source": "multi_swe_bench_fmt_targeted_ctest",
            "command": exec_cmd,
            "test_targets": targets,
            "exit_code": exit_code,
            "timed_out": timed_out,
            "elapsed_seconds": round(time.time() - started, 3),
            "stdout_tail": stdout_tail,
            "stderr_tail": stderr_tail,
        }
    )
    if timed_out:
        result["status"] = "timed_out"
    elif exit_code == 0:
        result["status"] = "resolved"
        result["resolved"] = True
        result["completed"] = True
    else:
        result["status"] = classify_task_pass_failure(stdout_tail, stderr_tail)
        result["completed"] = True
    return result


def fmt_test_targets_from_patch(patch: str) -> list[str]:
    targets = set()
    for line in patch.splitlines():
        if not line.startswith("diff --git "):
            continue
        parts = line.split()
        if len(parts) < 4:
            continue
        path = parts[2][2:] if parts[2].startswith("a/") else parts[2]
        if not path.startswith("test/") or not path.endswith(".cc"):
            continue
        targets.add(Path(path).stem)
    return sorted(targets)


def run_swebench_default_task_pass(
    result: dict,
    row: dict,
    container_name: str,
    container_cwd: str,
    timeout_seconds: int,
    started: float,
    stdout_path: Path,
    stderr_path: Path,
) -> dict:
    tests = parse_task_tests(row.get("f2p")) + parse_task_tests(row.get("p2p"))
    test_targets = sorted({test.split("::", 1)[0] for test in tests if test})
    if not test_targets:
        result["status"] = "unsupported_benchmark_image"
        result["reason"] = "swebench_default task has no f2p/p2p tests"
        return result

    quoted_tests = " ".join(shlex.quote(test) for test in test_targets)
    command = (
        "set -u; "
        "if [ -f /opt/miniconda3/etc/profile.d/conda.sh ]; then "
        "  . /opt/miniconda3/etc/profile.d/conda.sh; "
        "else "
        "  . /opt/miniconda3/bin/activate; "
        "fi; "
        "conda activate testbed; "
        f"cd {shlex.quote(container_cwd)}; "
        "git reset --hard; "
        "git clean -fd; "
        f"git checkout {shlex.quote(str(row['base_commit']))}; "
        "git apply --whitespace=nowarn /home/test.patch; "
        "git apply --whitespace=nowarn /home/fix.patch; "
        f"python -m pytest -q {quoted_tests}"
    )
    exec_cmd = [
        "docker",
        "exec",
        "-i",
        "-w",
        container_cwd,
        container_name,
        "/bin/bash",
        "-lc",
        command,
    ]
    timed_out = False
    try:
        with stdout_path.open("w") as stdout, stderr_path.open("w") as stderr:
            process = subprocess.run(
                exec_cmd,
                cwd=ROOT,
                text=True,
                stdout=stdout,
                stderr=stderr,
                timeout=timeout_seconds,
                env=docker_subprocess_env(),
            )
        exit_code = process.returncode
    except subprocess.TimeoutExpired as error:
        timed_out = True
        exit_code = None
        stdout_path.write_text(decode_timeout_output(error.stdout))
        stderr_path.write_text(decode_timeout_output(error.stderr) or str(error))

    stdout_tail = stdout_path.read_text(errors="replace")[-4000:] if stdout_path.exists() else ""
    stderr_tail = stderr_path.read_text(errors="replace")[-4000:] if stderr_path.exists() else ""
    result.update(
        {
            "source": "swebench_default_pytest",
            "command": exec_cmd,
            "tested_count": len(tests),
            "test_targets": test_targets,
            "exit_code": exit_code,
            "timed_out": timed_out,
            "elapsed_seconds": round(time.time() - started, 3),
            "stdout_tail": stdout_tail,
            "stderr_tail": stderr_tail,
        }
    )
    if timed_out:
        result["status"] = "timed_out"
    elif exit_code == 0:
        result["status"] = "resolved"
        result["resolved"] = True
        result["completed"] = True
    else:
        result["status"] = classify_task_pass_failure(stdout_tail, stderr_tail)
        result["completed"] = True
    return result


def parse_task_tests(value) -> list[str]:
    if value is None:
        return []
    if isinstance(value, list):
        return [str(item) for item in value if str(item)]
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return []
        try:
            parsed = json.loads(text)
        except json.JSONDecodeError:
            return [text]
        if isinstance(parsed, list):
            return [str(item) for item in parsed if str(item)]
        if isinstance(parsed, str):
            return [parsed]
    return []


def classify_task_pass_failure(stdout_tail: str, stderr_tail: str) -> str:
    text = f"{stdout_tail}\n{stderr_tail}".lower()
    if "patch failed" in text or "does not apply" in text or "error: patch" in text or "git apply" in text:
        return "model_patch_apply_failed"
    return "unresolved"


def gold_hit_diagnostics(trajectory: dict, row: dict) -> dict:
    gold_files = set(gold_files_for(row))
    hits = []
    for idx, step in enumerate(trajectory.get("traj_data", {}).get("pred_steps", []), 1):
        seen = sorted(gold_files & set(step.get("files", [])))
        if seen:
            hits.append({"step": idx, "gold_files": seen})
    return {
        "gold_files": sorted(gold_files),
        "first_hit": hits[0] if hits else None,
        "hit_steps": hits,
    }


def gold_files_for(row: dict) -> list[str]:
    items = json.loads(row["gold_context"]) if isinstance(row.get("gold_context"), str) else []
    return sorted({normalize_gold_path(item.get("file", "")) for item in items if item.get("file")})


def normalize_gold_path(path: str) -> str:
    path = path.replace("\\", "/")
    if path.startswith("/workspace/"):
        rest = path[len("/workspace/") :]
        parts = rest.split("/", 1)
        return parts[1] if len(parts) == 2 else parts[0]
    if path.startswith("/testbed/"):
        return path[len("/testbed/") :]
    return path.lstrip("./").lstrip("/")


def summarize_trajectory(trajectory: dict) -> dict:
    data = trajectory.get("traj_data", {})
    return {
        "step_count": len(data.get("pred_steps", [])),
        "pred_file_count": len(data.get("pred_files", [])),
        "pred_files": data.get("pred_files", []),
    }


def extract_command(event) -> str | None:
    item = event_item(event)
    if isinstance(item, dict) and isinstance(item.get("command"), str):
        return item["command"]
    return None


def extract_completed_command(event) -> str | None:
    item = event_item(event)
    if not isinstance(item, dict) or item.get("type") != "command_execution":
        return None
    if isinstance(event, dict) and event.get("type") != "item.completed":
        return None
    return extract_command(event)


def command_execution_id(event) -> str | None:
    item = event_item(event)
    if isinstance(item, dict) and item.get("type") == "command_execution":
        item_id = item.get("id")
        return str(item_id) if item_id else None
    return None


def extract_output(event) -> str:
    text_parts = []
    stack = [event]
    while stack:
        value = stack.pop()
        if isinstance(value, dict):
            for key, item in value.items():
                if key in {"output", "stdout", "stderr", "aggregated_output"} and isinstance(item, str):
                    text_parts.append(item)
                elif isinstance(item, (dict, list)):
                    stack.append(item)
        elif isinstance(value, list):
            stack.extend(value)
    return "\n".join(text_parts)


def resolve_repo_path(path: str, repo_dir: Path) -> str | None:
    cleaned = path.strip().strip("'\"").replace("\\", "/")
    if not cleaned or cleaned.startswith("-"):
        return None
    while cleaned.startswith("./"):
        cleaned = cleaned[2:]
    if cleaned.startswith(str(repo_dir)):
        cleaned = str(Path(cleaned).relative_to(repo_dir)).replace("\\", "/")
    if cleaned.startswith("/"):
        cleaned = cleaned.lstrip("/")
    parts = [part for part in cleaned.split("/") if part and part != "."]
    for i in range(len(parts)):
        candidate = "/".join(parts[i:])
        full = repo_dir / candidate
        if full.is_file():
            return candidate
    return None


def count_lines(path: Path) -> int:
    try:
        return len(path.read_text(errors="replace").splitlines())
    except Exception:
        return 1


def iter_events(path: Path):
    if not path.exists():
        return
    for line in path.read_text(errors="replace").splitlines():
        try:
            yield json.loads(line)
        except Exception:
            continue


def git(cwd: Path, args: list[str]) -> str:
    result = subprocess.run(["git", *args], cwd=cwd, text=True, capture_output=True)
    if result.returncode != 0:
        raise RuntimeError(result.stderr)
    return result.stdout


def read_jsonl(path: Path) -> list[dict]:
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def read_json(path: Path) -> dict:
    return json.loads(path.read_text())


def write_json(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, default=str) + "\n")


def timestamp() -> str:
    return time.strftime("%Y%m%d-%H%M%S")


def safe_name(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]+", "_", value)


if __name__ == "__main__":
    raise SystemExit(main())
