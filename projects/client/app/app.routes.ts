import type { Routes } from '@angular/router';
import { AdminComponent } from './admin.component';

export const routes: Routes = [
    { path: 'admin', component: AdminComponent },
    { path: '**', redirectTo: '' }
];
