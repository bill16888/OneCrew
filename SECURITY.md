# Security Policy

## Supported Versions

OneCrew is currently an early-stage MVP. Security fixes target the `main` branch.

## Reporting a Vulnerability

Please do not report security vulnerabilities in public GitHub issues.

If you discover a vulnerability, contact the maintainer privately through the email address listed on the GitHub profile for `bill16888`, or open a private advisory if you have repository access.

Include as much detail as possible:

- affected commit or version
- reproduction steps
- expected impact
- relevant logs or screenshots
- whether credentials, user data, or deployment secrets are involved

The maintainer will review the report and coordinate a fix before public disclosure.

## Secret Handling

Never commit real values for:

- `NEXTAUTH_SECRET`
- AI provider API keys
- `RAILWAY_TOKEN`
- database URLs with real credentials
- Sentry auth tokens
- backup storage credentials

Use `.env.example` and `.env.production.example` for placeholders only.
