-- =====================================================================
-- PER-COMPANY GOOGLE MAPS ENABLEMENT
-- =====================================================================
-- The Google Maps API key is configured once at the platform (Super Admin)
-- level. This flag lets the Super Admin turn the Maps integration on/off for
-- each individual company. Default is FALSE so maps stay off until explicitly
-- enabled for a company (opt-in, e.g. as a paid add-on).
-- =====================================================================

ALTER TABLE companies
    ADD COLUMN IF NOT EXISTS google_maps_enabled BOOLEAN DEFAULT false;

-- Optional: enable maps for the demo company so testing works out of the box.
-- Adjust or remove as needed.
UPDATE companies
    SET google_maps_enabled = true
    WHERE subdomain = 'clarkexchange';
