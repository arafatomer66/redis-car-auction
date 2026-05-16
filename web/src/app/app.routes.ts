import { Routes } from '@angular/router';
import { AuctionListComponent } from './features/auction-list/auction-list';
import { CreateAuctionComponent } from './features/create-auction/create-auction';
import { AuctionDetailComponent } from './features/auction-detail/auction-detail';

export const routes: Routes = [
  { path: '', pathMatch: 'full', component: AuctionListComponent },
  { path: 'new', component: CreateAuctionComponent },
  { path: 'auctions/:id', component: AuctionDetailComponent },
];
