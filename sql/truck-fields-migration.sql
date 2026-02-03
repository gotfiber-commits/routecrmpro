-- Additional Truck Fields Migration
-- Run this in Neon SQL Editor to add missing fields
-- These fields are used in the UI but were missing from the schema

-- Tank Details
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS tank_manufacturer VARCHAR(255);
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS tank_serial_number VARCHAR(100);
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS tank_manufacture_date DATE;
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS working_pressure_psi INTEGER;
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS meter_serial_number VARCHAR(100);

-- Fuel
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS def_tank_capacity INTEGER;

-- Registration
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS registration_number VARCHAR(100);
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS inspection_decal_number VARCHAR(100);
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS ifta_account VARCHAR(100);
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS irp_account VARCHAR(100);

-- Insurance
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS cargo_coverage DECIMAL(12,2);

-- Maintenance & Usage
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS total_hours DECIMAL(10,2) DEFAULT 0;
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS last_service_mileage INTEGER;
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS next_service_mileage INTEGER;
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS oil_change_interval_miles INTEGER DEFAULT 15000;

-- Also ensure meter_next_calibration exists (used in data.js but may be missing)
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS meter_next_calibration DATE;

-- Index for performance
CREATE INDEX IF NOT EXISTS idx_trucks_tank_next_inspection ON trucks(tank_next_inspection);
CREATE INDEX IF NOT EXISTS idx_trucks_meter_calibration ON trucks(meter_next_calibration);
