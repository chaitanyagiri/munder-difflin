<!-- Internal, local-only. Not part of the public release; never merge this file (or a branch
     carrying it) into origin/main. It exists so a hive agent branching for local-only work
     always checks out from the tree the running app actually descends from, not from
     whatever `origin/main` happens to be. -->

# Production base for local-only Munder Difflin work

**The running app is NOT built from `origin/main`.** `origin/main` is the public GitHub
mainline (marketing/docs/community PRs). Production (and every local-only fix — the class of
change under the standing "everything touching Munder Difflin stays local, no push, no PR"
direction) descends from a **local-only branch that is never pushed**, currently:

```
aeon1493-maintenance-gc-0.5.2
```

## Before branching for ANY local Munder Difflin fix

1. **Do not `git fetch origin` + branch from `origin/main`.** That silently forks the wrong
   tree — it will build, typecheck, and pass its own tests, and still ship a real regression
   (missing whatever local-only fixes production already carries).
2. Confirm the branch named above is still current by checking it against the REAL installed
   app, not by trusting this file alone (a file can go stale; a running binary can't lie about
   its own version):
   ```
   npx --yes @electron/asar extract "/Applications/Munder Difflin.app/Contents/Resources/app.asar" /tmp/md-base-check
   cat /tmp/md-base-check/package.json | grep '"version"'   # must match this branch's version
   rm -rf /tmp/md-base-check
   ```
   If they don't match, a NEWER local-only branch exists somewhere and this file is stale —
   find it (`for b in $(git branch --format='%(refname:short)'); do git show $b:package.json
   2>/dev/null | grep -m1 version; done`) and update the branch name above in the same commit
   that fixes whatever you were about to fix.
3. Branch from that name, not from `origin/main`:
   ```
   git checkout -b <your-branch> aeon1493-maintenance-gc-0.5.2
   ```

## Why this file exists

AEON-1523 (2026-09-14): two reviewed, PASSED branches (AEON-1510's async git/commit
conversion, AEON-1513's mine-guard watchdog) were built and reviewed entirely against
`origin/main`, discovered only when a build card's own base check pulled the real app's asar
and found the running v0.5.3 didn't descend from that fetch at all. The real base carried a
fix (`365e9e1f`, periodic maintenance gc) for the exact freeze the async-commit work was also
trying to solve — including a documented prior attempt at the same async rewrite that had
already been tried and reverted, for measured reasons neither branch's author nor its
reviewer could have known about from the tree they were given. Re-basing and re-verifying
against the correct tree surfaced two more real, previously invisible gaps. Full writeup:
`agents/jim-mstom791/patches/AEON-1523-rebased-async-commit.README.md` in the hive repo.

Keep this file's branch name current whenever a new local-only base is cut. A stale marker
is worse than no marker — it launders exactly the mistake it exists to prevent.
