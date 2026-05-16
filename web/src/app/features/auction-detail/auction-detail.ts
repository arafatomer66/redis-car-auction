import { Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { ApiService, Auction, Bid } from '../../core/api.service';
import { SocketService } from '../../core/socket.service';

@Component({
  selector: 'app-auction-detail',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink],
  template: `
    <section class="card">
      <a routerLink="/" class="back">← Back</a>
      @if (auction(); as a) {
        <header class="head">
          <h2>{{ a.year }} {{ a.make }} {{ a.model }}<span class="trim" *ngIf="a.trim"> {{ a.trim }}</span></h2>
          @if (a.status === 'closed') {
            <span class="pill closed">sold</span>
          } @else {
            <span class="pill live">live · {{ watchers() }} watching</span>
          }
        </header>

        <div class="specs">
          @if (a.mileage) { <span>📏 {{ a.mileage | number }} km</span> }
          @if (a.transmission) { <span>⚙ {{ a.transmission }}</span> }
          @if (a.fuel) { <span>⛽ {{ a.fuel }}</span> }
          @if (a.exterior) { <span>🎨 {{ a.exterior }}</span> }
          @if (a.location) { <span>📍 {{ a.location }}</span> }
        </div>

        @if (a.description) { <p class="desc">{{ a.description }}</p> }

        <div class="grid">
          <div class="stat"><label>Current price</label><strong>{{ '$' + a.currentPrice }}</strong></div>
          <div class="stat"><label>Top bidder</label><strong>{{ a.topBidderId || '—' }}</strong></div>
          <div class="stat"><label>Bids</label><strong>{{ a.bidCount }}</strong></div>
          <div class="stat"><label>Unique bidders</label><strong>{{ uniqueBidders() }}</strong></div>
          <div class="stat"><label>{{ a.status === 'closed' ? 'Final' : 'Ends in' }}</label><strong>{{ countdown() }}</strong></div>
        </div>

        @if (a.status === 'live') {
          <div class="bid-form">
            <input type="number" [(ngModel)]="amount" [min]="minBid()" />
            <button (click)="bid()" [disabled]="busy()">
              {{ busy() ? '...' : 'Bid $' + amount }}
            </button>
            @if (lastBidExtended()) {
              <span class="snipe">⚡ anti-snipe! +10s</span>
            }
            @if (error()) { <span class="err">{{ error() }}</span> }
          </div>
        }
      }

      <h3>Bid history</h3>
      @if (bids().length === 0) {
        <p class="muted">No bids yet.</p>
      } @else {
        <ul class="bids">
          @for (b of bids(); track b.id) {
            <li [class.flash]="b.id === flashId()">
              <span>{{ b.bidderId }}</span>
              <strong>{{ '$' + b.amount }}</strong>
            </li>
          }
        </ul>
      }
    </section>
  `,
  styles: `
    .back { color: #555; text-decoration: none; display: inline-block; margin-bottom: 12px; }
    .head { display: flex; align-items: center; gap: 12px; }
    h2 { margin: 0; flex: 1; }
    .pill { font-size: 12px; padding: 4px 10px; border-radius: 999px; }
    .pill.live { background: #dcfce7; color: #166534; }
    .pill.closed { background: #e5e7eb; color: #555; }
    .desc { color: #555; background: #f9fafb; padding: 10px 14px; border-radius: 8px; }
    .trim { color: #888; font-weight: 400; }
    .specs { display: flex; flex-wrap: wrap; gap: 14px; color: #555; font-size: 13px; margin: 10px 0; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 12px; margin: 14px 0; }
    .stat { background: #f9fafb; padding: 10px; border-radius: 8px; }
    .stat label { display: block; font-size: 11px; color: #888; text-transform: uppercase; }
    .stat strong { font-size: 16px; }
    .bid-form { display: flex; align-items: center; gap: 10px; margin: 14px 0; }
    .bid-form input { padding: 8px; border: 1px solid #d1d5db; border-radius: 6px; width: 100px; }
    .bid-form button { background: #1a1a1a; color: white; border: 0; padding: 10px 16px; border-radius: 6px; cursor: pointer; }
    .bid-form button:disabled { opacity: 0.5; }
    .snipe { color: #b91c1c; font-weight: 600; font-size: 13px; }
    .err { color: #b91c1c; font-size: 13px; }
    .bids { list-style: none; padding: 0; margin: 0; display: grid; gap: 6px; }
    .bids li { display: flex; justify-content: space-between; padding: 10px 12px; background: #f9fafb; border-radius: 6px; transition: background 0.6s ease; }
    .bids li.flash { background: #fef9c3; }
    .muted { color: #888; }
  `,
})
export class AuctionDetailComponent implements OnInit, OnDestroy {
  private route = inject(ActivatedRoute);
  private api = inject(ApiService);
  private sock = inject(SocketService);

  id = '';
  auction = signal<Auction | null>(null);
  bids = signal<Bid[]>([]);
  watchers = signal(0);
  uniqueBidders = signal(0);
  amount = 0;
  busy = signal(false);
  error = signal<string | null>(null);
  flashId = signal<string | null>(null);
  lastBidExtended = signal(false);
  countdown = signal('—');
  private tick?: ReturnType<typeof setInterval>;

  minBid = computed(() => {
    const a = this.auction();
    return a ? a.currentPrice + a.minIncrement : 0;
  });

  async ngOnInit() {
    this.id = this.route.snapshot.paramMap.get('id')!;
    await this.refresh();
    this.amount = this.minBid();

    this.sock.emit('watch', this.id);
    this.sock.on('bid', (evt: any) => this.onLiveBid(evt));
    this.sock.on('closed', (evt: any) => this.onClosed(evt));
    this.sock.on('presence', (p: any) => {
      if (p.auctionId === this.id) this.watchers.set(p.watchers);
    });

    this.tick = setInterval(() => this.updateCountdown(), 1000);
  }

  ngOnDestroy() {
    if (this.tick) clearInterval(this.tick);
    this.sock.emit('unwatch', this.id);
    this.sock.off('bid');
    this.sock.off('closed');
    this.sock.off('presence');
  }

  async refresh() {
    const [a, b, s] = await Promise.all([
      this.api.getAuction(this.id),
      this.api.listBids(this.id),
      this.api.stats(this.id),
    ]);
    this.auction.set(a);
    this.bids.set(b.items);
    this.uniqueBidders.set(s.uniqueBidders);
    this.updateCountdown();
  }

  updateCountdown() {
    const a = this.auction();
    if (!a) return;
    if (a.status === 'closed') {
      this.countdown.set('$' + a.currentPrice);
      return;
    }
    const ms = a.endsAt - Date.now();
    if (ms <= 0) { this.countdown.set('closing…'); return; }
    const s = Math.floor(ms / 1000);
    if (s < 60) this.countdown.set(`${s}s`);
    else this.countdown.set(`${Math.floor(s / 60)}m ${s % 60}s`);
  }

  async bid() {
    if (this.busy()) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      const r = await this.api.placeBid(this.id, Number(this.amount));
      if (!r.ok) {
        this.error.set(r.reason ?? 'failed');
      }
    } catch (e: any) {
      this.error.set(e.message ?? 'failed');
    } finally {
      this.busy.set(false);
    }
  }

  private onLiveBid(evt: any) {
    const a = this.auction();
    if (!a) return;
    this.auction.set({
      ...a,
      currentPrice: evt.amount,
      topBidderId: evt.bidderId,
      bidCount: evt.bidCount,
      endsAt: evt.endsAt,
    });
    this.bids.update((arr) => [
      { id: evt.bidId, bidderId: evt.bidderId, amount: evt.amount, ts: evt.ts },
      ...arr,
    ]);
    this.flashId.set(evt.bidId);
    setTimeout(() => this.flashId.set(null), 800);
    this.amount = this.minBid();
    // Detect anti-snipe: if endsAt moved forward by ~10s relative to now
    const fromNow = evt.endsAt - Date.now();
    if (fromNow > 10000 && fromNow < 20000) {
      this.lastBidExtended.set(true);
      setTimeout(() => this.lastBidExtended.set(false), 3000);
    }
    this.updateCountdown();
    this.api.stats(this.id).then((s) => this.uniqueBidders.set(s.uniqueBidders));
  }

  private onClosed(evt: any) {
    const a = this.auction();
    if (a) this.auction.set({ ...a, status: 'closed' });
    this.updateCountdown();
  }
}
