import '../../setup';

/**
 * @file Property 25 — Socket.io 会话校验。
 *
 * createIOServer 安装的握手中间件 (lib/realtime/io.ts) 必须满足:
 *
 *   - 当 socket.handshake.auth.sessionToken 是用 NEXTAUTH_SECRET 编码、
 *     payload 含 uid (或 sub) 的合法 JWT 时:
 *       - next() 被调用 (无 Error)
 *       - socket.data.userId 被填为该 uid
 *
 *   - 当 sessionToken 缺失，且 cookie 也没有时:
 *       - next(Error('unauthenticated')) 被调用
 *       - socket.data.userId 不被设置
 *
 *   - 当 sessionToken 是无法 decode 的乱码时:
 *       - next(Error('SESSION_EXPIRED')) 被调用
 *       - socket.data.userId 不被设置
 *
 * 这条属性确保未登录 / session 过期的客户端永远拿不到 workspace
 * room 的实时事件 (Requirements 8.2, 8.3, 任务 4.7)。
 *
 * 我们直接捕获 io.use() 注册的 middleware 函数，绕过真实 HTTP server +
 * socket.io 握手；这样既避开 Windows 端口占用，也让属性单测可以
 * 在毫秒级跑完。
 *
 * Validates: Requirements 8.2, 8.3 (P2 task 4.7).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import { encode } from 'next-auth/jwt';

type MiddlewareFn = (
  socket: {
    handshake: { auth?: Record<string, unknown> };
    request: unknown;
    data: { userId?: string };
  },
  next: (err?: Error) => void,
) => Promise<void> | void;

interface CapturedServer {
  middleware: MiddlewareFn | null;
  // io.on('connection', handler) — not used in these tests
  connectionHandler: ((socket: unknown) => void) | null;
}

const captured: CapturedServer = {
  middleware: null,
  connectionHandler: null,
};

// Stub socket.io 的 Server 构造器: 暴露我们注册的 middleware 给测试断言。
vi.mock('socket.io', () => ({
  Server: class {
    constructor() {
      // noop
    }
    use(fn: MiddlewareFn) {
      captured.middleware = fn;
      return this;
    }
    on(event: string, handler: (socket: unknown) => void) {
      if (event === 'connection') {
        captured.connectionHandler = handler;
      }
      return this;
    }
  },
}));

// logger 真实导入会拖入 pino + 文件路径解析；为了让 io.ts 可以
// 安全在 test 环境跑，我们 stub 掉。
vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { createIOServer } from '@/lib/realtime/io';

const SECRET = process.env.NEXTAUTH_SECRET as string;

beforeEach(() => {
  captured.middleware = null;
  captured.connectionHandler = null;
});

afterEach(() => {
  vi.clearAllMocks();
});

/** 触发 io.ts 把 middleware 注册到我们的 stub 上。 */
function buildMiddleware(): MiddlewareFn {
  // We don't actually need the http server here; the stub Server above
  // just records the middleware.
  createIOServer({} as never);
  if (!captured.middleware) throw new Error('middleware not captured');
  return captured.middleware;
}

interface NextResult {
  called: boolean;
  err: Error | undefined;
}

async function runMiddleware(
  middleware: MiddlewareFn,
  auth: Record<string, unknown> | undefined,
): Promise<{
  next: NextResult;
  socket: { handshake: { auth?: Record<string, unknown> }; request: unknown; data: { userId?: string } };
}> {
  const socket = {
    handshake: { auth: auth ?? {} },
    // request stays as a bare object: getToken({req}) cannot find the
    // cookie, so it returns null and we fall through to whichever
    // branch was asked of us (auth-token branch when sessionToken is
    // present, unauthenticated otherwise).
    request: { headers: {} },
    data: {} as { userId?: string },
  };
  const next: NextResult = { called: false, err: undefined };
  await Promise.resolve(
    middleware(socket, (err) => {
      next.called = true;
      next.err = err;
    }),
  );
  return { next, socket };
}

describe('Feature: ai-native-team-workspace, Property 25: Socket.io 会话校验', () => {
  it('合法 sessionToken (含 uid) 通过校验，socket.data.userId 被填', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 5, maxLength: 30 }).filter((s) => /^[A-Za-z0-9_-]+$/.test(s)),
        async (uid) => {
          const middleware = buildMiddleware();
          const token = await encode({
            token: { uid, sub: uid, name: uid },
            secret: SECRET,
          });
          const { next, socket } = await runMiddleware(middleware, {
            sessionToken: token,
          });
          expect(next.called).toBe(true);
          expect(next.err).toBeUndefined();
          expect(socket.data.userId).toBe(uid);
        },
      ),
      { numRuns: 20 },
    );
  });

  it('完全没 token 且无 cookie：next(Error("unauthenticated"))，socket.data.userId 不设置', async () => {
    const middleware = buildMiddleware();
    const { next, socket } = await runMiddleware(middleware, undefined);
    expect(next.called).toBe(true);
    expect(next.err).toBeInstanceOf(Error);
    expect(next.err?.message).toBe('unauthenticated');
    expect(socket.data.userId).toBeUndefined();
  });

  it('sessionToken 是不可 decode 的乱码：next(Error("SESSION_EXPIRED"))', async () => {
    const middleware = buildMiddleware();
    const { next, socket } = await runMiddleware(middleware, {
      sessionToken: 'this-is-not-a-jwt-at-all',
    });
    expect(next.called).toBe(true);
    expect(next.err).toBeInstanceOf(Error);
    expect(next.err?.message).toBe('SESSION_EXPIRED');
    expect(socket.data.userId).toBeUndefined();
  });

  it('sessionToken 是合法 JWT 但 payload 既无 uid 也无 sub：next(Error("SESSION_EXPIRED"))', async () => {
    const middleware = buildMiddleware();
    const token = await encode({
      // payload 无 uid 也无 sub
      token: { name: 'no-id' },
      secret: SECRET,
    });
    const { next, socket } = await runMiddleware(middleware, {
      sessionToken: token,
    });
    expect(next.called).toBe(true);
    expect(next.err).toBeInstanceOf(Error);
    expect(next.err?.message).toBe('SESSION_EXPIRED');
    expect(socket.data.userId).toBeUndefined();
  });
});
