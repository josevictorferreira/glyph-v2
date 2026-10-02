-- Omniroute is gone; velox is the only provider. Any omniroute rows left in
-- the catalog are marked unavailable so they stop appearing in listings,
-- and workflows still using them are flagged the usual way (validator).
UPDATE available_models
SET available = false, updated_at = now()
WHERE provider = 'omniroute' AND available;
