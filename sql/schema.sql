-- RouteCRMPro Multi-Tenant SaaS Schema
-- Database: Neon PostgreSQL

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- =====================================================
-- CORE TENANT TABLES
-- =====================================================

-- Companies (Tenants)
CREATE TABLE companies (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    subdomain VARCHAR(63) UNIQUE NOT NULL,
    email VARCHAR(255) NOT NULL,
    phone VARCHAR(20),
    address TEXT,
    city VARCHAR(100),
    state VARCHAR(50),
    zip VARCHAR(20),
    
    -- Subscription & Billing
    plan VARCHAR(50) DEFAULT 'trial',  -- trial, starter, professional, enterprise
    plan_started_at TIMESTAMP,
    plan_expires_at TIMESTAMP,
    max_users INTEGER DEFAULT 5,
    max_distribution_centers INTEGER DEFAULT 2,
    max_trucks INTEGER DEFAULT 10,
    
    -- Status
    status VARCHAR(20) DEFAULT 'active',  -- active, suspended, cancelled
    
    -- Settings
    settings JSONB DEFAULT '{}',
    
    -- Timestamps
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create index on subdomain for fast lookups
CREATE INDEX idx_companies_subdomain ON companies(subdomain);
CREATE INDEX idx_companies_status ON companies(status);

-- =====================================================
-- USERS TABLE (Multi-tenant)
-- =====================================================

CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    company_id UUID REFERENCES companies(id) ON DELETE CASCADE,
    
    username VARCHAR(100) NOT NULL,
    email VARCHAR(255) NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    
    -- Profile
    name VARCHAR(255) NOT NULL,
    phone VARCHAR(20),
    avatar VARCHAR(10) DEFAULT '👤',
    
    -- Role & Permissions
    role VARCHAR(50) NOT NULL,  -- admin, driver, dispatch, accounting, payroll
    
    -- Assignments
    dc_id UUID,  -- Can be assigned to specific DC
    driver_id UUID,  -- Link to driver record if role is driver
    
    -- Status
    status VARCHAR(20) DEFAULT 'active',  -- active, inactive, suspended
    last_login TIMESTAMP,
    
    -- Timestamps
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    -- Unique username per company
    UNIQUE(company_id, username),
    UNIQUE(company_id, email)
);

CREATE INDEX idx_users_company ON users(company_id);
CREATE INDEX idx_users_role ON users(role);

-- =====================================================
-- SUPER ADMIN TABLE (Platform level - not per tenant)
-- =====================================================

CREATE TABLE super_admins (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    username VARCHAR(100) UNIQUE NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    name VARCHAR(255) NOT NULL,
    
    -- Permissions
    can_create_companies BOOLEAN DEFAULT true,
    can_delete_companies BOOLEAN DEFAULT false,
    can_impersonate BOOLEAN DEFAULT false,
    
    -- Status
    status VARCHAR(20) DEFAULT 'active',
    last_login TIMESTAMP,
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- =====================================================
-- DISTRIBUTION CENTERS (Multi-tenant)
-- =====================================================

CREATE TABLE distribution_centers (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    
    code VARCHAR(20) NOT NULL,  -- e.g., DC-AL-001
    name VARCHAR(255) NOT NULL,
    address TEXT,
    city VARCHAR(100),
    state VARCHAR(50),
    zip VARCHAR(20),
    phone VARCHAR(20),
    
    -- GPS
    lat DECIMAL(10, 6),
    lng DECIMAL(10, 6),
    
    -- Operations
    manager_name VARCHAR(255),
    capacity_gallons INTEGER DEFAULT 50000,
    
    status VARCHAR(20) DEFAULT 'active',
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    UNIQUE(company_id, code)
);

CREATE INDEX idx_dc_company ON distribution_centers(company_id);

-- =====================================================
-- TRUCKS (Multi-tenant)
-- =====================================================

CREATE TABLE trucks (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    dc_id UUID REFERENCES distribution_centers(id) ON DELETE SET NULL,
    
    code VARCHAR(20) NOT NULL,  -- e.g., TRK-001
    name VARCHAR(100),
    
    -- Vehicle Info
    make VARCHAR(50),
    model VARCHAR(50),
    year INTEGER,
    vin VARCHAR(50),
    license_plate VARCHAR(20),
    
    -- Capacity
    capacity_gallons INTEGER DEFAULT 3000,
    
    -- GPS Tracking
    current_lat DECIMAL(10, 6),
    current_lng DECIMAL(10, 6),
    speed DECIMAL(5, 2) DEFAULT 0,
    heading INTEGER DEFAULT 0,
    last_gps_update TIMESTAMP,
    
    -- Fuel
    fuel_level DECIMAL(5, 2) DEFAULT 100,
    mpg DECIMAL(5, 2) DEFAULT 8,
    
    -- Status
    status VARCHAR(20) DEFAULT 'active',  -- active, maintenance, inactive
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    UNIQUE(company_id, code)
);

CREATE INDEX idx_trucks_company ON trucks(company_id);
CREATE INDEX idx_trucks_dc ON trucks(dc_id);

-- =====================================================
-- DRIVERS (Multi-tenant)
-- =====================================================

CREATE TABLE drivers (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    dc_id UUID REFERENCES distribution_centers(id) ON DELETE SET NULL,
    
    code VARCHAR(20) NOT NULL,  -- e.g., DRV-001
    name VARCHAR(255) NOT NULL,
    email VARCHAR(255),
    phone VARCHAR(20),
    
    -- License Info
    license_number VARCHAR(50),
    license_state VARCHAR(50),
    license_expiry DATE,
    cdl_class VARCHAR(10),
    hazmat_certified BOOLEAN DEFAULT false,
    
    -- Employment
    hire_date DATE,
    hourly_rate DECIMAL(10, 2),
    
    -- Status
    status VARCHAR(20) DEFAULT 'active',  -- active, available, on_route, off_duty, inactive
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    UNIQUE(company_id, code)
);

CREATE INDEX idx_drivers_company ON drivers(company_id);
CREATE INDEX idx_drivers_dc ON drivers(dc_id);

-- =====================================================
-- CUSTOMERS (Multi-tenant)
-- =====================================================

CREATE TABLE customers (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    preferred_dc_id UUID REFERENCES distribution_centers(id) ON DELETE SET NULL,
    
    code VARCHAR(20) NOT NULL,  -- e.g., CUST-001
    name VARCHAR(255) NOT NULL,
    contact_name VARCHAR(255),
    email VARCHAR(255),
    phone VARCHAR(20),
    
    -- Address
    address TEXT,
    city VARCHAR(100),
    state VARCHAR(50),
    zip VARCHAR(20),
    
    -- GPS
    lat DECIMAL(10, 6),
    lng DECIMAL(10, 6),
    
    -- Customer Type
    customer_type VARCHAR(50) DEFAULT 'residential',  -- residential, commercial, industrial
    
    -- Tank Info
    tank_size INTEGER DEFAULT 500,  -- gallons
    current_level DECIMAL(5, 2) DEFAULT 50,  -- percentage
    
    -- Billing
    price_per_gallon DECIMAL(10, 4) DEFAULT 2.50,
    payment_terms VARCHAR(50) DEFAULT 'net30',
    balance DECIMAL(12, 2) DEFAULT 0,
    
    -- Service
    delivery_instructions TEXT,
    auto_delivery BOOLEAN DEFAULT false,
    minimum_level INTEGER DEFAULT 20,  -- auto-order when below this %
    
    status VARCHAR(20) DEFAULT 'active',
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    UNIQUE(company_id, code)
);

CREATE INDEX idx_customers_company ON customers(company_id);
CREATE INDEX idx_customers_dc ON customers(preferred_dc_id);
CREATE INDEX idx_customers_type ON customers(customer_type);

-- =====================================================
-- ORDERS (Multi-tenant)
-- =====================================================

CREATE TABLE orders (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    dc_id UUID REFERENCES distribution_centers(id) ON DELETE SET NULL,
    route_id UUID,  -- Will reference routes table
    
    order_number VARCHAR(20) NOT NULL,
    
    -- Order Details
    gallons_requested INTEGER NOT NULL,
    gallons_delivered INTEGER,
    price_per_gallon DECIMAL(10, 4),
    total_amount DECIMAL(12, 2),
    
    -- Scheduling
    requested_date DATE,
    scheduled_date DATE,
    delivery_window VARCHAR(50),  -- morning, afternoon, anytime
    
    -- Delivery
    delivered_at TIMESTAMP,
    delivery_notes TEXT,
    
    -- Status
    status VARCHAR(20) DEFAULT 'pending',  -- pending, scheduled, in_progress, delivered, cancelled
    priority VARCHAR(20) DEFAULT 'normal',  -- low, normal, high, urgent
    
    -- Payment
    payment_status VARCHAR(20) DEFAULT 'unpaid',  -- unpaid, partial, paid
    paid_amount DECIMAL(12, 2) DEFAULT 0,
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    UNIQUE(company_id, order_number)
);

CREATE INDEX idx_orders_company ON orders(company_id);
CREATE INDEX idx_orders_customer ON orders(customer_id);
CREATE INDEX idx_orders_status ON orders(status);
CREATE INDEX idx_orders_date ON orders(scheduled_date);

-- =====================================================
-- ROUTES (Multi-tenant)
-- =====================================================

CREATE TABLE routes (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    dc_id UUID NOT NULL REFERENCES distribution_centers(id) ON DELETE CASCADE,
    truck_id UUID REFERENCES trucks(id) ON DELETE SET NULL,
    driver_id UUID REFERENCES drivers(id) ON DELETE SET NULL,
    
    route_number VARCHAR(20) NOT NULL,
    name VARCHAR(255),
    
    -- Schedule
    scheduled_date DATE NOT NULL,
    start_time TIME,
    
    -- Route Stats
    total_stops INTEGER DEFAULT 0,
    total_gallons INTEGER DEFAULT 0,
    total_miles DECIMAL(10, 2) DEFAULT 0,
    estimated_duration INTEGER,  -- minutes
    
    -- Optimization
    is_optimized BOOLEAN DEFAULT false,
    original_miles DECIMAL(10, 2),
    optimized_miles DECIMAL(10, 2),
    
    -- Status
    status VARCHAR(20) DEFAULT 'planned',  -- planned, in_progress, completed, cancelled
    started_at TIMESTAMP,
    completed_at TIMESTAMP,
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    UNIQUE(company_id, route_number)
);

CREATE INDEX idx_routes_company ON routes(company_id);
CREATE INDEX idx_routes_date ON routes(scheduled_date);
CREATE INDEX idx_routes_status ON routes(status);

-- Add foreign key from orders to routes
ALTER TABLE orders ADD CONSTRAINT fk_orders_route 
    FOREIGN KEY (route_id) REFERENCES routes(id) ON DELETE SET NULL;

-- =====================================================
-- ROUTE STOPS (Order of deliveries on a route)
-- =====================================================

CREATE TABLE route_stops (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    route_id UUID NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
    order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    
    stop_number INTEGER NOT NULL,
    
    -- Estimated
    estimated_arrival TIME,
    estimated_duration INTEGER DEFAULT 30,  -- minutes
    
    -- Actual
    arrived_at TIMESTAMP,
    departed_at TIMESTAMP,
    
    status VARCHAR(20) DEFAULT 'pending',  -- pending, arrived, completed, skipped
    notes TEXT,
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_route_stops_route ON route_stops(route_id);

-- =====================================================
-- AUDIT LOG (Track important changes)
-- =====================================================

CREATE TABLE audit_log (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    company_id UUID REFERENCES companies(id) ON DELETE CASCADE,
    user_id UUID,
    
    action VARCHAR(50) NOT NULL,  -- create, update, delete, login, etc.
    entity_type VARCHAR(50),  -- company, user, order, route, etc.
    entity_id UUID,
    
    old_values JSONB,
    new_values JSONB,
    
    ip_address VARCHAR(45),
    user_agent TEXT,
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_audit_company ON audit_log(company_id);
CREATE INDEX idx_audit_created ON audit_log(created_at);

-- =====================================================
-- HELPER FUNCTIONS
-- =====================================================

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Apply trigger to all tables with updated_at
CREATE TRIGGER update_companies_updated_at BEFORE UPDATE ON companies
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_dc_updated_at BEFORE UPDATE ON distribution_centers
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_trucks_updated_at BEFORE UPDATE ON trucks
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_drivers_updated_at BEFORE UPDATE ON drivers
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_customers_updated_at BEFORE UPDATE ON customers
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_orders_updated_at BEFORE UPDATE ON orders
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_routes_updated_at BEFORE UPDATE ON routes
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- =====================================================
-- INITIAL SUPER ADMIN (Change password after first login!)
-- =====================================================

-- Password: 'superadmin123' hashed with bcrypt
-- You should change this immediately after setup
INSERT INTO super_admins (username, email, password_hash, name, can_delete_companies, can_impersonate)
VALUES (
    'superadmin',
    'admin@routecrmpro.com',
    '$2b$10$placeholder_hash_change_this',
    'Platform Administrator',
    true,
    true
);
