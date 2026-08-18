#!/usr/bin/env python3
"""Save and restore this device's installation state.

Two files hold settings that belong to *this physical installation* rather than
to the code: the color calibration (``pi/color_map.json``, written by
``color_calibration.py``) and the RFID tag pairings (``pi/puzzles/index.json``,
written by the ``/admin`` dashboard). Both are gitignored, so no ``git pull``,
branch switch, or ``git checkout .`` can overwrite them.

That keeps them safe from git, but it also means git is no longer backing them
up -- and an SD reimage or the read-only overlay would take them with it. This
script is the backup: it snapshots both files onto a dedicated orphan branch,
``installation-state``, checked out in a git worktree *outside* this repo. That
branch is never merged into a code branch, so it cannot cause a conflict, but
it does push to origin, so the snapshot survives a reimage and can be read from
any other clone.

Snapshots are stored per-hostname, so several devices can share the branch
without overwriting each other.

Usage:
    python installation_config.py status
    python installation_config.py save [-m MESSAGE] [--push] [--force]
    python installation_config.py restore [--from HOSTNAME] [--force]
    python installation_config.py list

Run this with the read-only overlay disabled; it writes to disk.
"""

import argparse
import hashlib
import json
import os
import shutil
import socket
import subprocess
import sys
from datetime import datetime, timezone

STATE_BRANCH = "installation-state"

# Files to snapshot, as paths relative to the repository root. The basename is
# what lands in the snapshot directory, so these must not collide.
STATE_FILES = ("pi/color_map.json", "pi/puzzles/index.json")


# --- git plumbing ---

def _git_env():
    """Environment for every git call, with interactive prompting disabled.

    These run unattended on the exhibit Pi, often over SSH. If git stops to ask
    for a username and password it hangs forever rather than failing -- and
    GitHub rejects passwords anyway. Authentication is expected to come from a
    deploy key; see SETUP.md, "Step 0: Git Access".
    """
    env = dict(os.environ)
    env["GIT_TERMINAL_PROMPT"] = "0"
    env.setdefault("GIT_SSH_COMMAND", "ssh -o BatchMode=yes")
    return env


def git(*args, cwd=None, check=True, stdin=None):
    """Run a git command and return its stdout, stripped."""
    proc = subprocess.run(
        ("git",) + args, cwd=cwd, check=False, text=True, encoding="utf-8",
        input=("" if stdin is None else stdin), env=_git_env(),
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    if check and proc.returncode != 0:
        raise RuntimeError("git {} failed ({}): {}".format(
            " ".join(args), proc.returncode, (proc.stderr or "").strip()))
    return (proc.stdout or "").strip()


def git_ok(*args, cwd=None):
    """True if the git command exits zero."""
    return subprocess.run(
        ("git",) + args, cwd=cwd, check=False, stdin=subprocess.DEVNULL,
        env=_git_env(),
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    ).returncode == 0


def git_try(*args, cwd=None):
    """Run git, returning (ok, combined output). For calls allowed to fail."""
    proc = subprocess.run(
        ("git",) + args, cwd=cwd, check=False, text=True, encoding="utf-8",
        input="", env=_git_env(),
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
    )
    return proc.returncode == 0, (proc.stdout or "").strip()


AUTH_MARKERS = (
    "authentication failed", "could not read username", "could not read password",
    "terminal prompts disabled", "permission denied (publickey)",
    "invalid username or password", "support for password authentication",
    "403 forbidden", "access denied",
)


def looks_like_auth_failure(text):
    low = (text or "").lower()
    return any(m in low for m in AUTH_MARKERS)


def print_auth_hint(root, wt=None):
    """Explain how to give git credentials it can actually use."""
    url = git("remote", "get-url", "origin", cwd=root, check=False)
    print("  Remote: {}".format(url or "(none configured)"))
    if url.startswith("https://"):
        print("  That is an HTTPS remote. These scripts run git with prompting")
        print("  disabled -- otherwise an unattended Pi hangs forever on an")
        print("  invisible password prompt -- so git cannot ask you for a token.")
        print("  Store the credential once, from a shell where git CAN prompt:")
        print()
        print("      git config --global credential.helper store")
        if wt:
            print("      git -C {} push -u origin {}".format(wt, STATE_BRANCH))
        else:
            print("      git push")
        print()
        print("  Enter your username and paste the token as the password. It is")
        print("  saved in plaintext to ~/.git-credentials, so use a repo-scoped")
        print("  token, never an account password.")
    print("  A deploy key avoids the storage and expiry problems entirely --")
    print("  see SETUP.md, 'Step 0: Git Access'.")


def unpushed_commits(root, wt):
    """How many commits on the local state branch are not yet on origin."""
    if not has_origin(root):
        return 0
    if not git_ok("rev-parse", "--verify", "--quiet",
                  "refs/remotes/origin/" + STATE_BRANCH, cwd=wt):
        # Never pushed, so every commit on the branch is outstanding.
        out = git("rev-list", "--count", STATE_BRANCH, cwd=wt, check=False)
        return int(out) if out.isdigit() else 1
    out = git("rev-list", "--count",
              "origin/{}..{}".format(STATE_BRANCH, STATE_BRANCH),
              cwd=wt, check=False)
    return int(out) if out.isdigit() else 0


def push_state(root, wt):
    """Push the state branch to origin. Returns a process exit code."""
    if not has_origin(root):
        print("No 'origin' remote configured -- the snapshot is local only.")
        return 1
    ok, out = git_try("push", "-u", "origin", STATE_BRANCH, cwd=wt)
    if ok:
        print("Pushed to origin/{}.".format(STATE_BRANCH))
        return 0
    print("The snapshot is committed on this device, but the push failed:")
    for line in (out or "").splitlines()[:4]:
        print("  " + line)
    print()
    print("It is safe here and survives a reboot -- but not a reimage, until it")
    print("reaches origin.")
    print()
    if looks_like_auth_failure(out):
        print_auth_hint(root, wt)
    else:
        print("  Retry with: git -C {} push -u origin {}".format(wt, STATE_BRANCH))
    return 1



def repo_root():
    return os.path.normpath(git("rev-parse", "--show-toplevel",
                                cwd=os.path.dirname(os.path.abspath(__file__))))


def worktree_path(root):
    """Where the installation-state branch is checked out.

    Deliberately a sibling of the repo, not a subdirectory: a subdirectory
    would show up as an untracked path in every code-branch status.
    """
    override = os.environ.get("TDD_STATE_WORKTREE")
    if override:
        return os.path.abspath(override)
    parent, name = os.path.split(root)
    return os.path.join(parent, name + "-installation-state")


def has_origin(root):
    return "origin" in git("remote", cwd=root).split()


def ensure_branch(root):
    """Make sure the installation-state branch exists locally."""
    if git_ok("rev-parse", "--verify", "--quiet", STATE_BRANCH, cwd=root):
        return

    if has_origin(root):
        # Best effort -- offline is fine, we just create the branch locally.
        git_ok("fetch", "origin", STATE_BRANCH, cwd=root)
        if git_ok("rev-parse", "--verify", "--quiet",
                  "refs/remotes/origin/" + STATE_BRANCH, cwd=root):
            git("branch", STATE_BRANCH, "origin/" + STATE_BRANCH, cwd=root)
            print("Tracked existing origin/{}.".format(STATE_BRANCH))
            return

    # Create it as a true orphan: an empty tree with no parent, so it shares no
    # history with any code branch and can never be fast-forwarded into one.
    empty_tree = git("hash-object", "-t", "tree", "--stdin", cwd=root, stdin="")
    commit = git("commit-tree", empty_tree, "-m",
                 "Initialize installation-state branch", cwd=root, stdin="")
    git("branch", STATE_BRANCH, commit, cwd=root)
    print("Created orphan branch {}.".format(STATE_BRANCH))


def ensure_worktree(root):
    """Return the path to the installation-state worktree, creating it if needed."""
    path = worktree_path(root)
    listing = git("worktree", "list", "--porcelain", cwd=root)
    registered = {
        os.path.normpath(line[len("worktree "):])
        for line in listing.splitlines() if line.startswith("worktree ")
    }
    if os.path.normpath(path) in registered:
        return path

    if os.path.exists(path):
        raise RuntimeError(
            "{} exists but is not a registered git worktree. Move or delete "
            "it, or point TDD_STATE_WORKTREE somewhere else.".format(path))

    ensure_branch(root)
    git("worktree", "add", path, STATE_BRANCH, cwd=root)
    print("Checked out {} at {}.".format(STATE_BRANCH, path))
    return path


# --- helpers ---

def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def looks_calibrated(path):
    """True if color_map.json holds a real calibration rather than a placeholder."""
    try:
        with open(path) as f:
            return "sensors" in json.load(f)
    except (OSError, ValueError):
        return False


def looks_paired(path):
    """True if index.json holds at least one real tag mapping."""
    try:
        with open(path) as f:
            data = json.load(f)
    except (OSError, ValueError):
        return False
    return any(not k.startswith("_") for k in data)


def sanity_check(root):
    """Return a list of complaints about the live files, for --force to override."""
    problems = []
    color_map = os.path.join(root, "pi/color_map.json")
    index = os.path.join(root, "pi/puzzles/index.json")

    if not os.path.exists(color_map):
        problems.append("pi/color_map.json does not exist "
                        "(run color_calibration.py)")
    elif not looks_calibrated(color_map):
        problems.append("pi/color_map.json has no 'sensors' key -- it is a "
                        "placeholder, not a calibration")

    if not os.path.exists(index):
        problems.append("pi/puzzles/index.json does not exist "
                        "(pair tags at /admin)")
    elif not looks_paired(index):
        problems.append("pi/puzzles/index.json has no tag mappings")

    return problems


def snapshot_dir(wt, host):
    return os.path.join(wt, host)


def local_hostname():
    return socket.gethostname()


def available_hosts(wt):
    return sorted(
        d for d in os.listdir(wt)
        if os.path.isdir(os.path.join(wt, d)) and not d.startswith(".")
    )


def sync_worktree(root, wt):
    """Best-effort pull of the state branch, so we snapshot onto current history."""
    if not has_origin(root):
        return
    ok, out = git_try("fetch", "origin", STATE_BRANCH, cwd=wt)
    if not ok:
        low = (out or "").lower()
        if looks_like_auth_failure(out):
            print("  Could not reach origin: authentication failed.")
            print_auth_hint(root, wt)
        elif "couldn't find remote ref" in low or "does not appear to be" in low:
            print("  (no {} branch on origin yet -- push will create it)".format(
                STATE_BRANCH))
        else:
            first = (out or "unknown error").splitlines()[0]
            print("  Could not reach origin, working locally: {}".format(first))
        return
    if git_ok("rev-parse", "--verify", "--quiet",
              "refs/remotes/origin/" + STATE_BRANCH, cwd=wt):
        if not git_ok("merge", "--ff-only", "origin/" + STATE_BRANCH, cwd=wt):
            print("  WARNING: local {} has diverged from origin. Resolve it in "
                  "{} before pushing.".format(STATE_BRANCH, wt))



# --- commands ---

def cmd_save(args):
    root = repo_root()
    problems = sanity_check(root)
    if problems and not args.force:
        print("Refusing to save -- this does not look like real installation state:")
        for p in problems:
            print("  - " + p)
        print("\nFix the above, or pass --force to snapshot it anyway.")
        return 1
    for p in problems:
        print("WARNING: " + p)

    wt = ensure_worktree(root)
    sync_worktree(root, wt)

    host = local_hostname()
    dest = snapshot_dir(wt, host)
    os.makedirs(dest, exist_ok=True)

    manifest = {
        "hostname": host,
        "saved_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source_branch": git("rev-parse", "--abbrev-ref", "HEAD", cwd=root),
        "source_commit": git("rev-parse", "--short", "HEAD", cwd=root),
        "files": {},
    }

    saved = []
    for rel in STATE_FILES:
        src = os.path.join(root, rel)
        if not os.path.exists(src):
            print("  skipping {} (not present)".format(rel))
            continue
        shutil.copy2(src, os.path.join(dest, os.path.basename(rel)))
        manifest["files"][os.path.basename(rel)] = {
            "source_path": rel, "sha256": sha256(src),
        }
        saved.append(rel)

    if not saved:
        print("Nothing to save -- neither state file exists.")
        return 1

    # Decide whether anything actually changed *before* writing the manifest.
    # Its timestamp differs on every run, so writing it first would make every
    # save look like a change and fill the branch with no-op commits.
    git("add", "-A", cwd=wt)
    if git_ok("diff", "--cached", "--quiet", cwd=wt):
        print("No changes -- the snapshot for {} is already current.".format(host))
        # Still push if anything is outstanding. An earlier save may have
        # committed and then failed to push (expired token, Pi offline);
        # without this, that snapshot sits unpushed forever, because every
        # later save takes this same branch and returns early.
        outstanding = unpushed_commits(root, wt)
        if outstanding:
            if args.push:
                print("{} earlier snapshot(s) never reached origin -- pushing now.".format(outstanding))
                return push_state(root, wt)
            print("But {} snapshot(s) have never reached origin. Push with:"
                  .format(outstanding))
            print("  python installation_config.py save --push")
        return 0

    with open(os.path.join(dest, "manifest.json"), "w", newline="\n") as f:
        json.dump(manifest, f, indent=2)
        f.write("\n")
    git("add", "-A", cwd=wt)

    message = args.message or "Snapshot installation state for {} ({})".format(
        host, manifest["saved_utc"])
    git("commit", "-m", message, cwd=wt)
    print("Committed snapshot for {}:".format(host))
    for rel in saved:
        print("  " + rel)

    if args.push:
        return push_state(root, wt)

    print()
    print("Not pushed. To back it up off this device:")
    print("  python installation_config.py save --push")
    return 0


def cmd_restore(args):
    root = repo_root()
    wt = ensure_worktree(root)
    sync_worktree(root, wt)

    host = args.from_host or local_hostname()
    src_dir = snapshot_dir(wt, host)
    if not os.path.isdir(src_dir):
        print("No snapshot for host '{}'.".format(host))
        hosts = available_hosts(wt)
        if hosts:
            print("Available: " + ", ".join(hosts))
            print("Restore another device's state with --from HOSTNAME.")
        else:
            print("The {} branch has no snapshots yet.".format(STATE_BRANCH))
        return 1

    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    restored, skipped = [], []
    for rel in STATE_FILES:
        src = os.path.join(src_dir, os.path.basename(rel))
        if not os.path.exists(src):
            skipped.append(rel)
            continue
        dst = os.path.join(root, rel)

        if os.path.exists(dst):
            if sha256(src) == sha256(dst):
                print("  {} already matches the snapshot".format(rel))
                continue
            if not args.force:
                backup = "{}.bak-{}".format(dst, stamp)
                shutil.copy2(dst, backup)
                print("  backed up current {} -> {}".format(
                    rel, os.path.basename(backup)))

        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copy2(src, dst)
        restored.append(rel)

    for rel in skipped:
        print("  no {} in the snapshot".format(os.path.basename(rel)))

    if restored:
        print("Restored from {}:".format(host))
        for rel in restored:
            print("  " + rel)
        print("\nRestart the service to pick them up:")
        print("  sudo systemctl restart tdd-exhibit")
    else:
        print("Nothing needed restoring.")
    return 0


def cmd_list(args):
    root = repo_root()
    wt = ensure_worktree(root)
    sync_worktree(root, wt)

    hosts = available_hosts(wt)
    if not hosts:
        print("No snapshots on {} yet.".format(STATE_BRANCH))
        return 0

    print("Snapshots on {} (worktree: {}):\n".format(STATE_BRANCH, wt))
    for host in hosts:
        marker = "  <- this device" if host == local_hostname() else ""
        try:
            with open(os.path.join(wt, host, "manifest.json")) as f:
                m = json.load(f)
            print("  {}{}".format(host, marker))
            print("      saved:  {}".format(m.get("saved_utc", "?")))
            print("      from:   {} @ {}".format(
                m.get("source_branch", "?"), m.get("source_commit", "?")))
            print("      files:  {}".format(
                ", ".join(sorted(m.get("files", {}))) or "none"))
        except (OSError, ValueError):
            print("  {}{} (no readable manifest)".format(host, marker))
    return 0


def cmd_status(args):
    root = repo_root()
    host = local_hostname()
    print("Repository:  {}".format(root))
    print("Branch:      {} @ {}".format(
        git("rev-parse", "--abbrev-ref", "HEAD", cwd=root),
        git("rev-parse", "--short", "HEAD", cwd=root)))
    print("Hostname:    {}\n".format(host))

    print("Live installation state:")
    for rel in STATE_FILES:
        path = os.path.join(root, rel)
        if not os.path.exists(path):
            print("  {:<24} MISSING".format(rel))
            continue
        if rel.endswith("color_map.json"):
            note = "calibrated" if looks_calibrated(path) else "PLACEHOLDER"
        else:
            note = "paired" if looks_paired(path) else "NO MAPPINGS"
        print("  {:<24} present, {}".format(rel, note))

    # Confirm git really is ignoring them -- the whole design rests on this.
    print("\nIgnored by git (so pulls cannot touch them):")
    tracked = []
    for rel in STATE_FILES:
        ignored = git_ok("check-ignore", "-q", rel, cwd=root)
        if not ignored:
            tracked.append(rel)
        print("  {:<24} {}".format(rel, "yes" if ignored else "NO -- still tracked!"))
    if tracked:
        print()
        print("  This branch predates the gitignore change, so checking out")
        print("  another branch can silently overwrite the file(s) above.")
        print("  Run 'save' before switching, and 'restore' after.")

    wt = worktree_path(root)
    print("\nSnapshot branch: {}".format(STATE_BRANCH))
    if not git_ok("rev-parse", "--verify", "--quiet", STATE_BRANCH, cwd=root):
        print("  not created yet -- run: python installation_config.py save")
        return 0
    if not os.path.isdir(wt):
        print("  branch exists; worktree not checked out at {}".format(wt))
        print("  it will be created on the next save/restore")
        return 0

    print("  worktree: {}".format(wt))
    snap = snapshot_dir(wt, host)
    if not os.path.isdir(snap):
        print("  no snapshot for {} yet -- run: python installation_config.py save"
              .format(host))
    else:
        stale = []
        for rel in STATE_FILES:
            live = os.path.join(root, rel)
            saved = os.path.join(snap, os.path.basename(rel))
            if os.path.exists(live) and os.path.exists(saved):
                if sha256(live) != sha256(saved):
                    stale.append(rel)
            elif os.path.exists(live):
                stale.append(rel)
        if stale:
            print("  snapshot is OUT OF DATE for: " + ", ".join(stale))
            print("  run: python installation_config.py save")
        else:
            print("  snapshot for {} is current".format(host))

    if git_ok("rev-parse", "--verify", "--quiet",
              "refs/remotes/origin/" + STATE_BRANCH, cwd=root):
        unpushed = git("log", "--oneline",
                       "origin/{}..{}".format(STATE_BRANCH, STATE_BRANCH),
                       cwd=root, check=False)
        if unpushed:
            print("  {} commit(s) not pushed to origin".format(
                len(unpushed.splitlines())))
            print("  run: git -C {} push origin {}".format(wt, STATE_BRANCH))
    return 0


def main():
    parser = argparse.ArgumentParser(
        description="Save and restore this device's installation state.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="Snapshots live on the '{}' branch, which is never merged into "
               "a code branch.".format(STATE_BRANCH))
    sub = parser.add_subparsers(dest="command")

    p = sub.add_parser("status", help="show live state and snapshot freshness")
    p.set_defaults(func=cmd_status)

    p = sub.add_parser("save", help="snapshot this device's state to the branch")
    p.add_argument("-m", "--message", help="commit message")
    p.add_argument("--push", action="store_true", help="push to origin afterwards")
    p.add_argument("--force", action="store_true",
                   help="save even if the files look like placeholders")
    p.set_defaults(func=cmd_save)

    p = sub.add_parser("restore", help="copy a snapshot back into the working tree")
    p.add_argument("--from", dest="from_host", metavar="HOSTNAME",
                   help="restore another device's snapshot (default: this host)")
    p.add_argument("--force", action="store_true",
                   help="overwrite without leaving a .bak copy")
    p.set_defaults(func=cmd_restore)

    p = sub.add_parser("list", help="list snapshots on the branch")
    p.set_defaults(func=cmd_list)

    args = parser.parse_args()
    if not getattr(args, "func", None):
        parser.print_help()
        return 1
    try:
        return args.func(args)
    except RuntimeError as e:
        print("Error: {}".format(e), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
