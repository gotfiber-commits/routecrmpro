-- Enhanced Driver and Truck Profiles
-- Run this in Neon SQL Editor

-- =====================================================
-- ENHANCED DRIVER FIELDS
-- =====================================================

-- Pay & Compensation
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS hourly_rate DECIMAL(10,2) DEFAULT 25.00;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS overtime_rate DECIMAL(10,2);
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS per_diem DECIMAL(10,2) DEFAULT 0;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS pay_type VARCHAR(20) DEFAULT 'hourly'; -- hourly, salary, per_mile, per_delivery

-- CDL Details
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS cdl_number VARCHAR(50);
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS cdl_state VARCHAR(2);
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS cdl_endorsements VARCHAR(50); -- H, N, P, S, T, X (comma separated)

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
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS background_check_status VARCHAR(20) DEFAULT 'pending'; -- pending, cleared, failed, expired
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS drug_test_date DATE;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS drug_test_status VARCHAR(20) DEFAULT 'pending'; -- pending, passed, failed
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS drug_test_type VARCHAR(20); -- pre_employment, random, post_accident
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS mvr_check_date DATE; -- Motor Vehicle Record
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

-- Performance Metrics (updated periodically)
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS total_deliveries INTEGER DEFAULT 0;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS total_miles_driven DECIMAL(12,2) DEFAULT 0;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS total_gallons_delivered DECIMAL(12,2) DEFAULT 0;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS accidents_count INTEGER DEFAULT 0;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS violations_count INTEGER DEFAULT 0;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS on_time_delivery_rate DECIMAL(5,2) DEFAULT 100; -- percentage
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS customer_rating DECIMAL(3,2); -- 1-5 scale

-- Notes
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS notes TEXT;


-- =====================================================
-- ENHANCED TRUCK FIELDS
-- =====================================================

-- Assigned Driver (foreign key)
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS assigned_driver_id UUID REFERENCES drivers(id) ON DELETE SET NULL;

-- Weight Specifications (all in pounds)
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS empty_weight INTEGER; -- Tare weight (truck empty)
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS gvwr INTEGER; -- Gross Vehicle Weight Rating (max total)
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS gcwr INTEGER; -- Gross Combined Weight Rating (if towing)
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS max_payload INTEGER; -- Max cargo weight
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS front_axle_weight INTEGER;
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS rear_axle_weight INTEGER;
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS axle_configuration VARCHAR(20); -- single, tandem, tridem

-- Tank Specifications
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS tank_capacity_gallons INTEGER DEFAULT 3000;
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS tank_material VARCHAR(50); -- steel, aluminum, composite
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS tank_last_inspection DATE;
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS tank_next_inspection DATE;
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS tank_certification VARCHAR(50); -- DOT, ASME

-- Product Configuration
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS product_type VARCHAR(50) DEFAULT 'propane'; -- propane, diesel, gasoline, heating_oil
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS product_weight_per_gallon DECIMAL(5,3) DEFAULT 4.20; -- propane = 4.2 lbs/gal

-- Fuel System (truck's own fuel, not cargo)
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS fuel_tank_capacity INTEGER; -- gallons
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS fuel_type VARCHAR(20) DEFAULT 'diesel'; -- diesel, gasoline, cng, electric
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS diesel_weight_per_gallon DECIMAL(5,3) DEFAULT 7.10; -- diesel = ~7.1 lbs/gal
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS current_fuel_gallons DECIMAL(10,2);
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS avg_mpg DECIMAL(5,2) DEFAULT 8.0;
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS cost_per_mile DECIMAL(6,4); -- calculated operating cost

-- Pump & Meter
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS has_pump BOOLEAN DEFAULT true;
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS pump_type VARCHAR(50);
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS meter_type VARCHAR(50);
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS meter_last_calibration DATE;
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS meter_next_calibration DATE;

-- DOT & Registration
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS dot_number VARCHAR(20);
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS mc_number VARCHAR(20);
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS registration_state VARCHAR(2);
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS registration_expiration DATE;
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS last_dot_inspection DATE;
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS next_dot_inspection DATE;
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS dot_inspection_status VARCHAR(20); -- passed, failed, due

-- Insurance
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS insurance_policy_number VARCHAR(100);
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS insurance_provider VARCHAR(255);
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS insurance_expiration DATE;
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS liability_coverage DECIMAL(12,2);

-- Maintenance
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS last_oil_change DATE;
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS last_oil_change_miles INTEGER;
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS next_oil_change_miles INTEGER;
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS last_service_date DATE;
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS next_service_date DATE;
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS current_odometer INTEGER;
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS tire_size VARCHAR(50);
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
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS has_eld BOOLEAN DEFAULT true; -- Electronic Logging Device
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS eld_provider VARCHAR(100);
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS eld_serial_number VARCHAR(100);

-- Financials
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS purchase_date DATE;
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS purchase_price DECIMAL(12,2);
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS current_value DECIMAL(12,2);
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS monthly_payment DECIMAL(10,2);
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS monthly_insurance DECIMAL(10,2);

-- Performance Metrics
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS total_miles INTEGER DEFAULT 0;
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS total_deliveries INTEGER DEFAULT 0;
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS total_gallons_delivered DECIMAL(12,2) DEFAULT 0;
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS breakdowns_count INTEGER DEFAULT 0;
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS avg_fuel_efficiency DECIMAL(5,2);

-- Notes
ALTER TABLE trucks ADD COLUMN IF NOT EXISTS notes TEXT;

-- Index for assigned driver lookup
CREATE INDEX IF NOT EXISTS idx_trucks_assigned_driver ON trucks(assigned_driver_id);


-- =====================================================
-- PRODUCT TYPES REFERENCE TABLE
-- =====================================================

CREATE TABLE IF NOT EXISTS product_types (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    code VARCHAR(20) UNIQUE NOT NULL,
    name VARCHAR(100) NOT NULL,
    weight_per_gallon DECIMAL(5,3) NOT NULL, -- lbs per gallon
    default_price_per_gallon DECIMAL(10,4),
    hazmat_class VARCHAR(20),
    un_number VARCHAR(10),
    description TEXT,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Insert common fuel products with accurate weights
INSERT INTO product_types (code, name, weight_per_gallon, hazmat_class, un_number, description) VALUES
('propane', 'Propane (LPG)', 4.20, '2.1', 'UN1075', 'Liquefied Petroleum Gas'),
('diesel', 'Diesel Fuel', 7.10, '3', 'UN1202', 'Diesel fuel #2'),
('gasoline', 'Gasoline', 6.30, '3', 'UN1203', 'Motor gasoline'),
('heating_oil', 'Heating Oil', 7.20, '3', 'UN1202', 'Home heating oil #2'),
('kerosene', 'Kerosene', 6.80, '3', 'UN1223', 'Kerosene / K-1'),
('biodiesel', 'Biodiesel (B20)', 7.05, '3', 'UN1202', 'Biodiesel blend B20'),
('def', 'DEF (Diesel Exhaust Fluid)', 9.10, 'Non-Hazmat', NULL, 'Diesel exhaust fluid / AdBlue')
ON CONFLICT (code) DO NOTHING;


-- =====================================================
-- DRIVER CERTIFICATIONS LOG
-- =====================================================

CREATE TABLE IF NOT EXISTS driver_certifications (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    driver_id UUID NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
    certification_type VARCHAR(100) NOT NULL,
    issuing_authority VARCHAR(255),
    certificate_number VARCHAR(100),
    issued_date DATE,
    expiration_date DATE,
    status VARCHAR(20) DEFAULT 'active', -- active, expired, revoked
    document_url TEXT,
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_driver_certs_driver ON driver_certifications(driver_id);
CREATE INDEX IF NOT EXISTS idx_driver_certs_expiration ON driver_certifications(expiration_date);


-- =====================================================
-- TRUCK MAINTENANCE LOG
-- =====================================================

CREATE TABLE IF NOT EXISTS truck_maintenance (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    truck_id UUID NOT NULL REFERENCES trucks(id) ON DELETE CASCADE,
    maintenance_type VARCHAR(100) NOT NULL, -- oil_change, tire_rotation, brake_service, dot_inspection, etc.
    description TEXT,
    performed_by VARCHAR(255),
    vendor VARCHAR(255),
    cost DECIMAL(10,2),
    odometer_reading INTEGER,
    performed_date DATE NOT NULL,
    next_due_date DATE,
    next_due_miles INTEGER,
    parts_replaced TEXT,
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_truck_maint_truck ON truck_maintenance(truck_id);
CREATE INDEX IF NOT EXISTS idx_truck_maint_date ON truck_maintenance(performed_date);


-- =====================================================
-- VIEWS FOR COMPLIANCE TRACKING
-- =====================================================

-- Drivers needing attention (expiring documents)
CREATE OR REPLACE VIEW driver_compliance_alerts AS
SELECT 
    d.id,
    d.company_id,
    d.code,
    d.name,
    d.status,
    CASE 
        WHEN d.license_expiry < CURRENT_DATE THEN 'CDL EXPIRED'
        WHEN d.license_expiry < CURRENT_DATE + INTERVAL '30 days' THEN 'CDL expiring soon'
        ELSE NULL
    END as cdl_alert,
    CASE 
        WHEN d.medical_card_expiration < CURRENT_DATE THEN 'MEDICAL CARD EXPIRED'
        WHEN d.medical_card_expiration < CURRENT_DATE + INTERVAL '30 days' THEN 'Medical card expiring soon'
        ELSE NULL
    END as medical_alert,
    CASE 
        WHEN d.hazmat_endorsed AND d.hazmat_expiration < CURRENT_DATE THEN 'HAZMAT EXPIRED'
        WHEN d.hazmat_endorsed AND d.hazmat_expiration < CURRENT_DATE + INTERVAL '60 days' THEN 'HAZMAT expiring soon'
        ELSE NULL
    END as hazmat_alert,
    CASE 
        WHEN d.background_check_status = 'expired' OR d.background_check_date < CURRENT_DATE - INTERVAL '1 year' THEN 'Background check needed'
        ELSE NULL
    END as background_alert,
    CASE 
        WHEN d.drug_test_date < CURRENT_DATE - INTERVAL '1 year' THEN 'Annual drug test due'
        ELSE NULL
    END as drug_test_alert,
    d.license_expiry as cdl_expiration,
    d.medical_card_expiration,
    d.hazmat_expiration,
    d.background_check_date,
    d.drug_test_date
FROM drivers d
WHERE d.status = 'active'
  AND (
    d.license_expiry < CURRENT_DATE + INTERVAL '30 days'
    OR d.medical_card_expiration < CURRENT_DATE + INTERVAL '30 days'
    OR (d.hazmat_endorsed AND d.hazmat_expiration < CURRENT_DATE + INTERVAL '60 days')
    OR d.background_check_date < CURRENT_DATE - INTERVAL '1 year'
    OR d.drug_test_date < CURRENT_DATE - INTERVAL '1 year'
  );


-- Trucks needing attention
CREATE OR REPLACE VIEW truck_compliance_alerts AS
SELECT 
    t.id,
    t.company_id,
    t.code,
    t.name,
    t.status,
    CASE 
        WHEN t.registration_expiration < CURRENT_DATE THEN 'REGISTRATION EXPIRED'
        WHEN t.registration_expiration < CURRENT_DATE + INTERVAL '30 days' THEN 'Registration expiring soon'
        ELSE NULL
    END as registration_alert,
    CASE 
        WHEN t.next_dot_inspection < CURRENT_DATE THEN 'DOT INSPECTION OVERDUE'
        WHEN t.next_dot_inspection < CURRENT_DATE + INTERVAL '30 days' THEN 'DOT inspection due soon'
        ELSE NULL
    END as dot_alert,
    CASE 
        WHEN t.insurance_expiration < CURRENT_DATE THEN 'INSURANCE EXPIRED'
        WHEN t.insurance_expiration < CURRENT_DATE + INTERVAL '30 days' THEN 'Insurance expiring soon'
        ELSE NULL
    END as insurance_alert,
    CASE 
        WHEN t.tank_next_inspection < CURRENT_DATE THEN 'TANK INSPECTION OVERDUE'
        WHEN t.tank_next_inspection < CURRENT_DATE + INTERVAL '60 days' THEN 'Tank inspection due soon'
        ELSE NULL
    END as tank_alert,
    CASE 
        WHEN t.meter_next_calibration < CURRENT_DATE THEN 'METER CALIBRATION OVERDUE'
        WHEN t.meter_next_calibration < CURRENT_DATE + INTERVAL '30 days' THEN 'Meter calibration due soon'
        ELSE NULL
    END as meter_alert,
    CASE 
        WHEN t.current_odometer >= t.next_oil_change_miles THEN 'Oil change due'
        ELSE NULL
    END as oil_change_alert,
    t.registration_expiration,
    t.next_dot_inspection,
    t.insurance_expiration,
    t.tank_next_inspection,
    t.meter_next_calibration,
    t.current_odometer,
    t.next_oil_change_miles
FROM trucks t
WHERE t.status = 'active'
  AND (
    t.registration_expiration < CURRENT_DATE + INTERVAL '30 days'
    OR t.next_dot_inspection < CURRENT_DATE + INTERVAL '30 days'
    OR t.insurance_expiration < CURRENT_DATE + INTERVAL '30 days'
    OR t.tank_next_inspection < CURRENT_DATE + INTERVAL '60 days'
    OR t.meter_next_calibration < CURRENT_DATE + INTERVAL '30 days'
    OR t.current_odometer >= t.next_oil_change_miles
  );
