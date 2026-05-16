import { Injectable, effect, inject } from '@angular/core';
import { io, Socket } from 'socket.io-client';
import { ApiService } from './api.service';

@Injectable({ providedIn: 'root' })
export class SocketService {
  private api = inject(ApiService);
  private socket: Socket | null = null;

  constructor() {
    effect(() => {
      const userId = this.api.userId();
      if (this.socket) this.socket.disconnect();
      this.socket = io('http://localhost:3000', { auth: { userId } });
    });
  }

  on<T = unknown>(event: string, handler: (payload: T) => void) {
    this.socket?.on(event, handler as (p: unknown) => void);
  }

  off(event: string) {
    this.socket?.off(event);
  }

  emit(event: string, ...args: unknown[]) {
    this.socket?.emit(event, ...args);
  }

  pullNotifications(lastId: string, cb: (r: { items: any[] }) => void) {
    this.socket?.emit('notifications:pull', lastId, cb);
  }
}
