/**
 * AI-Native Team Workspace — Database seed script.
 *
 * Provisions the hardcoded single workspace required by the MVP:
 *   - 1 Workspace (id from `process.env.WORKSPACE_ID`, default `ws_default`)
 *   - 3 human users with bcrypt-hashed passwords (demo credentials)
 *   - 2 AI colleagues: `Ada` (AI Engineer) and `Hopper` (AI Project Manager),
 *     both with `isAI = true`, `passwordHash = null`, distinct `aiRole`
 *   - 2 default channels: `#general` and `#engineering`
 *
 * All writes use `upsert` to remain idempotent across re-runs (humans match by
 * `email`, AIs match by `email`, the workspace and channels match by `id`).
 *
 * Run via `npm run prisma:seed` or `npx prisma db seed` (the `prisma.seed`
 * field is configured in `package.json`).
 *
 * Validates: Requirements 1.6, 4.1, 4.3
 */

import { PrismaClient, type Prisma } from '@prisma/client';
import { hashSync } from 'bcryptjs';

const prisma = new PrismaClient();

/** Workspace identifier — keep aligned with `.env` `WORKSPACE_ID`. */
const WORKSPACE_ID: string = process.env.WORKSPACE_ID ?? 'ws_default';
const WORKSPACE_NAME = 'Helio Demo Workspace';
/** Demo password shared by every seeded human user. Documented in README. */
const HUMAN_PASSWORD = 'password123';
const BCRYPT_ROUNDS = 10;

interface HumanSeed {
  readonly email: string;
  readonly name: string;
}

interface AISeed {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly aiRole: 'Ada' | 'Hopper';
}

interface ChannelSeed {
  readonly id: string;
  readonly name: string;
}

const HUMAN_USERS: readonly HumanSeed[] = [
  { email: 'mia@helio.local', name: 'Mia' },
  { email: 'dev@helio.local', name: 'Dev' },
  { email: 'pm@helio.local', name: 'PM' },
] as const;

const AI_USERS: readonly AISeed[] = [
  { id: 'user_ai_ada', email: 'ada@helio.local', name: 'Ada', aiRole: 'Ada' },
  { id: 'user_ai_hopper', email: 'hopper@helio.local', name: 'Hopper', aiRole: 'Hopper' },
] as const;

const CHANNELS: readonly ChannelSeed[] = [
  { id: 'chan_general', name: 'general' },
  { id: 'chan_engineering', name: 'engineering' },
] as const;

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
    const data: Prisma.UserUncheckedCreateInput = {
      email: human.email,
      name: human.name,
      passwordHash,
      isAI: false,
      aiRole: null,
      workspaceId: WORKSPACE_ID,
    };
    await prisma.user.upsert({
      where: { email: human.email },
      update: {
        name: data.name,
        passwordHash: data.passwordHash,
        isAI: data.isAI,
        aiRole: data.aiRole,
        workspaceId: data.workspaceId,
      },
      create: data,
    });
    console.log(`✓ Human user ${human.email}`);
  }
}

/**
 * Upsert the AI colleagues. AI users have `passwordHash = null` so the
 * Credentials provider can never authenticate as them.
 */
async function seedAIs(): Promise<void> {
  for (const ai of AI_USERS) {
    const data: Prisma.UserUncheckedCreateInput = {
      id: ai.id,
      email: ai.email,
      name: ai.name,
      passwordHash: null,
      isAI: true,
      aiRole: ai.aiRole,
      workspaceId: WORKSPACE_ID,
    };
    await prisma.user.upsert({
      where: { email: ai.email },
      update: {
        name: data.name,
        passwordHash: data.passwordHash,
        isAI: data.isAI,
        aiRole: data.aiRole,
        workspaceId: data.workspaceId,
      },
      create: data,
    });
    console.log(`✓ AI colleague ${ai.name} (aiRole=${ai.aiRole})`);
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

async function main(): Promise<void> {
  console.log(`Seeding workspace "${WORKSPACE_NAME}" (id=${WORKSPACE_ID})…`);
  const passwordHash: string = hashSync(HUMAN_PASSWORD, BCRYPT_ROUNDS);

  await seedWorkspace();
  await seedHumans(passwordHash);
  await seedAIs();
  await seedChannels();

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
