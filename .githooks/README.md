# Push policy

This repository keeps the private development history on local `main` and
publishes only the squashed `public-main` snapshot.

Activate the tracked hooks in a fresh clone:

```powershell
git config core.hooksPath .githooks
```

The pre-push hook permits exactly this mapping:

```text
local public-main -> remote main
```

Use:

```powershell
git push origin public-main:main
```

The hook intentionally rejects development branches, tags, branch deletions,
and any other ref mapping. Git hooks are local safeguards; GitHub branch
protection should be enabled separately for server-side enforcement.
