-- Reset Super Admin Password
-- Run this in your Neon database console

-- This sets the password to: admin123
-- The hash below is a valid bcrypt hash for 'admin123'

-- First, check if admin exists
SELECT id, username, email FROM super_admins;

-- Update existing admin password (if username is 'superadmin')
UPDATE super_admins 
SET password_hash = '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZRGdjGj/n3.rjViVaRF1tpBRiC1S2',
    username = 'admin'
WHERE username = 'superadmin' OR username = 'admin';

-- OR if no admin exists, insert one:
INSERT INTO super_admins (username, email, password_hash, name, can_delete_companies, can_impersonate)
SELECT 'admin', 'admin@routecrmpro.com', '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZRGdjGj/n3.rjViVaRF1tpBRiC1S2', 'Platform Administrator', true, true
WHERE NOT EXISTS (SELECT 1 FROM super_admins WHERE username = 'admin');

-- Verify the change
SELECT id, username, email, name FROM super_admins;
