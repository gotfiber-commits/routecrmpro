-- =====================================================
-- RouteCRMPro Complete Database Migration
-- Safe to run on existing databases (uses IF NOT EXISTS)
-- Run this entire script in Neon SQL Editor
-- =====================================================

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- =====================================================
-- CORE TABLES
-- =====================================================

-- Companies (Tenants)
CREATE TABLE IF NOT EXISTS companies (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    subdomain VARCHAR(63) UNIQUE NOT NULL,
    email VARCHAR(255) NOT NULL,
    phone VARCHAR(20),
    address TEXT,
    city VARCHAR(100),
    state VARCHAR(50),
    zip VARCHAR(20),
    plan VARCHAR(50) DEFAULT 'trial',
    plan_started_at TIMESTAMP,
    plan_expires_at TIMESTAMP,
    max_users INTEGER DEFAULT 5,
    max_distribution_centers INTEGER DEFAULT 2,
    max_trucks INTEGER DEFAULT 10,
    status VARCHAR(20) DEFAULT 'active',
    settings JSONB DEFAULT '{}',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_companies_subdomain ON companies(subdomain);
CREATE INDEX IF NOT EXISTS idx_companies_status ON companies(status);

-- Super Admins
CREATE TABLE IF NOT EXISTS super_admins (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    username VARCHAR(100) UNIQUE NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    name VARCHAR(255) NOT NULL,
    can_create_companies BOOLEAN DEFAULT true,
    can_delete_companies BOOLEAN DEFAULT false,
    can_impersonate BOOLEAN DEFAULT false,
    status VARCHAR(20) DEFAULT 'active',
    last_login TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Users
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    company_id UUID REFERENCES companies(id) ON DELETE CASCADE,
    username VARCHAR(100) NOT NULL,
    email VARCHAR(255) NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    name VARCHAR(255) NOT NULL,
    phone VARCHAR(20),
    avatar VARCHAR(10) DEFAULT '👤',
    role VARCHAR(50) NOT NULL,
    dc_id UUID,
    driver_id UUID,
    status VARCHAR(20) DEFAULT 'active',
    last_login TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(company_id, username),
    UNIQUE(company_id, email)
);

CREATE INDEX IF NOT EXISTS idx_users_company ON users(company_id);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);

-- Distribution Centers
CREATE TABLE IF NOT EXISTS distribution_centers (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    code VARCHAR(20) NOT NULL,
    name VARCHAR(255) NOT NULL,
    address TEXT,
    city VARCHAR(100),
    state VARCHAR(50),
    zip VARCHAR(20),
    phone VARCHAR(20),
    lat DECIMAL(10, 6),
    lng DECIMAL(10, 6),
    manager_name VARCHAR(255),
    capacity_gallons INTEGER DEFAULT 50000,
    status VARCHAR(20) DEFAULT 'active',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(company_id, code)
);

CREATE INDEX IF NOT EXISTS idx_dc_company ON distribution_centers(company_id);

-- Drivers (base table)
CREATE TABLE IF NOT EXISTS drivers (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    dc_id UUID REFERENCES distribution_centers(id) ON DELETE SET NULL,
    code VARCHAR(20) NOT NULL,
    name VARCHAR(255) NOT NULL,
    email VARCHAR(255),
    phone VARCHAR(20),
    license_number VARCHAR(50),
    license_state VARCHAR(50),
    license_expiry DATE,
    cdl_class VARCHAR(10),
    hazmat_certified BOOLEAN DEFAULT false,
    hire_date DATE,
    hourly_rate DECIMAL(10, 2),
    status VARCHAR(20) DEFAULT 'active',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(company_id, code)
);

CREATE INDEX IF NOT EXISTS idx_drivers_company ON drivers(company_id);
CREATE INDEX IF NOT EXISTS idx_drivers_dc ON drivers(dc_id);

-- Trucks (base table)
CREATE TABLE IF NOT EXISTS trucks (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    dc_id UUID REFERENCES distribution_centers(id) ON DELETE SET NULL,
    code VARCHAR(20) NOT NULL,
    name VARCHAR(100),
    make VARCHAR(50),
    model VARCHAR(50),
    year INTEGER,
    vin VARCHAR(50),
    license_plate VARCHAR(20),
    capacity_gallons INTEGER DEFAULT 3000,
    current_lat DECIMAL(10, 6),
    current_lng DECIMAL(10, 6),
    speed DECIMAL(5, 2) DEFAULT 0,
    heading INTEGER DEFAULT 0,
    last_gps_update TIMESTAMP,
    fuel_level DECIMAL(5, 2) DEFAULT 100,
    mpg DECIMAL(5, 2) DEFAULT 8,
    status VARCHAR(20) DEFAULT 'active',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(company_id, code)
);

CREATE INDEX IF NOT EXISTS idx_trucks_company ON trucks(company_id);
CREATE INDEX IF NOT EXISTS idx_trucks_dc ON trucks(dc_id);

-- Customers
CREATE TABLE IF NOT EXISTS customers (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    preferred_dc_id UUID REFERENCES distribution_centers(id) ON DELETE SET NULL,
    code VARCHAR(20) NOT NULL,
    name VARCHAR(255) NOT NULL,
    contact_name VARCHAR(255),
    email VARCHAR(255),
    phone VARCHAR(20),
    address TEXT,
    city VARCHAR(100),
    state VARCHAR(50),
    zip VARCHAR(20),
    lat DECIMAL(10, 6),
    lng DECIMAL(10, 6),
    customer_type VARCHAR(50) DEFAULT 'residential',
    tank_size INTEGER DEFAULT 500,
    current_level DECIMAL(5, 2) DEFAULT 50,
    price_per_gallon DECIMAL(10, 4) DEFAULT 2.50,
    payment_terms VARCHAR(50) DEFAULT 'net30',
    balance DECIMAL(12, 2) DEFAULT 0,
    delivery_instructions TEXT,
    auto_delivery BOOLEAN DEFAULT false,
    minimum_level INTEGER DEFAULT 20,
    status VARCHAR(20) DEFAULT 'active',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(company_id, code)
);

CREATE INDEX IF NOT EXISTS idx_customers_company ON customers(company_id);
CREATE INDEX IF NOT EXISTS idx_customers_dc ON customers(preferred_dc_id);
CREATE INDEX IF NOT EXISTS idx_customers_type ON customers(customer_type);

-- Routes
CREATE TABLE IF NOT EXISTS routes (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    dc_id UUID NOT NULL REFERENCES distribution_centers(id) ON DELETE CASCADE,
    truck_id UUID REFERENCES trucks(id) ON DELETE SET NULL,
    driver_id UUID REFERENCES drivers(id) ON DELETE SET NULL,
    route_number VARCHAR(20) NOT NULL,
    name VARCHAR(255),
    scheduled_date DATE NOT NULL,
    start_time TIME,
    total_stops INTEGER DEFAULT 0,
    total_gallons INTEGER DEFAULT 0,
    total_miles DECIMAL(10, 2) DEFAULT 0,
    estimated_duration INTEGER,
    is_optimized BOOLEAN DEFAULT false,
    original_miles DECIMAL(10, 2),
    optimized_miles DECIMAL(10, 2),
    status VARCHAR(20) DEFAULT 'planned',
    started_at TIMESTAMP,
    completed_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(company_id, route_number)
);

CREATE INDEX IF NOT EXISTS idx_routes_company ON routes(company_id);
CREATE INDEX IF NOT EXISTS idx_routes_date ON routes(scheduled_date);
CREATE INDEX IF NOT EXISTS idx_routes_status ON routes(status);

-- Orders
CREATE TABLE IF NOT EXISTS orders (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    dc_id UUID REFERENCES distribution_centers(id) ON DELETE SET NULL,
    route_id UUID REFERENCES routes(id) ON DELETE SET NULL,
    order_number VARCHAR(20) NOT NULL,
    gallons_requested INTEGER NOT NULL,
    gallons_delivered INTEGER,
    price_per_gallon DECIMAL(10, 4),
    total_amount DECIMAL(12, 2),
    requested_date DATE,
    scheduled_date DATE,
    delivery_window VARCHAR(50),
    delivered_at TIMESTAMP,
    delivery_notes TEXT,
    status VARCHAR(20) DEFAULT 'pending',
    priority VARCHAR(20) DEFAULT 'normal',
    payment_status VARCHAR(20) DEFAULT 'unpaid',
    paid_amount DECIMAL(12, 2) DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(company_id, order_number)
);

CREATE INDEX IF NOT EXISTS idx_orders_company ON orders(company_id);
CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_date ON orders(scheduled_date);

-- Route Stops
CREATE TABLE IF NOT EXISTS route_stops (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    route_id UUID NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
    order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    stop_number INTEGER NOT NULL,
    estimated_arrival TIME,
    estimated_duration INTEGER DEFAULT 30,
    arrived_at TIMESTAMP,
    departed_at TIMESTAMP,
    status VARCHAR(20) DEFAULT 'pending',
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_route_stops_route ON route_stops(route_id);

-- Audit Log
CREATE TABLE IF NOT EXISTS audit_log (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    company_id UUID REFERENCES companies(id) ON DELETE CASCADE,
    user_id UUID,
    action VARCHAR(50) NOT NULL,
    entity_type VARCHAR(50),
    entity_id UUID,
    old_values JSONB,
    new_values JSONB,
    ip_address VARCHAR(45),
    user_agent TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_audit_company ON audit_log(company_id);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);


-- =====================================================
-- ENHANCED DRIVER FIELDS
-- =====================================================

-- Pay & Compensation
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS hourly_rate DECIMAL(10,2) DEFAULT 25.00;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS overtime_rate DECIMAL(10,2);
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS per_diem DECIMAL(10,2) DEFAULT 0;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS pay_type VARCHAR(20) DEFAULT 'hourly';

-- CDL Details
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS cdl_number VARCHAR(50);
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS cdl_state VARCHAR(2);
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS cdl_endorsements VARCHAR(50);

-- HAZMAT & Certifications  
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS hazmat_endorsed BOOLEAN DEFAULT false;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS hazmat_expiration DATE;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS tanker_endorsed BOOLEAN DEFAULT false;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS twic_card BOOLEAN DEFAULT false;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS twic_expiration DATE;

-- DOT Medical
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS medical_card_expiration DATE;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS medical_examiner_name VARCHAR(255);
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS medical_exam_date DATE;

-- Background & Drug Testing
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS background_check_date DATE;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS background_check_status VARCHAR(20) DEFAULT 'pending';
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS drug_test_date DATE;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS drug_test_status VARCHAR(20) DEFAULT 'pending';
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS drug_test_type VARCHAR(20);
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS mvr_check_date DATE;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS mvr_status VARCHAR(20) DEFAULT 'pending';

-- Experience & Training
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS years_experience INTEGER DEFAULT 0;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS date_of_birth DATE;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS propane_certified BOOLEAN DEFAULT false;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS propane_cert_expiration DATE;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS defensive_driving_cert BOOLEAN DEFAULT false;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS smith_system_trained BOOLEAN DEFAULT false;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS last_training_date DATE;

-- Emergency Contact
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS emergency_contact_name VARCHAR(255);
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS emergency_contact_phone VARCHAR(20);
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS emergency_contact_relation VARCHAR(50);

-- Address
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS address TEXT;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS city VARCHAR(100);
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS state VARCHAR(50);
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS zip VARCHAR(20);

-- Notes
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS notes TEXT;


-- =====================================================
-- ENHANCED TRUCK FIELDS
-- =====================================================

-- Assigned Driver
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS assigned_driver_id UUID REFERENCES drivers(id) ON DELETE SET NULL;

-- Weight Specifications
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS empty_weight INTEGER;
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS gvwr INTEGER;
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS gcwr INTEGER;
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS max_payload INTEGER;
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS front_axle_weight INTEGER;
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS rear_axle_weight INTEGER;
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS axle_configuration VARCHAR(20);

-- Tank Specifications
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS tank_capacity_gallons INTEGER DEFAULT 3000;
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS tank_material VARCHAR(50);
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS tank_last_inspection DATE;
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS tank_next_inspection DATE;
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS tank_certification VARCHAR(50);
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS tank_manufacturer VARCHAR(100);
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS tank_serial_number VARCHAR(100);
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS tank_manufacture_date DATE;
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS working_pressure_psi INTEGER;

-- Product Configuration
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS product_type VARCHAR(50) DEFAULT 'propane';
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS product_weight_per_gallon DECIMAL(5,3) DEFAULT 4.20;

-- Fuel System
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS fuel_tank_capacity INTEGER;
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS fuel_type VARCHAR(20) DEFAULT 'diesel';
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS diesel_weight_per_gallon DECIMAL(5,3) DEFAULT 7.10;
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS current_fuel_gallons DECIMAL(10,2);
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS avg_mpg DECIMAL(5,2) DEFAULT 8.0;
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS cost_per_mile DECIMAL(6,4);
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS def_tank_capacity INTEGER;

-- Pump & Meter
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS has_pump BOOLEAN DEFAULT true;
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS pump_type VARCHAR(50);
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS meter_type VARCHAR(50);
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS meter_serial_number VARCHAR(100);
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS meter_last_calibration DATE;
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS meter_next_calibration DATE;

-- DOT & Registration
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS dot_number VARCHAR(20);
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS mc_number VARCHAR(20);
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS registration_number VARCHAR(50);
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS registration_state VARCHAR(2);
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS registration_expiration DATE;
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS last_dot_inspection DATE;
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS next_dot_inspection DATE;
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS dot_inspection_status VARCHAR(20);
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS inspection_decal_number VARCHAR(50);
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS ifta_account VARCHAR(50);
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS irp_account VARCHAR(50);

-- Insurance
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS insurance_policy_number VARCHAR(100);
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS insurance_provider VARCHAR(255);
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS insurance_expiration DATE;
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS liability_coverage DECIMAL(12,2);
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS cargo_coverage DECIMAL(12,2);

-- Maintenance
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS last_oil_change DATE;
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS last_oil_change_miles INTEGER;
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS next_oil_change_miles INTEGER;
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS oil_change_interval_miles INTEGER DEFAULT 15000;
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS last_service_date DATE;
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS last_service_mileage INTEGER;
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS next_service_date DATE;
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS next_service_mileage INTEGER;
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS current_odometer INTEGER;
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS total_hours DECIMAL(10,1);
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS tire_size VARCHAR(50);
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS tire_type VARCHAR(50);
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS tire_last_replaced DATE;

-- Telematics / GPS
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS telematics_device_id VARCHAR(100);
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS telematics_provider VARCHAR(100);
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS last_location_update TIMESTAMP;

-- Equipment Flags
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS has_lift_gate BOOLEAN DEFAULT false;
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS has_pto_pump BOOLEAN DEFAULT false;
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS has_gps_tracker BOOLEAN DEFAULT true;
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS has_dash_cam BOOLEAN DEFAULT false;
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS has_eld BOOLEAN DEFAULT true;
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS eld_provider VARCHAR(100);
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS eld_serial_number VARCHAR(100);

-- Financials
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS purchase_date DATE;
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS purchase_price DECIMAL(12,2);
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS current_value DECIMAL(12,2);
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS monthly_payment DECIMAL(10,2);
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS monthly_insurance DECIMAL(10,2);

-- Notes
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS notes TEXT;


-- =====================================================
-- UPDATED_AT TRIGGER FUNCTION
-- =====================================================

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Apply triggers (DROP first to avoid duplicates)
DROP TRIGGER IF EXISTS update_companies_updated_at ON companies;
CREATE TRIGGER update_companies_updated_at BEFORE UPDATE ON companies
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_users_updated_at ON users;
CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_dc_updated_at ON distribution_centers;
CREATE TRIGGER update_dc_updated_at BEFORE UPDATE ON distribution_centers
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_trucks_updated_at ON trucks;
CREATE TRIGGER update_trucks_updated_at BEFORE UPDATE ON trucks
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_drivers_updated_at ON drivers;
CREATE TRIGGER update_drivers_updated_at BEFORE UPDATE ON drivers
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_customers_updated_at ON customers;
CREATE TRIGGER update_customers_updated_at BEFORE UPDATE ON customers
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_orders_updated_at ON orders;
CREATE TRIGGER update_orders_updated_at BEFORE UPDATE ON orders
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_routes_updated_at ON routes;
CREATE TRIGGER update_routes_updated_at BEFORE UPDATE ON routes
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();


-- =====================================================
-- DEFAULT SUPER ADMIN
-- Password: admin123
-- =====================================================

INSERT INTO super_admins (username, email, password_hash, name, can_delete_companies, can_impersonate)
VALUES (
    'admin',
    'admin@routecrmpro.com',
    '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZRGdjGj/n3.rjViVaRF1tpBRiC1S2',
    'Platform Administrator',
    true,
    true
) ON CONFLICT (username) DO UPDATE SET
    password_hash = '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZRGdjGj/n3.rjViVaRF1tpBRiC1S2';


-- =====================================================
-- ROUTE TEMPLATES (Reusable route definitions)
-- =====================================================

CREATE TABLE IF NOT EXISTS route_templates (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    dc_id UUID REFERENCES distribution_centers(id) ON DELETE SET NULL,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    day_of_week INTEGER,
    frequency VARCHAR(20) DEFAULT 'weekly',
    assigned_driver_id UUID REFERENCES drivers(id) ON DELETE SET NULL,
    assigned_truck_id UUID REFERENCES trucks(id) ON DELETE SET NULL,
    total_stops INTEGER DEFAULT 0,
    estimated_miles DECIMAL(10, 2),
    estimated_duration_minutes INTEGER,
    status VARCHAR(20) DEFAULT 'active',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_route_templates_company ON route_templates(company_id);
CREATE INDEX IF NOT EXISTS idx_route_templates_dc ON route_templates(dc_id);

-- =====================================================
-- ROUTE TEMPLATE STOPS
-- =====================================================

CREATE TABLE IF NOT EXISTS route_template_stops (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    template_id UUID NOT NULL REFERENCES route_templates(id) ON DELETE CASCADE,
    customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    stop_number INTEGER NOT NULL,
    distance_from_previous DECIMAL(10, 2),
    time_from_previous_minutes INTEGER,
    delivery_instructions TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_template_stops_template ON route_template_stops(template_id);
CREATE INDEX IF NOT EXISTS idx_template_stops_customer ON route_template_stops(customer_id);

-- =====================================================
-- ROUTE RUNS (Active/historical routes)
-- =====================================================

CREATE TABLE IF NOT EXISTS route_runs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    template_id UUID REFERENCES route_templates(id) ON DELETE SET NULL,
    name VARCHAR(100),
    dc_id UUID REFERENCES distribution_centers(id) ON DELETE SET NULL,
    driver_id UUID REFERENCES drivers(id) ON DELETE SET NULL,
    truck_id UUID REFERENCES trucks(id) ON DELETE SET NULL,
    scheduled_date DATE NOT NULL,
    start_time TIME,
    started_at TIMESTAMP,
    completed_at TIMESTAMP,
    
    -- Stop counts
    total_stops INTEGER DEFAULT 0,
    stops_completed INTEGER DEFAULT 0,
    
    -- Delivery totals
    total_gallons_delivered DECIMAL(12, 2) DEFAULT 0,
    total_revenue DECIMAL(12, 2) DEFAULT 0,
    
    -- Mileage tracking
    estimated_miles DECIMAL(10, 2),
    actual_miles DECIMAL(10, 2),
    start_odometer INTEGER,
    end_odometer INTEGER,
    
    -- Fuel costs (calculated from truck MPG)
    truck_mpg DECIMAL(5, 2),  -- Snapshot of truck MPG at route start
    fuel_price_per_gallon DECIMAL(10, 4) DEFAULT 3.50,  -- Current diesel price
    estimated_fuel_gallons DECIMAL(10, 2),
    estimated_fuel_cost DECIMAL(10, 2),
    actual_fuel_gallons DECIMAL(10, 2),
    actual_fuel_cost DECIMAL(10, 2),
    
    -- Time tracking
    estimated_duration_minutes INTEGER,
    actual_duration_minutes INTEGER,
    
    -- Driver costs (calculated from driver hourly rate)
    driver_hourly_rate DECIMAL(10, 2),  -- Snapshot of driver rate at route start
    driver_overtime_rate DECIMAL(10, 2),
    estimated_driver_hours DECIMAL(5, 2),
    estimated_driver_cost DECIMAL(10, 2),
    actual_driver_hours DECIMAL(5, 2),
    actual_driver_cost DECIMAL(10, 2),
    
    -- Total costs
    estimated_total_cost DECIMAL(12, 2),  -- fuel + driver
    actual_total_cost DECIMAL(12, 2),
    
    -- Profit calculation
    estimated_profit DECIMAL(12, 2),  -- revenue - costs
    actual_profit DECIMAL(12, 2),
    
    status VARCHAR(20) DEFAULT 'scheduled',
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_route_runs_company ON route_runs(company_id);
CREATE INDEX IF NOT EXISTS idx_route_runs_date ON route_runs(scheduled_date);
CREATE INDEX IF NOT EXISTS idx_route_runs_status ON route_runs(status);
CREATE INDEX IF NOT EXISTS idx_route_runs_driver ON route_runs(driver_id);
CREATE INDEX IF NOT EXISTS idx_route_runs_truck ON route_runs(truck_id);

-- =====================================================
-- ROUTE RUN STOPS (Stops for active routes)
-- =====================================================

CREATE TABLE IF NOT EXISTS route_run_stops (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    run_id UUID NOT NULL REFERENCES route_runs(id) ON DELETE CASCADE,
    customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    stop_number INTEGER NOT NULL,
    tank_size_gallons INTEGER,
    tank_level_before DECIMAL(5, 2),
    price_per_gallon DECIMAL(10, 4),
    arrived_at TIMESTAMP,
    departed_at TIMESTAMP,
    tank_level_after DECIMAL(5, 2),
    gallons_delivered DECIMAL(10, 2) DEFAULT 0,
    delivery_total DECIMAL(12, 2) DEFAULT 0,
    status VARCHAR(20) DEFAULT 'pending',
    skip_reason TEXT,
    notes TEXT,
    signature_data TEXT,
    photo_url TEXT,
    arrival_lat DECIMAL(10, 6),
    arrival_lng DECIMAL(10, 6),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_run_stops_run ON route_run_stops(run_id);
CREATE INDEX IF NOT EXISTS idx_run_stops_customer ON route_run_stops(customer_id);
CREATE INDEX IF NOT EXISTS idx_run_stops_status ON route_run_stops(status);

-- Trigger for route_runs updated_at
DROP TRIGGER IF EXISTS update_route_runs_updated_at ON route_runs;
CREATE TRIGGER update_route_runs_updated_at BEFORE UPDATE ON route_runs
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();


-- =====================================================
-- VERIFICATION QUERY
-- Run this to confirm everything was created
-- =====================================================

SELECT 'Tables created:' as status;
SELECT table_name FROM information_schema.tables 
WHERE table_schema = 'public' 
ORDER BY table_name;

SELECT 'Truck columns:' as status, count(*) as column_count 
FROM information_schema.columns 
WHERE table_name = 'trucks';

SELECT 'Driver columns:' as status, count(*) as column_count 
FROM information_schema.columns 
WHERE table_name = 'drivers';

SELECT 'Super admin exists:' as status, username FROM super_admins LIMIT 1;
-- Products & Services Schema
-- Flexible delivery model supporting gallons, products, services, or mixed

-- =====================================================
-- COMPANY DELIVERY SETTINGS
-- =====================================================

-- Add delivery model to companies
ALTER TABLE companies ADD COLUMN IF NOT EXISTS delivery_model VARCHAR(20) DEFAULT 'gallons';
-- Options: 'gallons', 'products', 'services', 'mixed'

ALTER TABLE companies ADD COLUMN IF NOT EXISTS track_empties BOOLEAN DEFAULT false;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS track_truck_inventory BOOLEAN DEFAULT false;

-- =====================================================
-- PRODUCTS & SERVICES CATALOG
-- =====================================================

CREATE TABLE IF NOT EXISTS products (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    
    -- Basic Info
    type VARCHAR(20) NOT NULL DEFAULT 'product', -- 'product' or 'service'
    code VARCHAR(50),
    name VARCHAR(255) NOT NULL,
    description TEXT,
    category VARCHAR(100), -- e.g., 'Propane Tanks', 'Accessories', 'Services'
    
    -- Pricing
    unit VARCHAR(50) DEFAULT 'each', -- 'each', 'gallon', 'hour', etc.
    default_price DECIMAL(10,2) NOT NULL DEFAULT 0,
    cost DECIMAL(10,2) DEFAULT 0, -- Company's cost for margin tracking
    
    -- For propane products - gallon equivalent for reporting
    gallon_equivalent DECIMAL(10,2),
    
    -- For bottle exchange
    is_exchangeable BOOLEAN DEFAULT false, -- Can be returned/exchanged
    deposit_amount DECIMAL(10,2) DEFAULT 0,
    
    -- Inventory tracking
    track_inventory BOOLEAN DEFAULT false,
    sku VARCHAR(100),
    
    -- Status
    status VARCHAR(20) DEFAULT 'active', -- 'active', 'inactive', 'discontinued'
    sort_order INTEGER DEFAULT 0,
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_products_company ON products(company_id);
CREATE INDEX idx_products_type ON products(company_id, type);
CREATE INDEX idx_products_category ON products(company_id, category);

-- =====================================================
-- CUSTOMER-SPECIFIC PRODUCTS & PRICING
-- =====================================================

CREATE TABLE IF NOT EXISTS customer_products (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    
    -- Customer-specific pricing (NULL = use default)
    custom_price DECIMAL(10,2),
    
    -- Whether this customer can order this product
    is_enabled BOOLEAN DEFAULT true,
    
    -- Customer-specific notes
    notes TEXT,
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    UNIQUE(customer_id, product_id)
);

CREATE INDEX idx_customer_products_customer ON customer_products(customer_id);
CREATE INDEX idx_customer_products_product ON customer_products(product_id);

-- =====================================================
-- DELIVERY LINE ITEMS
-- Tracks what was delivered/collected at each stop
-- =====================================================

CREATE TABLE IF NOT EXISTS delivery_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    stop_id UUID NOT NULL REFERENCES route_run_stops(id) ON DELETE CASCADE,
    product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    
    -- Quantities
    quantity_delivered INTEGER DEFAULT 0,
    quantity_collected INTEGER DEFAULT 0, -- For empties/exchanges
    
    -- Pricing at time of delivery
    unit_price DECIMAL(10,2) NOT NULL,
    line_total DECIMAL(10,2) NOT NULL,
    
    -- For empties
    deposit_collected DECIMAL(10,2) DEFAULT 0,
    deposit_refunded DECIMAL(10,2) DEFAULT 0,
    
    notes TEXT,
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_delivery_items_stop ON delivery_items(stop_id);
CREATE INDEX idx_delivery_items_product ON delivery_items(product_id);

-- =====================================================
-- TRUCK INVENTORY
-- Tracks what's on each truck
-- =====================================================

CREATE TABLE IF NOT EXISTS truck_inventory (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    truck_id UUID NOT NULL REFERENCES trucks(id) ON DELETE CASCADE,
    product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    
    -- Current quantity on truck
    quantity INTEGER DEFAULT 0,
    
    -- Par levels for restocking alerts
    par_level INTEGER DEFAULT 0,
    max_level INTEGER DEFAULT 0,
    
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    UNIQUE(truck_id, product_id)
);

CREATE INDEX idx_truck_inventory_truck ON truck_inventory(truck_id);

-- =====================================================
-- TRUCK INVENTORY LOG
-- History of inventory changes
-- =====================================================

CREATE TABLE IF NOT EXISTS truck_inventory_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    truck_id UUID NOT NULL REFERENCES trucks(id) ON DELETE CASCADE,
    product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    
    -- Change details
    change_type VARCHAR(50) NOT NULL, -- 'load', 'delivery', 'return', 'adjustment', 'collection'
    quantity_change INTEGER NOT NULL, -- Positive for adds, negative for removes
    quantity_before INTEGER,
    quantity_after INTEGER,
    
    -- Reference
    stop_id UUID REFERENCES route_run_stops(id),
    run_id UUID REFERENCES route_runs(id),
    user_id UUID REFERENCES users(id),
    
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_inventory_log_truck ON truck_inventory_log(truck_id);
CREATE INDEX idx_inventory_log_date ON truck_inventory_log(created_at);

-- =====================================================
-- ROUTE RUN STOPS - Add product delivery tracking
-- =====================================================

ALTER TABLE route_run_stops ADD COLUMN IF NOT EXISTS delivery_model VARCHAR(20);
-- NULL = use company default, or 'gallons', 'products', 'mixed'

ALTER TABLE route_run_stops ADD COLUMN IF NOT EXISTS items_total DECIMAL(10,2) DEFAULT 0;
ALTER TABLE route_run_stops ADD COLUMN IF NOT EXISTS deposits_collected DECIMAL(10,2) DEFAULT 0;
ALTER TABLE route_run_stops ADD COLUMN IF NOT EXISTS deposits_refunded DECIMAL(10,2) DEFAULT 0;

-- =====================================================
-- HELPER VIEWS
-- =====================================================

-- Customer products with effective pricing
CREATE OR REPLACE VIEW v_customer_product_pricing AS
SELECT 
    cp.customer_id,
    p.id as product_id,
    p.company_id,
    p.type,
    p.code,
    p.name,
    p.category,
    p.unit,
    COALESCE(cp.custom_price, p.default_price) as effective_price,
    p.default_price,
    cp.custom_price,
    p.gallon_equivalent,
    p.is_exchangeable,
    p.deposit_amount,
    p.status,
    p.sort_order,
    COALESCE(cp.is_enabled, true) as is_enabled
FROM products p
LEFT JOIN customer_products cp ON p.id = cp.product_id
WHERE p.status = 'active';

-- Truck inventory summary
CREATE OR REPLACE VIEW v_truck_inventory_summary AS
SELECT 
    ti.truck_id,
    t.code as truck_code,
    t.name as truck_name,
    p.id as product_id,
    p.code as product_code,
    p.name as product_name,
    p.category,
    ti.quantity,
    ti.par_level,
    ti.max_level,
    CASE 
        WHEN ti.quantity <= 0 THEN 'out_of_stock'
        WHEN ti.quantity < ti.par_level THEN 'low'
        ELSE 'ok'
    END as stock_status
FROM truck_inventory ti
JOIN trucks t ON ti.truck_id = t.id
JOIN products p ON ti.product_id = p.id
WHERE p.status = 'active';

-- =====================================================
-- SEED DEFAULT PRODUCTS FOR EXISTING COMPANIES
-- (Optional - run manually if needed)
-- =====================================================

-- Example: Add standard propane bottles for a company
-- INSERT INTO products (company_id, type, code, name, category, unit, default_price, gallon_equivalent, is_exchangeable, deposit_amount, track_inventory, sort_order)
-- VALUES 
--     ('your-company-id', 'product', '20LB', '20lb Propane Tank', 'Propane Tanks', 'each', 24.99, 4.7, true, 30.00, true, 1),
--     ('your-company-id', 'product', '30LB', '30lb Propane Tank', 'Propane Tanks', 'each', 34.99, 7.0, true, 35.00, true, 2),
--     ('your-company-id', 'product', '40LB', '40lb Propane Tank', 'Propane Tanks', 'each', 44.99, 9.4, true, 40.00, true, 3),
--     ('your-company-id', 'product', '100LB', '100lb Propane Tank', 'Propane Tanks', 'each', 89.99, 23.6, true, 75.00, true, 4),
--     ('your-company-id', 'service', 'INSTALL', 'Tank Installation', 'Services', 'each', 150.00, NULL, false, 0, false, 10),
--     ('your-company-id', 'service', 'LEAK-CHECK', 'Leak Check', 'Services', 'each', 50.00, NULL, false, 0, false, 11);
