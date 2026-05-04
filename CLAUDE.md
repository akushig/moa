# moa — 프로젝트 규칙

## Git author / committer (필수)

이 repo 의 모든 commit 은 **개인 GitHub 계정** 으로만 작성. 회사 메일 절대 사용 금지.

새 clone / 새 worktree 시작 전에 반드시 repo-local 설정 적용:

```bash
git config user.email <personal-github-email>
git config user.name  <personal-handle>
```

(global git config 는 회사 repo 와 충돌하므로 건드리지 말고 repo-local 만 설정.)

기존에 회사 메일로 박힌 commit 이 발견되면 즉시 `git filter-branch` 또는 `git filter-repo` 로 rewrite + `--force-with-lease` push.

## 컨벤션

- v0.1 = 1인 dogfood. multi-user / OAuth 는 v0.5+.
- secrets 는 모두 `.env.local` (gitignored). repo 안에는 `process.env.X` 참조만.
- 거래소 호출은 GCP 워커 (`worker/`) 에서만. Vercel app 은 DB read + 워커 proxy 만.
- Prisma `db push` 가 libsql URL 못 다루므로 schema 변경 시 `scripts/migrate.mjs` 사용.
