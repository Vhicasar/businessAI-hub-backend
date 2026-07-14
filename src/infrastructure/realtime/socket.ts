import type { Server as HttpServer } from 'http';
import { Server, type Socket } from 'socket.io';
import { env } from '../../shared/config/env';
import { logger } from '../../shared/logger';
import { tokenService } from '../../application/auth/token.service';
import { SOCKET_EVENTS, socketRooms } from '../../shared/events';

let io: Server | null = null;

interface SocketAuth {
  userId: string;
  organizationId: string | null;
}

/**
 * Socket.IO gateway. JWT is verified on the handshake; sockets join their
 * tenant and user rooms so services can broadcast with `emitToOrg`/`emitToUser`.
 * Written against the adapter API so the Redis adapter can be added for
 * horizontal scaling without code changes (Phase 8).
 */
export function initSocketServer(httpServer: HttpServer): Server {
  io = new Server(httpServer, {
    path: '/socket.io',
    cors: { origin: env.corsOrigins, credentials: true },
  });

  io.use((socket, next) => {
    try {
      const token =
        (socket.handshake.auth?.token as string | undefined) ??
        (socket.handshake.headers.authorization?.startsWith('Bearer ')
          ? socket.handshake.headers.authorization.slice(7)
          : undefined);
      if (!token) return next(new Error('Authentication required'));
      const payload = tokenService.verifyAccessToken(token);
      (socket.data as SocketAuth).userId = payload.sub;
      (socket.data as SocketAuth).organizationId = payload.org;
      next();
    } catch {
      next(new Error('Invalid token'));
    }
  });

  io.on('connection', (socket: Socket) => {
    const { userId, organizationId } = socket.data as SocketAuth;
    socket.join(socketRooms.user(userId));
    if (organizationId) socket.join(socketRooms.org(organizationId));

    logger.debug({ userId, organizationId, sid: socket.id }, 'Socket connected');

    socket.on('conversation:join', (conversationId: string) => {
      if (typeof conversationId === 'string' && conversationId.length < 64) {
        socket.join(socketRooms.conversation(conversationId));
      }
    });
    socket.on('conversation:leave', (conversationId: string) => {
      socket.leave(socketRooms.conversation(String(conversationId)));
    });
    socket.on(SOCKET_EVENTS.INBOX_TYPING, (payload: { conversationId: string }) => {
      if (payload?.conversationId) {
        socket
          .to(socketRooms.conversation(payload.conversationId))
          .emit(SOCKET_EVENTS.INBOX_TYPING, { userId, ...payload });
      }
    });

    socket.on('disconnect', () => {
      logger.debug({ userId, sid: socket.id }, 'Socket disconnected');
    });
  });

  return io;
}

export function getIo(): Server {
  if (!io) throw new Error('Socket server not initialized');
  return io;
}

export function emitToOrg(orgId: string, event: string, payload: unknown): void {
  io?.to(socketRooms.org(orgId)).emit(event, payload);
}

export function emitToUser(userId: string, event: string, payload: unknown): void {
  io?.to(socketRooms.user(userId)).emit(event, payload);
}

export function emitToConversation(conversationId: string, event: string, payload: unknown): void {
  io?.to(socketRooms.conversation(conversationId)).emit(event, payload);
}
