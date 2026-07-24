import { Router } from 'express';
import { getProductBranding } from '../../../application/catalog/site-catalog.service';

export const brandingRoutes = Router();

/** Browser-safe product identity, available before login for auth screens. */
brandingRoutes.get('/', (_req, res, next) => {
  getProductBranding()
    .then((data) => res.json({ success: true, data }))
    .catch(next);
});
