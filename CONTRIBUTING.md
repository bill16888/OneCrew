# Contributing to OneCrew

Thanks for taking the time to improve OneCrew.

## Before You Start

- Check existing issues and pull requests to avoid duplicate work.
- Keep changes focused. Small pull requests are easier to review and merge.
- For security issues, do not open a public issue. Follow `SECURITY.md`.

## Local Development

```bash
npm install
cp .env.example .env
npm run prisma:generate
npm run prisma:migrate
npm run prisma:seed
npm run dev
```

Update `.env` with valid local values before starting the server.

## Checks

Run the relevant checks before submitting changes:

```bash
npm run typecheck
npm run lint
npm run test
```

For UI or workflow changes, also run:

```bash
npm run test:e2e
```

## Pull Request Guidelines

- Explain what changed and why.
- Include screenshots or recordings for visible UI changes.
- Mention any environment or migration impact.
- Add or update tests when behavior changes.
- Keep secrets out of commits. Use `.env.example` for placeholders only.

## Commit Style

Use short, descriptive commit messages. Conventional prefixes are welcome:

- `feat:`
- `fix:`
- `docs:`
- `test:`
- `refactor:`
- `chore:`
