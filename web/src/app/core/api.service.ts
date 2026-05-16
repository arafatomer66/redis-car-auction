import { Injectable, inject, signal } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

export interface Auction {
  id: string;
  title: string;
  description: string;
  imageUrl: string;
  sellerId: string;
  startPrice: number;
  currentPrice: number;
  minIncrement: number;
  endsAt: number;
  status: 'live' | 'closed';
  topBidderId: string;
  bidCount: number;
  ttl?: number;
  // car-specific
  year: number;
  make: string;
  model: string;
  trim: string;
  mileage: number;
  transmission: string;
  fuel: string;
  exterior: string;
  location: string;
}

export interface CarInput {
  year: number;
  make: string;
  model: string;
  trim?: string;
  mileage: number;
  transmission: string;
  fuel: string;
  exterior?: string;
  location?: string;
  description?: string;
  imageUrl?: string;
  startPrice: number;
  minIncrement: number;
  durationSec: number;
}

export interface Bid {
  id: string;
  bidderId: string;
  amount: number;
  ts: number;
}

@Injectable({ providedIn: 'root' })
export class ApiService {
  private http = inject(HttpClient);
  private base = 'http://localhost:3000';

  readonly userId = signal<string>(
    localStorage.getItem('userId') ?? 'demo-alice',
  );

  setUser(id: string) {
    this.userId.set(id);
    localStorage.setItem('userId', id);
  }

  private headers() {
    return new HttpHeaders({ 'X-User-Id': this.userId() });
  }

  listAuctions(opts: { city?: string; radiusKm?: number; make?: string } = {}) {
    const params: string[] = [];
    if (opts.city) params.push(`city=${encodeURIComponent(opts.city)}`);
    if (opts.radiusKm) params.push(`radiusKm=${opts.radiusKm}`);
    if (opts.make) params.push(`make=${encodeURIComponent(opts.make)}`);
    const qs = params.length ? `?${params.join('&')}` : '';
    return firstValueFrom(
      this.http.get<{ items: Auction[] }>(`${this.base}/auctions${qs}`),
    );
  }

  meta() {
    return Promise.all([
      firstValueFrom(this.http.get<{ items: string[] }>(`${this.base}/auctions/meta/cities`)),
      firstValueFrom(this.http.get<{ items: string[] }>(`${this.base}/auctions/meta/makes`)),
    ]).then(([cities, makes]) => ({ cities: cities.items, makes: makes.items }));
  }

  getAuction(id: string) {
    return firstValueFrom(this.http.get<Auction>(`${this.base}/auctions/${id}`));
  }

  createAuction(body: CarInput) {
    return firstValueFrom(
      this.http.post<{ id: string; endsAt: number; title: string }>(
        `${this.base}/auctions`,
        body,
        { headers: this.headers() },
      ),
    );
  }

  listBids(auctionId: string) {
    return firstValueFrom(
      this.http.get<{ items: Bid[] }>(
        `${this.base}/auctions/${auctionId}/bids`,
      ),
    );
  }

  placeBid(auctionId: string, amount: number) {
    return firstValueFrom(
      this.http.post<{ ok: boolean; reason?: string; newPrice?: number }>(
        `${this.base}/auctions/${auctionId}/bids`,
        { amount },
        { headers: this.headers() },
      ),
    );
  }

  hotAuctions() {
    return firstValueFrom(
      this.http.get<{ items: (Auction & { hotScore: number })[] }>(
        `${this.base}/leaderboard/hot`,
      ),
    );
  }

  stats(auctionId: string) {
    return firstValueFrom(
      this.http.get<{ uniqueBidders: number }>(
        `${this.base}/leaderboard/auctions/${auctionId}/stats`,
      ),
    );
  }
}
