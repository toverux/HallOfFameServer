import type { Routes } from '@angular/router';
import { AdminComponent } from './admin.component';
import { AppComponent } from './app.component';

export const routes: Routes = [
  { path: '', component: AppComponent },
  { path: 'admin', component: AdminComponent },
  { path: '**', redirectTo: '' }
];
