import { Component, inject, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { RouterOutlet } from '@angular/router';
import { ApiService } from './core/api.service';
import { SocketService } from './core/socket.service';

type Health = { redis: string; db: string; uptime: number };

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, DecimalPipe],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {
  private http = inject(HttpClient);
  private api = inject(ApiService);
  // Eagerly inject SocketService so it connects when the app boots.
  private _sock = inject(SocketService);

  protected readonly health = signal<Health | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly currentUser = this.api.userId;

  constructor() {
    this.refresh();
    setInterval(() => this.refresh(), 5000);
  }

  refresh() {
    this.http.get<Health>('http://localhost:3000/health').subscribe({
      next: (h) => this.health.set(h),
      error: (e) => this.error.set(e.message ?? 'API unreachable'),
    });
  }

  switchUser(id: string) {
    this.api.setUser(id);
  }
}
