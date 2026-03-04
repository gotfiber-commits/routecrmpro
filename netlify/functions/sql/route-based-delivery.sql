-- =====================================================
-- ROUTE-BASED DELIVERY MODEL MIGRATION
-- =====================================================
-- This converts the system from order-based to route-based
-- Drivers have recurring routes with assigned customers
-- They visit each stop, check inventory, and fill if needed
-- =====================================================

-- =====================================================
-- ROUTE TEMPLATES (Reusable route definitions)
-- =====================================================
-- e.g., "Monday North Route", "Tuesday South Route"

CREATE TABLE IF NOT EXISTS route_templates (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    dc_id UUID REFERENCES distribution_centers(id) ON DELETE SET NULL,
    
    name VARCHAR(100) NOT NULL,  -- "Monday North Route"
    description TEXT,
    
    -- Schedule
    day_of_week INTEGER,  -- 0=Sunday, 1=Monday, etc. (NULL = unscheduled)
    frequency VARCHAR(20) DEFAULT 'weekly',  -- weekly, biweekly, monthly
    
    -- Assignment
    assigned_driver_id UUID REFERENCES drivers(id) ON DELETE SET NULL,
    assigned_truck_id UUID REFERENCES trucks(id) ON DELETE SET NULL,
    
    -- Route stats (updated after optimization)
    total_stops INTEGER DEFAULT 0,
    estimated_miles DECIMAL(10, 2),
    estimated_duration_minutes INTEGER,
    
    -- Status
    status VARCHAR(20) DEFAULT 'active',  -- active, inactive, archived
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_route_templates_company ON route_templates(company_id);
CREATE INDEX idx_route_templates_dc ON route_templates(dc_id);
CREATE INDEX idx_route_templates_day ON route_templates(day_of_week);

-- =====================================================
-- ROUTE TEMPLATE STOPS (Customers assigned to template)
-- =====================================================

CREATE TABLE IF NOT EXISTS route_template_stops (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    template_id UUID NOT NULL REFERENCES route_templates(id) ON DELETE CASCADE,
    customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    
    -- Optimized sequence
    stop_number INTEGER NOT NULL,
    
    -- Distance/time from previous stop
    distance_from_previous DECIMAL(10, 2),
    time_from_previous_minutes INTEGER,
    
    -- Notes
    delivery_instructions TEXT,
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    UNIQUE(template_id, customer_id),
    UNIQUE(template_id, stop_number)
);

CREATE INDEX idx_template_stops_template ON route_template_stops(template_id);
CREATE INDEX idx_template_stops_customer ON route_template_stops(customer_id);

-- =====================================================
-- ROUTE RUNS (Instance of running a template)
-- =====================================================
-- When a driver "starts" a route, it creates a run

CREATE TABLE IF NOT EXISTS route_runs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    template_id UUID REFERENCES route_templates(id) ON DELETE SET NULL,
    
    -- Can also be an ad-hoc route (no template)
    name VARCHAR(100),
    
    -- Assignment
    dc_id UUID REFERENCES distribution_centers(id) ON DELETE SET NULL,
    driver_id UUID REFERENCES drivers(id) ON DELETE SET NULL,
    truck_id UUID REFERENCES trucks(id) ON DELETE SET NULL,
    
    -- Schedule
    scheduled_date DATE NOT NULL,
    start_time TIME,
    
    -- Actual times
    started_at TIMESTAMP,
    completed_at TIMESTAMP,
    
    -- Stats (calculated)
    total_stops INTEGER DEFAULT 0,
    stops_completed INTEGER DEFAULT 0,
    total_gallons_delivered DECIMAL(12, 2) DEFAULT 0,
    total_revenue DECIMAL(12, 2) DEFAULT 0,
    actual_miles DECIMAL(10, 2),
    
    -- Status
    status VARCHAR(20) DEFAULT 'scheduled',  -- scheduled, in_progress, completed, cancelled
    
    notes TEXT,
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_route_runs_company ON route_runs(company_id);
CREATE INDEX idx_route_runs_template ON route_runs(template_id);
CREATE INDEX idx_route_runs_date ON route_runs(scheduled_date);
CREATE INDEX idx_route_runs_driver ON route_runs(driver_id);
CREATE INDEX idx_route_runs_status ON route_runs(status);

-- =====================================================
-- ROUTE RUN STOPS (Actual stops for a specific run)
-- =====================================================

CREATE TABLE IF NOT EXISTS route_run_stops (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    run_id UUID NOT NULL REFERENCES route_runs(id) ON DELETE CASCADE,
    customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    
    -- Sequence
    stop_number INTEGER NOT NULL,
    
    -- Pre-visit info (copied from customer at route start)
    tank_size_gallons INTEGER,
    tank_level_before DECIMAL(5, 2),  -- percentage
    price_per_gallon DECIMAL(10, 4),
    
    -- Delivery info (filled by driver)
    arrived_at TIMESTAMP,
    departed_at TIMESTAMP,
    tank_level_after DECIMAL(5, 2),  -- percentage after fill
    gallons_delivered DECIMAL(10, 2) DEFAULT 0,
    delivery_total DECIMAL(12, 2) DEFAULT 0,
    
    -- Status
    status VARCHAR(20) DEFAULT 'pending',  -- pending, skipped, completed, no_access
    skip_reason TEXT,  -- "Gate locked", "Customer not home", "Tank full"
    
    -- Driver notes
    notes TEXT,
    signature_data TEXT,  -- Base64 signature if required
    photo_url TEXT,  -- Photo of meter/tank if required
    
    -- GPS
    arrival_lat DECIMAL(10, 6),
    arrival_lng DECIMAL(10, 6),
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    UNIQUE(run_id, stop_number)
);

CREATE INDEX idx_run_stops_run ON route_run_stops(run_id);
CREATE INDEX idx_run_stops_customer ON route_run_stops(customer_id);
CREATE INDEX idx_run_stops_status ON route_run_stops(status);

-- =====================================================
-- UPDATE CUSTOMERS TABLE
-- =====================================================
-- Add fields for route-based service

ALTER TABLE customers ADD COLUMN IF NOT EXISTS service_type VARCHAR(20) DEFAULT 'will_call';
-- will_call = customer calls when they need delivery
-- keep_full = automatic route-based service
-- scheduled = specific delivery schedule

ALTER TABLE customers ADD COLUMN IF NOT EXISTS route_template_id UUID REFERENCES route_templates(id) ON DELETE SET NULL;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS last_delivery_date DATE;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS last_delivery_gallons DECIMAL(10, 2);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS avg_daily_usage DECIMAL(10, 4);  -- gallons per day (calculated)
ALTER TABLE customers ADD COLUMN IF NOT EXISTS days_until_empty INTEGER;  -- calculated based on level and usage

CREATE INDEX IF NOT EXISTS idx_customers_service_type ON customers(service_type);
CREATE INDEX IF NOT EXISTS idx_customers_route_template ON customers(route_template_id);

-- =====================================================
-- HELPER FUNCTION: Calculate days until empty
-- =====================================================

CREATE OR REPLACE FUNCTION calculate_days_until_empty(
    tank_size INTEGER,
    current_level DECIMAL,
    avg_daily_usage DECIMAL
) RETURNS INTEGER AS $$
BEGIN
    IF avg_daily_usage IS NULL OR avg_daily_usage <= 0 THEN
        RETURN NULL;
    END IF;
    RETURN FLOOR((tank_size * (current_level / 100)) / avg_daily_usage);
END;
$$ LANGUAGE plpgsql;

-- =====================================================
-- VIEW: Customers needing service
-- =====================================================

CREATE OR REPLACE VIEW customers_needing_service AS
SELECT 
    c.*,
    dc.name as dc_name,
    rt.name as route_name,
    calculate_days_until_empty(c.tank_size, c.current_level, c.avg_daily_usage) as days_until_empty,
    CASE 
        WHEN c.current_level <= 20 THEN 'critical'
        WHEN c.current_level <= 30 THEN 'low'
        WHEN c.current_level <= 50 THEN 'monitor'
        ELSE 'ok'
    END as tank_status
FROM customers c
LEFT JOIN distribution_centers dc ON c.preferred_dc_id = dc.id
LEFT JOIN route_templates rt ON c.route_template_id = rt.id
WHERE c.status = 'active'
AND c.service_type = 'keep_full'
AND c.current_level <= 50
ORDER BY c.current_level ASC;

-- =====================================================
-- SAMPLE DATA: Create a route template
-- =====================================================
-- Uncomment to add sample data

-- INSERT INTO route_templates (company_id, dc_id, name, day_of_week, description)
-- SELECT 
--     c.id,
--     (SELECT id FROM distribution_centers WHERE company_id = c.id LIMIT 1),
--     'Monday Route A',
--     1,
--     'North zone residential customers'
-- FROM companies c
-- WHERE c.subdomain = 'demo'
-- LIMIT 1;

