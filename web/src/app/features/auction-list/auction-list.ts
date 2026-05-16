import { Component, OnInit, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { ApiService, Auction } from '../../core/api.service';

@Component({
  selector: 'app-auction-list',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink],
  template: `
    <section class="card">
      <div class="head">
        <h2>🚗 Live car auctions</h2>
        <a routerLink="/new" class="btn">+ List a car</a>
      </div>

      <div class="filters">
        <div class="row">
          <label>📍 Near</label>
          <select [(ngModel)]="city" (ngModelChange)="reload()">
            <option value="">Anywhere</option>
            @for (c of cities(); track c) { <option [value]="c">{{ c }}</option> }
          </select>
          @if (city) {
            <select [(ngModel)]="radius" (ngModelChange)="reload()">
              <option [value]="50">within 50 km</option>
              <option [value]="150">within 150 km</option>
              <option [value]="300">within 300 km</option>
              <option [value]="1000">within 1000 km</option>
            </select>
          }
        </div>
        <div class="row">
          <label>🏭 Make</label>
          <div class="chips">
            <button class="chip" [class.on]="!make" (click)="setMake('')">All</button>
            @for (m of makes(); track m) {
              <button class="chip" [class.on]="make === m" (click)="setMake(m)">{{ m }}</button>
            }
          </div>
        </div>
      </div>

      @if (loading()) {
        <p>Loading…</p>
      } @else if (items().length === 0) {
        <p class="muted">No cars match this filter.</p>
      } @else {
        <p class="count">{{ items().length }} car{{ items().length === 1 ? '' : 's' }}</p>
        <ul class="list">
          @for (a of items(); track a.id) {
            <li>
              <a [routerLink]="['/auctions', a.id]">
                <div class="title-row">
                  <strong>{{ a.year }} {{ a.make }} {{ a.model }}<span class="trim" *ngIf="a.trim"> {{ a.trim }}</span></strong>
                  <span class="price">{{ '$' + a.currentPrice }}</span>
                </div>
                <div class="specs">
                  @if (a.mileage) { <span>📏 {{ a.mileage | number }} km</span> }
                  @if (a.transmission) { <span>⚙ {{ a.transmission }}</span> }
                  @if (a.fuel) { <span>⛽ {{ a.fuel }}</span> }
                  @if (a.location) { <span>📍 {{ a.location }}</span> }
                </div>
                <div class="meta">
                  <span>{{ a.bidCount }} bids</span>
                  <span class="dot"></span>
                  <span>ends in {{ remaining(a) }}</span>
                </div>
              </a>
            </li>
          }
        </ul>
      }
    </section>
  `,
  styles: `
    .head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
    .btn { background: #1a1a1a; color: white; padding: 6px 14px; border-radius: 6px; text-decoration: none; font-size: 13px; }
    .filters { background: #f9fafb; padding: 12px; border-radius: 8px; margin-bottom: 14px; display: grid; gap: 8px; }
    .filters .row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .filters label { font-size: 13px; color: #555; min-width: 60px; }
    .filters select { padding: 4px 8px; border: 1px solid #d1d5db; border-radius: 6px; background: white; }
    .chips { display: flex; gap: 6px; flex-wrap: wrap; }
    .chip { background: white; border: 1px solid #d1d5db; padding: 4px 12px; border-radius: 999px; cursor: pointer; font-size: 13px; }
    .chip.on { background: #1a1a1a; color: white; border-color: #1a1a1a; }
    .count { color: #888; font-size: 12px; margin: 0 0 8px; }
    .list { list-style: none; padding: 0; margin: 0; display: grid; gap: 10px; }
    .list li a { display: block; padding: 14px; border: 1px solid #e5e7eb; border-radius: 10px; text-decoration: none; color: inherit; }
    .list li a:hover { border-color: #1a1a1a; box-shadow: 0 4px 16px rgba(0,0,0,0.04); }
    .title-row { display: flex; justify-content: space-between; gap: 12px; }
    .trim { color: #666; font-weight: 400; }
    .price { font-weight: 700; color: #166534; font-size: 18px; white-space: nowrap; }
    .specs { color: #555; font-size: 13px; display: flex; flex-wrap: wrap; gap: 14px; margin-top: 6px; }
    .meta { color: #888; font-size: 12px; display: flex; align-items: center; gap: 8px; margin-top: 8px; }
    .meta .dot { width: 3px; height: 3px; background: #888; border-radius: 50%; }
    .muted { color: #888; }
  `,
})
export class AuctionListComponent implements OnInit {
  private api = inject(ApiService);
  items = signal<Auction[]>([]);
  loading = signal(true);
  cities = signal<string[]>([]);
  makes = signal<string[]>([]);

  city = '';
  radius = 200;
  make = '';

  async ngOnInit() {
    const meta = await this.api.meta();
    this.cities.set(meta.cities);
    this.makes.set(meta.makes);
    await this.reload();
  }

  async reload() {
    this.loading.set(true);
    const r = await this.api.listAuctions({
      city: this.city,
      radiusKm: this.radius,
      make: this.make,
    });
    this.items.set(r.items.filter((a) => a.status === 'live'));
    this.loading.set(false);
  }

  setMake(m: string) {
    this.make = m;
    this.reload();
  }

  remaining(a: Auction) {
    const ms = a.endsAt - Date.now();
    if (ms <= 0) return 'ended';
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    return `${m}m ${s % 60}s`;
  }
}
