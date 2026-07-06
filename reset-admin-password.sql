-- =====================================================
-- VERIZON CONNECT / FLEETMATICS INTEGRATION
-- Migration to add telematics integration support
-- =====================================================

-- Add Fleetmatics settings to companies table
ALTER TABLE companies ADD COLUMN IF NOT EXISTS fleetmatics_enabled BOOLEAN DEFAULT false;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS fleetmatics_username VARCHAR(255);
ALTER TABLE companies ADD COLUMN IF NOT EXISTS fleetmatics_password_encrypted VARCHAR(500);
ALTER TABLE companies ADD COLUMN IF NOT EXISTS fleetmatics_api_key VARCHAR(255);
ALTER TABLE companies ADD COLUMN IF NOT EXISTS fleetmatics_last_sync TIMESTAMP;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS fleetmatics_vehicle_count INTEGER DEFAULT 0;

-- Add real-time tracking columns to trucks table
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS fleetmatics_vehicle_id VARCHAR(100);
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS current_lat DECIMAL(10, 6);
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS current_lng DECIMAL(10, 6);
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS current_speed DECIMAL(5, 1);
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS current_heading INTEGER;
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS ignition_status VARCHAR(20);
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS last_location_update TIMESTAMP;

-- Index for faster lookups by Fleetmatics vehicle ID
CREATE INDEX IF NOT EXISTS idx_trucks_fleetmatics ON trucks(fleetmatics_vehicle_id) WHERE fleetmatics_vehicle_id IS NOT NULL;

-- Create vehicle location history table for tracking
CREATE TABLE IF NOT EXISTS truck_location_history (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    truck_id UUID NOT NULL REFERENCES trucks(id) ON DELETE CASCADE,
    lat DECIMAL(10, 6) NOT NULL,
    lng DECIMAL(10, 6) NOT NULL,
    speed DECIMAL(5, 1),
    heading INTEGER,
    ignition_status VARCHAR(20),
    odometer INTEGER,
    recorded_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_truck_location_history_truck ON truck_location_history(truck_id);
CREATE INDEX IF NOT EXISTS idx_truck_location_history_time ON truck_location_history(recorded_at);

-- Partition by time for better performance (optional, for high-volume tracking)
-- Note: Actual partitioning requires PostgreSQL 10+ and more complex setup

-- Create telematics alerts table
CREATE TABLE IF NOT EXISTS telematics_alerts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    truck_id UUID REFERENCES trucks(id) ON DELETE SET NULL,
    driver_id UUID REFERENCES drivers(id) ON DELETE SET NULL,
    external_alert_id VARCHAR(100),
    alert_type VARCHAR(50) NOT NULL,
    severity VARCHAR(20) DEFAULT 'info',
    message TEXT,
    lat DECIMAL(10, 6),
    lng DECIMAL(10, 6),
    address TEXT,
    speed DECIMAL(5, 1),
    acknowledged BOOLEAN DEFAULT false,
    acknowledged_by UUID REFERENCES users(id),
    acknowledged_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_telematics_alerts_company ON telematics_alerts(company_id);
CREATE INDEX IF NOT EXISTS idx_telematics_alerts_truck ON telematics_alerts(truck_id);
CREATE INDEX IF NOT EXISTS idx_telematics_alerts_type ON telematics_alerts(alert_type);
CREATE INDEX IF NOT EXISTS idx_telematics_alerts_unack ON telematics_alerts(company_id, acknowledged) WHERE acknowledged = false;

-- Common alert types for propane delivery:
-- speeding, harsh_braking, harsh_acceleration, idle_time, geofence_entry, geofence_exit, 
-- low_fuel, engine_fault, unauthorized_use, after_hours, route_deviation

-- Add comments for documentation
COMMENT ON COLUMN companies.fleetmatics_enabled IS 'Whether Verizon Connect integration is active';
COMMENT ON COLUMN companies.fleetmatics_password_encrypted IS 'Encrypted API password - use encryption in production';
COMMENT ON COLUMN trucks.fleetmatics_vehicle_id IS 'Linked Verizon Connect vehicle ID for telematics';
COMMENT ON COLUMN trucks.current_lat IS 'Real-time latitude from telematics';
COMMENT ON COLUMN trucks.current_lng IS 'Real-time longitude from telematics';
COMMENT ON TABLE truck_location_history IS 'Historical breadcrumb trail of truck locations';
COMMENT ON TABLE telematics_alerts IS 'Alerts received from telematics provider';
