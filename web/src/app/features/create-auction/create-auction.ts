import { Component, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { ApiService } from '../../core/api.service';

@Component({
  selector: 'app-create-auction',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink],
  template: `
    <section class="card">
      <a routerLink="/" class="back">← Back to listings</a>
      <h2>List your car</h2>
      <p class="muted">All fields drive Redis writes — see <code>auctionRepo.ts</code>.</p>

      <form (submit)="$event.preventDefault(); submit()">
        <div class="row3">
          <label>Year<input [(ngModel)]="year" name="year" type="number" min="1900" max="2030" required /></label>
          <label>Make<input [(ngModel)]="make" name="make" placeholder="Toyota" required /></label>
          <label>Model<input [(ngModel)]="model" name="model" placeholder="Corolla" required /></label>
        </div>
        <div class="row3">
          <label>Trim (optional)<input [(ngModel)]="trim" name="trim" placeholder="GR Sport" /></label>
          <label>Mileage (km)<input [(ngModel)]="mileage" name="mileage" type="number" min="0" required /></label>
          <label>Exterior color<input [(ngModel)]="exterior" name="exterior" placeholder="Pearl White" /></label>
        </div>
        <div class="row3">
          <label>Transmission
            <select [(ngModel)]="transmission" name="transmission">
              <option value="auto">Automatic</option>
              <option value="manual">Manual</option>
              <option value="cvt">CVT</option>
              <option value="dct">DCT</option>
              <option value="other">Other</option>
            </select>
          </label>
          <label>Fuel
            <select [(ngModel)]="fuel" name="fuel">
              <option value="petrol">Petrol</option>
              <option value="diesel">Diesel</option>
              <option value="hybrid">Hybrid</option>
              <option value="ev">Electric</option>
              <option value="lpg">LPG</option>
              <option value="cng">CNG</option>
            </select>
          </label>
          <label>Location<input [(ngModel)]="location" name="location" placeholder="Dhaka" /></label>
        </div>
        <label>Image URL (optional)<input [(ngModel)]="imageUrl" name="imageUrl" type="url" placeholder="https://…" /></label>
        <label>Notes / condition<textarea [(ngModel)]="description" name="description" rows="3" placeholder="Service history, accidents, modifications, …"></textarea></label>
        <div class="row3">
          <label>Start price (\${{ '' }})<input [(ngModel)]="startPrice" name="startPrice" type="number" min="1" /></label>
          <label>Min increment (\${{ '' }})<input [(ngModel)]="minIncrement" name="minIncrement" type="number" min="1" /></label>
          <label>Duration (sec)<input [(ngModel)]="durationSec" name="durationSec" type="number" min="10" /></label>
        </div>

        @if (error()) { <p class="error">{{ error() }}</p> }
        <button [disabled]="busy()">{{ busy() ? 'Listing…' : '🚗 List for auction' }}</button>
      </form>
    </section>
  `,
  styles: `
    .back { color: #555; text-decoration: none; display: inline-block; margin-bottom: 12px; }
    .muted { color: #888; font-size: 13px; margin: 0 0 16px; }
    code { background: #f3f4f6; padding: 1px 5px; border-radius: 3px; font-size: 12px; }
    form { display: grid; gap: 12px; }
    label { display: grid; gap: 4px; font-size: 13px; color: #555; }
    input, textarea, select { padding: 8px; border: 1px solid #d1d5db; border-radius: 6px; font: inherit; background: white; }
    .row3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
    @media (max-width: 600px) { .row3 { grid-template-columns: 1fr; } }
    button { background: #1a1a1a; color: white; border: 0; padding: 12px; border-radius: 6px; cursor: pointer; font-size: 15px; }
    button:disabled { opacity: 0.5; }
    .error { color: #b91c1c; }
  `,
})
export class CreateAuctionComponent {
  private api = inject(ApiService);
  private router = inject(Router);

  year = 2020;
  make = '';
  model = '';
  trim = '';
  mileage = 50000;
  transmission = 'auto';
  fuel = 'petrol';
  exterior = '';
  location = '';
  imageUrl = '';
  description = '';
  startPrice = 5000;
  minIncrement = 100;
  durationSec = 180;

  busy = signal(false);
  error = signal<string | null>(null);

  async submit() {
    this.busy.set(true);
    this.error.set(null);
    try {
      const r = await this.api.createAuction({
        year: Number(this.year),
        make: this.make,
        model: this.model,
        trim: this.trim,
        mileage: Number(this.mileage),
        transmission: this.transmission,
        fuel: this.fuel,
        exterior: this.exterior,
        location: this.location,
        imageUrl: this.imageUrl,
        description: this.description,
        startPrice: Number(this.startPrice),
        minIncrement: Number(this.minIncrement),
        durationSec: Number(this.durationSec),
      });
      this.router.navigate(['/auctions', r.id]);
    } catch (e: any) {
      const flat = e.error?.error?.fieldErrors;
      const msg = flat ? Object.entries(flat).map(([k, v]) => `${k}: ${(v as string[]).join(', ')}`).join(' · ') : (e.message ?? 'Failed');
      this.error.set(msg);
    } finally {
      this.busy.set(false);
    }
  }
}
