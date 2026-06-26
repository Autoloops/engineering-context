#!/usr/bin/env python3
"""Materialize ContextBench full.parquet rows into memory-build dataset tasks."""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.request
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "memory-workbench" / "pydeps"))
sys.path.insert(0, str(ROOT / "scripts" / "contextbench"))

import pandas as pd  # type: ignore
from swe_eval_safety import materialize_base_snapshot  # type: ignore


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--parquet", default=str(ROOT / "memory-workbench" / "contextbench-inspect" / "data" / "full.parquet"))
    parser.add_argument("--dataset", required=True)
    parser.add_argument("--repo", required=True)
    parser.add_argument("--tasks", nargs="+", required=True)
    args = parser.parse_args()

    dataset_dir = Path(args.dataset).resolve()
    tasks_dir = dataset_dir / "tasks"
    tasks_dir.mkdir(parents=True, exist_ok=True)

    df = pd.read_parquet(args.parquet)
    manifest_tasks: list[dict[str, object]] = []

    for task_id in args.tasks:
        matches = df[df["original_inst_id"].eq(task_id)]
        if len(matches) != 1:
            raise SystemExit(f"Expected exactly one row for {task_id}, found {len(matches)}")
        row = matches.iloc[0].to_dict()
        if row["repo"] != args.repo:
            raise SystemExit(f"{task_id} is for repo {row['repo']}, expected {args.repo}")

        target_pr = target_pr_number(task_id)
        cutoff = github_pr_created_at(args.repo, target_pr)
        linked_numbers = sorted(n for n in github_numbers(str(row.get("problem_statement") or "")) if n != target_pr)

        task_dir = tasks_dir / task_id
        repo_dir = materialize_base_snapshot(task_dir / "repo", args.repo, row["base_commit"])
        source_tar = task_dir / "repo" / "base-source.tar.gz"
        if not source_tar.exists():
            # materialize_base_snapshot writes archive beside repo/, so keep the dataset shape
            # expected by prepare-task.ts.
            archive = task_dir / "repo" / "base-source.tar.gz"
            raise SystemExit(f"Missing expected archive after materialization: {archive}")

        task = {
            "task_id": task_id,
            "task_index": int(matches.index[0]) + 1,
            "instance_id": row["instance_id"],
            "repo": row["repo"],
            "repo_url": row["repo_url"],
            "memory_remote_url": f"greplica-eval://swe-context/{row['repo']}",
            "base_commit": row["base_commit"],
            "cutoff": cutoff,
            "target_pr_number": target_pr,
            "task_pr_url": f"https://github.com/{row['repo']}/pull/{target_pr}",
            "linked_issue_numbers": linked_numbers,
            "linked_numbers_in_problem": linked_numbers,
            "accepted_for_apples_to_apples": True,
        }
        write_json(task_dir / "task.json", task)
        (task_dir / "prompt.md").write_text(str(row.get("problem_statement") or "").strip() + "\n", encoding="utf-8")
        manifest_tasks.append({
            "task_id": task_id,
            "task_index": task["task_index"],
            "base_commit": row["base_commit"],
            "target_pr_number": target_pr,
            "accepted_for_apples_to_apples": True,
        })
        print(f"Materialized {task_id}: {repo_dir}")

    write_json(dataset_dir / "manifest.json", {
        "name": dataset_dir.name,
        "repo": args.repo,
        "source_parquet": str(Path(args.parquet).resolve()),
        "tasks": manifest_tasks,
    })
    readme = [
        f"# {dataset_dir.name}",
        "",
        "Generated from ContextBench `full.parquet` for Greplica memory benchmarking.",
        "",
        "Tasks:",
        *[f"- `{task['task_id']}`" for task in manifest_tasks],
        "",
    ]
    (dataset_dir / "README.md").write_text("\n".join(readme), encoding="utf-8")
    return 0


def target_pr_number(task_id: str) -> int:
    match = re.search(r"-(\d+)$", task_id)
    if match is None:
        raise SystemExit(f"Cannot infer target PR number from {task_id}")
    return int(match.group(1))


def github_numbers(text: str) -> set[int]:
    return {int(match) for match in re.findall(r"#(\d+)", text)}


def github_pr_created_at(repo: str, number: int) -> str:
    url = f"https://api.github.com/repos/{repo}/pulls/{number}"
    headers = {
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "greplica-memory-build",
    }
    token = os.environ.get("GITHUB_TOKEN")
    if token:
        headers["Authorization"] = f"Bearer {token}"
    request = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(request, timeout=60) as response:
        body = json.loads(response.read().decode("utf-8"))
    created_at = body.get("created_at")
    if not isinstance(created_at, str) or not created_at:
        raise SystemExit(f"GitHub PR response has no created_at for {repo}#{number}")
    return created_at


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    raise SystemExit(main())
