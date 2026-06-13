/**
 * AI-Native Team Workspace — Database seed script.
 *
 * Provisions the single workspace required by the MVP. Every
 * brand-identifying value (workspace name, AI colleague names, email
 * domain) is read from environment configuration so the codebase ships
 * no hard-coded external brand. Development falls back to the
 * OneCrew / Ada / Hopper / onecrew.local fixture so local dev and e2e
 * keep working unchanged; production refuses to seed
 * without explicit configuration (mirrors the SEED_HUMAN_PASSWORD
 * discipline from audit M5).
 *
 *   - 1 Workspace (id from `WORKSPACE_ID`, name from `WORKSPACE_NAME`)
 *   - 3 human users with bcrypt-hashed passwords
 *   - N AI colleagues from `AI_AGENT_NAMES_JSON` (default: 2)
 *   - 2 default channels: `#general` and `#engineering`
 *
 * All writes use `upsert` to remain idempotent across re-runs.
 *
 * Run via `npm run prisma:seed` or `npx prisma db seed`.
 *
 * Validates: Requirements 1.6, 4.1, 4.3; Phase 1 Req 16.1, 16.2.
 */

import { PrismaClient, type Prisma } from '@prisma/client';
import { hashSync } from 'bcryptjs';

const prisma = new PrismaClient();

const IS_PRODUCTION = process.env.NODE_ENV === 'production';

/** Workspace identifier — keep aligned with `.env` `WORKSPACE_ID`. */
const WORKSPACE_ID: string = process.env.WORKSPACE_ID ?? 'ws_default';

/**
 * Development defaults. These keep local dev + e2e
 * (`mia@onecrew.local` / Ada / Hopper) working without any env
 * configuration. Production never uses these — see
 * {@link resolveBrandValue}.
 */
const DEV_WORKSPACE_NAME = 'OneCrew Demo Workspace';
const DEV_EMAIL_DOMAIN = 'onecrew.local';
const DEV_AGENTS_JSON = JSON.stringify([
  {
    id: 'user_ai_ada',
    name: 'Ada',
    aiRole: 'Ada',
    mentionAliases: ['艾达', '阿达', 'ada'],
  },
  {
    id: 'user_ai_hopper',
    name: 'Hopper',
    aiRole: 'Hopper',
    mentionAliases: ['霍珀', '霍普', '哈珀', '哈柏', 'hopper'],
  },
]);

/**
 * Resolve a brand value from env, falling back to the dev default.
 * In production, a missing env var is fatal — we refuse to silently
 * seed the demo brand into a real deployment.
 */
function resolveBrandValue(
  envKey: string,
  devDefault: string,
  label: string,
): string {
  const fromEnv = process.env[envKey]?.trim();
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  if (IS_PRODUCTION) {
    throw new Error(
      `${envKey} must be set when NODE_ENV=production. Refusing to seed the demo ${label}.`,
    );
  }
  return devDefault;
}

const WORKSPACE_NAME = resolveBrandValue(
  'WORKSPACE_NAME',
  DEV_WORKSPACE_NAME,
  'workspace name',
);
const EMAIL_DOMAIN = resolveBrandValue(
  'SEED_EMAIL_DOMAIN',
  DEV_EMAIL_DOMAIN,
  'email domain',
);

/**
 * Demo password shared by every seeded human user.
 *
 * Resolution order:
 *   1. `SEED_HUMAN_PASSWORD` env var.
 *   2. Falls back to `'password123'` ONLY in development. Production
 *      throws (audit finding M5).
 */
function resolveSeedPassword(): string {
  const fromEnv = process.env.SEED_HUMAN_PASSWORD?.trim();
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  if (IS_PRODUCTION) {
    throw new Error(
      'SEED_HUMAN_PASSWORD must be set when NODE_ENV=production. Refusing to seed with the demo default.',
    );
  }
  console.warn(
    '[seed] Using insecure default password "password123" because SEED_HUMAN_PASSWORD is not set.\n' +
      '       This is acceptable for local development ONLY. Set SEED_HUMAN_PASSWORD for any deployed environment.',
  );
  return 'password123';
}

/**
 * bcrypt cost factor. OWASP 2024 guidance recommends `>= 12`
 * (audit finding M6).
 */
const BCRYPT_ROUNDS = Number.parseInt(process.env.SEED_BCRYPT_ROUNDS ?? '12', 10);

interface HumanSeed {
  readonly localPart: string;
  readonly name: string;
}

interface AISeed {
  readonly id: string;
  readonly name: string;
  /** Optional role key; only the seeded defaults map to a system prompt. */
  readonly aiRole: string | null;
  /** Additional @-mention aliases written to `aiSettings.mentionAliases`. */
  readonly mentionAliases: readonly string[];
}

interface ChannelSeed {
  readonly id: string;
  readonly name: string;
}

const HUMAN_USERS: readonly HumanSeed[] = [
  { localPart: 'mia', name: 'Mia' },
  { localPart: 'dev', name: 'Dev' },
  { localPart: 'pm', name: 'PM' },
] as const;

const CHANNELS: readonly ChannelSeed[] = [
  { id: 'chan_general', name: 'general' },
  { id: 'chan_engineering', name: 'engineering' },
] as const;

/** Build a full email address from a local part and the configured domain. */
function emailFor(localPart: string): string {
  return `${localPart}@${EMAIL_DOMAIN}`;
}

/**
 * Parse and validate `AI_AGENT_NAMES_JSON` (or the dev default).
 *
 * Validation lives here (not in `lib/env.ts`) so a malformed value
 * only fails `prisma:seed`, never a running server process. Each entry
 * must carry a non-empty `name`; `id`, `aiRole`, and `mentionAliases`
 * are optional. A stable `id` is derived from the lowercased name when
 * not supplied so re-runs stay idempotent.
 */
function resolveAIAgents(): AISeed[] {
  const raw = process.env.AI_AGENT_NAMES_JSON?.trim();
  if (!raw || raw.length === 0) {
    if (IS_PRODUCTION) {
      throw new Error(
        'AI_AGENT_NAMES_JSON must be set when NODE_ENV=production. Refusing to seed the demo Ada/Hopper agents.',
      );
    }
    return parseAgents(DEV_AGENTS_JSON);
  }
  return parseAgents(raw);
}

function parseAgents(json: string): AISeed[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    throw new Error(
      `AI_AGENT_NAMES_JSON is not valid JSON: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('AI_AGENT_NAMES_JSON must be a non-empty JSON array.');
  }

  return parsed.map((entry, index): AISeed => {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(`AI_AGENT_NAMES_JSON[${index}] must be an object.`);
    }
    const record = entry as Record<string, unknown>;
    const name = typeof record.name === 'string' ? record.name.trim() : '';
    if (name.length === 0) {
      throw new Error(
        `AI_AGENT_NAMES_JSON[${index}].name must be a non-empty string.`,
      );
    }
    const id =
      typeof record.id === 'string' && record.id.trim().length > 0
        ? record.id.trim()
        : `user_ai_${name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`;
    const aiRole =
      typeof record.aiRole === 'string' && record.aiRole.trim().length > 0
        ? record.aiRole.trim()
        : null;
    const mentionAliases = Array.isArray(record.mentionAliases)
      ? record.mentionAliases.filter(
          (a): a is string => typeof a === 'string' && a.trim().length > 0,
        )
      : [];
    return { id, name, aiRole, mentionAliases };
  });
}

const AI_USERS: readonly AISeed[] = resolveAIAgents();

/** Upsert the single workspace required by the MVP. */
async function seedWorkspace(): Promise<void> {
  await prisma.workspace.upsert({
    where: { id: WORKSPACE_ID },
    update: { name: WORKSPACE_NAME },
    create: {
      id: WORKSPACE_ID,
      name: WORKSPACE_NAME,
    },
  });
  console.log(`✓ Workspace ${WORKSPACE_ID} (${WORKSPACE_NAME})`);
}

/**
 * Upsert all human users sharing the same bcrypt-hashed demo password.
 * Re-runs always re-assert `isAI=false` and clear `aiRole`.
 */
async function seedHumans(passwordHash: string): Promise<void> {
  for (const human of HUMAN_USERS) {
    const email = emailFor(human.localPart);
    const data: Prisma.UserUncheckedCreateInput = {
      email,
      name: human.name,
      passwordHash,
      isAI: false,
      aiRole: null,
      workspaceId: WORKSPACE_ID,
    };
    await prisma.user.upsert({
      where: { email },
      update: {
        name: data.name,
        passwordHash: data.passwordHash,
        isAI: data.isAI,
        aiRole: data.aiRole,
        workspaceId: data.workspaceId,
      },
      create: data,
    });
    console.log(`✓ Human user ${email}`);
  }
}

/**
 * Upsert the AI colleagues. AI users have `passwordHash = null` so the
 * Credentials provider can never authenticate as them.
 *
 * `mentionAliases` from the agent config is written to
 * `aiSettings.mentionAliases`; the runtime (`MessageService`) reads it
 * to resolve `@`-mentions, replacing the brand-specific table that used
 * to live in `lib/services/message.service.ts` (Phase 1 Req 16.2).
 */
async function seedAIs(): Promise<void> {
  for (const ai of AI_USERS) {
    const email = emailFor(ai.name.toLowerCase());
    const aiSettings: Prisma.InputJsonValue = {
      systemPrompt: '',
      toolSet: [],
      mentionAliases: [...ai.mentionAliases],
      avatarUrl: null,
    };
    const data: Prisma.UserUncheckedCreateInput = {
      id: ai.id,
      email,
      name: ai.name,
      passwordHash: null,
      isAI: true,
      aiRole: ai.aiRole,
      aiStatus: 'active',
      aiSettings,
      workspaceId: WORKSPACE_ID,
    };
    await prisma.user.upsert({
      where: { email },
      update: {
        name: data.name,
        passwordHash: data.passwordHash,
        isAI: data.isAI,
        aiRole: data.aiRole,
        aiStatus: data.aiStatus,
        aiSettings,
        workspaceId: data.workspaceId,
      },
      create: data,
    });
    console.log(
      `✓ AI colleague ${ai.name}${ai.aiRole ? ` (aiRole=${ai.aiRole})` : ''}`,
    );
  }
}

/** Upsert the two default channels (`#general`, `#engineering`). */
async function seedChannels(): Promise<void> {
  for (const channel of CHANNELS) {
    await prisma.channel.upsert({
      where: { id: channel.id },
      update: {
        name: channel.name,
        workspaceId: WORKSPACE_ID,
      },
      create: {
        id: channel.id,
        name: channel.name,
        workspaceId: WORKSPACE_ID,
      },
    });
    console.log(`✓ Channel #${channel.name}`);
  }
}

/**
 * Seed channel memberships (Phase 1 Req 17). Every seeded user — human
 * and AI — joins every seeded channel, reproducing the pre-membership
 * "everyone in every channel" behaviour so a fresh seed works without
 * the operator manually adding members. Idempotent via composite-key
 * upsert.
 */
async function seedChannelMembers(): Promise<void> {
  const users = await prisma.user.findMany({
    where: { workspaceId: WORKSPACE_ID },
    select: { id: true, isAI: true },
  });
  let count = 0;
  for (const channel of CHANNELS) {
    for (const user of users) {
      await prisma.channelMember.upsert({
        where: {
          channelId_userId: { channelId: channel.id, userId: user.id },
        },
        update: { role: user.isAI ? 'ai' : 'human' },
        create: {
          channelId: channel.id,
          userId: user.id,
          role: user.isAI ? 'ai' : 'human',
        },
      });
      count++;
    }
  }
  console.log(`✓ Channel memberships (${count})`);
}

async function main(): Promise<void> {
  console.log(`Seeding workspace "${WORKSPACE_NAME}" (id=${WORKSPACE_ID})…`);
  const seedPassword: string = resolveSeedPassword();
  const passwordHash: string = hashSync(seedPassword, BCRYPT_ROUNDS);

  await seedWorkspace();
  await seedHumans(passwordHash);
  await seedAIs();
  await seedChannels();
  await seedChannelMembers();

  console.log('Seed complete.');
}

main()
  .catch((err: unknown) => {
    console.error('Seed failed:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
